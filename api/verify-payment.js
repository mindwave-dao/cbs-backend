import { applyCors } from "../lib/cors.js";
import { findTransaction } from "../lib/sheets.logic.js";
import { finalizeSuccessfulPayment } from "../lib/finalize-payment.js";

/**
 * VERIFY PAYMENT ENDPOINT
 * POST /api/verify-payment
 *
 * Purpose:
 * - Used by frontend after payment completion
 * - With new 3thix direct API, payment status is already in DB
 * - Triggers email finalization if needed
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
        invoiceId.trim().length < 5
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
        // With the new 3thix direct payment API, status is already set by createInvoiceLogic
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

        // STEP 5: Check status from DB
        if (tx.status === "SUCCESS") {
            console.log(
                `[VERIFY-PAYMENT:${correlationId}] Payment SUCCESS`
            );

            // Trigger finalization to ensure emails are sent
            try {
                await finalizeSuccessfulPayment(invoiceId, {
                    source: "VERIFY_ENDPOINT",
                });
            } catch (finalizationError) {
                // IMPORTANT: Never fail UX
                console.error(
                    `[VERIFY-PAYMENT:${correlationId}] Finalization error`,
                    finalizationError
                );
            }

            // Re-read for updated values (tokens, etc)
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

        // STEP 6: Pending status
        if (tx.status === "PENDING" || tx.status === "CREATED") {
            return res.status(200).json({
                success: false,
                paymentStatus: "PENDING",
                invoiceId: tx.invoice_id,
                message: "Payment is being processed",
            });
        }

        // STEP 7: Failed status
        if (tx.status === "FAILED" || tx.status === "CANCELLED") {
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

        // STEP 8: Unknown status → Treat as pending
        console.warn(
            `[VERIFY-PAYMENT:${correlationId}] Unknown status ${tx.status}`
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
