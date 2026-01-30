import { finalizeSuccessfulPayment } from "../../lib/payment-logic.js";
import { applyCors } from "../../lib/cors.js";

export const config = {
    api: {
        bodyParser: true,
    },
};

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    if (applyCors(req, res)) return;

    // 2. Method Check
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // 3. Env Validation (Safe import)
    try {
        const { validateEnv } = await import("../../lib/env.js");
        validateEnv();
    } catch (e) {
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    const { WEBHOOK_AUTH_TOKEN, ADMIN_TOKEN } = process.env;

    // Security: Check Bearer Token
    const authHeader = req.headers['authorization'];
    const validToken = ADMIN_TOKEN || WEBHOOK_AUTH_TOKEN;

    if (!authHeader || !authHeader.includes(validToken)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { invoiceId } = req.body;

    try {
        if (!invoiceId) {
            return res.status(400).json({ error: "Missing invoiceId" });
        }

        console.log(`[ADMIN RECONCILE] Starting for invoice: ${invoiceId}`);

        // RECONCILE LOGIC:
        // Reuse same finalize function.
        // It handles 3Thix check if payload is missing.
        const result = await finalizeSuccessfulPayment(invoiceId, null, "ADMIN_RECONCILE");

        if (result.status !== 'SUCCESS') {
            return res.status(409).json({
                error: "Reconciliation Failed",
                reason: result.reason,
                status: result.status,
                details: result
            });
        }

        return res.json({
            ok: true,
            mode: "SINGLE",
            result
        });

    } catch (err) {
        console.error(`[ADMIN RECONCILE ERROR]`, err);
        return res.status(500).json({ error: err.message });
    }
}
