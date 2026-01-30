import {
    check3ThixAuthoritative,
    detectWalletNetwork
} from "./payment-logic.js";
import {
    updateTransactionStatus,
    appendToActivityLog,
    markEmailSent,
    findTransaction
} from "./sheets.logic.js";
import {
    sendUserPaymentSuccessEmail,
    sendAdminPaymentNotification
} from "./email.logic.js";
import { getPrice } from "./price.js";
import { verifyFulfillment } from "./fulfillment.js";
import crypto from "crypto";

import {
    check3ThixAuthoritative,
    detectWalletNetwork
} from "./payment-logic.js";
import {
    updateTransactionStatus,
    appendToActivityLog,
    markEmailSent,
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
 * AUTHORITATIVE PAYMENT FINALIZER
 * Checks 3Thix Fulfillment Status and upgrades to SUCCESS if confirmed.
 * 
 * @param {string} invoiceId - The 3Thix Invoice ID
 * @param {string} source - Source of the call ('WEBHOOK', 'AUTO_HEAL', 'ADMIN_RECONCILE')
 * @returns {Promise<{status: string, updated: boolean}>}
 */
export async function checkFulfillmentStatus(invoiceId, source = 'UNKNOWN') {
    if (!invoiceId) {
        console.error("[CHECK_FULFILLMENT] Missing invoiceId");
        return { status: "ERROR", reason: "MISSING_ID" };
    }

    console.log(`[CHECK_FULFILLMENT] Checking for ${invoiceId} (Source: ${source})`);

    // 1. Fetch Current State
    const tx = await findTransaction(invoiceId);
    if (tx && tx.STATUS === 'SUCCESS') {
        // Already SUCCESS, ensure idempotency (e.g. emails sent)
        if (tx.EMAIL_SENT !== 'YES') {
            console.log(`[CHECK_FULFILLMENT] Repairing SUCCESS state (Missing Emails) for ${invoiceId}`);
            // Fall through to re-run email logic (idempotency handled in helper)
        } else {
            return { status: 'SUCCESS', source: 'CACHE', idempotent: true };
        }
    }

    // 2. Fulfillment Verification via 3Thix
    // We use the shared verifyFulfillment orchestrator which handles Create/Poll/Status check.
    const fulfillmentResult = await verifyFulfillment(invoiceId);

    // Status Logic
    if (!fulfillmentResult.success) {
        console.log(`[CHECK_FULFILLMENT] Fulfillment Pending/Failed. Status: ${fulfillmentResult.status}`);
        // If not successful, we DO NOT write FAILED unless it's a hard failure?
        // User request: "Logic: if ... mark SUCCESS ... else: remain AWAITING_FULFILLMENT"
        // So we return current status or AWAITING_FULFILLMENT.
        return { status: 'AWAITING_FULFILLMENT', reason: fulfillmentResult.status };
    }

    // 3. SUCCESS PATH
    console.log(`[CHECK_FULFILLMENT] Fulfillment Confirmed (${fulfillmentResult.status}). Finalizing Success.`);

    // 4. Retrieve Metadata (from 3Thix Invoice)
    const authResult = await check3ThixAuthoritative(invoiceId);
    const invoiceData = authResult?.data?.invoice || authResult?.data || {};
    const metadata = invoiceData.metadata ? (typeof invoiceData.metadata === 'string' ? JSON.parse(invoiceData.metadata) : invoiceData.metadata) : {};

    const amount = parseFloat(invoiceData.amount || 0);
    const currency = invoiceData.currency || "USD";
    const walletAddress = metadata.wallet_address || metadata.walletAddress || "";
    const name = metadata.name || "";
    const email = metadata.email || "";
    const walletNetwork = detectWalletNetwork(walletAddress);

    // 5. Calculate Tokens (Strictly on SUCCESS)
    let tokenPrice = 0;
    let tokens = 0;
    try {
        const priceData = await getPrice();
        tokenPrice = priceData?.price_usd || 0;
        if (tokenPrice > 0) {
            tokens = parseFloat((amount / tokenPrice).toFixed(6));
        }
    } catch (e) {
        console.error(`[CHECK_FULFILLMENT] Price fetch failed: ${e.message}`);
    }

    // 6. Update Persistence (Authority Write)
    // ALWAYS write all fields to prevent data loss bug
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

    // 7. Activity Log
    await appendToActivityLog([
        crypto.randomUUID(),
        invoiceId,
        invoiceData.merchant_ref_id || "",
        "PAYMENT_SUCCESS",
        amount,
        currency,
        "3THIX_FULFILLMENT",
        "", "", "",
        JSON.stringify(metadata),
        new Date().toISOString()
    ]);

    // 8. Send Emails (Strictly on SUCCESS)
    if (email) {
        await sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress);
    }

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

    return { status: 'SUCCESS', updated: true };
}


// normalizeStatus helper removed as it's no longer used for strict fulfillment check.

