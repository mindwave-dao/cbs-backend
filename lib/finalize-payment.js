import {
    detectWalletNetwork
} from "./payment-logic.js";
import {
    updateTransactionStatus,
    findTransaction
} from "./sheets.logic.js";
import {
    sendUserPaymentSuccessEmail,
    sendAdminPaymentNotification
} from "./email.logic.js";
import { getAuthoritativePrice } from "./price.js";

/**
 * FINALIZES SUCCESSFUL PAYMENT
 * 
 * With the new 3thix direct payment API, payments are processed synchronously.
 * This function is now primarily used for:
 * 1. Sending emails after successful payment
 * 2. Calculating tokens and updating final transaction state
 * 3. Recovery/reconciliation if the main flow was interrupted
 * 
 * @param {string} invoiceId 
 * @param {object} options - Options object
 * @param {string} options.source - 'DIRECT_PAYMENT', 'ADMIN_RECONCILE', 'AUTO_HEAL'
 */
export async function finalizeSuccessfulPayment(invoiceId, options = {}) {
    const source = options.source || 'UNKNOWN';

    if (!invoiceId) {
        console.error("[FINALIZE] CRITICAL: Missing invoiceId");
        throw new Error('Missing invoiceId in finalization');
    }

    console.log(`[FINALIZE] Starting finalization for ${invoiceId} (Source: ${source})`);

    // 1. Fetch Current State from Sheets
    const tx = await findTransaction(invoiceId);

    if (!tx) {
        console.error(`[FINALIZE] Invoice ${invoiceId} not found in DB`);
        return { status: 'NOT_FOUND', reason: 'INVOICE_NOT_IN_DB' };
    }

    // 2. Check current status - with new API, status is already set by createInvoiceLogic
    // Only proceed if status is SUCCESS
    if (tx.status !== 'SUCCESS') {
        console.log(`[FINALIZE] Invoice ${invoiceId} status is ${tx.status}. Cannot finalize.`);
        return { status: tx.status, reason: "NOT_PAID" };
    }

    // 3. Idempotency: If already SUCCESS and EMAIL SENT, exit.
    if (tx.email_sent_user === 'YES' && tx.email_sent_admin === 'YES') {
        console.log(`[FINALIZE] Invoice ${invoiceId} already fully complete.`);
        return { status: 'SUCCESS', source: 'CACHE', idempotent: true };
    }

    // 4. Get identity from transaction
    const email = tx.email || "";
    const name = tx.name || "";
    const walletAddress = tx.wallet_address || "";
    const walletNetwork = tx.wallet_network || detectWalletNetwork(walletAddress);

    // STRICT EMAIL CHECK
    if (!email) {
        console.error(`[FINALIZE] CRITICAL: No email found for ${invoiceId}. Cannot finalize.`);
        throw new Error("No user email available");
    }

    // Amount/Currency
    const amount = parseFloat(tx.amount || 0);
    const currency = tx.currency || "USD";

    // 5. Calculate Tokens (if not already calculated)
    let tokenPrice = parseFloat(tx.token_price) || 0;
    let tokens = parseFloat(tx.tokens_purchased) || 0;

    if (tokenPrice === 0 && amount > 0) {
        try {
            const priceData = await getAuthoritativePrice(amount);
            tokenPrice = priceData.price_usd || 0;
        } catch (e) {
            console.error(`[FINALIZE] Price fetch error: ${e.message}`);
        }
    }

    if (tokenPrice > 0 && amount > 0 && tokens === 0) {
        tokens = Math.round(amount / tokenPrice);
        console.log(`[PAYMENT_FINALIZATION] Calculated tokens: ${tokens} (Price: ${tokenPrice})`);
    }

    console.log(`[PAYMENT_FINALIZATION] Finalizing for ${invoiceId}. Source: ${source}. Tokens: ${tokens}. Amount: ${amount}`);

    // 6. Update PAYMENT_TRANSACTIONS with token info
    await updateTransactionStatus(invoiceId, 'SUCCESS', {
        email,
        name,
        walletAddress,
        walletNetwork,
        amount,
        currency,
        tokenPrice,
        tokens
    });

    // 7. Send Emails (PARALLEL)
    // We fire both user and admin emails concurrently to reduce total wait time.
    const emailPromises = [];

    // User Email Promise
    if (tokens > 0) {
        if (tx.email_sent_user !== 'YES') {
            emailPromises.push(
                sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress)
                    .then(res => ({ type: 'USER', res }))
                    .catch(e => ({ type: 'USER', error: e }))
            );
        } else {
            console.log(`[FINALIZE] User email already sent for ${invoiceId}`);
        }
    }

    // Admin Email Promise
    if (tx.email_sent_admin !== 'YES') {
        emailPromises.push(
            sendAdminPaymentNotification({
                invoiceId, amount, currency, tokens, tokenPrice, email, name, walletAddress,
                source: `${source}_FULFILLED`, timestamp: new Date().toISOString()
            })
                .then(res => ({ type: 'ADMIN', res }))
                .catch(e => ({ type: 'ADMIN', error: e }))
        );
    }

    // Await all (settled)
    const results = await Promise.allSettled(emailPromises);

    // Process Results
    let emailSent = (tx.email_sent_user === 'YES'); // Start with existing state

    results.forEach(p => {
        if (p.status === 'fulfilled') {
            const { type, res, error } = p.value;
            if (error) {
                console.error(`[FINALIZE] ${type} email failed with error: ${error.message}`);
            } else {
                if (type === 'USER' && res?.success) {
                    console.log(`[FINALIZE] User email sent successfully for ${invoiceId}`);
                    emailSent = true;
                } else if (type === 'USER') {
                    console.error(`[FINALIZE] User email attempt failed: ${res?.error || 'Unknown'}`);
                }
            }
        }
    });

    return {
        status: 'SUCCESS',
        updated: true,
        tokens,
        tokenPrice,
        emailSentUser: emailSent
    };
}

// Alias
export const checkFulfillmentStatus = finalizeSuccessfulPayment;
