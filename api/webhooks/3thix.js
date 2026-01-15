import { handlePaymentLogic } from "../../lib/payment-logic.js";
import getRawBody from "raw-body";

/*
  WEBHOOK HANDLER: POST /api/webhooks/3thix
  Secured by Authorization header.
*/

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Auth Check (Critical)
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.WEBHOOK_AUTH_TOKEN;

    if (!expectedToken) {
      console.error("[WEBHOOK FATAL] WEBHOOK_AUTH_TOKEN not set in env");
      return res.status(500).json({ error: "Server Configuration Error" });
    }

    if (authHeader !== `Bearer ${expectedToken}`) {
      console.warn("[WEBHOOK AUTH FAILED] Invalid token");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2. Parse Body
    const buffer = await getRawBody(req);
    const bodyStr = buffer.toString('utf-8');
    let body;
    try {
      body = JSON.parse(bodyStr);
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    console.log("[WEBHOOK RECEIVED]", JSON.stringify(body));

    // 3. Extract logic
    const invoiceId = body.invoice?.id || body.order?.id || body.payload?.invoiceId || body.id;
    const event = body.event || body.type;
    // const status = body.invoice?.status || body.status;

    if (!invoiceId) {
      console.warn("[WEBHOOK SKIPPED] No invoice ID found");
      return res.status(400).json({ error: "Missing invoice ID" });
    }

    // 4. Processing
    // We simply pass every valid webhook event for a given Invoice ID to the shared logic.
    // The shared logic will idempotently check 3Thix (authoritative) or use provided data if authoritative fails.
    // We strictly filter for Payment events to avoid noise, OR just pass everything?
    // Requirement says: "For invoice events (INVOICE_PAID, INVOICE_STATUS_CHANGED, ORDER_COMPLETED)..."
    // Let's be permissive but efficient.

    if (event?.includes('INVOICE') || event?.includes('ORDER') || event?.includes('PAYMENT')) {
      console.log(`[WEBHOOK PROCESSING] Invoice ${invoiceId} / Event ${event}`);
      // We do not await this if we want to return 202 quickly?
      // Requirement: "Respond 200 quickly. If processing is heavy, respond 202 and queue background..."
      // Node.js serverless functions (Vercel) need to await before return usually, unless using background functions.
      // Standard: await it. It shouldn't be too slow (couple of internal fetches).
      await handlePaymentLogic(invoiceId, 'WEBHOOK', body);
    } else {
      console.log(`[WEBHOOK IGNORED] Event type irrelevant: ${event}`);
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
