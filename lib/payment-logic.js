

import { google } from "googleapis";
import { processSuccessfulPayment } from "./email.js";
import { getPrice } from "./price.js";
import crypto from "crypto";



import { google } from "googleapis";
import { processSuccessfulPayment } from "./email.js";
import { getPrice } from "./price.js";
import crypto from "crypto";
import { validateEnv } from "./env.js"; // Reuse existing if possible

// Validation helper (keep this pure)
// ...

function getPaymentEnv() {
    return {
        THIX_API_URL: process.env.THIX_API_URL,
        THIX_API_KEY: process.env.THIX_API_KEY,
        GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
        GOOGLE_SHEETS_CREDENTIALS: process.env.GOOGLE_SHEETS_CREDENTIALS,
        ADMIN_EMAIL: process.env.ADMIN_EMAIL
    };
}

// Wallet Regex Patterns
const ETH_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TRON_REGEX = /^T[a-zA-Z0-9]{33}$/;

export function validateWalletAddress(address) {
    if (!address) return true; // Empty is valid
    return ETH_REGEX.test(address) || TRON_REGEX.test(address);
}

export function detectWalletNetwork(address) {
    if (!address) return null;
    if (address.startsWith("0x")) return "ETH / BSC";
    if (address.startsWith("T")) return "TRON";
    return null;
}

