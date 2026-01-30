
import { checkPaymentStatusLogic } from "../lib/payment.logic.js";
import { checkFulfillmentStatus } from "../lib/finalize-payment.js"; // Renamed/Refactored module
import { applyCors } from "../lib/cors.js";

/* ---------- CORS Setup for Read-Only ---------- */
function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
}

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
        // 1. Get Passive Status
        let result = await checkPaymentStatusLogic(invoiceId);

        // 2. Auto-Healing Logic
        // Triggers if status is CREATED or AWAITING_FULFILLMENT and age > 90s
        if (["CREATED", "AWAITING_FULFILLMENT"].includes(result.status)) {
            // checkPaymentStatusLogic doesn't return created_at timestamp usually? 
            // We need to fetch it or rely on internal logic? 
            // Logic in payment.logic.js returns: if CREATED -> createdTime.
            // Wait, checkPaymentStatusLogic implementation in lib/payment.logic.js returns { status: 'CREATED', ... }
            // It doesn't return created_at explicitely in the result object usually. 
            // Let's modify checkPaymentStatusLogic return or fetch it here? 
            // Or better, just import findTransaction here to check age?
            // Or assume checkPaymentStatusLogic returns sufficient data? 
            // Let's modify checkPaymentStatusLogic (next step) to return createdAt or age.
            // For now, let's assume result has details or we re-fetch.

            // Actually, simplest is to use `checkFulfillmentStatus` if result.status is pending.
            // But we want to respect the 90s rule? 
            // Let's just blindly call `checkFulfillmentStatus` if pending? No, rate limits.

            // I will update checkPaymentStatusLogic in next step to include `createdAt`.
            // Assuming result.createdAt exists:
            const createdAt = result.createdAt ? new Date(result.createdAt).getTime() : 0;
            const now = Date.now();
            const ageSeconds = (now - createdAt) / 1000;

            if (createdAt > 0 && ageSeconds > 90) {
                console.log(`[AUTO_HEAL] Healing invoice ${invoiceId} (Age: ${ageSeconds.toFixed(0)}s)`);
                const healResult = await checkFulfillmentStatus(invoiceId, 'AUTO_HEAL');
                if (healResult.status === 'SUCCESS') {
                    // Refetch or manual construct success response
                    return res.status(200).json({
                        status: 'SUCCESS',
                        invoiceId,
                        healed: true,
                        // Should return full details but we might need to re-fetch or use healResult if it returns data
                        // checkFulfillmentStatus returns { status, updated }
                        // Let's re-call checkPaymentStatusLogic to get formatted response
                        ...await checkPaymentStatusLogic(invoiceId)
                    });
                }
            }
        }

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
