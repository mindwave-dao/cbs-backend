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

import { updateTransactionStatus, findTransaction, appendToCardTransactions, findTransactionByTransactionId } from "./sheets.logic.js";
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

        console.log(`[CARD_FLOW] [VERIFY] Request for invoice_id: ${invoice_id}, intent_id: ${intent_id}`);

        if (!intent_id && !invoice_id) {
            return res.status(400).json({
                success: false,
                error: 'Missing intent_id or invoice_id'
            });
        }

        // Find transaction by invoice_id (our reference)
        // The invoice_id is our reference_id that we sent to 3thix
        let invoiceId = invoice_id;

        // --- FALLBACK LOGIC START ---
        // If invoiceId is missing but we have intent_id, try to find it in CARD_TRANSACTIONS
        if (!invoiceId && intent_id) {
            console.log(`[VERIFY-INTENT] Missing invoiceId. Attempting to lookup by intent_id: ${intent_id}`);
            const lookup = await findTransactionByTransactionId(intent_id);

            if (lookup && lookup.invoice_id) {
                invoiceId = lookup.invoice_id;
                console.log(`[VERIFY-INTENT] Recovered invoiceId ${invoiceId} from intent_id ${intent_id}`);
            } else {
                console.error(`[VERIFY-INTENT] Failed to recover invoiceId for intent ${intent_id}`);
                // Proceeding will fail below, but we log explicitly here
            }
        }
        // --- FALLBACK LOGIC END ---

        if (!invoiceId) {
            console.error('[VERIFY-INTENT] Cannot verify without invoice_id (Fallback failed)');
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

            // --- START UPSTREAM VERIFICATION ---
            console.log(`[VERIFY-INTENT] Verifying upstream status for intent: ${intent_id}`);
            try {
                const upstreamStatus = await check3thixIntentStatus(intent_id);
                console.log(`[VERIFY-INTENT] Upstream status: ${upstreamStatus.status}`);

                if (upstreamStatus.status !== 'succeeded') {
                    // If it's not succeeded (e.g. requires_payment), we do NOT fulfill
                    console.warn(`[VERIFY-INTENT] Upstream says ${upstreamStatus.status}, NOT fulfilling.`);

                    // If it's requires_payment, we just return that status
                    return res.status(200).json({
                        success: false,
                        invoiceId,
                        status: upstreamStatus.status,
                        message: `Payment status is ${upstreamStatus.status}`
                    });
                }

                // If succeeded, we proceed to fulfill
                console.log(`[VERIFY-INTENT] Upstream verified SUCCESS. Proceeding to fulfill.`);

            } catch (err) {
                console.error(`[VERIFY-INTENT] Upstream verification failed: ${err.message}`);
                // FALLBACK: If upstream check fails (e.g. server error), do we trust frontend?
                // For security, we should probably FAIL or require retry.
                // But if it's just a network blip?
                // Let's be strict: if we can't verify, we don't fulfill.
                return res.status(502).json({
                    success: false,
                    error: "Unable to verify payment status with gateway"
                });
            }
            // --- END UPSTREAM VERIFICATION ---

            console.log(`[CARD_FLOW] [VERIFY] Updating ${invoiceId} to SUCCESS (via intent_id: ${intent_id})`);

            // Update transaction to SUCCESS
            await updateTransactionStatus(invoiceId, 'SUCCESS', {
                email: tx.email,
                name: tx.name,
                walletAddress: tx.wallet_address,
                walletNetwork: tx.wallet_network,
                amount: tx.amount,
                currency: tx.currency
            });

            // LOG INTENT ID TO CARD_TRANSACTIONS (Backup mechanism if create-invoice failed to save it)
            // We only have the intent_id and invoiceId here, so other fields will be empty/defaults
            // This ensures we at least have the mapping.
            try {
                await appendToCardTransactions({
                    invoiceId: invoiceId,
                    transactionId: intent_id,
                    amount: tx.amount ? parseFloat(tx.amount) : 0,
                    currency: tx.currency || 'USD',
                    status: 'SUCCESS',
                    // Optional: Try to fill other fields if available in tx (but they probably aren't)
                    billingName: tx.name,
                    billingEmail: tx.email
                });
                console.log(`[VERIFY-INTENT] Backfilled intent_id ${intent_id} to CARD_TRANSACTIONS`);
            } catch (err) {
                console.error(`[VERIFY-INTENT] Failed to backfill intention: ${err.message}`);
            }

            // Trigger finalization (emails + token calculation)
            // Don't await - let it run async to return response quickly
            finalizeSuccessfulPayment(invoiceId, { source: 'INTENT_VERIFY' })
                .then(result => console.log(`[CARD_FLOW] [VERIFY] Finalization complete for ${invoiceId}:`, result.status))
                .catch(err => console.error(`[CARD_FLOW] [VERIFY] Finalization error for ${invoiceId}:`, err.message));

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

/**
 * Checks intent status directly with 3thix API
 * @param {string} intentId 
 * @returns {Promise<{status: string, ...}>}
 */
async function check3thixIntentStatus(intentId) {
    const THIX_API_URL = (process.env.THIX_API_URL || "https://webadmin.3thix.com").replace(/\/$/, "");
    const THIX_PUBLIC_KEY = process.env.THIX_PUBLIC_KEY;
    const THIX_SECRET_KEY = process.env.THIX_SECRET_KEY;

    if (!THIX_PUBLIC_KEY || !THIX_SECRET_KEY) {
        throw new Error("Missing 3thix credentials");
    }

    const url = `${THIX_API_URL}/api/card/${intentId}/status`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            public_key: THIX_PUBLIC_KEY,
            secret_key: THIX_SECRET_KEY
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`3thix API Error: ${response.status} ${text}`);
    }

    const data = await response.json();

    if (!data.success || !data.data) {
        throw new Error(`3thix API Verification Failed: ${data.message?.error || data.remark || 'Unknown error'}`);
    }

    return data.data; // Expected { status: 'succeeded' | 'requires_payment', ... }
}

export default verifyPaymentIntent;
