import crypto from "crypto";
import { applyCors } from "../lib/cors.js";
import { finalizeSuccessfulPayment } from "../lib/finalize-payment.js";
import { updateTransactionStatus } from "../lib/sheets.logic.js";

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
  const { WEBHOOK_AUTH_TOKEN, THIX_WEBHOOK_SECRET, THIX_WEBHOOK_URL } = process.env;
  if (!WEBHOOK_AUTH_TOKEN || !THIX_WEBHOOK_SECRET) {
    console.error("[WEBHOOK CONFIG] Missing secrets");
    return res.status(500).json({ error: "Server Configuration Error" });
  }

  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.includes(WEBHOOK_AUTH_TOKEN)) {
      console.error("[WEBHOOK SECURITY] Invalid or missing Authorization header");
      return res.status(401).json({ error: "Unauthorized" });
    }

    const rawBodyBuffer = await getRawBody(req);
    const rawBodyString = rawBodyBuffer.toString("utf8");
    const signature = req.headers['x-webhook-signature'];

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
    const correlationId = req.headers['x-vercel-id'] || req.headers['x-request-id'] || `req-${Date.now()}`;
    const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;
    if (!invoiceId) {
      console.warn(`[WEBHOOK] [${correlationId}] Missing Invoice ID`);
      return res.status(200).json({ error: "Missing Invoice ID" });
    }

    console.log(`[WEBHOOK] [${correlationId}] Received for invoice ${invoiceId}`);

    const event = payload.event || payload.type || payload.status;
    const paymentStatus = payload.payment_status;
    const status = payload.status;
    const invoiceStatus = payload.invoice?.status;

    // Expanded Success Criteria (Triggers Fulfillment Check)
    const isTrigger =
      event === "ORDER_COMPLETED" ||
      event === "INVOICE_PAID" ||
      status === "PAID" ||
      paymentStatus === "APPROVED" ||
      paymentStatus === "PAID" ||
      invoiceStatus === "PAID";

    if (isTrigger) {
      console.log(`[WEBHOOK] [${correlationId}] Trigger confirmed for ${invoiceId}. Marking AWAITING_FULFILLMENT...`);

      // 1. NON-AUTHORITATIVE UPDATE
      // We explicitly DO NOT mark as SUCCESS here.
      // We mark as AWAITING_FULFILLMENT so the frontend (or reconciliation) knows something happened.
      try {
        await updateTransactionStatus(invoiceId, 'AWAITING_FULFILLMENT', {
          // We do NOT update metadata here. We wait for authoritative check.
        });
      } catch (err) {
        console.error(`[WEBHOOK] Failed to set AWAITING_FULFILLMENT:`, err);
        // Non-fatal. Proceed to trigger verification.
      }

      // 2. TRIGGER DEFINITIVE CHECK
      // Fire-and-forget or await?
      // Better to await to capture logs, but return 200 quickly if possible?
      // Since function execution time is limited, we await but handle errors gracefully.
      try {
        const result = await finalizeSuccessfulPayment(invoiceId, null, 'WEBHOOK');
        // If result is success, we are good.
        // If result is !success, it means 3Thix didn't confirm yet. That's fine.
        console.log(`[WEBHOOK] [${correlationId}] Finalization Result: ${result.status}`);
        return res.status(200).json({ status: 'PROCESSED', finalization: result.status });
      } catch (e) {
        console.error(`[WEBHOOK ERROR] [${correlationId}] Finalization trigger failed: ${e.message}`);
        return res.status(500).json({ error: "Processing Trigger Failed" });
      }
    }

    return res.status(200).json({ status: 'IGNORED', message: "Event not a success trigger" });

  } catch (err) {
    const correlationId = req.headers['x-vercel-id'] || "unknown";
    console.error(`[WEBHOOK FATAL] [${correlationId}]`, err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}

