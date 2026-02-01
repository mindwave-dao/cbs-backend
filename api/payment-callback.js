/**
 * ⚠️ DEPRECATED - This webhook endpoint may no longer be needed.
 * 
 * With the new 3thix direct payment API (POST /api/payment),
 * payments are processed synchronously - no webhook callbacks.
 * 
 * Keep this file only if 3thix still sends webhooks for some events.
 * Otherwise, this endpoint can be safely removed.
 */

import { applyCors } from "../lib/cors.js";
import { updateTransactionStatus } from "../lib/sheets.logic.js";
import { finalizeSuccessfulPayment } from "../lib/finalize-payment.js";
import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false, // RAW body needed for HMAC
  },
};

export default async function handler(req, res) {
  // 1. HARD CORS GUARD
  if (applyCors(req, res)) return;

  // 2. Method Check
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 3. Env Check (Fail Fast)
  try {
    validateEnv();
  } catch (e) {
    return res.status(500).json({ error: "Server Config Error" });
  }

  // 4. VERIFY (Inline Strict)
  const { THIX_WEBHOOK_SECRET, WEBHOOK_AUTH_TOKEN } = process.env;

  // Auth Header
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.includes(WEBHOOK_AUTH_TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Read Body safely
  let rawBodyBuffer;
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    rawBodyBuffer = Buffer.concat(chunks);
  } catch (e) {
    return res.status(400).json({ error: "Body Read Error" });
  }

  // Signature
  const signature = req.headers['x-webhook-signature'];
  const hmac = crypto.createHmac('sha256', THIX_WEBHOOK_SECRET);
  const digest = hmac.update(rawBodyBuffer).digest('hex');

  if (digest !== signature) {
    return res.status(401).json({ error: "Signature Mismatch" });
  }

  // Parse
  let payload;
  try {
    const json = JSON.parse(rawBodyBuffer.toString('utf8'));
    payload = json.payload || json;
  } catch (e) {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const correlationId = req.headers['x-vercel-id'] || `req-${Date.now()}`;
  const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;

  if (!invoiceId) {
    return res.status(200).json({ error: "Missing Invoice ID" });
  }

  console.log(`[WEBHOOK] [${correlationId}] Received for ${invoiceId}`);

  // 5. EVENT FILTERING (Strict)
  const event = payload.event || payload.type || payload.status;
  const paymentStatus = payload.payment_status;

  const ALLOWED_EVENTS = ["ORDER_COMPLETED", "INVOICE_PAID", "PAID", "SUCCESS", "COMPLETED"];

  if (!ALLOWED_EVENTS.includes(event) && !ALLOWED_EVENTS.includes(paymentStatus)) {
    return res.status(200).json({ status: "IGNORED" });
  }

  // 6. EXECUTION (Guaranteed Path)
  // A. Mark as AWAITING (Signal Reception)
  await updateTransactionStatus(invoiceId, "AWAITING_FULFILLMENT", {}).catch(() => { });

  // B. Trigger Definitive Check
  try {
    const result = await finalizeSuccessfulPayment(invoiceId, { source: "WEBHOOK", rawPayload: payload });
    return res.status(200).json({ status: "PROCESSED", finalization: result.status });
  } catch (e) {
    console.error(`[WEBHOOK ERROR] [${correlationId}] ${e.message}`);
    // FAIL LOUDLY per requirement
    return res.status(500).json({ error: "Finalization failed", details: e.message });
  }
}
