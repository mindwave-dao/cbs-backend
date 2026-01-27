
import { google } from "googleapis";

let sheets = null;

// --- Headers Definitions (DO NOT CHANGE ORDER) ---
const TRANSACTIONS_HEADERS = [
    "INVOICE_ID", "STATUS", "EMAIL", "NAME", "EMAIL_SENT", "EMAIL_SENT_AT",
    "TOKEN_PRICE", "TOKENS_PURCHASED", "ADMIN_EMAIL_SENT"
];

const ADDITIONAL_INFO_HEADERS = [
    "merchant_ref_id", "invoice_id", "name", "email", "timestamp", "wallet_address"
];

const ACTIVITY_LOG_HEADERS = [
    "activity_id", "invoice_id", "merchant_ref_id", "event_type",
    "amount", "currency", "gateway", "country", "user_agent", "ip",
    "metadata", "timestamp"
];

const RAW_RESPONSES_HEADERS = [
    "invoice_id", "source", "status", "raw_response", "timestamp"
];


export async function getSheetsClient() {
    if (sheets) return sheets;

    const creds = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!creds) return null;

    try {
        const credentials = JSON.parse(creds);
        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ["https://www.googleapis.com/auth/spreadsheets"]
        });
        sheets = google.sheets({ version: "v4", auth });
        return sheets;
    } catch (err) {
        console.error("Failed to initialize Google Sheets:", err);
        return null;
    }
}

async function ensureHeaders(sheetName, headers) {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    try {
        const range = `${sheetName}!A1:Z1`;
        const res = await client.spreadsheets.values.get({ spreadsheetId: sheetId, range });
        const existing = res.data.values?.[0];

        if (!existing || existing.length < headers.length) {
            console.log(`[SHEETS] Updating headers for ${sheetName}`);
            await client.spreadsheets.values.update({
                spreadsheetId: sheetId,
                range: `${sheetName}!A1`,
                valueInputOption: "RAW",
                requestBody: { values: [headers] }
            });
        }
    } catch (e) {
        console.warn(`[SHEETS] Header check failed for ${sheetName}: ${e.message}`);
    }
}

// --- Public Methods ---

export async function appendToTransactions(row) {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    await ensureHeaders("PAYMENT_TRANSACTIONS", TRANSACTIONS_HEADERS);

    // Idempotency Check: Check if Invoice ID (Index 0) exists
    // We read column A
    try {
        const res = await client.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "PAYMENT_TRANSACTIONS!A:A"
        });
        const existingIds = res.data.values?.flat() || [];
        if (existingIds.includes(row[0])) {
            console.log(`[SHEETS] Invoice ${row[0]} already exists in PAYMENT_TRANSACTIONS. Skipping append.`);
            // Note: If we need to UPDATE, that's different. But create-payment-invoice just appends.
            // If it's a new status update to an existing row, we should use updatePayment status.
            return;
        }

        await client.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "PAYMENT_TRANSACTIONS!A:J",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
    } catch (e) {
        console.error(`[SHEETS] Failed to append to Transactions: ${e.message}`);
    }
}

export async function appendToActivityLog(row) {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    await ensureHeaders("TransactionActivityLog", ACTIVITY_LOG_HEADERS);

    try {
        await client.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "TransactionActivityLog!A:L",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
    } catch (e) {
        console.error(`[SHEETS] Failed to append to ActivityLog: ${e.message}`);
    }
}

