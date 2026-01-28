
import { finalizePaymentStatus } from "../lib/finalize-payment.js";

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
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { invoiceId } = req.query;

    if (!invoiceId) {
        return res.status(400).json({ error: "Missing invoiceId" });
    }

    try {
        const result = await finalizePaymentStatus(invoiceId);

        // Ensure result structure matches requirements
        return res.status(200).json(result);

    } catch (e) {
        console.error(`[STATUS API] Error checking status for ${invoiceId}:`, e);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
