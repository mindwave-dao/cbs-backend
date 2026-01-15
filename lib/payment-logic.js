
import { google } from "googleapis";
import { processSuccessfulPayment } from "./email.js";
import crypto from "crypto";
import fetch from "node-fetch";

// Environment validation
const THIX_API_URL = process.env.THIX_API_URL;
const THIX_API_KEY = process.env.THIX_API_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEETS_CREDENTIALS = process.env.GOOGLE_SHEETS_CREDENTIALS;

// Validation helper (can be called by consumers to fail fast)
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
    "gateway", "invoice_id", "fee", "flag", "country", "notes", "timestamp"
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
        const endCol = String.fromCharCode(64 + headers.length);
        const range = `${sheetName}!A1:${endCol}1`;
        const response = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range });

        if (!response.data.values || !response.data.values[0] || response.data.values[0].length !== headers.length) {
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
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `${sheetName}!A2:M`
        });
        const rows = response.data.values || [];
        return rows.some(row => row[columnIndex] === invoiceId);
    } catch (e) {
        console.warn(`[IDEMPOTENCY CHECK FAILED] ${sheetName}`, e.message);
        return true; // Fail safe
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
            range: "Transactions!A2:L",
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
        if (exists) return;
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
            range: "PAYMENT_TRANSACTIONS!A2:F"
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
                    EMAIL_SENT_AT: rows[i][5] || ''
                };
            }
        }
    } catch (e) { console.warn("[PAYMENT_TRANSACTIONS Check Failed]", e.message); }
    return null;
}

