
import { checkPaymentStatusLogic } from "../lib/payment-logic.js";

/* ---------- CORS Setup for Read-Only ---------- */
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
}

import { applyCors } from "../lib/cors.js";

export default async function handler(req, res) {
    if (applyCors(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({
            status: "ERROR",
            message: "Method not allowed. GET only."
        });
    }

    const { invoiceId } = req.query;

    if (!invoiceId) {
        return res.status(400).json({
            status: "ERROR",
            message: "Missing invoiceId"
        });
    }

    try {
        // STRICT READ-ONLY LOGIC
        const result = await checkPaymentStatusLogic(invoiceId);

        // Return 404 if NOT_FOUND
        if (result.status === "NOT_FOUND") {
            return res.status(404).json(result);
        }

        return res.status(200).json(result);

    } catch (e) {
        console.error(`[CHECK STATUS ERROR] ${invoiceId}`, e);
        return res.status(500).json({
            status: "ERROR",
            message: "Internal Server Error"
        });
    }
}
