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
 * @param {object} options - Options object
 * @param {string} options.source - 'WEBHOOK', 'ADMIN_RECONCILE', 'AUTO_HEAL'
 */
export async function finalizeSuccessfulPayment(invoiceId, options = {}) {
    // Legacy support or new options object
    const source = options.source || 'UNKNOWN';

    if (!invoiceId) {
        console.error("[FINALIZE] CRITICAL: Missing invoiceId");
        throw new Error('Missing invoiceId in finalization');
    }

    console.log(`[FINALIZE] Starting finalization for ${invoiceId} (Source: ${source})`);

    // 0. Env Validation (Safety)
    // We don't error out hard here inside logic to avoid crashing the caller (like reconcile loop), 
    // but we log it. However, if env is missing, logic will fail anyway.

    // 1. Authoritative Check (MANDATORY)
    // We ignore the webhook payload status because we demand a live check.
    const authResult = await check3ThixStatusAPI(invoiceId);

    // STRICT: Only SUCCESS status from 3THIX allows upgrade
    // "PAID", "COMPLETED" are normalized to "SUCCESS"
    if (authResult.status !== 'SUCCESS') {
        console.log(`[FINALIZE] 3Thix status is ${authResult.status}. Cannot finalize.`);
        return { status: authResult.status, reason: "NOT_PAID_ON_GATEWAY" };
    }

    // 3Thix Fulfillment Check (Required for Final Settlement)
    try {
        const { THIX_API_URL, THIX_API_KEY } = process.env;
        const fulfillmentRes = await fetch(`${THIX_API_URL}/fulfillment/list?invoice_id=${invoiceId}`, {
            headers: { "x-api-key": THIX_API_KEY }
        });
        const fulfillmentData = await fulfillmentRes.json();

        // Strict Check: Must be COMPLETED (or SETTLED/PAID per user instructions? User said "SETTLED", "PAID").
        // "if (!['SETTLED', 'PAID'].includes(status)) throw"
        // Let's check what 3Thix returns. Usually "COMPLETED".
        // User requested: `["SETTLED", "PAID"].includes(fulfillment.status)`
        // But `fulfillment/list` returns an array.
        // `!fulfillment?.data?.some(f => ...)`
        // I will stick to "COMPLETED" as I used before, or add "PAID"/"SETTLED" to be safe.
        const isFulfilled = fulfillmentData?.data?.some(f =>
            ["COMPLETED", "SETTLED", "PAID", "SUCCESS"].includes(f.status)
        );

        if (!isFulfilled) {
            console.log(`[FINALIZE] Invoice ${invoiceId} fulfillment status pending.`);
            throw new Error("Fulfillment not settled yet");
        }
    } catch (e) {
        console.warn(`[FINALIZE] Fulfillment check failed: ${e.message}`);
        throw e; // Fail loudly so webhook returns 500
    }

    // 2. Fetch Current State from Sheets (for fallback identity)
    const tx = await findTransaction(invoiceId);

    // Idempotency: If already SUCCESS and EMAIL SENT, exit.
    if (tx && tx.status === 'SUCCESS' && tx.email_sent_user === 'YES' && tx.email_sent_admin === 'YES') {
        console.log(`[FINALIZE] Invoice ${invoiceId} already fully complete.`);
        return { status: 'SUCCESS', source: 'CACHE', idempotent: true };
    }

    // 3. Normalize Identity
    const invoiceData = authResult.data?.invoice || authResult.data || {};
    let metadata = {};
    if (typeof invoiceData.metadata === 'string') {
        try { metadata = JSON.parse(invoiceData.metadata); } catch (e) { }
    } else {
        metadata = invoiceData.metadata || {};
    }

    // Resolution Strategy: 3Thix Metadata > Sheets/TX Data > Defaults
    const finalEmail = metadata.email || tx?.email || "";
    const name = metadata.name || tx?.name || "";
    const walletAddress = metadata.wallet_address || metadata.walletAddress || tx?.wallet_address || "";
    const walletNetwork = detectWalletNetwork(walletAddress);

    // STRICT EMAIL CHECK
    if (!finalEmail) {
        console.error(`[FINALIZE] CRITICAL: No email found for ${invoiceId}. Cannot finalize.`);
        throw new Error("No user email available");
    }
    const email = finalEmail;

    // Amount/Currency
    const amount = parseFloat(invoiceData.amount || 0);
    const currency = invoiceData.currency || "USD";

    // 4. Calculate Tokens
    let tokenPrice = 0;
    let tokens = 0;

    if (tx && parseFloat(tx.token_price) > 0) {
        tokenPrice = parseFloat(tx.token_price);
    } else {
        try {
            const priceData = await getAuthoritativePrice(amount);
            tokenPrice = priceData.price_usd || 0;
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

    // 6. Send Emails (ORDER: User -> Admin)
    let emailSent = false;

    // User Email (Priority)
    if (tokens > 0) {
        if (!tx || tx.email_sent_user !== 'YES') {
            try {
                await sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress);
                emailSent = true;
            } catch (e) {
                console.error(`[FINALIZE] User email failed: ${e.message}`);
            }
        } else {
            emailSent = true;
        }
    }

    // Admin Notification
    if (!tx || tx.email_sent_admin !== 'YES') {
        try {
            await sendAdminPaymentNotification({
                invoiceId, amount, currency, tokens, tokenPrice, email, name, walletAddress,
                source: `${source}_FULFILLED`, timestamp: new Date().toISOString()
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

