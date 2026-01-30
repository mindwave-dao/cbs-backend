import { check3ThixAuthoritative } from "../../lib/payment-logic.js";
import { normalize3ThixStatus } from "../../lib/payment-logic.js";
// Note: normalize3ThixStatus is in payment-logic.js (dash) as per Step 190, line 433.
// Wait, Step 201 shows: import { finalizeSuccessfulPayment, normalize3ThixStatus } from "../../lib/payment.logic.js"; 
// payment.logic.js (dot) might be just re-exporting or old.
// centralized `finalize-payment.js` does NOT export normalize3ThixStatus.
// I should import normalize3ThixStatus from `../../lib/payment-logic.js` (dash) to be safe/direct.

import { checkFulfillmentStatus } from "../../lib/finalize-payment.js";

import { reconcilePendingInvoices } from "../../lib/reconcile.logic.js";
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
    const authHeader = req.headers['authorization'];
    const validToken = ADMIN_TOKEN || WEBHOOK_AUTH_TOKEN;

    if (!authHeader || !authHeader.includes(validToken)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    const { invoiceId } = req.body;

    try {
        // CASE 1: Bulk Scan (Cron Mode)
        if (!invoiceId) {
            console.log(`[ADMIN RECONCILE] Invoice ID missing. Starting Bulk Scan.`);
            const result = await reconcilePendingInvoices({
                minAgeMinutes: 3,
                maxAgeHours: 24
            });
            return res.json({
                ok: true,
                mode: "SCAN",
                stats: result
            });
        }

        // CASE 2: Single Invoice (Manual Repair)
        console.log(`[ADMIN RECONCILE] Starting for SINGLE invoice: ${invoiceId}`);

        // 1. Get Invoice from 3THIX
        // Note: finalizeSuccessfulPayment does authoritative check internally!
        // But user provided pseudo-code: "Query 3THIX... If APPROVED... Upgrade".
        // finalizeSuccessfulPayment DOES that check.
        // So we can just call it directly?
        // User request mandated: "Call finalizeSuccessfulPayment(invoiceId, 'ADMIN_RECONCILE')"
        // But finalizeSuccessfulPayment returns what?
        // My implementation returns { success: true/false, reason: ... }
        // If I just call it, it handles the check.

        // HOWEVER, to return useful status to the caller (Admin), specifically "Why did it fail?", 3Thix check here provides "Reason".
        // finalizeSuccessfulPayment logic I wrote:
        // if (!authResult) return reason: THIX_API_FAIL
        // if (normalizedStatus !== 'SUCCESS') return reason: NOT_PAID

        // So I can JUST call finalizeSuccessfulPayment!

        const result = await checkFulfillmentStatus(invoiceId, "ADMIN_RECONCILE");


        if (result.status !== 'SUCCESS') {
            return res.status(409).json({
                error: "Reconciliation Failed",
                reason: result.reason,
                status: result.status,
                details: result
            });
        }

        console.log(`[ADMIN RECONCILE] Success for ${invoiceId}`);

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
