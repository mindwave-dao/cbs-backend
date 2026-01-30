import crypto from "crypto";
// finalizeSuccessfulPayment removed. Webhook is signal only.
import { withCors } from "../lib/withCors.js";


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
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 2. Method Check
  if (req.method !== "POST") {
    if (req.method === "GET") {
      return res.status(200).json({ message: "Webhook endpoint. GET ignored." });
    }
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 3. Env Check
  try {
    const { validateEnv } = await import("../lib/env.js");
    validateEnv();
  } catch (e) {
    return res.status(500).json({ error: "Server Configuration Error" });
  }

  const WEBHOOK_AUTH_TOKEN = process.env.WEBHOOK_AUTH_TOKEN;
  const THIX_WEBHOOK_SECRET = process.env.THIX_WEBHOOK_SECRET;

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
      console.error(`[WEBHOOK SECURITY] Signature mismatch.Expected: ${digest}, Got: ${signature} `);
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

    // --- LOGIC START ---

    const invoiceId = payload.invoice_id || payload.id || payload.invoice?.id;
    if (!invoiceId) {
      console.error("[WEBHOOK ERROR] Missing Invoice ID in payload");
      return res.status(200).json({ error: "Missing Invoice ID" });
    }

    const shortId = `...${String(invoiceId).slice(-4)} `;
    console.log(`[WEBHOOK] Received for invoice ${shortId}`);

    const event = payload.event || payload.type || payload.status;
    const paymentStatus = payload.payment_status;
    const status = payload.status;
    const invoiceStatus = payload.invoice?.status;

    // Expanded Success Criteria
    const isSuccess =
      event === "ORDER_COMPLETED" ||
      event === "INVOICE_PAID" ||
      status === "PAID" ||
      paymentStatus === "APPROVED" || // Some gateways use APPROVED
      paymentStatus === "PAID" ||
      invoiceStatus === "PAID";

    const isFailed =
      event === "ORDER_FAILED" ||
      status === "FAILED" ||
      status === "CANCELLED" ||
      status === "EXPIRED";

    if (isSuccess) {
      console.log(`[WEBHOOK] Success confirmed for ${invoiceId}.Finalizing...`);

      // Use Shared Finalization Logic
      // This handles: DB Update, Emails (User+Admin), Activity Log
      const { finalizeSuccessfulPayment } = await import("../lib/payment-logic.js");

      // Pass the payload as authoritative data source
      const result = await finalizeSuccessfulPayment(invoiceId, payload, 'WEBHOOK');

      return res.status(200).json({ status: 'SUCCESS', result });
    }

    if (isFailed) {
      console.log(`[WEBHOOK] Failed event for ${invoiceId}`);
      const { updateTransactionStatus } = await import("../lib/sheets.logic.js");
      await updateTransactionStatus(invoiceId, status, {
      });
      return res.status(200).json({ status: 'FAILED' });
    }

    // Ignore other events
    console.log(`[WEBHOOK IGNORE]Event: ${event}, Status: ${status} `);
    return res.status(200).json({ ignored: true });

  } catch (err) {
    console.error("Payment callback error:", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
