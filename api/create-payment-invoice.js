import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";
import { isGeoRestricted } from "../lib/geo.js";

const {
  THIX_API_KEY,
  THIX_API_URL,
  VERCEL_URL,
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS
} = process.env;

// SANDBOX references (commented for future debugging):
// THIX_API_URL=https://sandbox-api.3thix.com
// THIX_API_KEY=SANDBOX_API_KEY
// PAYMENT_PAGE_BASE=https://sandbox-pay.3thix.com

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

/* ---------- Payment Ledger Sheet ---------- */
const SHEET_HEADERS = [
  "INVOICE_ID",
  "STATUS",
  "EMAIL",
  "NAME",
  "EMAIL_SENT",
  "EMAIL_SENT_AT",
  "AMOUNT",
  "CURRENCY",
  "CREATED_AT"
];

let headersInitialized = false;

async function ensureHeadersExist(sheetsClient) {
  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A1:I1"
    });

    const existingHeaders = response.data.values?.[0];

    if (!existingHeaders || !existingHeaders[0]) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Transactions!A1:I1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_HEADERS] }
      });
      console.log("Added headers to Transactions sheet");
    }
  } catch (err) {
    console.warn("Header check failed, attempting to add:", err.message);
    try {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Transactions!A1:I1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_HEADERS] }
      });
    } catch (updateErr) {
      console.error("Failed to add headers:", updateErr.message);
    }
  }
}

async function appendToGoogleSheets(row) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) return;

  try {
    if (!headersInitialized) {
      await ensureHeadersExist(sheetsClient);
      headersInitialized = true;
    }

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:I",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log("Ledger entry added successfully");
  } catch (err) {
    console.error("Google Sheets append error:", err);
    throw err;
  }
}

/* ---------- PaymentAdditionalInfo Sheet ---------- */
const ADDITIONAL_INFO_HEADERS = [
  "merchant_ref_id",
  "invoice_id",
  "name",
  "email",
  "timestamp"
];

let additionalInfoHeadersInitialized = false;

async function ensureAdditionalInfoHeaders(sheetsClient) {
  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A1:E1"
    });

    const existingHeaders = response.data.values?.[0];

    if (!existingHeaders || !existingHeaders[0]) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "PaymentAdditionalInfo!A1:E1",
        valueInputOption: "RAW",
        requestBody: { values: [ADDITIONAL_INFO_HEADERS] }
      });
      console.log("Added headers to PaymentAdditionalInfo sheet");
    }
  } catch (err) {
    console.warn("AdditionalInfo header check failed, attempting to add:", err.message);
    try {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "PaymentAdditionalInfo!A1:E1",
        valueInputOption: "RAW",
        requestBody: { values: [ADDITIONAL_INFO_HEADERS] }
      });
    } catch (updateErr) {
      console.error("Failed to add AdditionalInfo headers:", updateErr.message);
    }
  }
}

async function appendToAdditionalInfoSheet(row) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    console.warn("Google Sheets not configured, skipping additional info");
    return;
  }

  try {
    if (!additionalInfoHeadersInitialized) {
      await ensureAdditionalInfoHeaders(sheetsClient);
      additionalInfoHeadersInitialized = true;
    }

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A:E",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log("Additional info entry added successfully");
  } catch (err) {
    console.error("Additional info append error:", err);
    // Don't throw - additional info logging should not block payment flow
  }
}