// Validation helper
export function validatePaymentEnv() {
    const { THIX_API_URL, THIX_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SHEETS_CREDENTIALS } = getPaymentEnv();
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

const PAYMENT_TRANSACTIONS_HEADERS = [
    "INVOICE_ID", "STATUS", "EMAIL", "NAME", "WALLET_ADDRESS", "WALLET_NETWORK",
    "AMOUNT", "CURRENCY", "CREATED_AT", "EMAIL_SENT", "ADMIN_EMAIL_SENT",
    "TOKEN_PRICE", "TOKENS_PURCHASED", "EMAIL_SENT_AT"
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
export async function getSheetsClient() {
    try {
        const { GOOGLE_SHEETS_CREDENTIALS } = getPaymentEnv();
        const creds = GOOGLE_SHEETS_CREDENTIALS;
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

        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
export async function findInPaymentTransactions(sheets, invoiceId) {
    try {
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "PAYMENT_TRANSACTIONS!A2:N" // Expanded range to N (index 13)
        });
        const rows = response.data.values || [];
        for (let i = 0; i < rows.length; i++) {
            if (rows[i][0] === invoiceId) {
                return {
                    rowIndex: i + 2,
                    STATUS: rows[i][1] || 'PENDING',
                    EMAIL: rows[i][2] || '',
                    NAME: rows[i][3] || '',
                    WALLET_ADDRESS: rows[i][4] || '',
                    WALLET_NETWORK: rows[i][5] || '',
                    AMOUNT: rows[i][6] || '',
                    CURRENCY: rows[i][7] || '',
                    CREATED_AT: rows[i][8] || '',
                    EMAIL_SENT: rows[i][9] || 'NO',
                    ADMIN_EMAIL_SENT: rows[i][10] || 'NO',
                    TOKEN_PRICE: rows[i][11] || '',
                    TOKENS_PURCHASED: rows[i][12] || '',
                    EMAIL_SENT_AT: rows[i][13] || ''
                };
            }
        }
    } catch (e) { console.warn("[PAYMENT_TRANSACTIONS Check Failed]", e.message); }
    return null;
}

// Updated to support new columns
export async function createPaymentTransaction(sheets, { invoiceId, email, name, walletAddress, walletNetwork, amount, currency }) {
    if (!sheets) return;
    try {
        await ensureHeaders(sheets, "PAYMENT_TRANSACTIONS", PAYMENT_TRANSACTIONS_HEADERS);

        // Strict consistency: Check if exists first
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (existing) {
            console.warn(`[CREATE SKIP] Invoice ${invoiceId} already exists in PAYMENT_TRANSACTIONS`);
            return;
        }

        const createdAt = new Date().toISOString();
        const row = [
            invoiceId,          // A: INVOICE_ID
            "CREATED",          // B: STATUS
            email || "",        // C: EMAIL
            name || "",         // D: NAME
            walletAddress || "",// E: WALLET_ADDRESS
            walletNetwork || "",// F: WALLET_NETWORK
            amount || "",       // G: AMOUNT
            currency || "",     // H: CURRENCY
            createdAt,          // I: CREATED_AT
            "NO",               // J: EMAIL_SENT
            "NO",               // K: ADMIN_EMAIL_SENT
            "",                 // L: TOKEN_PRICE (Empty on create)
            "",                 // M: TOKENS_PURCHASED (Empty on create)
            ""                  // N: EMAIL_SENT_AT (Empty on create)
        ];

        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "PAYMENT_TRANSACTIONS!A2:N",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
        console.log(`[PAYMENT CREATED] ${invoiceId} added to sheet.`);
    } catch (err) { console.error(`[CREATE FAILED] ${invoiceId}`, err); }
}

export async function updatePaymentSuccess(sheets, invoiceId, { tokenPrice, tokensPurchased, emailSentAt }) {
    if (!sheets) return;
    try {
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (!existing) {
            console.error(`[UPDATE FAILED] Invoice ${invoiceId} not found in PAYMENT_TRANSACTIONS`);
            return;
        }

        const rowIndex = existing.rowIndex;
        const updates = [
            { col: 'B', val: "SUCCESS" },           // STATUS
            { col: 'J', val: "YES" },               // EMAIL_SENT (User)
            { col: 'K', val: "YES" },               // ADMIN_EMAIL_SENT
            { col: 'L', val: tokenPrice },          // TOKEN_PRICE
            { col: 'M', val: tokensPurchased },     // TOKENS_PURCHASED
            { col: 'N', val: emailSentAt }          // EMAIL_SENT_AT
        ];

        await updatePaymentTransactionRow(sheets, rowIndex, updates);
        console.log(`[PAYMENT SUCCESS] ${invoiceId} updated in sheet.`);
    } catch (err) { console.error(`[UPDATE SUCCESS FAILED] ${invoiceId}`, err); }
}

export async function updatePaymentFailed(sheets, invoiceId) {
    if (!sheets) return;
    try {
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (!existing) return;

        const rowIndex = existing.rowIndex;
        // Only update status to FAILED
        await updatePaymentTransactionRow(sheets, rowIndex, [
            { col: 'B', val: "FAILED" }
        ]);
        console.log(`[PAYMENT FAILED] ${invoiceId} updated in sheet.`);
    } catch (err) { console.error(`[UPDATE FAILED ERROR] ${invoiceId}`, err); }
}

export async function updatePaymentStatus(sheets, invoiceId, status) {
    if (!sheets) return;
    try {
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (!existing) return;

        const rowIndex = existing.rowIndex;
        await updatePaymentTransactionRow(sheets, rowIndex, [
            { col: 'B', val: status }
        ]);
        console.log(`[PAYMENT STATUS UPDATE] ${invoiceId} -> ${status}`);
    } catch (err) { console.error(`[UPDATE STATUS FAILED] ${invoiceId}`, err); }
}

// Deprecated sync function, keeping solely for backward comp temporarily or removing if fully replaced. 
// Replacing with no-op or alias if needed, but implementation plan said to refactor. 
// We will leave original syncToPaymentTransactions removed.

async function updatePaymentTransactionRow(sheets, rowIndex, updates) {
    try {
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "PaymentAdditionalInfo!A2:H" });
        const row = (res.data.values || []).find(r => r[0] === invoiceId);
        if (row && row[3]) return { email: row[3], name: row[2] || '' };
    } catch (e) { }

    // 2. ActivityLog
    try {
        const { GOOGLE_SHEET_ID } = getPaymentEnv();
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
    const { THIX_API_KEY, THIX_API_URL } = getPaymentEnv();
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
    const { ADMIN_EMAIL } = getPaymentEnv();
    if (!ADMIN_EMAIL) return;

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
                ADMIN_EMAIL,
                invoiceId,
                { reason, status, emailSent }
            );
        } catch (e) {
            console.error("[ESCALATION FAILED]", e.message);
        }
    }
}

/* ---------- Core Business Logic ---------- */

