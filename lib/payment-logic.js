import { processSuccessfulPayment, sendAdminPaymentNotification } from "./email.js";
import { getPrice } from "./price.js";
import crypto from "crypto";

// Unified Imports from sheets.logic.js
import {
    getSheetsClient,
    findTransaction,
    updateTransactionStatus,
    appendToActivityLog,
    appendToAdditionalInfo,
    appendToRawResponses,
    markEmailSent
} from "./sheets.logic.js";

// Wallet Regex Patterns
const ETH_REGEX = /^0x[a-fA-F0-9]{40}$/;
const TRON_REGEX = /^T[a-zA-Z0-9]{33}$/;

export function validateWalletAddress(address) {
    if (!address) return true; // Empty is valid
    return ETH_REGEX.test(address) || TRON_REGEX.test(address);
}

export function detectWalletNetwork(address) {
    if (!address) return null;
    if (address.startsWith("0x")) return "ETH / BSC";
    if (address.startsWith("T")) return "TRON";
    return null;
}

// Validation helper
export function validatePaymentEnv() {
    const THIX_API_URL = process.env.THIX_API_URL;
    const THIX_API_KEY = process.env.THIX_API_KEY;
    const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
    const GOOGLE_SHEETS_CREDENTIALS = process.env.GOOGLE_SHEETS_CREDENTIALS;

    // if (!THIX_API_URL?.startsWith('https://api.3thix.com')) {
    //     // throw new Error('INVALID CONFIG: THIX_API_URL must be https://api.3thix.com');
    // }
    if (!THIX_API_KEY || !GOOGLE_SHEET_ID || !GOOGLE_SHEETS_CREDENTIALS) {
        throw new Error('INVALID CONFIG: Missing required environment variables');
    }
}

/* ---------- Fetch Helper with Retry ---------- */
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url, options);
            if (res.ok) return res;
            if (res.status >= 500 && i < retries - 1) {
                await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
                continue;
            }
            return res; // Return checking error for caller to handle
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise(r => setTimeout(r, 500 * Math.pow(2, i)));
        }
    }
}

