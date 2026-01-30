import crypto from "crypto";
import { applyCors } from "../lib/cors.js";
import { finalizeSuccessfulPayment } from "../lib/payment-logic.js";

export const config = {
  api: {
    bodyParser: false, // RAW body needed for HMAC
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
  // 1. HARD CORS GUARD
  if (applyCors(req, res)) return;

  // 2. Method Check
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 3. Env Check
  try {
    const { validateEnv } = await import("../lib/env.js");
    validateEnv();
  } catch (e) {
    return res.status(500).json({ error: "Server Configuration Error" });
  }

  const { WEBHOOK_AUTH_TOKEN, THIX_WEBHOOK_SECRET } = process.env;

  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.includes(WEBHOOK_AUTH_TOKEN)) {
      console.error("[WEBHOOK SECURITY] Invalid or missing Authorization header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const rawBodyBuffer = await getRawBody(req);
    const rawBodyString = rawBodyBuffer.toString("utf8");
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

    if (digest !== signature) {
      console.error(`[WEBHOOK SECURITY] Signature mismatch. Expected: ${digest}, Got: ${signature}`);
      return res.status(401).json({ error: "Invalid Signature" });
    }

    let data;
    try {
      data = JSON.parse(rawBodyString);
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const payload = data.payload || data;
    if (typeof payload !== 'object') {
      return res.status(400).json({ error: "Invalid payload structure" });
    }

    // --- LOGIC START ---
    const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;
    if (!invoiceId) {
      return res.status(200).json({ error: "Missing Invoice ID" });
    }

    console.log(`[WEBHOOK] Received for invoice ${invoiceId}`);

    const event = payload.event || payload.type || payload.status;
    const paymentStatus = payload.payment_status;
    const status = payload.status;
    const invoiceStatus = payload.invoice?.status;

    // Expanded Success Criteria
    const isSuccess =
      event === "ORDER_COMPLETED" ||
      event === "INVOICE_PAID" ||
      status === "PAID" ||
      paymentStatus === "APPROVED" ||
      paymentStatus === "PAID" ||
      invoiceStatus === "PAID";

    if (isSuccess) {
      console.log(`[WEBHOOK] Success confirmed for ${invoiceId}. Finalizing...`);

      // Use Centralized Logic
      const result = await finalizeSuccessfulPayment(invoiceId, payload, 'WEBHOOK');
      return res.status(200).json({ status: 'SUCCESS', result });
    }

    // We only care about SUCCESS in this strict refactor.
    // Allow clean exit for others.
    return res.status(200).json({ status: 'IGNORED', message: "Event not processed" });

  } catch (err) {
    console.error("Payment callback error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