// EXPORTED: Shared finalization logic for Webhook & Admin Reconcile
export async function finalizeSuccessfulPayment(invoiceId, authoritativeData, sourceLabel) {
    const sheets = await getSheetsClient();
    if (!sheets) return { status: 'ERROR', message: 'Database unavailable' };

    console.log(`[FINALIZE] Starting finalization for ${invoiceId} (Source: ${sourceLabel})`);

    // 1. Idempotency Check
    const existing = await findInPaymentTransactions(sheets, invoiceId);
    if (existing && existing.STATUS === 'SUCCESS') {
        console.log(`[IDEMPOTENT] Invoice ${invoiceId} already SUCCESS.`);

        // Handle Email Retry for Admin Reconcile even if already matched
        if (sourceLabel === 'ADMIN_RECONCILE' && existing.EMAIL_SENT !== 'YES') {
            console.log(`[ADMIN_RECONCILE] Invoice is SUCCESS but email not sent. Retrying emails...`);
            // Fall through to continue logic (effectively retrying emails as writing to sheets again is idempotent/safe upsert)
        } else {
            return {
                status: 'SUCCESS',
                invoiceId,
                tokens: existing.TOKENS_PURCHASED,
                tokenPrice: existing.TOKEN_PRICE,
                walletAddress: existing.WALLET_ADDRESS,
                source: 'CACHE'
            };
        }
    }

    // 2. Data Extraction
    const metaSource = authoritativeData.metadata || (authoritativeData.invoice && authoritativeData.invoice.metadata) || (authoritativeData.order && authoritativeData.order.metadata);
    const metadata = typeof metaSource === 'string' ? JSON.parse(metaSource) : metaSource || {};

    const merchRef = authoritativeData.merchant_ref_id || (authoritativeData.invoice && authoritativeData.invoice.merchant_ref_id) || '';
    const amountStr = authoritativeData.amount || (authoritativeData.invoice && authoritativeData.invoice.amount) || '0';
    const currency = authoritativeData.currency || (authoritativeData.invoice && authoritativeData.invoice.currency) || 'USD';
    const fee = authoritativeData.fee || (authoritativeData.invoice && authoritativeData.invoice.fee) || '0';
    const amountVal = parseFloat(amountStr);
    const walletAddress = metadata.wallet_address || metadata.walletAddress || "";
    const name = metadata.name || '';
    const email = metadata.email || '';
    const network = detectWalletNetwork(walletAddress);
    const notes = network ? `walletNetwork: ${network}` : '';

    // 3. Price & Token Calculation
    let tokenPriceUsed = 0;
    let tokensPurchased = 0;

    try {
        const priceData = await getPrice();
        if (priceData && priceData.price_usd > 0) {
            tokenPriceUsed = priceData.price_usd;
            tokensPurchased = parseFloat((amountVal / tokenPriceUsed).toFixed(6));
        } else {
            console.warn(`[PRICE MISSING] Could not fetch price for ${invoiceId}. Defaulting to 0.`);
        }
    } catch (e) {
        console.error(`[PRICE ERROR] ${invoiceId}`, e);
    }

    // 4. Update PAYMENT_TRANSACTIONS (One Write)
    // We use updateTransactionStatus which internally handles batch updates
    await updateTransactionStatus(invoiceId, 'SUCCESS', {
        email, name, walletAddress, walletNetwork: network,
        amount: amountStr, currency,
        tokenPrice: tokenPriceUsed, tokens: tokensPurchased,
        walletAddress // redundancy
    });

    // 5. Activity Log
    await appendToActivityLog(sheets, [
        crypto.randomUUID(), invoiceId, merchRef, "PAYMENT_SUCCESS",
        amountStr, currency, "3THIX", '', '', '',
        JSON.stringify(metadata), new Date().toISOString()
    ]);

    // 6. Additional Info
    if (name || email) {
        await appendToAdditionalInfo(sheets, [
            invoiceId, merchRef, name, email,
            'SUCCESS', amountStr, currency, new Date().toISOString()
        ]);
    }

    // 7. Emails
    let emailSentUser = false;
    let emailSentAdmin = false;

    // A. User Email
    if (email) {
        try {
            const emailResult = await processSuccessfulPayment(
                invoiceId, email, name, tokensPurchased, tokenPriceUsed, amountVal, walletAddress
            );
            if (emailResult.success && emailResult.emailSent) {
                // Update Flag
                await markEmailSent(invoiceId, 'USER');
                emailSentUser = true;
            }
        } catch (err) {
            console.error(`[EMAIL FAIL] User email for ${invoiceId}`, err);
        }
    }

    // B. Admin Email
    try {
        const { sendAdminPaymentNotification } = await import("./email.js");
        const adminSent = await sendAdminPaymentNotification({
            invoiceId,
            amount: amountVal,
            currency,
            tokens: tokensPurchased,
            tokenPrice: tokenPriceUsed,
            email, name, walletAddress,
            source: sourceLabel,
            timestamp: new Date().toISOString()
        });
        if (adminSent) {
            await markEmailSent(invoiceId, 'ADMIN');
            emailSentAdmin = true;
        }
    } catch (err) {
        console.error(`[EMAIL FAIL] Admin email for ${invoiceId}`, err);
    }

    return {
        status: 'SUCCESS',
        invoiceId,
        amount: amountStr,
        currency,
        tokens: tokensPurchased,
        tokenPrice: tokenPriceUsed,
        emailSentUser,
        emailSentAdmin,
        source: sourceLabel
    };
}

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

    // 3. Delegate to Finalize if SUCCESS
    if (finalStatus === 'SUCCESS') {
        // Safe check for valid wallet if strictly required, but finalize handles it
        // However, we must ensure we have transactionData to pass.
        // If we only have 'existing' (DB), finalize check logic handles idempotency return.

        let dataToPass = transactionData;

        if (!dataToPass) {
            // If we don't have fresh data but status is SUCCESS, we might be relying on cache.
            if (existing && existing.STATUS === 'SUCCESS') {
                // Just return DB state
                return {
                    status: 'SUCCESS',
                    invoiceId,
                    tokens: existing.TOKENS_PURCHASED,
                    tokenPrice: existing.TOKEN_PRICE,
                    source: 'CACHE'
                };
            }
        }

        return await finalizeSuccessfulPayment(invoiceId, dataToPass || {}, sourceLabel);
    } else if (finalStatus === 'FAILED') {
        // Handle failure
        await updatePaymentFailed(sheets, invoiceId);
        return { invoiceId, status: 'FAILED', source: sourceLabel };
    }

    return {
        invoiceId,
        status: finalStatus,
        source: sourceLabel
    };
}

