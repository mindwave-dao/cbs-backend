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
    console.error("Google Sheets append error:", err);
  }
}

/* ---------- API Handler ---------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const country = req.headers["x-vercel-ip-country"] || "UNKNOWN";
  const paymentBlocked = country === "US"; // 🔒 block payment only

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