async function syncToPaymentTransactions(sheets, invoiceId, status, email, name) {
    if (!sheets) return;
    try {
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (!existing) {
            await sheets.spreadsheets.values.append({
                spreadsheetId: GOOGLE_SHEET_ID,
                range: "PAYMENT_TRANSACTIONS!A2:F",
                valueInputOption: "RAW",
                insertDataOption: "INSERT_ROWS",
                requestBody: { values: [[invoiceId, status, email || '', name || '', 'NO', '']] }
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
    let email = '', name = '';
    // Try PaymentAdditionalInfo
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: GOOGLE_SHEET_ID, range: "PaymentAdditionalInfo!A2:H" });
        const row = (res.data.values || []).find(r => r[0] === invoiceId);
        if (row && row[3]) return { email: row[3], name: row[2] || '' };
    } catch (e) { }

    // Try TransactionActivityLog
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
        // USER REQUEST: curl -X POST https://api.3thix.com/invoice/issuer/get ...
        const response = await fetch(`${THIX_API_URL}/invoice/issuer/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({ id: invoiceId })
        });

        if (response.ok) {
            const data = await response.json();
            // 3Thix response structure: root.invoice.status or root.invoice.payment_status usually
            // User snippet suggests checking data.invoice.status directly for PAID/APPROVED/etc.
            let status = null;
            if (data.invoice && data.invoice.status) {
                status = data.invoice.status;
            } else if (data.invoice && data.invoice.payment_status) {
                status = data.invoice.payment_status;
            } else if (data.status) {
                status = data.status;
            }
            return { status: (status || '').toUpperCase(), data };
        } else {
            const errorText = await response.text();
            console.error(`3Thix Check Failed [${response.status}]: ${errorText}`);
        }
    } catch (e) { console.error("3Thix Check Error:", e.message); }
    return null;
}


/* ---------- Helper ---------- */
export function normalize3ThixStatus(rawStatus) {
    if (!rawStatus) return 'PENDING';
    const s = rawStatus.toUpperCase();
    if (['PAID', 'COMPLETED'].includes(s)) return 'SUCCESS';
    if (['CANCELLED', 'FAILED', 'ERROR', 'EXPIRED'].includes(s)) return 'FAILED';
    if (['PARTIALLY_PAID', 'PARTIAL'].includes(s)) return 'PARTIAL';
    // STRICT RULE: APPROVED is PROCESSING, not SUCCESS.
    return 'PROCESSING';
}

/* ---------- Admin Escalation Helper ---------- */
async function checkAndEscalate(sheets, invoiceId, status, emailSent, createdAtStr) {
    if (!process.env.ADMIN_EMAIL) return; // No admin email configured

    const now = new Date();
    const created = new Date(createdAtStr || now);
    const diffMinutes = (now - created) / 1000 / 60;

    let triggerEscalation = false;
    let reason = "";

    // Rule 1: Stuck in PROCESSING for > 10 mins
    if (status === 'PROCESSING' && diffMinutes > 10) {
        triggerEscalation = true;
        reason = `Payment stuck in PROCESSING for ${Math.round(diffMinutes)} minutes`;
    }

    // Rule 2: SUCCESS but email not sent for > 5 mins
    if (status === 'SUCCESS' && emailSent !== 'YES' && diffMinutes > 5) {
        triggerEscalation = true;
        reason = `Payment SUCCESS but customer email not sent for ${Math.round(diffMinutes)} minutes`;
    }

    // Rule 3: 3Thix APPROVED but not settling (covered by Rule 1 effectively because APPROVED->PROCESSING)

    if (triggerEscalation) {
        // Check if we already alerted (optional optimization, but good to prevent spam)
        // For now, we will just send it. The email function handles generic errors.
        // Ideally we'd log this alerting in a sheet too, but let's keep it simple for now.
        const { sendAdminEmail } = await import("./email.js");
        // We might need to fetch user details again if not passed, but we'll do our best.
        // Just call it with minimal info if needed, or rely on the main flow to have hydrating info.
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
export async function handlePaymentLogic(invoiceId, sourceLabel = '3THIX_API') {
    const sheets = await getSheetsClient();
    if (!sheets) {
        return {
            invoiceId,
            status: "PENDING",
            source: "ERROR",
            emailSent: false
        };
    }

    let finalStatus = 'PENDING';
    let transactionData = null;

    // 1. Authoritative Check
    // We ALWAYS check 3Thix to be authoritative, even if webhook data is present,
    // unless we trust the webhook signature 100%, but the requirement says "Backend decides final state".
    const apiResult = await check3ThixAuthoritative(invoiceId);

    if (apiResult) {
        const rawStatus = apiResult.status;
        finalStatus = normalize3ThixStatus(rawStatus);
        transactionData = apiResult.data;

        // Log Raw Response
        await appendToRawResponses(sheets, invoiceId, sourceLabel, rawStatus, transactionData);
    } else {
        // API call failed.
        // If ledgers already say SUCCESS, we respect that (Single Source of Truth - Persistence).
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (existing && existing.STATUS === 'SUCCESS') {
            finalStatus = 'SUCCESS';
        } else if (sourceLabel !== 'WEBHOOK') {
            // If manual check fails and not success in DB, we keep existing or PENDING
            finalStatus = existing ? existing.STATUS : 'PENDING';
        }
    }

    // 2. Prevent Regression (Never overwrite SUCCESS with PENDING/PROCESSING)
    if (finalStatus !== 'SUCCESS') {
        const existing = await findInPaymentTransactions(sheets, invoiceId);
        if (existing && existing.STATUS === 'SUCCESS') {
            console.log(`[LOGIC PROTECT] Keeping SUCCESS for ${invoiceId} despite current status ${finalStatus}`);
            finalStatus = 'SUCCESS';
        }
    }

    // 3. SUCCESS Handling (Ledger Writes)
    if (finalStatus === 'SUCCESS' && transactionData) {
        let metadata = {};
        try {
            const metaSource = transactionData.metadata || (transactionData.invoice && transactionData.invoice.metadata) || (transactionData.order && transactionData.order.metadata);
            metadata = typeof metaSource === 'string' ? JSON.parse(metaSource) : metaSource || {};
            // Fallback for metadata if it's deeply nested differently or missing
        } catch (e) { }

        const merchRef = transactionData.merchant_ref_id || (transactionData.invoice && transactionData.invoice.merchant_ref_id) || '';
        const amount = transactionData.amount || (transactionData.invoice && transactionData.invoice.amount) || '';
        const currency = transactionData.currency || (transactionData.invoice && transactionData.invoice.currency) || '';
        const fee = transactionData.fee || (transactionData.invoice && transactionData.invoice.fee) || '0';

        // A. Transactions (Idempotent)
        await appendToTransactions(sheets, [
            merchRef, "NILA TOKEN - Mindwave", amount, currency,
            'SUCCESS', "3THIX", invoiceId, fee,
            metadata.paymentBlocked ? 'BLOCKED' : '', '', '', new Date().toISOString()
        ]);

        // B. ActivityLog (Idempotent)
        await appendToActivityLog(sheets, [
            crypto.randomUUID(), invoiceId, merchRef, "PAYMENT_SUCCESS",
            amount, currency, "3THIX", '', '', '',
            JSON.stringify(metadata), new Date().toISOString()
        ]);

        // C. AdditionalInfo (Idempotent)
        const name = metadata.name || '';
        const email = metadata.email || '';
        if (name || email) {
            await appendToAdditionalInfo(sheets, [
                invoiceId, merchRef, name, email,
                'SUCCESS', amount, currency, new Date().toISOString()
            ]);
        }
    }

    // 4. View Layer Sync & Email
    let ptRow = await findInPaymentTransactions(sheets, invoiceId);
    let customerName = '', customerEmail = '';

    if (!ptRow) {
        // Create initial row
        await syncToPaymentTransactions(sheets, invoiceId, finalStatus, '', '');
        ptRow = await findInPaymentTransactions(sheets, invoiceId);
    }

    let isEmailSent = (ptRow && ptRow.EMAIL_SENT === 'YES');

    if (ptRow) {
        const updates = [];

        // Update STATUS if changed
        if (ptRow.STATUS !== finalStatus) {
            updates.push({ col: 'B', val: finalStatus });
            ptRow.STATUS = finalStatus;
        }

        // Attempt Hydration if missing info
        if (!ptRow.EMAIL || !ptRow.NAME) {
            let hydrated = null;
            // Try from transactionData first
            if (transactionData) {
                try {
                    const metaSource = transactionData.metadata || (transactionData.invoice && transactionData.invoice.metadata) || (transactionData.order && transactionData.order.metadata);
                    const md = typeof metaSource === 'string' ? JSON.parse(metaSource) : metaSource || {};
                    if (md.email) hydrated = { email: md.email, name: md.name };
                } catch (e) { }
            }
            // Try from ledgers if still null
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

        // 5. Send Email Rule: SUCCESS + EMAIL_SENT != YES
        if (finalStatus === 'SUCCESS' && ptRow.EMAIL_SENT !== 'YES') {
            if (customerEmail) {
                try {
                    // Send Email
                    const emailResult = await processSuccessfulPayment(invoiceId, customerEmail, customerName);
                    if (emailResult.success && emailResult.emailSent) {
                        // Update Sheet
                        await updatePaymentTransactionRow(sheets, ptRow.rowIndex, [
                            { col: 'E', val: 'YES' },
                            { col: 'F', val: new Date().toISOString() }
                        ]);
                        isEmailSent = true;
                    }
                } catch (emailErr) {
                    console.error(`[EMAIL FAIL LOGIC] ${invoiceId}`, emailErr);
                    // Do NOT mark as sent. Will retry next time.
                }
            } else {
                console.warn(`[EMAIL SKIP] No email address for ${invoiceId} yet.`);
            }
        } else if (ptRow.EMAIL_SENT === 'YES') {
            isEmailSent = true;
        }
    }

    // 6. Admin Escalation
    // We use a safe check wrapper
    // We need creation time. If we have ptRow, let's use EMAIL_SENT_AT or just assume created recently if we don't track creation time explicitly in this sheet.
    // wait, PAYMENT_TRANSACTIONS doesn't have created_at. Transactions sheet does.
    // Let's use a rough heuristic or try to fetch from transactionData if available, or just skip if we can't determine duration accurately?
    // The requirement says "Status = PROCESSING for > 10 minutes".
    // We can use the timestamp from 3Thix response (transactionData.timestamp or invoice.created_at).
    let createdTime = new Date().toISOString();
    if (transactionData) {
        createdTime = transactionData.timestamp || (transactionData.invoice && transactionData.invoice.created_at) || (transactionData.order && transactionData.order.created_at) || createdTime;
    }
    await checkAndEscalate(sheets, invoiceId, finalStatus, isEmailSent ? 'YES' : 'NO', createdTime);

    return {
        invoiceId,
        status: finalStatus,
        source: sourceLabel,
        emailSent: isEmailSent
    };
}
