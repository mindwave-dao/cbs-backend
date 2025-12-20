import fetch from "node-fetch";

const {
  THIX_API_KEY,
  THIX_API_URL,
  VERCEL_URL
} = process.env;

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
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
  
  // Build callback URL for payment status updates
  const baseUrl = VERCEL_URL
    ? `https://${VERCEL_URL}`
    : 'http://localhost:3000';
  const callback_url = `${baseUrl}/api/payment-callback`;

  const payload = {
    rail: "CREDIT_CARD",
    currency,
    amount: amount.toString(),
    merchant_ref_id,
    callback_url,
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
  // Ledger will be updated via payment-callback when payment is completed/failed/timed out
  res.status(200).json({
    invoiceId,
    merchant_ref_id,
    paymentBlocked,
    callback_url
  });
}
