import { getSheetsClient } from "../../lib/payment-logic.js";

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------- Logic Helper (Testable) ---------- */
export async function lookupInvoiceStatus(sheets, invoiceId) {
    const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const SHEET_NAME = "PAYMENT_TRANSACTIONS";

    // Read headers and all data
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${SHEET_NAME}!A:Z`
    });

    const rows = response.data.values || [];
    if (rows.length === 0) {
        return null; // indicates 404/Empty
    }

    // Dynamic Column Mapping
    const headers = rows[0].map(h => h.trim().toUpperCase());

    // Helper to get value
    const getValue = (row, headerName) => {
        const index = headers.indexOf(headerName);
        if (index === -1) return null;
        return row[index];
    };

    // Find Row
    const invoiceIdIndex = headers.indexOf("INVOICE_ID");
    const targetRow = rows.find(r => {
        // Check finding by header or default to first column (codebase convention)
        const val = invoiceIdIndex !== -1 ? r[invoiceIdIndex] : r[0];
        return val === invoiceId;
    });

    if (!targetRow) {
        return null;
    }

    // Extract Data
    const rawStatus = getValue(targetRow, "STATUS") || "PENDING";
    const amountUsd = parseFloat(getValue(targetRow, "AMOUNT_USD") || getValue(targetRow, "AMOUNT") || "0");
    const nilaTokens = parseFloat(getValue(targetRow, "NILA_TOKENS") || getValue(targetRow, "TOKENS_PURCHASED") || "0");
    const pricePerNila = parseFloat(getValue(targetRow, "PRICE_PER_NILA") || getValue(targetRow, "TOKEN_PRICE") || "0");
    const walletAddress = getValue(targetRow, "WALLET_ADDRESS") || "";
    const email = getValue(targetRow, "EMAIL") || "";
    const emailSentRaw = getValue(targetRow, "EMAIL_SENT") || "";
    const createdAt = getValue(targetRow, "CREATED_AT") || getValue(targetRow, "TIMESTAMP") || "";

    // Normalize Status
    let status = rawStatus.toUpperCase();
    if (status === "SUCCESS") status = "PAID"; // Normalize SUCCESS -> PAID
    // PENDING, PROCESSING remain as is.

    return {
        invoiceId,
        status,
        amountUsd,
        nilaTokens,
        pricePerNila,
        walletAddress,
        email,
        emailSent: emailSentRaw === "YES" || emailSentRaw === "true",
        createdAt
    };
}

export default async function handler(req, res) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

    const { invoiceId } = req.query;
    if (!invoiceId) return res.status(400).json({ error: "Missing invoiceId" });

    try {
        const sheets = await getSheetsClient();
        if (!sheets) {
            // In production, this means config error.
            throw new Error("Google Sheets client initialization failed");
        }

        const data = await lookupInvoiceStatus(sheets, invoiceId);

        if (!data) {
            return res.json({ status: "NOT_FOUND" });
        }

        return res.json(data);

    } catch (err) {
        console.error("[Invoice Status Error]", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
