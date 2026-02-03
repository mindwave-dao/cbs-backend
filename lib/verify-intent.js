/**
 * Intent Verification Endpoint
 * 
 * This endpoint is called by the frontend after receiving a payment completion
 * event from 3thix (via postMessage for iframe or redirect for URL integration).
 * 
 * The frontend sends the intent_id (received from 3thix) and we:
 * 1. Find the transaction by intent_id or reference_id
 * 2. Optionally verify with 3thix API (if they provide a status endpoint)
 * 3. Update transaction status to SUCCESS
 * 4. Trigger email notifications and token calculation
 * 
 * Endpoint: POST /api/verify-intent
 * Body: { intent_id: string, invoice_id?: string }
 */

import { updateTransactionStatus, findTransaction } from "./sheets.logic.js";
import { finalizeSuccessfulPayment } from "./finalize-payment.js";

/**
 * Verify payment intent and finalize transaction
 * Called by frontend after receiving payment.success postMessage or redirect
 */
export async function verifyPaymentIntent(req, res) {
    console.log('[VERIFY-INTENT] Payment verification request received');

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { intent_id, invoice_id } = req.body;

        console.log(`[VERIFY-INTENT] intent_id: ${intent_id}, invoice_id: ${invoice_id}`);

        if (!intent_id && !invoice_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing intent_id or invoice_id'
            });
        }

        // Find transaction by invoice_id (our reference)
        // The invoice_id is our reference_id that we sent to 3thix
        const invoiceId = invoice_id;

        if (!invoiceId) {
            console.error('[VERIFY-INTENT] Cannot verify without invoice_id');
            return res.status(400).json({
                success: false,
                error: 'invoice_id is required to verify payment'
            });
        }

        // Find transaction in our DB
        const tx = await findTransaction(invoiceId);

        if (!tx) {
            console.error(`[VERIFY-INTENT] Transaction not found: ${invoiceId}`);
            return res.status(404).json({
                success: false,
                error: 'Transaction not found'
            });
        }

        console.log(`[VERIFY-INTENT] Found transaction: ${invoiceId}, current status: ${tx.status}`);

        // Idempotency: If already SUCCESS, return cached result
        if (tx.status === 'SUCCESS') {
            console.log(`[VERIFY-INTENT] Transaction ${invoiceId} already SUCCESS`);
            return res.status(200).json({
                success: true,
                invoiceId,
                status: 'SUCCESS',
                message: 'Payment already verified',
                tokens: tx.tokens_purchased ? parseFloat(tx.tokens_purchased) : 0,
                tokenPrice: tx.token_price ? parseFloat(tx.token_price) : 0,
                amount: tx.amount ? parseFloat(tx.amount) : 0,
                emailSent: tx.email_sent_user === 'YES'
            });
        }

        // If status is PENDING and we received intent_id, trust the frontend
        // 3thix only sends payment.success postMessage on actual success
        if (tx.status === 'PENDING' && intent_id) {
            console.log(`[VERIFY-INTENT] Updating ${invoiceId} to SUCCESS (intent: ${intent_id})`);

            // Update transaction to SUCCESS
            await updateTransactionStatus(invoiceId, 'SUCCESS', {
                email: tx.email,
                name: tx.name,
                walletAddress: tx.wallet_address,
                walletNetwork: tx.wallet_network,
                amount: tx.amount,
                currency: tx.currency
            });

            // Trigger finalization (emails + token calculation)
            // Don't await - let it run async to return response quickly
            finalizeSuccessfulPayment(invoiceId, { source: 'INTENT_VERIFY' })
                .then(result => console.log(`[VERIFY-INTENT] Finalization complete for ${invoiceId}:`, result.status))
                .catch(err => console.error(`[VERIFY-INTENT] Finalization error for ${invoiceId}:`, err.message));

            return res.status(200).json({
                success: true,
                invoiceId,
                intentId: intent_id,
                status: 'SUCCESS',
                message: 'Payment verified and confirmed'
            });
        }

        // If status is FAILED or other, return current status
        return res.status(200).json({
            success: false,
            invoiceId,
            status: tx.status,
            message: `Payment status is ${tx.status}`
        });

    } catch (error) {
        console.error('[VERIFY-INTENT] Error:', error);
        return res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
}

export default verifyPaymentIntent;
