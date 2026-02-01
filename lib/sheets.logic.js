import { getGoogleClient } from "./googleClient.js";

// Wrapper for compatibility and easy export
export function getSheetsClient() {
    return getGoogleClient();
}

// 99% SCHEMA PROTECTION
// 99% SCHEMA PROTECTION
export const SHEET_SCHEMA = {
    INVOICE_ID: 0,
    STATUS: 1,
    EMAIL: 2,
    NAME: 3,
    WALLET: 4,
    WALLET_NETWORK: 5,
    AMOUNT: 6,
    CURRENCY: 7,
    TOKEN_PRICE: 8,
    TOKENS: 9,
    EMAIL_SENT_USER: 10,
    EMAIL_SENT_ADMIN: 11,
    CREATED_AT: 12,
    UPDATED_AT: 13
};

const TRANSACTIONS_HEADERS = [
    "invoice_id", "status", "email", "name", "wallet_address", "wallet_network",
    "amount", "currency", "token_price", "tokens_purchased", "email_sent_user", "email_sent_admin",
    "created_at", "updated_at"
];

// ... (Other headers remain unchanged) ...

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

// Card transaction metadata (PCI SAFE - last 4 only, never full card)
const CARD_TRANSACTIONS_HEADERS = [
    "invoice_id", "transaction_id", "card_last4", "card_exp", "card_type",
    "amount", "currency", "billing_name", "billing_email", "billing_country",
    "status", "created_at"
];

async function ensureHeaders(sheetName, headers) {
    const client = getSheetsClient();
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
    const client = getSheetsClient();
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
        if (existingIds.includes(row[SHEET_SCHEMA.INVOICE_ID])) {
            console.log(`[SHEETS] Invoice ${row[SHEET_SCHEMA.INVOICE_ID]} already exists in PAYMENT_TRANSACTIONS. Skipping append.`);
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
    const client = getSheetsClient();
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
    const client = getSheetsClient();
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
    const client = getSheetsClient();
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
    const client = getSheetsClient();
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
            if (rows[i][SHEET_SCHEMA.INVOICE_ID] === invoiceId) {
                // Map to object based on New 14 Core Schema using SHEET_SCHEMA map
                const r = rows[i];
                return {
                    rowIndex: i + 1, // 1-based index
                    invoice_id: r[SHEET_SCHEMA.INVOICE_ID],
                    status: r[SHEET_SCHEMA.STATUS],
                    email: r[SHEET_SCHEMA.EMAIL],
                    name: r[SHEET_SCHEMA.NAME],
                    wallet_address: r[SHEET_SCHEMA.WALLET],
                    wallet_network: r[SHEET_SCHEMA.WALLET_NETWORK],
                    amount: r[SHEET_SCHEMA.AMOUNT],
                    currency: r[SHEET_SCHEMA.CURRENCY],
                    token_price: r[SHEET_SCHEMA.TOKEN_PRICE],
                    tokens_purchased: r[SHEET_SCHEMA.TOKENS],
                    email_sent_user: r[SHEET_SCHEMA.EMAIL_SENT_USER],
                    email_sent_admin: r[SHEET_SCHEMA.EMAIL_SENT_ADMIN],
                    created_at: r[SHEET_SCHEMA.CREATED_AT],
                    updated_at: r[SHEET_SCHEMA.UPDATED_AT]
                };
            }
        }
    } catch (e) {
        console.warn(`[SHEETS] Find transaction failed: ${e.message}`);
    }
    return null;
}

/**
 * Finds a transaction by 3thix Transaction ID
 * Looks up CARD_TRANSACTIONS to find the invoice_id, then gets full transaction record
 * Returns { rowIndex, data: object, transactionId }
 */
export async function findTransactionByTransactionId(transactionId) {
    const client = getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return null;

    try {
        // First, find invoice_id from CARD_TRANSACTIONS by transaction_id
        const res = await client.spreadsheets.values.get({
            spreadsheetId: sheetId,
            range: "CARD_TRANSACTIONS!A:L"
        });
        const rows = res.data.values || [];

        // CARD_TRANSACTIONS schema: invoice_id, transaction_id, ...
        // transaction_id is at index 1
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][1] === transactionId) {
                const invoiceId = rows[i][0];
                if (invoiceId) {
                    // Found the transaction_id, now get full transaction from PAYMENT_TRANSACTIONS
                    const fullTx = await findTransaction(invoiceId);
                    if (fullTx) {
                        return {
                            ...fullTx,
                            transactionId: transactionId
                        };
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`[SHEETS] Find transaction by transactionId failed: ${e.message}`);
    }
    return null;
}

/**
 * Atomic update for transaction status and metadata
 */
