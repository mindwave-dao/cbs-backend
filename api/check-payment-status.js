import { validatePaymentEnv, handlePaymentLogic } from "../lib/payment-logic.js";

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { invoiceId } = req.query;
  if (!invoiceId) return res.status(400).json({ error: "invoiceId required" });

  try {
    // 1. Validate Config
    validatePaymentEnv();

    // 2. Execute Shared Logic
    // source='3THIX_API' is the default for polling
    const result = await handlePaymentLogic(invoiceId, '3THIX_API');

    // 8️⃣ Backend Status Contract (Authoritative)
    // Return ONLY specified fields
    const response = {
      invoiceId: result.invoiceId,
      status: result.status, // "PENDING | PROCESSING | SUCCESS | FAILED"
      amount: result.amount,
      currency: result.currency,
      tokens: result.tokens,
      emailSentUser: result.emailSentUser,
      emailSentAdmin: result.emailSentAdmin,
      walletAddress: result.walletAddress
    };

    return res.json(response);

  } catch (err) {
    console.error("[check-payment-status CRASH]", err);
    return res.json({
      invoiceId,
      status: "PENDING",
      error: "Internal Error" // Do not expose err.message
    });
  }
}
