import { getGoogleClient } from "./googleClient.js";

// Wrapper for compatibility and easy export
export function getSheetsClient() {
    return getGoogleClient();
}

// --- Headers Definitions ---
// SCHEMA (STRICT 14 COLUMNS):
// A: invoice_id
// B: status
// C: email
// D: name
// E: wallet_address
// F: wallet_network
// G: amount
// H: currency
// I: token_price
// J: tokens_purchased
// K: email_sent_user
// L: email_sent_admin
// M: created_at
// N: updated_at

const TRANSACTIONS_HEADERS = [
    "invoice_id", "status", "email", "name", "wallet_address", "wallet_network",
    "amount", "currency", "token_price", "tokens_purchased", "email_sent_user", "email_sent_admin",
    "created_at", "updated_at"
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
            range: "PAYMENT_TRANSACTIONS!A:N",
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
            range: "PAYMENT_TRANSACTIONS!A:N"
        });
        const rows = res.data.values || [];

        // Skip header
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === invoiceId) {
                // Map to object based on New 14 Core Schema
                const r = rows[i];
                return {
                    rowIndex: i + 1, // 1-based index
                    invoice_id: r[0],
                    status: r[1],
                    email: r[2],
                    name: r[3],
                    wallet_address: r[4],
                    wallet_network: r[5],
                    amount: r[6],
                    currency: r[7],
                    token_price: r[8],
                    tokens_purchased: r[9],
                    email_sent_user: r[10],
                    email_sent_admin: r[11],
                    created_at: r[12],
                    updated_at: r[13]
                };
            }
        }
    } catch (e) {
        console.warn(`[SHEETS] Find transaction failed: ${e.message}`);
    }
    return null;
}

/**
 * Atomic update for transaction status and metadata
 */
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
            "", "", "NO", "NO", createdAt, createdAt
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
    if (tx.status !== status) {
        requests.push({ range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] });
    }

    // STRICT SUCCESS HANDLING: Update ALL Data Columns
    if (status === 'SUCCESS') {
        const {
            email = tx.email, name = tx.name,
            walletAddress = tx.wallet_address, walletNetwork = tx.wallet_network,
            amount = tx.amount, currency = tx.currency,
            tokens = tx.tokens_purchased, tokenPrice = tx.token_price
        } = extraData;

        // Atomic Field Updates (Sparse)
        if (email && email !== tx.email) requests.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[email]] });
        if (name && name !== tx.name) requests.push({ range: `PAYMENT_TRANSACTIONS!D${rowIndex}`, values: [[name]] });
        if (walletAddress && walletAddress !== tx.wallet_address) requests.push({ range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[walletAddress]] });
        if (walletNetwork && walletNetwork !== tx.wallet_network) requests.push({ range: `PAYMENT_TRANSACTIONS!F${rowIndex}`, values: [[walletNetwork]] });
        if (amount && amount.toString() !== tx.amount) requests.push({ range: `PAYMENT_TRANSACTIONS!G${rowIndex}`, values: [[amount.toString()]] });
        if (currency && currency !== tx.currency) requests.push({ range: `PAYMENT_TRANSACTIONS!H${rowIndex}`, values: [[currency]] });

        if (tokenPrice && tokenPrice.toString() !== tx.token_price) requests.push({ range: `PAYMENT_TRANSACTIONS!I${rowIndex}`, values: [[tokenPrice.toString()]] });
        if (tokens && tokens.toString() !== tx.tokens_purchased) requests.push({ range: `PAYMENT_TRANSACTIONS!J${rowIndex}`, values: [[tokens.toString()]] });

    } else {
        // Partial Update for Hydration
        if (extraData.email) requests.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[extraData.email]] });
        if (extraData.walletAddress) requests.push({ range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[extraData.walletAddress]] });
    }

    // UPDATED_AT (Col N)
    requests.push({ range: `PAYMENT_TRANSACTIONS!N${rowIndex}`, values: [[now]] });

    if (requests.length > 0) {
        try {
            await client.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetId,
                requestBody: { valueInputOption: "RAW", data: requests }
            });
            console.log(`[SHEETS] Updated ${requests.length} fields for ${invoiceId} (Row ${rowIndex})`);
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

    let range;
    if (type === 'USER') { // EMAIL_SENT (K)
        range = `PAYMENT_TRANSACTIONS!K${tx.rowIndex}`;
    } else { // ADMIN_EMAIL_SENT (L)
        range = `PAYMENT_TRANSACTIONS!L${tx.rowIndex}`;
    }

    try {
        await client.spreadsheets.values.update({
            spreadsheetId: sheetId,
            range,
            valueInputOption: "RAW",
            requestBody: { values: [["YES"]] }
        });
    } catch (e) {
        console.error(`[SHEETS] Failed to mark email sent: ${e.message}`);
    }
}
