
import { handlePaymentLogic, validatePaymentEnv } from "../../lib/payment-logic.js";
import crypto from "crypto";

/* ---------- Helper: Verify Signature ---------- */
function verifyWebhookSignature(req) {
  // If WEBHOOK_SECRET is set, we prefer HMAC verification
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers['x-3thix-signature'];
    if (!signature) return false;
    const body = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }

  // Fallback: Check BEARER Token
  const authHeader = req.headers['authorization'];
  const expectedToken = process.env.WEBHOOK_AUTH_TOKEN;
  if (!expectedToken) return true; // CRITICAL: If no token set, we fail open or close? Typically fail open is bad.
  // We assume strict security.
  if (!authHeader) return false;
  const token = authHeader.split(" ")[1];
  return token === expectedToken;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    // 1. Validate Env
    validatePaymentEnv();

    // 2. Auth Check
    if (!verifyWebhookSignature(req)) {
      console.warn("[WEBHOOK UNAUTHORIZED] Invalid signature or token");
      return res.status(401).send("Unauthorized");
    }

    const event = req.body;
    console.log(`[WEBHOOK RECEIVED] Event: ${event.type || 'UNKNOWN'}`);

    // 3. Extract Invoice ID from event
    // 3Thix events: INVOICE_STATUS_CHANGED, INVOICE_PAID, ORDER_COMPLETED
    // Payload usually has { type: "...", data: { invoice_id: "..." } } or similar
    // Check various paths
    let invoiceId = null;
    if (event.data) {
      invoiceId = event.data.invoice_id || event.data.id;
    }

    // If not found in common paths, check if the event itself is the object (unlikely but possible)
    if (!invoiceId && event.invoice_id) invoiceId = event.invoice_id;

    if (!invoiceId) {
      console.warn("[WEBHOOK SKIPPED] No invoice_id found in payload");
      return res.status(200).send("Skipped (No Invoice ID)");
    }

    // 4. Trigger Shared Logic (Fire-and-forget or await?)
    // Requirement: "Return HTTP 200 quickly; do heavy work in background... make sure to ack 200 <= 10s"
    // Since we are serverless (Vercel), we MUST await or the process dies.
    // We will await, but the shared logic is optimized.

    // We pass 'WEBHOOK' as source
    const result = await handlePaymentLogic(invoiceId, 'WEBHOOK');

    console.log(`[WEBHOOK PROCESSED] ${invoiceId} -> ${result.status}`);

    return res.status(200).json({ received: true, processed: true });

  } catch (e) {
    console.error("[WEBHOOK ERROR]", e);
    // Return 500 so 3Thix retries
    return res.status(500).send("Internal Server Error");
  }
}
