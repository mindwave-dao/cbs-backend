

import { google } from "googleapis";
import { processSuccessfulPayment } from "./email.js";
import { getPrice } from "./price.js";
import crypto from "crypto";
import fetch from "node-fetch";

// Environment validation
const THIX_API_URL = process.env.THIX_API_URL;
const THIX_API_KEY = process.env.THIX_API_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEETS_CREDENTIALS = process.env.GOOGLE_SHEETS_CREDENTIALS;

// Validation helper
export function validatePaymentEnv() {
    if (!THIX_API_URL?.startsWith('https://api.3thix.com')) {
        throw new Error('INVALID CONFIG: THIX_API_URL must be https://api.3thix.com');
    }
    if (!THIX_API_KEY || !GOOGLE_SHEET_ID || !GOOGLE_SHEETS_CREDENTIALS) {
        throw new Error('INVALID CONFIG: Missing required environment variables');
    }
}

/* ---------- Schemas ---------- */
const TRANSACTIONS_HEADERS = [
    "merchant_ref_id", "description", "amount", "currency", "status",
    "gateway", "invoice_id", "fee", "flag", "country", "notes", "timestamp",
    "token_price_usd", "tokens_purchased", "admin_email_sent" // New columns
];

const ADDITIONAL_INFO_HEADERS = [
    "invoice_id", "merchant_ref_id", "name", "email", "status",
    "amount", "currency", "timestamp"
];

const ACTIVITY_LOG_HEADERS = [
    "activity_id", "invoice_id", "merchant_ref_id", "event_type",
    "amount", "currency", "gateway", "country", "user_agent", "ip",
    "metadata", "timestamp"
];

const RAW_RESPONSES_HEADERS = [
    "invoice_id", "source", "status", "raw_response", "timestamp"
];

/* ---------- Fetch Helper with Retry ---------- */
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
            if (res.status >= 500 && i < retries - 1) {
                // Exponential backoff: 500ms, 1000ms, 2000ms
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
                continue;
            }
            return res; // Return checking error for caller to handle
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
        }
    }
}

/* ---------- Sheets Helpers ---------- */
async function getSheetsClient() {
    try {
        const creds = process.env.GOOGLE_SHEETS_CREDENTIALS;
        if (!creds) return null;
        const credentials = JSON.parse(creds);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });
        return google.sheets({ version: "v4", auth });
    } catch (e) {
        console.error("[Sheets Init Failed]", e);
        return null;
    }
}

async function ensureHeaders(sheets, sheetName, headers) {
    try {
        const endCol = String.fromCharCode(64 + headers.length); // Assumes < 26 columns
        // For > 26 columns, logic needs update, but we are under 26 (max ~14 here).
        // Transactions has 14 cols -> N.

        // Simple column letter generator for small counts
        const getColLetter = (n) => {
            return String.fromCharCode(64 + n);
        };
        const endLetter = getColLetter(headers.length);

        const range = `${sheetName}!A1:${endLetter}1`;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });

        if (!response.data.values || !response.data.values[0] || response.data.values[0].length < headers.length) {
            // If missing headers, overwrite/append logic. 
            // To be safe, we just update the header row if it looks short or empty.
            // We won't overwrite existing data if meaningful, but for headers it's usually safe.
            await sheets.spreadsheets.values.update({
                spreadsheetId: GOOGLE_SHEET_ID,
                range: `${sheetName}!A1`,
                valueInputOption: "RAW",
                requestBody: { values: [headers] }
            });
        }
    } catch (e) {
        console.warn(`[HEADER CHECK FAILED] ${sheetName}`, e.message);
    }
}

async function checkInvoiceExists(sheets, sheetName, invoiceId, columnIndex) {
    try {
        // Read optimized range if possible, but reading all is simpler for small sheets.
        // TODO: optimize for large sheets later.
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `${sheetName}!A2:M` // Adjusted coverage
        });
        const rows = response.data.values || [];
        return rows.some(row => row[columnIndex] === invoiceId);
    } catch (e) {
        console.warn(`[IDEMPOTENCY CHECK FAILED] ${sheetName}`, e.message);
        return true; // Fail safe: assume exists to prevent dupe
    }
}

