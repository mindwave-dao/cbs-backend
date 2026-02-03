/**
 * 3thix Webhook Handler
 * 
 * Handles payment completion webhooks from 3thix for the intent-based payment flow.
 * When a user completes payment via the 3thix iframe/redirect, 3thix sends a webhook
 * to notify us of the payment status.
 * 
 * Expected webhook payload (based on 3thix documentation):
 * {
 *   "event": "payment.success" | "payment.failed" | "payment.cancelled",
 *   "intent_id": "0194d210-xxxx-xxxx",
 *   "reference_id": "mw-1234567890",  // Our invoiceId
 *   "status": "completed" | "failed" | "cancelled",
 *   "amount": 100.00,
 *   "currency": "USD",
 *   "metadata": { wallet_address, wallet_network, source },
 *   "timestamp": "2026-02-02T00:00:00Z"
 * }
 */

import { updateTransactionStatus, findTransaction } from "./sheets.logic.js";
import { finalizeSuccessfulPayment } from "./finalize-payment.js";

/**
 * Normalizes 3thix webhook status to internal standard
 */
function normalizeWebhookStatus(event, status) {
    if (!event && !status) return 'PENDING';

    const eventUpper = (event || '').toUpperCase();
    const statusUpper = (status || '').toUpperCase();

    // Check event first
    if (eventUpper === 'PAYMENT.SUCCESS') return 'SUCCESS';
    if (eventUpper === 'PAYMENT.FAILED') return 'FAILED';
    if (eventUpper === 'PAYMENT.CANCELLED') return 'CANCELLED';

    // Fallback to status
    if (['COMPLETED', 'SUCCESS', 'PAID', 'APPROVED', 'SETTLED'].includes(statusUpper)) return 'SUCCESS';
    if (['FAILED', 'ERROR', 'DECLINED'].includes(statusUpper)) return 'FAILED';
    if (['CANCELLED', 'CANCELED', 'EXPIRED'].includes(statusUpper)) return 'CANCELLED';

    return 'PENDING';
}

/**
 * Main webhook handler
 */
export async function handle3ThixWebhook(req, res) {
    console.log('[WEBHOOK] 3thix webhook received');

    // Only accept POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const payload = req.body;

        console.log('[CARD_FLOW] [WEBHOOK] Payload received:', JSON.stringify(payload));

        // Extract key fields
        const {
            event,
            intent_id,
            reference_id,  // This is our invoiceId
            status,
            amount,
            currency,
            metadata,
            timestamp
        } = payload;

        // reference_id is our invoiceId (we set it when creating the intent)
        const invoiceId = reference_id;

        if (!invoiceId) {
            console.error('[WEBHOOK] Missing reference_id (invoiceId) in payload');
            // Return 200 to prevent 3thix from retrying - we can't process without invoiceId
            return res.status(200).json({
                success: false,
                error: 'Missing reference_id',
                received: true
            });
        }

        console.log(`[WEBHOOK] Processing for invoiceId: ${invoiceId}, event: ${event}, intent_id: ${intent_id}`);

        // Verify transaction exists
        const tx = await findTransaction(invoiceId);
        if (!tx) {
            console.error(`[WEBHOOK] Transaction not found: ${invoiceId}`);
            return res.status(200).json({
                success: false,
                error: 'Transaction not found',
                received: true
            });
        }

        // Normalize status
        const normalizedStatus = normalizeWebhookStatus(event, status);
        console.log(`[WEBHOOK] Normalized status: ${normalizedStatus}`);

        // Idempotency check - if already SUCCESS, don't reprocess
        if (tx.status === 'SUCCESS') {
            console.log(`[WEBHOOK] Transaction ${invoiceId} already SUCCESS. Skipping.`);
            return res.status(200).json({
                success: true,
                message: 'Already processed',
                invoiceId,
                idempotent: true
            });
        }

        // Handle based on status
        if (normalizedStatus === 'SUCCESS') {
            console.log(`[CARD_FLOW] [WEBHOOK] Payment SUCCESS for ${invoiceId}. Updating DB...`);

            // Update transaction to SUCCESS
            await updateTransactionStatus(invoiceId, 'SUCCESS', {
                email: tx.email || metadata?.email,
                name: tx.name || metadata?.name,
                walletAddress: tx.wallet_address || metadata?.wallet_address,
                walletNetwork: tx.wallet_network || metadata?.wallet_network,
                amount: amount || tx.amount,
                currency: currency || tx.currency
            });

            // Trigger email notifications and token calculation (async, don't block webhook response)
            finalizeSuccessfulPayment(invoiceId, { source: 'WEBHOOK' })
                .then(result => console.log(`[CARD_FLOW] [WEBHOOK] Finalization complete for ${invoiceId}:`, result.status))
                .catch(err => console.error(`[CARD_FLOW] [WEBHOOK] Finalization error for ${invoiceId}:`, err.message));

            return res.status(200).json({
                success: true,
                invoiceId,
                status: 'SUCCESS',
                message: 'Payment processed successfully'
            });

        } else if (normalizedStatus === 'FAILED' || normalizedStatus === 'CANCELLED') {
            console.log(`[CARD_FLOW] [WEBHOOK] Payment ${normalizedStatus} for ${invoiceId}`);

            // Update transaction to FAILED/CANCELLED
            await updateTransactionStatus(invoiceId, normalizedStatus);

            return res.status(200).json({
                success: true,
                invoiceId,
                status: normalizedStatus,
                message: `Payment ${normalizedStatus.toLowerCase()}`
            });

        } else {
            // Status is still PENDING - log but don't update
            console.log(`[WEBHOOK] Payment still PENDING for ${invoiceId}`);

            return res.status(200).json({
                success: true,
                invoiceId,
                status: 'PENDING',
                message: 'Payment still pending'
            });
        }

    } catch (error) {
        console.error('[WEBHOOK] Error processing webhook:', error);

        // Return 200 to prevent unnecessary retries, but log the error
        return res.status(200).json({
            success: false,
            error: error.message,
            received: true
        });
    }
}

export default handle3ThixWebhook;