export async function updateTransactionStatus(invoiceId, status, extraData = {}) {
    if (!invoiceId) throw new Error("Missing invoiceId");

    const client = getSheetsClient();
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
    // STRICT SUCCESS HANDLING: Update ALL Data Columns ATOMICALLY
    if (status === 'SUCCESS') {
        const {
            email = tx.email, name = tx.name,
            walletAddress = tx.wallet_address, walletNetwork = tx.wallet_network,
            amount = tx.amount, currency = tx.currency,
            tokens = tx.tokens_purchased, tokenPrice = tx.token_price
        } = extraData;

        // Map to Schema indices. B=1, etc.
        // But batchUpdate uses A1 notation ranges.
        // Better to overwrite the whole row? No, might clobber unnamed columns?
        // Schema is fixed 0-13.
        // A=0, B=1, ... N=13

        // Construct the row values for the authorized columns (B to N)
        // B: STATUS
        // C: EMAIL
        // D: NAME
        // E: WALLET
        // F: NETWORK
        // G: AMOUNT
        // H: CURRENCY
        // I: TOKEN_PRICE
        // J: TOKENS
        // K: EMAIL_SENT_USER (preserve or update if passed) - usually NOT passed here, handled by markEmailSent
        // L: EMAIL_SENT_ADMIN 
        // But user said: "Single atomic batchUpdate ... valueInputOption: RAW ... data: [ {range: ..., values: ...} ]"
        // And "Never partial updates" for success.

        const updates = [
            { range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] },
            { range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[email]] },
            { range: `PAYMENT_TRANSACTIONS!D${rowIndex}`, values: [[name]] },
            { range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[walletAddress]] },
            { range: `PAYMENT_TRANSACTIONS!F${rowIndex}`, values: [[walletNetwork]] },
            { range: `PAYMENT_TRANSACTIONS!G${rowIndex}`, values: [[amount.toString()]] },
            { range: `PAYMENT_TRANSACTIONS!H${rowIndex}`, values: [[currency]] },
            { range: `PAYMENT_TRANSACTIONS!I${rowIndex}`, values: [[tokenPrice.toString()]] },
            { range: `PAYMENT_TRANSACTIONS!J${rowIndex}`, values: [[tokens.toString()]] },
            { range: `PAYMENT_TRANSACTIONS!N${rowIndex}`, values: [[now]] }
        ];

        try {
            await client.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetId,
                requestBody: { valueInputOption: "RAW", data: updates }
            });
            console.log(`[SHEETS] Atomically updated ${invoiceId} to SUCCESS`);
        } catch (e) {
            console.error(`[SHEETS] Failed atomic update: ${e.message}`);
        }

    } else {
        // Non-Success Status Update (e.g. AWAITING_FULFILLMENT)
        requests.push({ range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] });
        requests.push({ range: `PAYMENT_TRANSACTIONS!N${rowIndex}`, values: [[now]] });

        try {
            await client.spreadsheets.values.batchUpdate({
                spreadsheetId: sheetId,
                requestBody: { valueInputOption: "RAW", data: requests }
            });
        } catch (e) {
            console.error(`[SHEETS] Failed status update: ${e.message}`);
        }
    }
}

export async function markEmailSent(invoiceId, type = 'USER') {
    const client = getSheetsClient();
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

/**
 * Appends card transaction metadata to CARD_TRANSACTIONS sheet
 * PCI SAFE: Only stores last 4 digits, never full card number
 * 
 * @param {object} data - Card transaction data
 * @param {string} data.invoiceId - Our internal invoice ID
 * @param {string} data.transactionId - 3thix transaction ID
 * @param {string} data.cardLast4 - Last 4 digits of card
 * @param {string} data.cardExp - Expiry date (MM/YY)
 * @param {string} data.cardType - Card type (Visa, Mastercard, Amex, etc)
 * @param {number} data.amount - Transaction amount
 * @param {string} data.currency - Currency code
 * @param {string} data.billingName - Billing name
 * @param {string} data.billingEmail - Billing email
 * @param {string} data.billingCountry - Billing country
 * @param {string} data.status - Transaction status (SUCCESS, FAILED)
 */
export async function appendToCardTransactions(data) {
    const client = getSheetsClient();
    const sheetId = process.env.GOOGLE_SHEET_ID;
    if (!client || !sheetId) return;

    await ensureHeaders("CARD_TRANSACTIONS", CARD_TRANSACTIONS_HEADERS);

    const row = [
        data.invoiceId || "",
        data.transactionId || "",
        data.cardLast4 || "",
        data.cardExp || "",
        data.cardType || "",
        data.amount?.toString() || "",
        data.currency || "USD",
        data.billingName || "",
        data.billingEmail || "",
        data.billingCountry || "",
        data.status || "",
        new Date().toISOString()
    ];

    try {
        await client.spreadsheets.values.append({
            spreadsheetId: sheetId,
            range: "CARD_TRANSACTIONS!A:L",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
        console.log(`[SHEETS] Card transaction logged for ${data.invoiceId}`);
    } catch (e) {
        console.error(`[SHEETS] Failed to append to CARD_TRANSACTIONS: ${e.message}`);
    }
}