/* ---------- Activity Log Headers ---------- */
const ACTIVITY_LOG_HEADERS = [
  "activity_id",
  "invoice_id",
  "merchant_ref_id",
  "event_type",
  "amount",
  "currency",
  "gateway",
  "country",
  "user_agent",
  "ip",
  "metadata",
  "timestamp"
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
 * Columns: activity_id, invoice_id, merchant_ref_id, event_type, amount, currency, 
 *          gateway, country, user_agent, ip, metadata, timestamp
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
    // Don't throw - activity logging should not block payment flow
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

  // Validate required environment variables for payment
  if (!THIX_API_KEY || !THIX_API_URL) {
    console.error("Missing THIX_API_KEY or THIX_API_URL environment variables");
    return res.status(500).json({ error: "Payment service not configured" });
  }

  const country = req.headers["x-vercel-ip-country"] || "";
  const userAgent = req.headers["user-agent"] || "";
  const ipAddress = req.headers["x-forwarded-for"]?.split(',')[0]?.trim() ||
                    req.headers["x-real-ip"] || "";

  /**
   * Block payment ONLY when country is "US"
   */
  const paymentBlocked = country === "US";

  // Accept return_url, name, and email from request body
  const { amount, currency, quantity = 1, name, email, return_url } = req.body;
  const description = "NILA TOKEN - Mindwave";

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  if (!currency || !description) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (!return_url) {
    return res.status(400).json({ error: 'return_url is required' });
  }

  const merchant_ref_id = `mw-${Date.now()}`;
  
  // Build callback URL for payment status updates
  const baseUrl = VERCEL_URL
    ? `https://${VERCEL_URL}`
    : 'http://localhost:3000';
  const callback_url = `${baseUrl}/api/webhooks/3thix`;

  // Store user info in metadata for retrieval during callback
  const userMetadata = {
    name: name || "",
    email: email || "",
    paymentBlocked
  };

  const payload = {
    rail: "CREDIT_CARD",
    currency,
    amount: amount.toString(),
    merchant_ref_id,
    callback_url,
    return_url: encodeURIComponent(return_url), // IMPORTANT: encode, but do NOT alter
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
    const response = await fetch(`${THIX_API_URL}/order/payment/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": THIX_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    invoiceId = data.invoice_id || data.invoice?.id || data.id;

  if (!invoiceId) {
    throw new Error("Invoice ID missing from 3Thix response");
  }

  // Store user info in Google Sheets (Additional Info Tab)
  await appendToAdditionalInfoSheet([
    merchant_ref_id,
    invoiceId,
    name,
    email,
    new Date().toISOString()
  ]);

  } catch (err) {
    console.error("3Thix error:", err);
    return res.status(500).json({ error: "Failed to create invoice" });
  }

  // Log INVOICE_CREATED event to TransactionActivityLog
  // This guarantees every attempt is recorded, even if payment never happens
  await appendToActivityLog([
    crypto.randomUUID(),           // activity_id
    invoiceId,                     // invoice_id
    merchant_ref_id,               // merchant_ref_id
    "INVOICE_CREATED",             // event_type
    amount.toString(),             // amount
    currency,                      // currency
    "3THIX",                       // gateway
    country,                       // country
    userAgent,                     // user_agent
    ipAddress,                     // ip
    JSON.stringify(userMetadata),  // metadata (includes name, email, paymentBlocked)
    new Date().toISOString()       // timestamp
  ]);

  // Write to Transactions sheet with PENDING status
  await appendToGoogleSheets([
    invoiceId,                    // INVOICE_ID
    "PENDING",                    // STATUS
    email || "",                  // EMAIL
    name || "",                   // NAME
    "",                           // EMAIL_SENT
    "",                           // EMAIL_SENT_AT
    amount.toString(),            // AMOUNT
    currency,                     // CURRENCY
    new Date().toISOString()      // CREATED_AT
  ]);

  // If payment blocked, log PAYMENT_BLOCKED_US event
  if (paymentBlocked) {
    await appendToActivityLog([
      crypto.randomUUID(),
      invoiceId,
      merchant_ref_id,
      "PAYMENT_BLOCKED_US",
      amount.toString(),
      currency,
      "3THIX",
      country,
      userAgent,
      ipAddress,
      JSON.stringify({ blocked: true }),
      new Date().toISOString()
    ]);
  }

  // Build redirect URL for payment page
  const redirectUrl = `${process.env.PAYMENT_PAGE_BASE}?invoiceId=${invoiceId}&callbackUrl=${encodeURIComponent(callback_url)}`;

  // ✅ Respond with invoice details and redirect URL
  res.status(200).json({
    invoiceId,
    merchant_ref_id,
    redirectUrl
  });
}
