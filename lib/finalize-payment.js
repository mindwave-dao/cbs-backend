import {
    check3ThixAuthoritative,
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
import { verifyFulfillment } from "./fulfillment.js";
import crypto from "crypto";

/**
 * FINALIZES SUCCESSFUL PAYMENT
 * Logic:
 * 1. Verifies success (via payload or 3Thix check)
 * 2. Calculates tokens/price
 * 3. Updates PAYMENT_TRANSACTIONS (Single Source of Truth)
 * 4. Sends Emails (User + Admin)
 * 
 * @param {string} invoiceId 
 * @param {object} [paymentPayload] - Optional payload from webhook
 * @param {string} source - 'WEBHOOK', 'ADMIN_RECONCILE', 'AUTO_HEAL'
 */
export async function finalizeSuccessfulPayment(invoiceId, paymentPayload = null, source = 'UNKNOWN') {
    if (!invoiceId) {
        return { status: "ERROR", reason: "MISSING_ID" };
    }

    console.log(`[FINALIZE] Processing ${invoiceId} (Source: ${source})`);

    // 1. Fetch Current State from Sheets
    const tx = await findTransaction(invoiceId);

    // Idempotency: If already SUCCESS, just ensure emails are sent? 
    // User Constraint: "RECONCILE = DISASTER RECOVERY ONLY"
    // "No duplicate logic"

    // If tx exists and is SUCCESS, strictly check if we need to do anything.
    if (tx && tx.STATUS === 'SUCCESS') {
        console.log(`[FINALIZE] Invoice ${invoiceId} already SUCCESS in DB.`);

        // Check if emails were sent
        if (tx.EMAIL_SENT === 'YES') {
            console.log(`[FINALIZE] Emails already sent. Fully Idempotent. Exiting.`);
            return { status: 'SUCCESS', source: 'CACHE', idempotent: true };
        } else {
            console.log(`[FINALIZE] Emails MISSING. Repairing...`);
            // Proceed to calculation & email logic (re-using headers)
        }
    }

    // 2. Validate Success Status
    // If payload provided (Webhook), trust it but verify status is success
    let isSuccess = false;
    let metadata = {};
    let amount = 0;
    let currency = "USD";

    if (paymentPayload) {
        // Webhook flow
        const event = paymentPayload.event || paymentPayload.type || paymentPayload.status;
        isSuccess =
            event === "ORDER_COMPLETED" ||
            event === "INVOICE_PAID" ||
            paymentPayload.status === "PAID" ||
            paymentPayload.payment_status === "APPROVED" ||
            paymentPayload.payment_status === "PAID";

        // Extract metadata
        const invoiceData = paymentPayload.invoice || paymentPayload; // structure varies
        amount = parseFloat(invoiceData.amount || 0);
        currency = invoiceData.currency || "USD";

        // Metadata might be stringified
        if (typeof invoiceData.metadata === 'string') {
            try { metadata = JSON.parse(invoiceData.metadata); } catch (e) { }
        } else {
            metadata = invoiceData.metadata || {};
        }

    } else {
        // Reconcile / Heal flow: Fetch from 3Thix
        const authResult = await check3ThixAuthoritative(invoiceId);
        if (authResult.status !== 'SUCCESS') {
            console.log(`[FINALIZE] 3Thix status is ${authResult.status}. Cannot finalize.`);
            // STRICT: If not success, do nothing.
            return { status: authResult.status, reason: "NOT_PAID_ON_GATEWAY" };
        }
        isSuccess = true;

        // Map data
        const invoiceData = authResult.data?.invoice || authResult.data || {};
        amount = parseFloat(invoiceData.amount || 0);
        currency = invoiceData.currency || "USD";

        if (typeof invoiceData.metadata === 'string') {
            try { metadata = JSON.parse(invoiceData.metadata); } catch (e) { }
        } else {
            metadata = invoiceData.metadata || {};
        }
    }

    if (!isSuccess) {
        return { status: 'PENDING', reason: "Payment not successful" };
    }

    // 3. Prepare Data for Persistence
    const name = metadata.name || tx?.NAME || "";
    const email = metadata.email || tx?.EMAIL || "";
    const walletAddress = metadata.wallet_address || metadata.walletAddress || tx?.WALLET_ADDRESS || "";
    const walletNetwork = detectWalletNetwork(walletAddress);

    // 4. Calculate Tokens
    let tokenPrice = 0;
    let tokens = 0;

    try {
        const priceData = await getPrice();
        tokenPrice = priceData?.price_usd || 0;

        // Fallback: If price API fails, check if we have it in DB from creation? 
        // No, CREATED usually doesn't have token price locked.
        // User said: "calculate tokenPrice... calculate tokensPurchased" at finalization.

        if (tokenPrice > 0 && amount > 0) {
            tokens = parseFloat((amount / tokenPrice).toFixed(6));
        } else {
            console.warn(`[FINALIZE] Token calclation warning. Amount: ${amount}, Price: ${tokenPrice}`);
        }
    } catch (e) {
        console.error(`[FINALIZE] Price fetch error: ${e.message}`);
    }

    // 5. Update PAYMENT_TRANSACTIONS (Single Source of Truth)
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

    // NOTE: Activity Log write removed per instruction "Only write to PAYMENT_TRANSACTIONS"

    // 6. Send Emails
    // "User email must be sent when and only when: status === SUCCESS, tokens > 0..."
    let emailSent = false;

    if (email && tokens > 0) {
        try {
            await sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress);
            emailSent = true;
        } catch (e) {
            console.error(`[FINALIZE] Email sending failed: ${e.message}`);
        }
    } else {
        console.warn(`[FINALIZE] Skipping user email. Email: ${!!email}, Tokens: ${tokens}`);
    }

    // Admin Notification
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

    return {
        status: 'SUCCESS',
        updated: true,
        tokens,
        tokenPrice,
        emailSentUser: emailSent
    };
}

// Alias for compatibility if needed, but we should use finalizeSuccessfulPayment
export const checkFulfillmentStatus = finalizeSuccessfulPayment;
