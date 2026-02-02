import { findCryptoPayment, updateCryptoPaymentStatus } from "../../lib/sheets.logic.js";
import { sendCryptoUserConfirmationEmail, sendCryptoAdminConfirmationEmail } from "../../lib/email.logic.js";

/**
 * POST /api/admin/crypto/confirm
 * 
 * Admin endpoint to confirm a crypto payment after manual verification.
 * Updates CRYPTO_PAYMENTS status to CONFIRMED and sends confirmation emails.
 * 
 * Authentication: Requires ADMIN_TOKEN header
 * 
 * Request Body:
 * {
 *   "txHashLast6": "abc123",
 *   "email": "user@example.com"
 * }
 * 
 * Response:
 * - 200: { success: true, message: "..." }
 * - 400: Missing fields
 * - 401: Unauthorized
 * - 404: Payment not found
 * - 409: Already confirmed
 * - 500: Server error
 */
export default async function handler(req, res) {
    // Only allow POST
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // 1. Authenticate Admin
    const adminToken = req.headers["x-admin-token"] || req.headers["admin-token"];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
        console.warn(`[ADMIN_CRYPTO_CONFIRM] Unauthorized attempt`);
        return res.status(401).json({ error: "Unauthorized" });
    }

    // 2. Validate Request Body
    const { txHashLast6, email } = req.body;
    if (!txHashLast6 || !email) {
        return res.status(400).json({ error: "Missing required fields: txHashLast6, email" });
    }

    console.log(`[ADMIN_CRYPTO_CONFIRM] Processing confirmation for ${email} / ${txHashLast6}`);

    try {
        // 3. Find the Crypto Payment
        const payment = await findCryptoPayment(txHashLast6, email);
        if (!payment) {
            return res.status(404).json({
                error: "Crypto payment not found",
                details: "No payment found with the provided txHashLast6 and email"
            });
        }

        // 4. Check if Already Confirmed
        if (payment.status === "CONFIRMED") {
            return res.status(409).json({
                error: "Already confirmed",
                message: "This payment has already been confirmed"
            });
        }

        // 5. Update Status to CONFIRMED
        const updated = await updateCryptoPaymentStatus(payment.rowIndex, "CONFIRMED");
        if (!updated) {
            throw new Error("Failed to update payment status in sheet");
        }

        // 6. Send Confirmation Emails (Fire & Forget)
        const emailParams = {
            email: payment.email,
            fullName: payment.fullName,
            walletAddress: payment.walletAddress,
            amount: payment.amount,
            estimatedTokens: payment.estimatedTokens,
            network: payment.network,
            txHashLast6: payment.txHashLast6,
            timestamp: payment.timestamp
        };

        // Send both emails in parallel, don't block response
        Promise.all([
            sendCryptoUserConfirmationEmail(emailParams),
            sendCryptoAdminConfirmationEmail(emailParams)
        ]).then(([userRes, adminRes]) => {
            console.log(`[ADMIN_CRYPTO_CONFIRM] Emails sent - User: ${userRes?.success}, Admin: ${adminRes}`);
        }).catch(err => {
            console.error(`[ADMIN_CRYPTO_CONFIRM] Email error: ${err.message}`);
        });

        // 7. Return Success
        return res.status(200).json({
            success: true,
            message: "Payment confirmed successfully",
            data: {
                email: payment.email,
                fullName: payment.fullName,
                amount: payment.amount,
                network: payment.network,
                txHashLast6: payment.txHashLast6,
                status: "CONFIRMED"
            }
        });

    } catch (e) {
        console.error(`[ADMIN_CRYPTO_CONFIRM] Error: ${e.message}`);
        return res.status(500).json({
            error: "Internal server error",
            message: "Failed to confirm payment"
        });
    }
}
