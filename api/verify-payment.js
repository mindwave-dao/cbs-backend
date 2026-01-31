import { applyCors } from "../lib/cors.js";
import { findTransaction } from "../lib/sheets.logic.js";
import { check3ThixStatus } from "../lib/3thix.fulfillment.js";
import { finalizeSuccessfulPayment } from "../lib/finalize-payment.js";

/**
 * VERIFY PAYMENT ENDPOINT
 * POST /api/verify-payment
 *
 * Purpose:
 * - Used by payment-success.html after return from 3thix
 * - Verifies payment status authoritatively
 * - Triggers finalization if webhook is delayed
 * - NEVER hard-fails UX
 */
export default async function handler(req, res) {
    // STEP 1: CORS
    if (applyCors(req, res)) return;

    // STEP 2: Method Guard
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // STEP 3: Input Validation
    const { invoiceId } = req.body || {};

    if (
        !invoiceId ||
        typeof invoiceId !== "string" ||
        invoiceId.trim().length < 10
    ) {
        return res.status(400).json({
            success: false,
            paymentStatus: "ERROR",
            message: "Invalid or missing invoice ID",
        });
    }

    const correlationId = `VP-${invoiceId.slice(0, 6)}-${Date.now()}`;
    console.log(`[VERIFY-PAYMENT:${correlationId}] Start ${invoiceId}`);

    try {
        // STEP 4: Lookup in Google Sheets (Source of Truth)
        const tx = await findTransaction(invoiceId);

        if (!tx) {
            console.warn(
                `[VERIFY-PAYMENT:${correlationId}] Invoice not found in DB`
            );
            return res.status(200).json({
                success: false,
                paymentStatus: "NOT_FOUND",
                message: "Invoice not found",
            });
        }

        // STEP 5: Idempotency Guard — already finalized
        if (tx.status === "SUCCESS") {
            console.log(
                `[VERIFY-PAYMENT:${correlationId}] Already SUCCESS (cached)`
            );

            return res.status(200).json({
                success: true,
                paymentStatus: "SUCCESS",
                invoiceId: tx.invoice_id,
                amount: parseFloat(tx.amount || 0),
                tokensPurchased: parseFloat(tx.tokens_purchased || 0),
                tokenPrice: parseFloat(tx.token_price || 0),
                walletAddress: tx.wallet_address || "",
                network: tx.wallet_network || "ETH / BSC",
                message: "Payment confirmed",
            });
        }

        // STEP 6: Authoritative Check with 3thix
        const authResult = await check3ThixStatus(invoiceId);

        console.log(
            `[VERIFY-PAYMENT:${correlationId}] 3thix status → ${authResult?.status}`
        );

        // STEP 7: Handle 3thix Result
        if (authResult?.status === "SUCCESS") {
            console.log(
                `[VERIFY-PAYMENT:${correlationId}] 3thix confirms SUCCESS`
            );

            // STEP 8: Finalize (Idempotent — safe even if webhook already ran)
            try {
                await finalizeSuccessfulPayment(invoiceId, {
                    source: "RETURN_URL_VERIFY",
                    rawPayload: authResult?.data,
                });
            } catch (finalizationError) {
                // IMPORTANT: Never fail UX — webhook may retry
                console.error(
                    `[VERIFY-PAYMENT:${correlationId}] Finalization error`,
                    finalizationError
                );
            }

            // STEP 9: Re-read DB for updated values
            const updatedTx = await findTransaction(invoiceId);

            return res.status(200).json({
                success: true,
                paymentStatus: "SUCCESS",
                invoiceId: updatedTx.invoice_id,
                amount: parseFloat(updatedTx.amount || 0),
                tokensPurchased: parseFloat(updatedTx.tokens_purchased || 0),
                tokenPrice: parseFloat(updatedTx.token_price || 0),
                walletAddress: updatedTx.wallet_address || "",
                network: updatedTx.wallet_network || "ETH / BSC",
                message: "Payment confirmed",
            });
        }

        // STEP 10: Pending / Processing
        if (
            authResult?.status === "PENDING" ||
            authResult?.status === "PROCESSING"
        ) {
            return res.status(200).json({
                success: false,
                paymentStatus: "PENDING",
                invoiceId: tx.invoice_id,
                message: "Payment is being processed",
            });
        }

        // STEP 11: Failed / Cancelled
        if (
            authResult?.status === "FAILED" ||
            authResult?.status === "CANCELLED"
        ) {
            console.warn(
                `[VERIFY-PAYMENT:${correlationId}] Payment FAILED`
            );
            return res.status(200).json({
                success: false,
                paymentStatus: "FAILED",
                invoiceId: tx.invoice_id,
                message: "Payment was not successful",
            });
        }

        // STEP 12: Unknown → Soft Pending
        console.warn(
            `[VERIFY-PAYMENT:${correlationId}] Unknown status ${authResult?.status}`
        );

        return res.status(200).json({
            success: false,
            paymentStatus: "PENDING",
            invoiceId: tx.invoice_id,
            message: "Payment status is being verified",
        });
    } catch (error) {
        console.error(
            `[VERIFY-PAYMENT:${correlationId}] Fatal error`,
            error
        );

        // UX-SAFE FAILURE
        return res.status(200).json({
            success: false,
            paymentStatus: "ERROR",
            message: "Unable to verify payment status",
        });
    }
}
