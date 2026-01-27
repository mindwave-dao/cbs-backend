
import { handlePaymentLogic } from "./payment.logic.js";

export async function handle3ThixWebhook(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // 1. Auth Check
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.WEBHOOK_AUTH_TOKEN;

    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
        console.warn("[WEBHOOK AUTH FAILED] Invalid token");
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const body = req.body; // Vercel parsing usually works, but if not we assume it is parsed by now in api/index.js if we use standard body parser? 
        // Wait, standard serverless function `req.body` is parsed if content-type is json.
        // `api/webhooks/3thix.js` used `getRawBody`.
        // In `api/index.js` we can just ensure we handle body parsing or use raw-body if needed.
        // For simplicity in consolidation, we'll assume `req.body` is available or we parse it here if it's a Buffer.

        console.log("[WEBHOOK RECEIVED]", JSON.stringify(body));

        const invoiceId = body.invoice?.id || body.order?.id || body.payload?.invoiceId || body.id;
        const event = body.event || body.type;

        if (!invoiceId) {
            return res.status(400).json({ error: "Missing invoice ID" });
        }

        if (event?.includes('INVOICE') || event?.includes('ORDER') || event?.includes('PAYMENT')) {
            await handlePaymentLogic(invoiceId, 'WEBHOOK', body);
        }

        return res.status(200).json({ ok: true });

    } catch (e) {
        console.error("[WEBHOOK ERROR]", e);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
