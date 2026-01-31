import { applyCors } from "../lib/cors.js";

/**
 * @deprecated
 * Use /api/check-payment-status instead.
 */
export default async function handler(req, res) {
    if (applyCors(req, res)) return;
    return res.status(200).json({
        status: "DEPRECATED",
        message: "Use /api/check-payment-status"
    });
}
