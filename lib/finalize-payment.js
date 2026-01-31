import {
    check3ThixStatus,
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
import { getPrice } from "./price.js";
// verifyFulfillment removed as we use check3ThixStatus from payment-logic (which wraps 3thix.fulfillment.js logic if correctly imported, but wait, check3ThixStatus is in 3thix.fulfillment.js actually)
// Correction: check3ThixStatus is exported from lib/3thix.fulfillment.js
import { check3ThixStatus as check3ThixStatusAPI } from "./3thix.fulfillment.js";

/**
 * FINALIZES SUCCESSFUL PAYMENT
 * Logic:
 * 1. ALWAYS verifies success via 3Thix API (Single Source of Truth)
 * 2. Normalizes Identity (3Thix Data > Sheets Data)
 * 3. Calculates tokens/price
 * 4. Updates PAYMENT_TRANSACTIONS (Atomic Update)
 * 5. Sends Emails (User + Admin)
 * 
 * @param {string} invoiceId 
 * @param {object} [ignoredPayload] - We ignore webhook payload for status authority
 * @param {string} source - 'WEBHOOK', 'ADMIN_RECONCILE', 'AUTO_HEAL'
 */
export async function finalizeSuccessfulPayment(invoiceId, ignoredPayload = null, source = 'UNKNOWN') {
    if (!invoiceId) {
        return { status: "ERROR", reason: "MISSING_ID" };
    }

    console.log(`[FINALIZE] Processing ${invoiceId} (Source: ${source})`);

    // 1. Authoritative Check (MANDATORY)
    // We ignore the webhook payload status because we demand a live check.
    const authResult = await check3ThixStatusAPI(invoiceId);

    if (authResult.status !== 'SUCCESS') {
        console.log(`[FINALIZE] 3Thix status is ${authResult.status}. Cannot finalize.`);
        return { status: authResult.status, reason: "NOT_PAID_ON_GATEWAY" };
    }

    // 2. Fetch Current State from Sheets (for fallback identity)
    const tx = await findTransaction(invoiceId);

    // Idempotency: If already SUCCESS and EMAIL SENT, exit.
    if (tx && tx.status === 'SUCCESS' && tx.email_sent_user === 'YES') {
        console.log(`[FINALIZE] Invoice ${invoiceId} already fully complete.`);
        return { status: 'SUCCESS', source: 'CACHE', idempotent: true };
    }

    // 3. Normalize Identity
    // 3Thix Data is Authoritative for Payer Identity
    const invoiceData = authResult.data?.invoice || authResult.data || {};
    let metadata = {};
    if (typeof invoiceData.metadata === 'string') {
        try { metadata = JSON.parse(invoiceData.metadata); } catch (e) { }
    } else {
        metadata = invoiceData.metadata || {};
    }

    // Resolution Strategy: 3Thix Metadata > Sheets/TX Data > Defaults
    const name = metadata.name || tx?.name || "";
    const email = metadata.email || tx?.email || "";
    const walletAddress = metadata.wallet_address || metadata.walletAddress || tx?.wallet_address || "";
    const walletNetwork = detectWalletNetwork(walletAddress);

    // Amount/Currency from 3Thix
    const amount = parseFloat(invoiceData.amount || 0);
    const currency = invoiceData.currency || "USD";

    // 4. Calculate Tokens
    let tokenPrice = 0;
    let tokens = 0;

    // Use price from TX if already locked? No, usually calculate at spot time or leverage metadata if we stored it?
    // User requirement: "Write token_price, tokens_purchased" implies calculation now.
    // If TX has it, we could respect it, but let's recalculate to be safe or use current price.
    // Ideally we assume price at payment time? 
    // For now, fetch current price if not in TX, or just use current price to be "live".
    if (tx && parseFloat(tx.token_price) > 0) {
        tokenPrice = parseFloat(tx.token_price);
    } else {
        try {
            const priceData = await getPrice();
            tokenPrice = priceData?.price_usd || 0;
        } catch (e) {
            console.error(`[FINALIZE] Price fetch error: ${e.message}`);
        }
    }

    if (tokenPrice > 0 && amount > 0) {
        tokens = parseFloat((amount / tokenPrice).toFixed(6));
    }

    // 5. Update PAYMENT_TRANSACTIONS (Atomic)
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

    // 6. Send Emails
    let emailSent = false;
    if (email && tokens > 0) {
        // Only send if not already sent
        if (!tx || tx.email_sent_user !== 'YES') {
            try {
                await sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress);
                emailSent = true;
            } catch (e) {
                console.error(`[FINALIZE] Email sending failed: ${e.message}`);
            }
        } else {
            emailSent = true; // Already sent
        }
    }

    // Admin Notification (Best Effort)
    if (!tx || tx.email_sent_admin !== 'YES') {
        try {
            await sendAdminPaymentNotification({
                invoiceId,
                amount,
                currency,
                tokens,
                tokenPrice,
                email,
                name,
                walletAddress,
                source: `${source}_FULFILLED`,
                timestamp: new Date().toISOString()
            });
        } catch (e) {
            console.error(`[FINALIZE] Admin email failed: ${e.message}`);
        }
    }

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

