import { finalizePaymentStatus } from "../lib/finalize-payment.js";
import { withCors } from "../lib/withCors.js";

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    if (withCors(req, res)) return;

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Method Check
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
