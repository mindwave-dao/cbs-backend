import crypto from "crypto";
// finalizeSuccessfulPayment removed. Webhook is signal only.
import { updatePaymentFailed } from "../lib/payment-logic.js"; // or sheets.logic if moved? Check import.
// Actually updatePaymentFailed is in lib/sheets.logic.js (dot/dash confusion).
// checking exports from previous view_file. 
// updatePaymentFailed is in `payment-logic.js` (dash)? No wait.
// In Step 190 `payment-logic.js` (dash) has exports: `validateWalletAddress`, `detectWalletNetwork`, `check3ThixAuthoritative`, `normalize3ThixStatus`, `finalizeSuccessfulPayment` (OLD), `handlePaymentLogic`.
// `sheets.logic.js` (Step 192) has: `updateTransactionStatus`... doesn't show `updatePaymentFailed` explicitly exported?
// Ah, `sheets.logic.js` text in step 192 shows `export async function updatePaymentFailed...` at line 326.
// So I should import `updatePaymentFailed` from `../lib/sheets.logic.js`.

import { updateTransactionStatus } from "../lib/sheets.logic.js";
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

  if (req.method !== "POST") {
    if (req.method === "GET") {
      return res.status(200).json({ message: "Webhook endpoint. GET ignored." });
    }
    return res.status(405).json({ error: "Method not allowed" });
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
      console.error("[WEBHOOK ERROR] Failed to parse JSON body");
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const payload = data.payload || data;
    if (typeof payload !== 'object') {
      return res.status(400).json({ error: "Invalid payload structure" });
    }

    const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;
    if (!invoiceId) {
      console.error("[WEBHOOK ERROR] Missing Invoice ID in payload");
      return res.status(200).json({ error: "Missing Invoice ID" });
    }

    const shortId = `...${String(invoiceId).slice(-4)}`;
    console.log(`[WEBHOOK] Verified payload for invoice ending in ${shortId}`);

    const event = payload.event || payload.type || payload.status;
    const paymentStatus = payload.payment_status;
    const status = payload.status;
    const invoiceStatus = payload.invoice?.status;

    const isSuccess =
      event === "ORDER_COMPLETED" ||
      event === "INVOICE_PAID" ||
      status === "PAID" ||
      paymentStatus === "APPROVED" ||
      invoiceStatus === "PAID";

    const isFailed =
      event === "ORDER_FAILED" ||
      status === "FAILED" ||
      status === "CANCELLED" ||
      status === "EXPIRED";

    if (isSuccess) {
      console.log(`[WEBHOOK] Success event detected for ${invoiceId}. Marking AWAITING_FULFILLMENT.`);
      // STRICT RULE: Webhook never marks SUCCESS. Only AWAITING_FULFILLMENT.
      await updateTransactionStatus(invoiceId, 'AWAITING_FULFILLMENT', {
        // We can optionally save metadata here if available, but simplest is state change.
        // checkFulfillmentStatus will fetch full metadata later.
      });
      return res.status(200).json({ status: 'AWAITING_FULFILLMENT' });
    }

    if (isFailed) {
      console.log(`[WEBHOOK] Failed event for ${invoiceId}`);
      // Keep minimal logic for failure: Update status to FAILED in sheets
      // We can use updateTransactionStatus from sheets logic directly
      await updateTransactionStatus(invoiceId, 'FAILED', {});
      return res.status(200).json({ status: 'FAILED' });
    }

    console.log(`[WEBHOOK IGNORE] Event not success/failed. Event: ${event}, Status: ${status}`);
    return res.status(200).json({ ignored: true, reason: "Status not relevant" });

  } catch (err) {
    console.error("Payment callback error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
