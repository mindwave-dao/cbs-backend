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
    if (!invoiceId) throw new Error("Missing invoiceId");

    const client = await getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    // 1. Find the transaction
    const tx = await findTransaction(invoiceId);
    if (!tx) {
        // Fallback: If not found, create new row
        const createdAt = new Date().toISOString();
        const row = [
            invoiceId, status, extraData.email || "", extraData.name || "",
            extraData.walletAddress || "", extraData.walletNetwork || "",
            extraData.amount || "", extraData.currency || "",
            createdAt, "NO", "NO", "", "", "", createdAt
        ];
        console.log(`[SHEETS] Invoice ${invoiceId} not found. Creating new row.`);
        await appendToTransactions(row);
        return;
    }

    const { rowIndex } = tx;
    const requests = [];
    const now = new Date().toISOString();

    // 2. Prepare Updates
    // STATUS (Col B)
    if (tx.STATUS !== status) {
        requests.push({ range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] });
    }

    // STRICT SUCCESS HANDLING: Update ALL Data Columns
    if (status === 'SUCCESS') {
        const {
            email = tx.EMAIL, name = tx.NAME,
            walletAddress = tx.WALLET_ADDRESS, walletNetwork = tx.WALLET_NETWORK,
            amount = tx.AMOUNT, currency = tx.CURRENCY,
            tokens = tx.TOKENS_PURCHASED, tokenPrice = tx.TOKEN_PRICE
        } = extraData;

        // Data Update
        requests.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[email]] });
        requests.push({ range: `PAYMENT_TRANSACTIONS!D${rowIndex}`, values: [[name]] });
        requests.push({ range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[walletAddress]] });
        requests.push({ range: `PAYMENT_TRANSACTIONS!F${rowIndex}`, values: [[walletNetwork]] });
        requests.push({ range: `PAYMENT_TRANSACTIONS!G${rowIndex}`, values: [[amount.toString()]] });
        requests.push({ range: `PAYMENT_TRANSACTIONS!H${rowIndex}`, values: [[currency]] });

        if (tokenPrice) requests.push({ range: `PAYMENT_TRANSACTIONS!L${rowIndex}`, values: [[tokenPrice.toString()]] });
        if (tokens) requests.push({ range: `PAYMENT_TRANSACTIONS!M${rowIndex}`, values: [[tokens.toString()]] });

        // Reset Email Flags (User Requirement: Set flags AFTER success, so here we reset/init if needed or assume separate call)
        // finalize-payment.js calls markEmailSent explicitly.
    } else {
        // Partial Update for Hydration
        if (extraData.email) requests.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[extraData.email]] });
        if (extraData.walletAddress) requests.push({ range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[extraData.walletAddress]] });
    }

    // UPDATED_AT (Col O)
    requests.push({ range: `PAYMENT_TRANSACTIONS!O${rowIndex}`, values: [[now]] });

    if (requests.length > 0) {
        try {
            await client.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetId,
                requestBody: { valueInputOption: "RAW", data: requests }
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