// 4. Read-Only Status Check Logic
export async function checkPaymentStatusLogic(invoiceId, injectedSheets = null) {
    const sheets = injectedSheets || await getSheetsClient();
    if (!sheets) {
        throw new Error("Database connection failed");
    }

    const ptRow = await findInPaymentTransactions(sheets, invoiceId);

    // IF NOT FOUND -> 404
    if (!ptRow) {
        return {
            found: false,
            status: "NOT_FOUND"
        };
    }

    // IF FOUND, RESOLVE STATUS
    let finalStatus = ptRow.STATUS || "CREATED";
    // Normalize logic just in case:
    if (finalStatus === "AWAITING_PAYMENT") finalStatus = "CREATED";

    // SAFETY GUARD: If CREATED (or matching) > 15 Minutes -> AWAITING_WEBHOOK
    // This derived status helps UI show "Contact Support" or "Check Webhook" instead of infinite "Waiting"
    if (finalStatus === "CREATED") {
        const createdAt = ptRow.CREATED_AT ? new Date(ptRow.CREATED_AT) : new Date();
        const now = new Date();
        const diffMs = now - createdAt;
        const diffMins = diffMs / 60000;

        if (diffMins > 15) {
            finalStatus = "AWAITING_WEBHOOK";
        }
    }

    // Build Response based on status
    const response = {
        found: true,
        status: finalStatus,
        invoiceId: ptRow.INVOICE_ID,
        createdAt: ptRow.CREATED_AT
    };

    if (finalStatus === "SUCCESS") {
        response.amount = ptRow.AMOUNT ? parseFloat(ptRow.AMOUNT) : 0;
        response.currency = ptRow.CURRENCY || "USD";
        response.tokens = ptRow.TOKENS_PURCHASED ? parseFloat(ptRow.TOKENS_PURCHASED) : 0;
        response.tokenPrice = ptRow.TOKEN_PRICE ? parseFloat(ptRow.TOKEN_PRICE) : 0;
        response.walletAddress = ptRow.WALLET_ADDRESS || "";
        response.network = ptRow.WALLET_NETWORK || "";
        response.emailSent = ptRow.EMAIL_SENT === 'YES';
    }

    return response;
}