/* ---------- 3Thix API Logic ---------- */
export async function check3ThixAuthoritative(invoiceId) {
    const THIX_API_KEY = process.env.THIX_API_KEY;
    const THIX_API_URL = process.env.THIX_API_URL;

    if (!THIX_API_KEY || !THIX_API_URL || !invoiceId) return null;
    try {
        console.log(`🔍 3Thix Authoritative Check: ${invoiceId}`);
        const response = await fetchWithRetry(`${THIX_API_URL}/invoice/issuer/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({ id: invoiceId })
        });

        if (response.ok) {
            const data = await response.json();
            let status = null;
            if (data.invoice && data.invoice.status) {
                status = data.invoice.status;
            } else if (data.invoice && data.invoice.payment_status) {
                status = data.invoice.payment_status;
            } else if (data.status) {
                status = data.status;
            } else if (data.order && data.order.status) {
                status = data.order.status;
            }
            return { status: (status || '').toUpperCase(), data };
        } else {
            const errorText = await response.text();
            console.error(`3Thix Check Failed [${response.status}]: ${errorText}`);
        }
    } catch (e) { console.error("3Thix Check Error:", e.message); }
    return null;
}

export function normalize3ThixStatus(rawStatus) {
    if (!rawStatus) return 'PENDING';
    const s = rawStatus.toUpperCase();
    if (['PAID', 'COMPLETED', 'SUCCESS', 'INVOICE_PAID', 'ORDER_COMPLETED', 'APPROVED', 'SETTLED'].includes(s)) return 'SUCCESS';
    if (['CANCELLED', 'FAILED', 'ERROR', 'EXPIRED', 'ORDER_FAILED'].includes(s)) return 'FAILED';
    return 'PENDING';
}

/* ---------- Core Business Logic ---------- */

// EXPORTED: Shared finalization logic for Webhook & Admin Reconcile
export async function finalizeSuccessfulPayment(invoiceId, authoritativeData, sourceLabel) {
    const sheetClient = await getSheetsClient(); // Just checks init
    if (!sheetClient) return { status: 'ERROR', message: 'Database unavailable' };

    console.log(`[FINALIZE] Starting finalization for ${invoiceId} (Source: ${sourceLabel})`);

    // 1. Idempotency Check
    const existing = await findTransaction(invoiceId);
    if (existing && existing.status === 'SUCCESS') {
        console.log(`[IDEMPOTENT] Invoice ${invoiceId} already SUCCESS.`);

        // Handle Email Retry for Admin Reconcile even if already matched
        if (sourceLabel === 'ADMIN_RECONCILE' && existing.email_sent_user !== 'YES') { // Fixed to use proper key
            console.log(`[ADMIN_RECONCILE] Invoice is SUCCESS but email not sent. Retrying emails...`);
            // Fall through
        } else {
            return {
                status: 'SUCCESS',
                invoiceId,
                tokens: existing.tokens_purchased,
                tokenPrice: existing.token_price,
                walletAddress: existing.wallet_address,
                source: 'CACHE'
            };
        }
    }

    // 2. Data Extraction
    let data = authoritativeData || {};
    if (!data.metadata && !data.invoice) {
        // Fallback: If no authoritative data passed, and we are here, we might need to fetch it?
        // Actually authorizeData is expected to be passed.
        // If null (e.g. Admin Reconcile without payload), try to fetch from 3Thix?
        // But reconcile-invoice calls this with null. so we MUST fetch.
        if (sourceLabel === 'ADMIN_RECONCILE' && !authoritativeData) {
            const apiRes = await check3ThixAuthoritative(invoiceId);
            if (apiRes && apiRes.data) data = apiRes.data;
        }
    }

    const metaSource = data.metadata || (data.invoice && data.invoice.metadata) || (data.order && data.order.metadata);
    const metadata = typeof metaSource === 'string' ? JSON.parse(metaSource) : metaSource || {};

    const merchRef = data.merchant_ref_id || (data.invoice && data.invoice.merchant_ref_id) || '';
    const amountStr = data.amount || (data.invoice && data.invoice.amount) || '0';
    const currency = data.currency || (data.invoice && data.invoice.currency) || 'USD';
    const amountVal = parseFloat(amountStr);
    const walletAddress = metadata.wallet_address || metadata.walletAddress || "";
    const name = metadata.name || '';
    const email = metadata.email || '';
    const network = detectWalletNetwork(walletAddress);

    // 3. Price & Token Calculation
    let tokenPriceUsed = 0;
    let tokensPurchased = 0;

    try {
        const priceData = await getPrice();
        if (priceData && priceData.price_usd > 0) {
            tokenPriceUsed = priceData.price_usd;
            tokensPurchased = parseFloat((amountVal / tokenPriceUsed).toFixed(6));
        } else {
            console.warn(`[PRICE MISSING] Could not fetch price for ${invoiceId}. Defaulting to 0.`);
        }
    } catch (e) {
        console.error(`[PRICE ERROR] ${invoiceId}`, e);
    }

    // 4. Update PAYMENT_TRANSACTIONS (One Write)
    await updateTransactionStatus(invoiceId, 'SUCCESS', {
        email, name, walletAddress, walletNetwork: network,
        amount: amountStr, currency,
        tokenPrice: tokenPriceUsed, tokens: tokensPurchased,
    });

    // 5. Activity Log
    // Updated to match sheets.logic.js expectation (array)
    // ACTIVITY_LOG_HEADERS = activity_id, invoice_id, merchant_ref_id, event_type, amount, currency, gateway, country, user_agent, ip, metadata, timestamp
    await appendToActivityLog([
        crypto.randomUUID(), invoiceId, merchRef, "PAYMENT_SUCCESS",
        amountStr, currency, "3THIX", '', '', '',
        JSON.stringify(metadata), new Date().toISOString()
    ]);

    // 6. Additional Info
    if (name || email) {
        // ADDITIONAL_INFO_HEADERS: merchant_ref_id, invoice_id, name, email, timestamp, wallet_address
        await appendToAdditionalInfo([
            merchRef, invoiceId, name, email,
            new Date().toISOString(), walletAddress
        ]);
    }

    // 7. Emails
    let emailSentUser = false;
    let emailSentAdmin = false;

    // A. User Email
    if (email) {
        try {
            const emailResult = await processSuccessfulPayment(
                invoiceId, email, name, tokensPurchased, tokenPriceUsed, amountVal, walletAddress
            );
            // processSuccessfulPayment updates sheet internally via sheets.logic.js
            if (emailResult.success && emailResult.emailSent) {
                emailSentUser = true;
            }
        } catch (err) {
            console.error(`[EMAIL FAIL] User email for ${invoiceId}`, err);
        }
    }

    // B. Admin Email
    try {
        const adminSent = await sendAdminPaymentNotification({
            invoiceId,
            amount: amountVal,
            currency,
            tokens: tokensPurchased,
            tokenPrice: tokenPriceUsed,
            email, name, walletAddress,
            source: sourceLabel,
            timestamp: new Date().toISOString()
        });
        if (adminSent) {
            await markEmailSent(invoiceId, 'ADMIN'); // Using new function
            emailSentAdmin = true;
        }
    } catch (err) {
        console.error(`[EMAIL FAIL] Admin email for ${invoiceId}`, err);
    }

    return {
        status: 'SUCCESS',
        invoiceId,
        amount: amountStr,
        currency,
        tokens: tokensPurchased,
        tokenPrice: tokenPriceUsed,
        emailSentUser,
        emailSentAdmin,
        source: sourceLabel
    };
}

// READ-ONLY check
export async function checkPaymentStatusLogic(invoiceId) {
    const tx = await findTransaction(invoiceId);

    // IF NOT FOUND -> 404
    if (!tx) {
        return {
            found: false,
            status: "NOT_FOUND",
            invoiceId
        };
    }

    // IF FOUND, RESOLVE STATUS
    let finalStatus = tx.status || "CREATED";
    // Normalize logic
    if (finalStatus === "AWAITING_PAYMENT") finalStatus = "CREATED";

    // derived status for UI
    if (finalStatus === "CREATED") {
        const createdAt = tx.created_at ? new Date(tx.created_at) : new Date();
        const now = new Date();
        const diffMs = now - createdAt;
        const diffMins = diffMs / 60000;

        if (diffMins > 15) {
            finalStatus = "AWAITING_WEBHOOK";
        }
    }

    // Build Response based on status
    const response = {
        found: true,
        status: finalStatus,
        invoiceId: tx.invoice_id,
        createdAt: tx.created_at,
        emailSent: tx.email_sent_user === 'YES'
    };

    if (finalStatus === "SUCCESS") {
        response.amount = tx.amount ? parseFloat(tx.amount) : 0;
        response.currency = tx.currency || "USD";
        response.tokens = tx.tokens_purchased ? parseFloat(tx.tokens_purchased) : 0;
        response.tokenPrice = tx.token_price ? parseFloat(tx.token_price) : 0;
        response.walletAddress = tx.wallet_address || "";
        response.network = tx.wallet_network || "";
    }

    return response;
}