/* ---------- Ledger Writers ---------- */
async function appendToRawResponses(sheets, invoiceId, source, status, rawData) {
    if (!sheets) return;
    try {
        await ensureHeaders(sheets, "Raw3thixResponses", RAW_RESPONSES_HEADERS);
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "Raw3thixResponses!A2:E",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [[invoiceId, source, status, JSON.stringify(rawData), new Date().toISOString()]] }
        });
    } catch (e) { console.error("[RAW LOG FAILED]", e.message); }
}

async function appendToTransactions(sheets, row) {
    if (!sheets) return;
    try {
        await ensureHeaders(sheets, "Transactions", TRANSACTIONS_HEADERS);
        // Dedup check on invoiceId (index 6)
        const exists = await checkInvoiceExists(sheets, "Transactions", row[6], 6);
        if (exists) {
            console.log(`[IDEMPOTENT SKIP] Transactions sheet already has invoice ${row[6]}`);
            return;
        }
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "Transactions!A2:N", // Updated range to include new columns
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
    } catch (e) { console.error("[LEDGER WRITE FAILED] Transactions", e.message); }
}

async function appendToActivityLog(sheets, row) {
    if (!sheets) return;
    try {
        await ensureHeaders(sheets, "TransactionActivityLog", ACTIVITY_LOG_HEADERS);
        // Dedup check on invoiceId (1) + eventType (3) for PAYMENT_SUCCESS
        if (row[3] === 'PAYMENT_SUCCESS') {
            const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: `TransactionActivityLog!A2:D` });
            const rows = response.data.values || [];
            if (rows.some(r => r[1] === row[1] && r[3] === 'PAYMENT_SUCCESS')) {
                console.log(`[IDEMPOTENT SKIP] ActivityLog already has PAYMENT_SUCCESS for ${row[1]}`);
                return;
            }
        }
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "TransactionActivityLog!A2:L",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
    } catch (e) { console.error("[LEDGER WRITE FAILED] ActivityLog", e.message); }
}

async function appendToAdditionalInfo(sheets, row) {
    if (!sheets) return;
    try {
        await ensureHeaders(sheets, "PaymentAdditionalInfo", ADDITIONAL_INFO_HEADERS);
        const exists = await checkInvoiceExists(sheets, "PaymentAdditionalInfo", row[0], 0);
        if (exists) return; // already present
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "PaymentAdditionalInfo!A2:H",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
    } catch (e) { console.error("[LEDGER WRITE FAILED] AdditionalInfo", e.message); }
}

/* ---------- Sync & Hydration Helpers ---------- */
async function findInPaymentTransactions(sheets, invoiceId) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "PAYMENT_TRANSACTIONS!A2:I" // Expanded range to I (index 8)
        });
        const rows = response.data.values || [];
        for (let i = 0; i < rows.length; i++) {
            if (rows[i][0] === invoiceId) {
                return {
                    rowIndex: i + 2,
                    STATUS: rows[i][1] || 'PENDING',
                    EMAIL: rows[i][2] || '',
                    NAME: rows[i][3] || '',
                    EMAIL_SENT: rows[i][4] || 'NO',
                    EMAIL_SENT_AT: rows[i][5] || '',
                    TOKEN_PRICE: rows[i][6] || '',
                    TOKENS_PURCHASED: rows[i][7] || '',
                    ADMIN_EMAIL_SENT: rows[i][8] || 'NO'
                };
            }
        }
    } catch (e) { console.warn("[PAYMENT_TRANSACTIONS Check Failed]", e.message); }
    return null;
}

