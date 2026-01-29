import { google } from "googleapis";

let sheets = null;

// --- Headers Definitions ---
// SCHEMA:
// A: INVOICE_ID (0)
// B: STATUS (1)
// C: EMAIL (2)
// D: NAME (3)
// E: WALLET_ADDRESS (4)
// F: WALLET_NETWORK (5)
// G: AMOUNT (6)
// H: CURRENCY (7)
// I: CREATED_AT (8)
// J: EMAIL_SENT (9)
// K: ADMIN_EMAIL_SENT (10)
// L: TOKEN_PRICE (11)
// M: TOKENS_PURCHASED (12)
// N: EMAIL_SENT_AT (13)
// O: UPDATED_AT (14)

const TRANSACTIONS_HEADERS = [
    "INVOICE_ID", "STATUS", "EMAIL", "NAME", "WALLET_ADDRESS", "WALLET_NETWORK",
    "AMOUNT", "CURRENCY", "CREATED_AT", "EMAIL_SENT", "ADMIN_EMAIL_SENT",
    "TOKEN_PRICE", "TOKENS_PURCHASED", "EMAIL_SENT_AT", "UPDATED_AT"
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

    // Idempotency Check: Check if Invoice ID (Index 0) exists in Col A
    try {
        const res = await client.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "PAYMENT_TRANSACTIONS!A:A"
        });
        const existingIds = res.data.values?.flat() || [];
        if (existingIds.includes(row[0])) {
            console.log(`[SHEETS] Invoice ${row[0]} already exists in PAYMENT_TRANSACTIONS. Skipping append.`);
            return;
        }

        // Ensure row respects schema length
        await client.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "PAYMENT_TRANSACTIONS!A:O",
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
            range: "PAYMENT_TRANSACTIONS!A:O"
        });
        const rows = res.data.values || [];

        // Skip header
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === invoiceId) {
                // Map to object based on New Schema
                const r = rows[i];
                return {
                    rowIndex: i + 1, // 1-based index
                    INVOICE_ID: r[0],
                    STATUS: r[1],
                    EMAIL: r[2],
                    NAME: r[3],
                    WALLET_ADDRESS: r[4],
                    WALLET_NETWORK: r[5],
                    AMOUNT: r[6],
                    CURRENCY: r[7],
                    CREATED_AT: r[8],
                    EMAIL_SENT: r[9],
                    ADMIN_EMAIL_SENT: r[10],
                    TOKEN_PRICE: r[11],
                    TOKENS_PURCHASED: r[12],
                    EMAIL_SENT_AT: r[13],
                    UPDATED_AT: r[14]
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
        // Fallback: If not found, we append a new row (Create Logic)
        // This handles the "Update existing row only" requirement by checking first.
        // If it doesn't exist, we create it (Safe fallback).
        const createdAt = new Date().toISOString();
        const row = [
            invoiceId,                      // 0: ID
            status,                         // 1: STATUS
            extraData.email || "",          // 2: EMAIL
            extraData.name || "",           // 3: NAME
            extraData.walletAddress || "",  // 4: WALLET
            extraData.walletNetwork || "",  // 5: NETWORK
            extraData.amount || "",         // 6: AMOUNT
            extraData.currency || "",       // 7: CURRENCY
            createdAt,                      // 8: CREATED_AT
            "NO",                           // 9: EMAIL_SENT (Default NO)
            "NO",                           // 10: ADMIN_EMAIL_SENT (Default NO)
            extraData.tokenPrice || "",     // 11: TOKEN_PRICE
            extraData.tokens || "",         // 12: TOKENS_PURCHASED
            "",                             // 13: EMAIL_SENT_AT
            createdAt                       // 14: UPDATED_AT
        ];

        console.log(`[SHEETS] Invoice ${invoiceId} not found. Creating new row.`);
        await appendToTransactions(row);
        return;
    }

    // Prepare batch update
    const requests = [];
    const rowIndex = tx.rowIndex;
    const now = new Date().toISOString();

    // Mapping of updates

    // Status (Col B / Index 1)
    if (tx.STATUS !== status) {
        requests.push({ range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] });
    }

    // Hydrate Data if missing OR update if provided (Upsert logic for important fields)
    if (extraData.email) requests.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[extraData.email]] });
    if (extraData.name) requests.push({ range: `PAYMENT_TRANSACTIONS!D${rowIndex}`, values: [[extraData.name]] });
    if (extraData.walletAddress) requests.push({ range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[extraData.walletAddress]] });
    if (extraData.walletNetwork) requests.push({ range: `PAYMENT_TRANSACTIONS!F${rowIndex}`, values: [[extraData.walletNetwork]] });
    if (extraData.amount) requests.push({ range: `PAYMENT_TRANSACTIONS!G${rowIndex}`, values: [[extraData.amount]] });
    if (extraData.currency) requests.push({ range: `PAYMENT_TRANSACTIONS!H${rowIndex}`, values: [[extraData.currency]] });

    // Required by User: UPDATED_AT (Col O / Index 14)
    requests.push({ range: `PAYMENT_TRANSACTIONS!O${rowIndex}`, values: [[now]] });

    // Required by User: Reset EMAIL_SENT to NO? 
    // "Update... EMAIL_SENT = 'NO'".
    // Only if status is changing to SUCCESS? Or always on webhook success?
    // Let's assume on SUCCESS status update we explicitly set it NO to ensure we trigger email sending.
    if (status === 'SUCCESS') {
        requests.push({ range: `PAYMENT_TRANSACTIONS!J${rowIndex}`, values: [["NO"]] });
        requests.push({ range: `PAYMENT_TRANSACTIONS!K${rowIndex}`, values: [["NO"]] });
    }

    // Token Data (Col L, M)
    if (extraData.tokenPrice) requests.push({ range: `PAYMENT_TRANSACTIONS!L${rowIndex}`, values: [[extraData.tokenPrice]] });
    if (extraData.tokens) requests.push({ range: `PAYMENT_TRANSACTIONS!M${rowIndex}`, values: [[extraData.tokens]] });

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

    const now = new Date().toISOString();
    let range, values;

    if (type === 'USER') {
        // EMAIL_SENT (J), EMAIL_SENT_AT (N)
        // Can't batch easily with single range if not adjacent, but J and N are separate.
        // We will do two updates or use batch.
        // Let's use batch for safety.
        try {
            await client.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetId,
                requestBody: {
                    valueInputOption: "RAW",
                    data: [
                        { range: `PAYMENT_TRANSACTIONS!J${tx.rowIndex}`, values: [["YES"]] },
                        { range: `PAYMENT_TRANSACTIONS!N${tx.rowIndex}`, values: [[now]] }
                    ]
                }
            });
        } catch (e) { console.error(e); }
        return;
    } else {
        // ADMIN_EMAIL_SENT (K)
        range = `PAYMENT_TRANSACTIONS!K${tx.rowIndex}`;
        values = [["YES"]];
    }

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
