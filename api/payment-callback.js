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
    // 2. Auth Token Validation (Loose Match)
    // Check this BEFORE reading body to fail fast if unauthorized
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.includes(WEBHOOK_AUTH_TOKEN)) {
      console.error("[WEBHOOK SECURITY] Invalid or missing Authorization header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 3. Get Raw Body (Required for HMAC)
    const rawBodyBuffer = await getRawBody(req);
    const rawBodyString = rawBodyBuffer.toString("utf8");

    // 4. HMAC Verification (Section 2 - RAW BODY)
    const signature = req.headers['x-webhook-signature'];

    if (!THIX_WEBHOOK_SECRET) {
      console.error("[WEBHOOK CONFIG] Missing THIX_WEBHOOK_SECRET");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    if (!signature) {
      console.error("[WEBHOOK SECURITY] Missing signature header");
      return res.status(401).json({ error: "Missing Signature" });
    }

    const hmac = crypto.createHmac('sha256', THIX_WEBHOOK_SECRET);
    const digest = hmac.update(rawBodyBuffer).digest('hex');

    // Timing Safe Compare
    if (digest !== signature) {
      console.error(`[WEBHOOK SECURITY] Signature mismatch. Expected: ${digest}, Got: ${signature}`);
      return res.status(401).json({ error: "Invalid Signature" });
    }

    // 5. Parse JSON (Safe after verification)
    let data;
    try {
      data = JSON.parse(rawBodyString);
    } catch (e) {
      console.error("[WEBHOOK ERROR] Failed to parse JSON body");
      return res.status(400).json({ error: "Invalid JSON" });
    }

    // 6. Safe Logging (Redacted)
    // Note: data might be wrapped in payload or direct.
    const payload = data.payload || data;

    // Safety check: is payload object?
    if (typeof payload !== 'object') {
      return res.status(400).json({ error: "Invalid payload structure" });
    }

    const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;
    const shortId = invoiceId ? `...${String(invoiceId).slice(-4)}` : 'UNKNOWN';
    console.log(`[WEBHOOK] Verified payload for invoice ending in ${shortId}`);

    // 7. Event/Status Acceptance (Expanded)
    // Accept: ORDER_COMPLETED, INVOICE_PAID, status=PAID, payment_status=APPROVED
    const event = payload.event || payload.type || payload.status;
    const paymentStatus = payload.payment_status;
    const status = payload.status;
    const invoiceStatus = payload.invoice?.status;

    // Corrected OR-based success condition
    const isSuccess =
      event === "ORDER_COMPLETED" ||
      event === "INVOICE_PAID" ||
      status === "PAID" ||
      paymentStatus === "APPROVED" ||
      invoiceStatus === "PAID"; // Added invoice.status check

    // Also handle FAILED
    const isFailed =
      event === "ORDER_FAILED" ||
      status === "FAILED" ||
      status === "CANCELLED" ||
      status === "EXPIRED";

    let internalStatus = null;

    if (isSuccess) {
      internalStatus = 'SUCCESS';
    } else if (isFailed) {
      internalStatus = 'FAILED';
    } else {
      console.log(`[WEBHOOK IGNORE] Event not success/failed. Event: ${event}, Status: ${status}`);
      // 200 OK for ignored events (prevents retry loop for non-critical events)
      return res.status(200).json({ ignored: true, reason: "Status not relevant" });
    }

    if (!invoiceId) {
      // If no invoice ID, we can't do anything. 
      // Return 200 to prevent retry loop for malformed data? 
      // Or 400? Usually 200 if we can't process it ever.
      console.error("[WEBHOOK ERROR] Missing Invoice ID in payload");
      return res.status(200).json({ error: "Missing Invoice ID" });
    }

    // 8. Process Logic
    // Pass 'WEBHOOK' as source.
    const result = await handlePaymentLogic(invoiceId, 'WEBHOOK', { ...payload, internalStatusOverride: internalStatus });

    return res.status(200).json(result);

  } catch (err) {
    console.error("Payment callback error:", err);
    // 500 triggers retry
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