// Updated to support new columns
async function syncToPaymentTransactions(sheets, invoiceId, status, email, name, tokenPrice = '', tokensPurchased = '') {
    if (!sheets) return;
    try {
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (!existing) {
            // Append with new columns, initializing ADMIN_EMAIL_SENT explicitly as 'NO'
            await sheets.spreadsheets.values.append({
                spreadsheetId: GOOGLE_SHEET_ID,
                range: "PAYMENT_TRANSACTIONS!A2:I",
                valueInputOption: "RAW",
                insertDataOption: "INSERT_ROWS",
                requestBody: { values: [[invoiceId, status, email || '', name || '', 'NO', '', tokenPrice, tokensPurchased, 'NO']] }
            });
        }
    } catch (err) { console.error(`[SYNC FAILED] ${invoiceId}`, err); }
}

async function updatePaymentTransactionRow(sheets, rowIndex, updates) {
    try {
        const data = updates.map(u => ({ range: `PAYMENT_TRANSACTIONS!${u.col}${rowIndex}`, values: [[u.val]] }));
        if (data.length > 0) {
            await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: GOOGLE_SHEET_ID,
                requestBody: { valueInputOption: "RAW", data }
            });
        }
    } catch (e) { console.error(`[UPDATE FAILED] Row ${rowIndex}`, e.message); }
}

async function hydrateFromLedgers(sheets, invoiceId) {
    // Strategy: Look in ActivityLog (metadata) or PaymentAdditionalInfo
    let email = '', name = '';

    // 1. PaymentAdditionalInfo
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "PaymentAdditionalInfo!A2:H" });
        const row = (res.data.values || []).find(r => r[0] === invoiceId);
        if (row && row[3]) return { email: row[3], name: row[2] || '' };
    } catch (e) { }

    // 2. ActivityLog
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "TransactionActivityLog!A2:L" });
        if (res.data.values) {
            for (let i = res.data.values.length - 1; i >= 0; i--) { // latest first
                const row = res.data.values[i];
                if (row[1] === invoiceId && row[10]) {
                    try {
                        const meta = JSON.parse(row[10]);
                        if (meta.email) return { email: meta.email, name: meta.name || meta.user_name || '' };
                    } catch (e) { }
                }
            }
        }
    } catch (e) { }
    return null;
}

