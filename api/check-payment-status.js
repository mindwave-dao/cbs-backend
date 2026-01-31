import { applyCors } from "../lib/cors.js";
import { checkPaymentStatusLogic } from "../lib/payment-logic.js";

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    if (applyCors(req, res)) return;

    // 2. Method Check
    if (req.method !== 'GET') {
        return res.status(405).json({
            status: "FAILED",
            message: "Method not allowed. GET only."
        });
    }

    const { invoiceId } = req.query;

    if (!invoiceId) {
        return res.status(400).json({
            status: "FAILED", // "FAILED" is better than ERROR for frontend state
            message: "Missing invoiceId"
        });
    }

    try {
        // 1. Get Status
        // checkPaymentStatusLogic imports sheets internally, might throw if DB down
        let result = await checkPaymentStatusLogic(invoiceId);

        // Normalize Status for Frontend (Strict List: CREATED, AWAITING_FULFILLMENT, SUCCESS, FAILED)
        let safeStatus = result.status;

        // Map internal or legacy statuses
        if (safeStatus === "NOT_FOUND") {
            // If not found, it might be a delay in sheets consistency? 
            // Or truly invalid.
            // Returning FAILED or CREATED?
            // If just created, it might not be in sheets yet? (Unlikely with await append)
            // User says "Return only...", NOT_FOUND implies FAILED usually?
            // But let's return FAILED to be clear.
            safeStatus = "FAILED";
        } else if (safeStatus === "AWAITING_WEBHOOK" || safeStatus === "PENDING" || safeStatus === "PROCESSING") {
            safeStatus = "CREATED"; // or AWAITING_FULFILLMENT?
            // "AWAITING_WEBHOOK" was > 15 mins.
            if (safeStatus === "AWAITING_WEBHOOK") safeStatus = "CREATED";
        }

        // Override if internal mapped to something else? 
        // Ensure strictly one of the 4:
        const ALLOWED = ["CREATED", "AWAITING_FULFILLMENT", "SUCCESS", "FAILED"];
        if (!ALLOWED.includes(safeStatus)) {
            // "PENDING", "PROCESSING", "AWAITING_PAYMENT" -> CREATED
            // "AWAITING_WEBHOOK" -> CREATED
            safeStatus = "CREATED";
        }

        // Logic check: If SUCCESS but missing data? Logic handles it.

        // SOFT AUTO-HEAL
        // If status is AWAITING_FULFILLMENT and older than 30s, trigger finalization in background
        // Ideally we should import finalizeSuccessfulPayment but dynamically to avoid loop issues?
        // `lib/payment-logic.js` usually doesn't import finalize-payment directly to avoid circles?
        // Let's assume we can't import it synchronously here easily without checking deps.
        // Actually, we can dynamic import.
        if (safeStatus === "AWAITING_FULFILLMENT" && result.createdAt) {
            const createdTime = new Date(result.createdAt).getTime();
            const now = Date.now();
            if (now - createdTime > 30000) { // 30s
                console.log(`[AUTO-HEAL] Triggering finalization for ${invoiceId} (stuck > 30s)`);
                // Fire and forget - do not await
                import("../lib/finalize-payment.js").then(({ finalizeSuccessfulPayment }) => {
                    finalizeSuccessfulPayment(invoiceId, { source: 'AUTO_HEAL' }).catch(() => { });
                });
            }
        }

        return res.status(200).json({
            ...result,
            status: safeStatus
        });
    } catch (e) {
        console.error(`[CHECK STATUS ERROR] ${invoiceId}`, e);
        return res.status(200).json({ status: "CREATED", invoiceId, message: "Status check temporary delay" });
    }
}

