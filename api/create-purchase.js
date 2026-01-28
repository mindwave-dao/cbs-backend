import { google } from "googleapis";
import crypto from "crypto";

import { validateWalletAddress, detectWalletNetwork } from "../lib/payment-logic.js";
// import { isGeoRestricted } from "../lib/geo.js"; // Geo restriction might not be needed for purchase-only, but keeping consistency if desired

const {
    THIX_API_KEY,
    THIX_API_URL,
    VERCEL_URL,
    GOOGLE_SHEET_ID,
    GOOGLE_SHEETS_CREDENTIALS
} = process.env;

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------- Google Sheets Setup (lazy init) ---------- */
let sheets = null;

function getGoogleSheets() {
    if (sheets) return sheets;

    if (!GOOGLE_SHEETS_CREDENTIALS) {
        console.warn("GOOGLE_SHEETS_CREDENTIALS not set, skipping sheets integration");
        return null;
    }

    try {
        const credentials = JSON.parse(GOOGLE_SHEETS_CREDENTIALS);
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

/* ---------- Activity Log Headers ---------- */
const ACTIVITY_LOG_HEADERS = [
    "Activity ID",
    "Invoice ID",
    "Merchant Ref ID",
    "Event Type",
    "Amount",
    "Currency",
    "Gateway",
    "Country",
    "User Agent",
    "IP",
    "Metadata",
    "Timestamp"
];

let activityHeadersInitialized = false;

async function ensureActivityLogHeaders(sheetsClient) {
    try {
        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "TransactionActivityLog!A1:L1"
        });

        const existingHeaders = response.data.values?.[0];

        if (!existingHeaders || !existingHeaders[0]) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: GOOGLE_SHEET_ID,
                range: "TransactionActivityLog!A1:L1",
                valueInputOption: "RAW",
                requestBody: { values: [ACTIVITY_LOG_HEADERS] }
            });
            console.log("Added headers to TransactionActivityLog sheet");
        }
    } catch (err) {
        console.warn("ActivityLog header check failed, attempting to add:", err.message);
        try {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: GOOGLE_SHEET_ID,
                range: "TransactionActivityLog!A1:L1",
                valueInputOption: "RAW",
                requestBody: { values: [ACTIVITY_LOG_HEADERS] }
            });
        } catch (updateErr) {
            console.error("Failed to add ActivityLog headers:", updateErr.message);
        }
    }
}

/**
 * Append a row to TransactionActivityLog sheet
 */
async function appendToActivityLog(row) {
    const sheetsClient = getGoogleSheets();
    if (!sheetsClient || !GOOGLE_SHEET_ID) {
        console.warn("Google Sheets not configured, skipping activity log");
        return;
    }

    try {
        if (!activityHeadersInitialized) {
            await ensureActivityLogHeaders(sheetsClient);
            activityHeadersInitialized = true;
        }

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "TransactionActivityLog!A:L",
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [row] }
        });
        console.log("Activity log entry added successfully");
    } catch (err) {
        console.error("Activity log append error:", err);
    }
}

/* ---------- API Handler ---------- */
export default async function handler(req, res) {
    // Set CORS headers for all requests
    setCorsHeaders(res);

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // Validate required environment variables
    if (!THIX_API_KEY || !THIX_API_URL) {
        console.error("Missing THIX_API_KEY or THIX_API_URL environment variables");
        return res.status(500).json({ error: "Payment service not configured" });
    }

    const country = req.headers["x-vercel-ip-country"] || "";
    const userAgent = req.headers["user-agent"] || "";
    const ipAddress = req.headers["x-forwarded-for"]?.split(',')[0]?.trim() ||
        req.headers["x-real-ip"] || "";

    // Extract body parameters
    const { amount, currency, description, quantity = 1, name, email, wallet_address, ...extraParams } = req.body;

    if (!amount || typeof amount !== "number" || amount <= 0) {
        return res.status(400).json({ error: "Invalid amount" });
    }

    if (!currency || !description) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    const merchant_ref_id = `mw-purchase-${Date.now()}`;

    // Build callback URL 
    const baseUrl = VERCEL_URL
        ? `https://${VERCEL_URL}`
        : 'http://localhost:3000';
    const callback_url = `${baseUrl}/api/payment-callback`;

    // Validate wallet format if provided
    if (wallet_address && !validateWalletAddress(wallet_address)) {
        return res.status(400).json({
            success: false,
            error: "Invalid wallet address format"
        });
    }

    const walletNetwork = detectWalletNetwork(wallet_address);

    // Store user info in metadata
    const userMetadata = {
        name: name || "",
        email: email || "",
        wallet_address: wallet_address || "",
        walletNetwork: walletNetwork || "", // New field
        type: "purchase",
        ...extraParams // Pass through other params if needed
    };

    // Construct payload for 3thix Purchase Creation
    // Note: inferred structure based on payment/create. 
    const payload = {
        rail: "CREDIT_CARD", // Assuming credit card for purchase as well, or maybe generic
        currency,
        amount: amount.toString(),
        merchant_ref_id,
        callback_url,
        return_url: `${baseUrl}/payment-success.html`, // Redirect to success page directly
        metadata: JSON.stringify(userMetadata),
        cart: [
            {
                product_name: description,
                qty_unit: quantity,
                price_unit: (amount / quantity).toString()
            }
        ]
    };

    let invoiceId = null;

    try {
        const response = await fetch(`${THIX_API_URL}/order/purchase/create`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": THIX_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        // Log the raw response for debugging integration
        console.log("3Thix Purchase Response:", JSON.stringify(data));

        invoiceId = data.invoice_id || data.invoice?.id || data.id;

        if (!response.ok) {
            console.error("3Thix API Error:", data);
            throw new Error(data.message || data.error || "Failed to create purchase order");
        }

        if (!invoiceId) {
            console.warn("Invoice ID missing from 3Thix response, check response format.");
            // throw new Error("Invoice ID missing from 3Thix response"); // Softening this requirement slightly if data.id exists
        }
    } catch (err) {
        console.error("3Thix error:", err);
        return res.status(500).json({ error: "Failed to create purchase order", details: err.message });
    }

    // Log PURCHASE_CREATED event
    await appendToActivityLog([
        crypto.randomUUID(),           // activity_id
        invoiceId || "UNKNOWN",        // invoice_id
        merchant_ref_id,               // merchant_ref_id
        "PURCHASE_CREATED",            // event_type
        amount.toString(),             // amount
        currency,                      // currency
        "3THIX",                       // gateway
        country,                       // country
        userAgent,                     // user_agent
        ipAddress,                     // ip
        JSON.stringify(userMetadata),  // metadata
        new Date().toISOString()       // timestamp
    ]);

    // COMPLIANCE: Write to PAYMENT_TRANSACTIONS (Strict Single Row)
    try {
        const sheetsClient = getGoogleSheets();
        if (sheetsClient) {
            const walletNetwork = detectWalletNetwork(wallet_address);
            // Use new helper
            const { createPaymentTransaction } = await import("../lib/payment-logic.js");
            await createPaymentTransaction(sheetsClient, {
                invoiceId,
                email,
                name,
                walletAddress: wallet_address,
                walletNetwork,
                amount: amount.toString(),
                currency
            });
        }
    } catch (e) {
        console.error("Failed to save transaction info:", e);
    }

    res.status(200).json({
        invoiceId,
        merchant_ref_id,
        callback_url,
        status: "CREATED"
    });
}