/* ---------- 3Thix API Logic ---------- */
export async function check3ThixAuthoritative(invoiceId) {
    if (!THIX_API_KEY || !THIX_API_URL || !invoiceId) return null;
    try {
        console.log(`🔍 3Thix Authoritative Check: ${invoiceId}`);
        // Retries added
        const response = await fetchWithRetry(`${THIX_API_URL}/invoice/issuer/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({ id: invoiceId })
        });

        if (response.ok) {
            const data = await response.json();
            let status = null;
            if (data.invoice && data.invoice.status) {
                status = data.invoice.status;
            } else if (data.invoice && data.invoice.payment_status) {
                status = data.invoice.payment_status;
            } else if (data.status) {
                status = data.status;
            } else if (data.order && data.order.status) {
                status = data.order.status;
            }
            return { status: (status || '').toUpperCase(), data };
        } else {
            const errorText = await response.text();
            console.error(`3Thix Check Failed [${response.status}]: ${errorText}`);
        }
    } catch (e) { console.error("3Thix Check Error:", e.message); }
    return null;
}

export function normalize3ThixStatus(rawStatus) {
    if (!rawStatus) return 'PENDING';
    const s = rawStatus.toUpperCase();
    if (['PAID', 'COMPLETED'].includes(s)) return 'SUCCESS';
    if (['CANCELLED', 'FAILED', 'ERROR', 'EXPIRED'].includes(s)) return 'FAILED';
    if (['PARTIALLY_PAID', 'PARTIAL'].includes(s)) return 'PARTIAL';
    return 'PROCESSING'; // Default incl 'APPROVED', 'PENDING'
}

/* ---------- Admin Escalation Helper ---------- */
async function checkAndEscalate(sheets, invoiceId, status, emailSent, createdAtStr) {
    if (!process.env.ADMIN_EMAIL) return;

    // Don't escalate effectively for now if we don't have good timestamps, 
    // but we can try if invoice data is rich.
    // logic same as before (simplistic)
    const now = new Date();
    // Default to 'now' if invalid, preventing instant escalation
    const created = !createdAtStr || isNaN(Date.parse(createdAtStr)) ? now : new Date(createdAtStr);
    const diffMinutes = (now - created) / 1000 / 60;

    let triggerEscalation = false;
    let reason = "";

    if (status === 'PROCESSING' && diffMinutes > 10) {
        triggerEscalation = true;
        reason = `Payment stuck in PROCESSING for ${Math.round(diffMinutes)} minutes`;
    }

    if (status === 'SUCCESS' && emailSent !== 'YES' && diffMinutes > 5) {
        triggerEscalation = true;
        reason = `Payment SUCCESS but customer email not sent for ${Math.round(diffMinutes)} minutes`;
    }

    if (triggerEscalation) {
        const { sendAdminEmail } = await import("./email.js");
        try {
            console.log(`[ADMIN ESCALATION] Triggering for ${invoiceId}: ${reason}`);
            await sendAdminEmail(
                "System Admin",
                process.env.ADMIN_EMAIL,
                invoiceId,
                { reason, status, emailSent }
            );
        } catch (e) {
            console.error("[ESCALATION FAILED]", e.message);
        }
    }
}

/* ---------- Core Business Logic ---------- */
export async function handlePaymentLogic(invoiceId, sourceLabel = '3THIX_API', webhookData = null) {
    const sheets = await getSheetsClient();
    if (!sheets) {
        // Fallback or error
        return {
            invoiceId,
            status: "PENDING",
            source: "ERROR",
            emailSentUser: false,
            emailSentAdmin: false,
            tokens: 0,
            tokenPrice: 0,
            amount: 0,
            currency: 'USD'
        };
    }

    let finalStatus = 'PENDING';
    let transactionData = null;

    // 1. Authoritative Check (Prioritize API, Fallback to Webhook Data)
    const apiResult = await check3ThixAuthoritative(invoiceId);

    if (apiResult) {
        const rawStatus = apiResult.status;
        finalStatus = normalize3ThixStatus(rawStatus);
        transactionData = apiResult.data;
        // Log Raw
        await appendToRawResponses(sheets, invoiceId, sourceLabel, rawStatus, transactionData);
    } else if (webhookData && sourceLabel === 'WEBHOOK') {
        // API failed but we have Webhook Data (Safety Net)
        console.warn(`[AUTHORITATIVE FAIL] Using Webhook Payload for ${invoiceId}`);
        const rawStatus = webhookData.status || (webhookData.invoice && webhookData.invoice.status) || 'PENDING';
        finalStatus = normalize3ThixStatus(rawStatus);
        transactionData = webhookData;
        await appendToRawResponses(sheets, invoiceId, 'WEBHOOK_FALLBACK', rawStatus, transactionData);
    } else {
        // API failed and no webhook data. Check persistence.
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (existing && existing.STATUS === 'SUCCESS') {
            finalStatus = 'SUCCESS';
        } else {
            finalStatus = existing ? existing.STATUS : 'PENDING';
        }
    }

    // 2. Protect Success
    if (finalStatus !== 'SUCCESS') {
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (existing && existing.STATUS === 'SUCCESS') {
            finalStatus = 'SUCCESS';
        }
    }

    // 3. SUCCESS Handling & Ledger
    let tokensPurchased = 0;
    let tokenPriceUsed = 0;
    let amountVal = 0;
    let currency = '';

    if (finalStatus === 'SUCCESS' && transactionData) {
        const metaSource = transactionData.metadata || (transactionData.invoice && transactionData.invoice.metadata) || (transactionData.order && transactionData.order.metadata);
        const metadata = typeof metaSource === 'string' ? JSON.parse(metaSource) : metaSource || {};

        const merchRef = transactionData.merchant_ref_id || (transactionData.invoice && transactionData.invoice.merchant_ref_id) || '';
        const amountStr = transactionData.amount || (transactionData.invoice && transactionData.invoice.amount) || '0';
        currency = transactionData.currency || (transactionData.invoice && transactionData.invoice.currency) || '';
        const fee = transactionData.fee || (transactionData.invoice && transactionData.invoice.fee) || '0';

        amountVal = parseFloat(amountStr);

        // Fetch Price & Calculate Tokens
        // Try to see if we already stored it? Check existing first.
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (existing && existing.TOKEN_PRICE && existing.TOKENS_PURCHASED) {
            tokenPriceUsed = parseFloat(existing.TOKEN_PRICE);
            tokensPurchased = parseFloat(existing.TOKENS_PURCHASED);
        } else {
            // Fetch live/cached price
            const priceData = await getPrice();
            if (priceData && priceData.price_usd > 0) {
                tokenPriceUsed = priceData.price_usd;
                tokensPurchased = parseFloat((amountVal / tokenPriceUsed).toFixed(6));
            } else {
                // Fallback if price fails? Maybe 0 or logic error.
                // For now record 0, handle manual fix if needed.
                console.warn(`[PRICE MISSING] Could not fetch price for ${invoiceId}`);
            }
        }

        // A. Transactions
        await appendToTransactions(sheets, [
            merchRef, "NILA TOKEN - Mindwave", amountStr, currency,
            'SUCCESS', "3THIX", invoiceId, fee,
            metadata.paymentBlocked ? 'BLOCKED' : '', '', '', new Date().toISOString(),
            tokenPriceUsed, tokensPurchased
        ]);

        // B. ActivityLog
        await appendToActivityLog(sheets, [
            crypto.randomUUID(), invoiceId, merchRef, "PAYMENT_SUCCESS",
            amountStr, currency, "3THIX", '', '', '',
            JSON.stringify(metadata), new Date().toISOString()
        ]);

        // C. AdditionalInfo
        const name = metadata.name || '';
        const email = metadata.email || '';
        if (name || email) {
            await appendToAdditionalInfo(sheets, [
                invoiceId, merchRef, name, email,
                'SUCCESS', amountStr, currency, new Date().toISOString()
            ]);
        }
    }

    // 4. View Layer & Email
    let ptRow = await findInPaymentTransactions(sheets, invoiceId);
    let customerName = '', customerEmail = '';

    if (!ptRow) {
        // Create initial
        await syncToPaymentTransactions(sheets, invoiceId, finalStatus, '', '', tokenPriceUsed || '', tokensPurchased || '');
        ptRow = await findInPaymentTransactions(sheets, invoiceId);
    }

    // Update Token info if missing in PT row and available now
    if (ptRow && (!ptRow.TOKEN_PRICE || !ptRow.TOKENS_PURCHASED) && (tokenPriceUsed && tokensPurchased)) {
        // Logic to update columns G & H (index 6, 7)
        // 6 -> G, 7 -> H
        const updates = [
            { col: 'G', val: tokenPriceUsed },
            { col: 'H', val: tokensPurchased }
        ];
        await updatePaymentTransactionRow(sheets, ptRow.rowIndex, updates);
        ptRow.TOKEN_PRICE = tokenPriceUsed;
        ptRow.TOKENS_PURCHASED = tokensPurchased;
    }

    let isEmailSent = (ptRow && ptRow.EMAIL_SENT === 'YES') ? true : false;
    let isAdminEmailSent = (ptRow && ptRow.ADMIN_EMAIL_SENT === 'YES') ? true : false;

    if (ptRow) {
        const updates = [];
        if (ptRow.STATUS !== finalStatus) {
            updates.push({ col: 'B', val: finalStatus });
            ptRow.STATUS = finalStatus;
        }

        // Hydration
        if (!ptRow.EMAIL || !ptRow.NAME) {
            let hydrated = null;
            if (transactionData) {
                try {
                    const metaSource = transactionData.metadata || (transactionData.invoice && transactionData.invoice.metadata) || (transactionData.order && transactionData.order.metadata);
                    const md = typeof metaSource === 'string' ? JSON.parse(metaSource) : metaSource || {};
                    if (md.email) hydrated = { email: md.email, name: md.name };
                } catch (e) { }
            }
            if (!hydrated || !hydrated.email) {
                hydrated = await hydrateFromLedgers(sheets, invoiceId);
            }
            if (hydrated && hydrated.email) {
                if (ptRow.EMAIL !== hydrated.email) {
                    updates.push({ col: 'C', val: hydrated.email });
                    ptRow.EMAIL = hydrated.email;
                }
                if (ptRow.NAME !== hydrated.name) {
                    updates.push({ col: 'D', val: hydrated.name });
                    ptRow.NAME = hydrated.name;
                }
            }
        }

        customerEmail = ptRow.EMAIL;
        customerName = ptRow.NAME;

        if (updates.length > 0) {
            await updatePaymentTransactionRow(sheets, ptRow.rowIndex, updates);
        }

        // --- NEW: Admin Email (Strictly on SUCCESS) ---
        if (finalStatus === 'SUCCESS' && ptRow.ADMIN_EMAIL_SENT !== 'YES') {
            try {
                const { sendAdminPaymentNotification } = await import("./email.js");
                const adminSent = await sendAdminPaymentNotification({
                    invoiceId,
                    amount: amountVal,
                    currency,
                    tokens: tokensPurchased,
                    tokenPrice: tokenPriceUsed,
                    email: customerEmail,
                    name: customerName,
                    source: sourceLabel,
                    timestamp: new Date().toISOString()
                });

                if (adminSent) {
                    await updatePaymentTransactionRow(sheets, ptRow.rowIndex, [
                        { col: 'I', val: 'YES' }
                    ]);
                    isAdminEmailSent = true;
                }
            } catch (adminErr) {
                console.error(`[ADMIN EMAIL LOGIC FAIL] ${invoiceId}`, adminErr);
            }
        }

        // 5. Send User Email Rule: SUCCESS + EMAIL_SENT != YES
        if (finalStatus === 'SUCCESS' && ptRow.EMAIL_SENT !== 'YES') {
            if (customerEmail) {
                try {
                    // Send Email with tokens info
                    const emailResult = await processSuccessfulPayment(
                        invoiceId,
                        customerEmail,
                        customerName,
                        ptRow.TOKENS_PURCHASED || tokensPurchased,
                        ptRow.TOKEN_PRICE || tokenPriceUsed,
                        amountVal
                    );

                    if (emailResult.success && emailResult.emailSent) {
                        await updatePaymentTransactionRow(sheets, ptRow.rowIndex, [
                            { col: 'E', val: 'YES' },
                            { col: 'F', val: new Date().toISOString() }
                        ]);
                        isEmailSent = true;
                    }
                } catch (emailErr) {
                    console.error(`[EMAIL FAIL LOGIC] ${invoiceId}`, emailErr);
                }
            }
        } else if (ptRow.EMAIL_SENT === 'YES') {
            isEmailSent = true;
        }
    }

    // 6. Escalation (Only for Processing Stuck or User Email Fail)
    let createdTime = new Date().toISOString();
    if (transactionData) {
        createdTime = transactionData.timestamp || (transactionData.invoice && transactionData.invoice.created_at) || (transactionData.order && transactionData.order.created_at) || createdTime;
    }
    await checkAndEscalate(sheets, invoiceId, finalStatus, isEmailSent ? 'YES' : 'NO', createdTime);

    // Return with extended info
    return {
        invoiceId,
        status: finalStatus,
        source: sourceLabel,
        emailSentUser: isEmailSent,
        emailSentAdmin: isAdminEmailSent,
        amount: String(amountVal),
        currency: currency || 'USD',
        tokens: String(ptRow ? ptRow.TOKENS_PURCHASED : (tokensPurchased || 0)),
        tokenPrice: String(ptRow ? ptRow.TOKEN_PRICE : (tokenPriceUsed || 0))
    };
}
