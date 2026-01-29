import { check3ThixAuthoritative, finalizeSuccessfulPayment, normalize3ThixStatus } from "../../lib/payment-logic.js";
import { applyCors } from "../../lib/cors.js";

const { WEBHOOK_AUTH_TOKEN, ADMIN_TOKEN } = process.env;

export const config = {
    api: {
        bodyParser: true, // We need body parsing for invoiceId
    },
};

export default async function handler(req, res) {
    // Basic CORS if needed (though usually admin endpoints might be tighter or same)
    if (applyCors(req, res)) return;

    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // Security: Check Bearer Token
    // User mentioned <ADMIN_TOKEN>, checking process.env.ADMIN_TOKEN or fallback to WEBHOOK_AUTH_TOKEN
    const authHeader = req.headers['authorization'];
    const validToken = ADMIN_TOKEN || WEBHOOK_AUTH_TOKEN;

    if (!authHeader || !authHeader.includes(validToken)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { invoiceId } = req.body;
    if (!invoiceId) {
        return res.status(400).json({ error: "invoiceId required" });
    }

    try {
        console.log(`[ADMIN RECONCILE] Starting for invoice: ${invoiceId}`);

        // 1. Get Invoice from 3THIX
        const apiResult = await check3ThixAuthoritative(invoiceId);

        if (!apiResult) {
            return res.status(404).json({ error: "Invoice not found in 3THIX" });
        }

        const status = normalize3ThixStatus(apiResult.status);

        if (status !== 'SUCCESS') {
            return res.status(409).json({
                error: "Invoice not paid",
                currentStatus: apiResult.status,
                normalized: status
            });
        }

        // 2. Finalize Payment (Updates Sheets, Sends Emails if needed)
        const result = await finalizeSuccessfulPayment(invoiceId, apiResult.data, "ADMIN_RECONCILE");

        console.log(`[ADMIN RECONCILE] Success for ${invoiceId}`);

        return res.json({
            ok: true,
            result
        });

    } catch (err) {
        console.error(`[ADMIN RECONCILE ERROR] ${invoiceId}`, err);
        return res.status(500).json({ error: err.message });
    }
}
