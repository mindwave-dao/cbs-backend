import { handlePaymentLogic } from "../../lib/payment-logic.js";
import getRawBody from "raw-body";

/*
  WEBHOOK HANDLER: POST /api/webhooks/3thix
  Secured by Authorization header.
*/

export const config = {
  api: {
    bodyParser: false, // We need raw body for potential signature verification or just standard parsing if we want control
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 1. Auth Check
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.WEBHOOK_AUTH_TOKEN;

    if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
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

    // 3. Extract Invoice ID & Event
    // Payload structure varies; try multiple paths
    const invoiceId = body.invoice?.id || body.order?.id || body.payload?.invoiceId || body.id;
    const event = body.event || body.type;
    const status = body.invoice?.status || body.status;

    if (!invoiceId) {
      console.warn("[WEBHOOK SKIPPED] No invoice ID found");
      return res.status(400).json({ error: "Missing invoice ID" });
    }

    // 4. Process Logic
    // We only really care if it's PAID or status changed to PAID.
    // However, for completeness, we can trigger the logic which handles all statuses.
    // The shared logic uses idempotent checks so safe to call repeatedly.

    if (event === 'INVOICE_PAID' ||
      event === 'ORDER_COMPLETED' ||
      status === 'PAID' ||
      status === 'APPROVED' ||
      (event === 'INVOICE_STATUS_CHANGED' && status === 'PAID')) {

      console.log(`[WEBHOOK PROCESSING] Invoice ${invoiceId}`);
      await handlePaymentLogic(invoiceId, 'WEBHOOK');
    } else {
      console.log(`[WEBHOOK IGNORED] Status not PAID/APPROVED: ${event} / ${status}`);
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("[WEBHOOK ERROR]", err);
    return res.status(500).json({ error: "Internal Server Error" });
  }
}
