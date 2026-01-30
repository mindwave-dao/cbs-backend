import { setCorsHeaders } from "../lib/cors.js";

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Method Check
    if (req.method !== 'GET') {
        return res.status(405).json({
            status: "ERROR",
            message: "Method not allowed. GET only."
        });
    }

    // 3. Safe Env Check (Optional but good practice)
    try {
        const { validateEnv } = await import("../lib/env.js");
        validateEnv();
    } catch (e) {
        return res.status(500).json({ error: "Server Configuration Error" });
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

        // 2. Auto-Healing Logic
        // Triggers if status is CREATED or AWAITING_FULFILLMENT and age > 60s
        const status = result.status;
        const isPending = status === "CREATED" || status === "AWAITING_FULFILLMENT" || status === "AWAITING_WEBHOOK";

        if (isPending) {
            const createdAt = result.createdAt ? new Date(result.createdAt).getTime() : 0;
            const now = Date.now();
            const ageSeconds = (now - createdAt) / 1000;

            if (createdAt > 0 && ageSeconds > 60) {
                console.log(`[AUTO_HEAL] Checking authoritative status for ${invoiceId} (Age: ${ageSeconds.toFixed(0)}s)`);

                // Dynamic imports to avoid circular dependency issues
                const { check3ThixStatus } = await import("../lib/3thix.fulfillment.js");
                const { finalizeSuccessfulPayment } = await import("../lib/payment-logic.js");

                const authResult = await check3ThixStatus(invoiceId);

                if (authResult.status === 'SUCCESS') {
                    console.log(`[AUTO_HEAL] Discovered SUCCESS for ${invoiceId}. Finalizing...`);
                    const finalResult = await finalizeSuccessfulPayment(invoiceId, authResult.data, 'AUTO_HEAL');

                    return res.status(200).json({
                        status: 'SUCCESS',
                        invoiceId,
                        amount: finalResult.amount,
                        currency: finalResult.currency,
                        tokens: finalResult.tokens,
                        tokenPrice: finalResult.tokenPrice,
                        walletAddress: finalResult.walletAddress,
                        healed: true,
                        emailSent: finalResult.emailSentUser
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
