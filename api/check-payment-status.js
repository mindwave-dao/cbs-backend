import { applyCors } from "../lib/cors.js";

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    if (applyCors(req, res)) return;

    // 2. Method Check
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
        // 1. Get Passive Status
        const { checkPaymentStatusLogic } = await import("../lib/payment-logic.js");
        let result = await checkPaymentStatusLogic(invoiceId);

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