export async function appendToAdditionalInfo(row) {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    await ensureHeaders("PaymentAdditionalInfo", ADDITIONAL_INFO_HEADERS);

    try {
        await client.spreadsheets.values.append({
            spreadsheetId: sheetId,
            // Updated range to include F for wallet address
            range: "PaymentAdditionalInfo!A:F",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
    } catch (e) {
        console.error(`[SHEETS] Failed to append to AdditionalInfo: ${e.message}`);
    }
}

export async function appendToRawResponses(row) {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    await ensureHeaders("Raw3thixResponses", RAW_RESPONSES_HEADERS);

    try {
        await client.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "Raw3thixResponses!A:E",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
    } catch (e) {
        console.error(`[SHEETS] Failed to append to RawResponses: ${e.message}`);
    }
}

/**
 * Finds a transaction row by Invoice ID
 * Returns { rowIndex, data: object }
 */
export async function findTransaction(invoiceId) {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return null;

    try {
        const res = await client.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "PAYMENT_TRANSACTIONS!A:J"
        });
        const rows = res.data.values || [];

        // Skip header
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === invoiceId) {
                // Map to object
                const r = rows[i];
                return {
                    rowIndex: i + 1, // 1-based index
                    INVOICE_ID: r[0],
                    STATUS: r[1],
                    EMAIL: r[2],
                    NAME: r[3],
                    EMAIL_SENT: r[4],
                    EMAIL_SENT_AT: r[5],
                    TOKEN_PRICE: r[6],
                    TOKENS_PURCHASED: r[7],
                    ADMIN_EMAIL_SENT: r[8]
                    // REMOVED WALLET_ADDRESS from mapping
                };
            }
        }
    } catch (e) {
        console.warn(`[SHEETS] Find transaction failed: ${e.message}`);
    }
    return null;
}

export async function updateTransactionStatus(invoiceId, status, extraData = {}) {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    const tx = await findTransaction(invoiceId);
    if (!tx) {
        // If not found, we might want to CREATE it (Hydration)
        // But for updateStatus, usually we expect it.
        // If missing, we can append (Lazy creation)
        console.log(`[SHEETS] Transaction ${invoiceId} not found for update, appending...`);
        // We need specific columns.
        await appendToTransactions([
            invoiceId,
            status,
            extraData.email || "",
            extraData.name || "",
            "NO",
            "",
            extraData.tokenPrice || "",
            extraData.tokens || "",
            "NO"
            // REMOVED WALLET_ADDRESS from created row
        ]);
        return;
    }

    // Prepare batch update
    const requests = [];
    const rowIndex = tx.rowIndex;

    // Status (Col B)
    if (tx.STATUS !== status) {
        requests.push({ range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] });
    }

    // Email/Name Hydration
    if (!tx.EMAIL && extraData.email) requests.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[extraData.email]] });
    if (!tx.NAME && extraData.name) requests.push({ range: `PAYMENT_TRANSACTIONS!D${rowIndex}`, values: [[extraData.name]] });

    // REMOVED WALLET ADDRESS update logic

    // Token Data (Col G, H)
    if (!tx.TOKEN_PRICE && extraData.tokenPrice) requests.push({ range: `PAYMENT_TRANSACTIONS!G${rowIndex}`, values: [[extraData.tokenPrice]] });
    if (!tx.TOKENS_PURCHASED && extraData.tokens) requests.push({ range: `PAYMENT_TRANSACTIONS!H${rowIndex}`, values: [[extraData.tokens]] });

    if (requests.length > 0) {
        try {
            await client.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetId,
                requestBody: {
                    valueInputOption: "RAW",
                    data: requests
                }
            });
        } catch (e) {
            console.error(`[SHEETS] Failed to batch update transaction: ${e.message}`);
        }
    }
}

export async function markEmailSent(invoiceId, type = 'USER') {
    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    const tx = await findTransaction(invoiceId);
    if (!tx) return;

    const range = type === 'USER'
        ? `PAYMENT_TRANSACTIONS!E${tx.rowIndex}:F${tx.rowIndex}`
        : `PAYMENT_TRANSACTIONS!I${tx.rowIndex}`;

    const values = type === 'USER'
        ? [["YES", new Date().toISOString()]]
        : [["YES"]];

    try {
        await client.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range,
            valueInputOption: "RAW",
            requestBody: { values }
        });
    } catch (e) {
        console.error(`[SHEETS] Failed to mark email sent: ${e.message}`);
    }
}
