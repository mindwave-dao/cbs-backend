import fetch from "node-fetch";
import { google } from "googleapis";

const {
  THIX_API_KEY,
  THIX_API_URL,
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS
} = process.env;

if (!THIX_API_KEY || !THIX_API_URL || !GOOGLE_SHEET_ID || !GOOGLE_SHEETS_CREDENTIALS) {
  throw new Error("Missing required environment variables");
}

/* ---------- Google Sheets Setup ---------- */
const credentials = JSON.parse(GOOGLE_SHEETS_CREDENTIALS);
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});
const sheets = google.sheets({ version: "v4", auth });

async function appendToGoogleSheets(row) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A:L",
      valueInputOption: "RAW",
      requestBody: { values: [row] }
    });
  } catch (err) {
    console.error("Google Sheets error:", err);
  }
}

/* ---------- API Handler ---------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const country = req.headers["x-vercel-ip-country"] || "UNKNOWN";
  if (country === "US") {
    return res.status(403).json({
      error: "Payments are not available in your region."
    });
  }

  const { amount, currency, description, quantity = 1 } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  const merchant_ref_id = `mw-${Date.now()}`;

  const payload = {
    rail: "CREDIT_CARD",
    currency,
    amount: amount.toString(),
    merchant_ref_id,
    cart: [{
      product_name: description,
      qty_unit: quantity,
      price_unit: (amount / quantity).toString()
    }]
  };

  const response = await fetch(`${THIX_API_URL}/order/payment/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": THIX_API_KEY
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  const invoiceId = data.invoice_id || data.invoice?.id || data.id;

  if (!invoiceId) {
    return res.status(500).json({ error: "Failed to create invoice" });
  }

  res.status(200).json({ invoiceId, merchant_ref_id });

  // Fire-and-forget ledger
  appendToGoogleSheets([
    merchant_ref_id,
    description,
    amount.toString(),
    currency,
    "INVOICE_CREATED",
    "3THIX",
    invoiceId,
    "0",
    "",
    "",
    "",
    new Date().toISOString()
  ]);
}
