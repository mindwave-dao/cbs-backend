import fetch from "node-fetch";
import { google } from "googleapis";

const {
  THIX_API_KEY,
  THIX_API_URL,
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

// Header row for the Transactions sheet
const SHEET_HEADERS = [
  "Merchant Ref ID",
  "Description",
  "Amount",
  "Currency",
  "Status",
  "Provider",
  "Invoice ID",
  "Fee",
  "Blocked Status",
  "Country",
  "Notes",
  "Timestamp"
];

async function ensureHeadersExist(sheetsClient) {
  try {
    // Check if row 1 has headers
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A1:L1"
    });
    
    const existingHeaders = response.data.values?.[0];
    
    // If no headers or first cell is empty, add headers
    if (!existingHeaders || !existingHeaders[0]) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Transactions!A1:L1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_HEADERS] }
      });
      console.log("Added headers to Transactions sheet");
    }
  } catch (err) {
    // If sheet doesn't exist or other error, try to add headers anyway
    console.warn("Header check failed, attempting to add:", err.message);
    try {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Transactions!A1:L1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_HEADERS] }
      });
    } catch (updateErr) {
      console.error("Failed to add headers:", updateErr.message);
    }
  }
}

let headersInitialized = false;

async function appendToGoogleSheets(row) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) return;
  
  try {
    // Ensure headers exist on first write
    if (!headersInitialized) {
      await ensureHeadersExist(sheetsClient);
      headersInitialized = true;
    }
    
    // Append data starting from row 2 onwards (after headers)
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:L",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.error("Google Sheets append error:", err);
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

  const country = req.headers["x-vercel-ip-country"];

  /**
   * Block payment ONLY when:
   * - country header exists
   * - and it is explicitly "US"
   */
  const paymentBlocked = country === "US";

  const { amount, currency, description, quantity = 1 } = req.body;

  if (!amount || typeof amount !== "number" || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  if (!currency || !description) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const merchant_ref_id = `mw-${Date.now()}`;

  const payload = {
    rail: "CREDIT_CARD",
    currency,
    amount: amount.toString(),
    merchant_ref_id,
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
  } catch (err) {
    console.error("3Thix error:", err);
    return res.status(500).json({ error: "Failed to create invoice" });
  }

  // ✅ Respond normally (NO 403)
  res.status(200).json({
    invoiceId,
    merchant_ref_id,
    paymentBlocked
  });

  // 🔁 Fire-and-forget ledger write
  setImmediate(() => {
    appendToGoogleSheets([
      merchant_ref_id,
      description,
      amount.toString(),
      currency,
      "INVOICE_CREATED",
      "3THIX",
      invoiceId,
      "0",
      paymentBlocked ? "PAYMENT_BLOCKED_US" : "",
      country,
      "",
      new Date().toISOString()
    ]);
  });
}
