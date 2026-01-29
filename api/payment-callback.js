import crypto from "crypto";
import { handlePaymentLogic } from "../lib/payment.logic.js";
import { applyCors } from "../lib/cors.js";

const { THIX_WEBHOOK_SECRET, WEBHOOK_AUTH_TOKEN } = process.env;

export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  // 1. Accept POST only
  if (req.method !== "POST") {
    if (req.method === "GET") {
      return res.status(200).json({ message: "Webhook endpoint. GET ignored." });
    }
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1.A. Log Headers (Temporary for debugging)
    console.log("Webhook Headers:", JSON.stringify(req.headers, null, 2));

    // 2. Auth Token Validation (Loose Match)
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.includes(WEBHOOK_AUTH_TOKEN)) {
      console.error("[WEBHOOK SECURITY] Invalid or missing Authorization header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 3. Get Raw Body & Parse
    const rawBodyBuffer = await getRawBody(req);
    const rawBodyString = rawBodyBuffer.toString("utf8");
    let data;
    try {
      data = JSON.parse(rawBodyString);
    } catch (e) {
      console.error("[WEBHOOK ERROR] Failed to parse JSON body");
      return res.status(400).json({ error: "Invalid JSON" });
    }

    // 4. HMAC Verification (Section 2 - RAW BODY)
    const signature = req.headers['x-webhook-signature']; // 3Thix header

    if (!THIX_WEBHOOK_SECRET) {
      console.error("[WEBHOOK CONFIG] Missing THIX_WEBHOOK_SECRET");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    if (!signature) {
      // If we strictly require signature. 3Thix docs say checks header.
      console.error("[WEBHOOK SECURITY] Missing signature header");
      return res.status(401).json({ error: "Missing Signature" });
    }

    const hmac = crypto.createHmac('sha256', THIX_WEBHOOK_SECRET);
    // Use the BUFFER or String? crypto.update accepts buffer or string.
    // Ideally use Buffer to avoid encoding issues, but usually utf8 string is fine.
    // User requested "HMAC uses raw body".
    const digest = hmac.update(rawBodyBuffer).digest('hex');

    // Timing Safe Compare
    if (digest !== signature) {
      console.error(`[WEBHOOK SECURITY] Signature mismatch. Expected: ${digest}, Got: ${signature}`);
      return res.status(401).json({ error: "Invalid Signature" });
    }

    // 5. Safe Logging
    // Extract ID first
    // Note: data might be wrapped in payload or direct.
    // 3Thix docs: Standard is direct body or body.payload?
    // User code previously checked data.payload.
    // Let's assume standard object.
    const payload = data.payload || data;

    // Safety check: is payload object?
    if (typeof payload !== 'object') {
      return res.status(400).json({ error: "Invalid payload structure" });
    }

    const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;
    const shortId = invoiceId ? `...${String(invoiceId).slice(-4)}` : 'UNKNOWN';
    console.log(`[WEBHOOK] Verified payload for invoice ending in ${shortId}`);

    // 6. Event/Status Acceptance (Expanded)
    // Accept: ORDER_COMPLETED, INVOICE_PAID, status=PAID, payment_status=APPROVED
    const event = payload.event || payload.type || payload.status;
    const paymentStatus = payload.payment_status;
    const status = payload.status;

    const isSuccess =
      event === "ORDER_COMPLETED" ||
      event === "INVOICE_PAID" ||
      status === "PAID" ||
      paymentStatus === "APPROVED";

    // Also handle FAILED
    const isFailed =
      event === "ORDER_FAILED" ||
      status === "FAILED";

    let internalStatus = null;

    if (isSuccess) {
      internalStatus = 'SUCCESS';
    } else if (isFailed) {
      internalStatus = 'FAILED';
    } else {
      console.log(`[WEBHOOK IGNORE] Event not success/failed. Event: ${event}, Status: ${status}`);
      return res.status(200).json({ ignored: true, reason: "Status not relevant" });
    }

    if (!invoiceId) {
      return res.status(400).json({ error: "Missing Invoice ID in payload" });
    }

    // 7. Process Logic
    // Pass 'WEBHOOK' as source.
    const result = await handlePaymentLogic(invoiceId, 'WEBHOOK', { ...payload, internalStatusOverride: internalStatus });

    return res.status(200).json(result);

  } catch (err) {
    console.error("Payment callback error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
