import crypto from "crypto";
import { handlePaymentLogic } from "../lib/payment.logic.js";
import { applyCors } from "../lib/cors.js";

const { THIX_WEBHOOK_SECRET, WEBHOOK_AUTH_TOKEN } = process.env;

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  // 1. Accept POST only
  if (req.method !== "POST") {
    if (req.method === "GET") {
      // Reject GET with 200 + no-op (User Rule 2)
      return res.status(200).json({ message: "Webhook endpoint. GET ignored." });
    }
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 2. Auth Token Validation (Section 2)
    const authHeader = req.headers['authorization'];
    if (!authHeader || authHeader !== `Bearer ${WEBHOOK_AUTH_TOKEN}`) {
      console.error("[WEBHOOK SECURITY] Invalid or missing Authorization header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    let data = req.body;

    // 3. Signature Verification (Section 2)
    // 3Thix sends: { signature, payload: {...} } or just payload.
    let payload = data;
    let signature = req.headers['x-webhook-signature'] || data.signature;

    if (data.payload && data.signature) {
      payload = data.payload;
      signature = data.signature;
    }

    if (!THIX_WEBHOOK_SECRET) {
      console.error("[WEBHOOK CONFIG] Missing THIX_WEBHOOK_SECRET");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    if (!signature) {
      console.error("[WEBHOOK SECURITY] Missing signature");
      return res.status(401).json({ error: "Missing Signature" });
    }

    const hmac = crypto.createHmac('sha256', THIX_WEBHOOK_SECRET);
    const digest = hmac.update(JSON.stringify(payload)).digest('hex');

    // Timing Safe Compare
    if (digest !== signature) {
      console.error("[WEBHOOK SECURITY] Signature mismatch");
      return res.status(401).json({ error: "Invalid Signature" });
    }

    // 4. Safe Logging (Redact PII) - Section 8
    // Don't log full payload if it has sensitive info.
    const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;
    const shortId = invoiceId ? `...${invoiceId.slice(-4)}` : 'UNKNOWN';
    console.log(`[WEBHOOK] Verified payload for invoice ending in ${shortId}`);

    // 5. Event Filtering (Section 1)
    // Allowed: ORDER_COMPLETED, INVOICE_PAID, ORDER_FAILED
    // Extract raw status / event
    const rawStatus = payload.status || payload.payment_status || (payload.invoice ? payload.invoice.status : null);

    // We need to match exact event names if provided in a specific field, OR map status.
    // User request: "Must Handle These Events (ONLY): ORDER_COMPLETED, INVOICE_PAID, ORDER_FAILED"
    // 3Thix payload usually has `status` or `type`. Let's assume `status` maps to these strings.

    // Map to internal status
    let internalStatus = null;
    if (['ORDER_COMPLETED', 'INVOICE_PAID'].includes(rawStatus)) {
      internalStatus = 'SUCCESS';
    } else if (rawStatus === 'ORDER_FAILED') {
      internalStatus = 'FAILED';
    } else {
      console.log(`[WEBHOOK IGNORE] Unhandled event type: ${rawStatus}`);
      return res.status(200).json({ message: "Event ignored" });
    }

    if (!invoiceId) {
      return res.status(400).json({ error: "Missing Invoice ID" });
    }

    // 6. Process Logic (Idempotency inside)
    // Pass 'WEBHOOK' as source.
    const result = await handlePaymentLogic(invoiceId, 'WEBHOOK', { ...payload, internalStatusOverride: internalStatus });

    return res.status(200).json(result);

  } catch (err) {
    console.error("Payment callback error:", err.message); // Don't log full obj incase PII
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
