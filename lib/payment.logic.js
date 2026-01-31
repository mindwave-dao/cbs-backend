


// ⚠️ PURE LOGIC ONLY
// No I/O, no Sheets, no Email, no Webhooks

import crypto from "crypto";
import {
    appendToTransactions,
    appendToActivityLog,
    appendToRawResponses,
    appendToAdditionalInfo,
    findTransaction,
    updateTransactionStatus,
    getSheetsClient,
    markEmailSent
} from "./sheets.logic.js";
import { sendUserPaymentSuccessEmail, sendAdminPaymentNotification } from "./email.logic.js";
// Imports from shared logic (dash file)
import { validateWalletAddress, detectWalletNetwork } from "./payment-logic.js";
import { getAuthoritativePrice } from "./price.js";


/* ---------- Logic: Create Invoice ---------- */
/* ---------- Logic: Create Invoice ---------- */
export async function createInvoiceLogic(req, res) {
    const { amount, currency, quantity = 1, name, email } = req.body;
    let { walletAddress } = req.body;

    // 1. Input Validation
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    // Strict Email Validation (RFC 5322)
    // - Must have @
    // - Must have .
    // - No spaces
    const EMAIL_REGEX = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    // Wallet Validation & Network Detection
    if (!walletAddress) walletAddress = "";
    else walletAddress = walletAddress.trim().substring(0, 128);

    const network = detectWalletNetwork(walletAddress);
    if (walletAddress && !network) {
        if (!validateWalletAddress(walletAddress)) {
            return res.status(400).json({ error: "Invalid wallet address" });
        }
    }

    const THIX_API_URL = process.env.THIX_API_URL;
    const THIX_API_KEY = process.env.THIX_API_KEY;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://buynow.mindwavedao.com";
    const PAYMENT_PAGE_BASE = process.env.PAYMENT_PAGE_BASE;
    const THIX_WEBHOOK_URL = process.env.THIX_WEBHOOK_URL;

    if (!THIX_WEBHOOK_URL) {
        console.error("Missing THIX_WEBHOOK_URL env var");
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    // Use Hardcoded Webhook URL
    const callback_url = THIX_WEBHOOK_URL;

    const description = "NILA TOKEN - Mindwave";
    // FIX: Generate Invoice ID locally and use it as merchant_ref_id
    // This allows proper reconciliation in 3thix UI to prevent crashes
    const invoiceId = `mw-${Date.now()}`;
    const merchant_ref_id = invoiceId;

    const userMetadata = {
        name,
        email,
        wallet_address: walletAddress,
        walletNetwork: network || "",
        invoiceId // Include in metadata for robustness
    };

    // Construct Absolute URLs
    // Remove trailing slashes from base to ensure clean path
    const cleanBaseUrl = FRONTEND_BASE_URL.replace(/\/$/, "");

    // Initial Return URL (will be patched with ID later if needed, or we rely on session)
    // But 3thix needs a valid URL here.
    const initialReturnUrl = `${cleanBaseUrl}/payment-success.html`;
    const cancelUrl = `${cleanBaseUrl}/payment-cancelled.html`;

    try {
        const response = await fetch(`${THIX_API_URL}/order/payment/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({
                rail: "CREDIT_CARD",
                currency: currency || "USD",
                amount: amount.toString(),
                merchant_ref_id, // ✅ REQUIRED: Link our ID to 3thix Order
                callback_url,
                // Compliance: snake_case for 3thix
                return_url: initialReturnUrl,
                cancel_url: cancelUrl,
                metadata: JSON.stringify(userMetadata),
                cart: [{ product_name: description, qty_unit: quantity, price_unit: (amount / quantity).toString() }]
            })
        });

        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error(`3Thix invalid response: ${text.substring(0, 100)}`); }

        // Capture 3thix Internal ID for API calls (PATCH)
        const thixOrderId = data.invoice_id || data.invoice?.id || data.id;
        if (!thixOrderId) throw new Error("No order ID returned from 3thix");

        const correlationId = req.headers['x-vercel-id'] || `req-${Date.now()}`;
        console.log(`[CREATE_INVOICE] [${correlationId}] Created Invoice ${invoiceId} (3thix: ${thixOrderId})`);

        // Update Return URL with Invoice ID (Crucial for Return Page to know what to verify)
        // Use OUR invoiceId so frontend/DB lookup matches
        const finalReturnUrl = `${cleanBaseUrl}/payment-success.html?invoiceId=${invoiceId}`;

        // Background patch - don't block response too long
        // Use thixOrderId for the API endpoint path
        await fetch(`${THIX_API_URL}/order/payment/update/${thixOrderId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({ return_url: finalReturnUrl })
        }).catch(e => console.warn("Return URL update failed", e));

        // COMPLIANCE: Write to PAYMENT_TRANSACTIONS (CREATED)
        const createdAt = new Date().toISOString();
        // New Schema: invoice_id, status, email, name, wallet_address, wallet_network, amount, currency, token_price, tokens_purchased, email_sent_user, email_sent_admin, created_at, updated_at
        const initialRow = [
            invoiceId, "CREATED", email, name, walletAddress, network || "",
            amount.toString(), currency || "USD", "", "", "NO", "NO", createdAt, createdAt
        ];
        await appendToTransactions(initialRow);

        // Extract Authoritative Payment URL from 3thix Response
        // Fallback to legacy construction only if missing
        const paymentUrl = data.payment_url || data.checkout_url || data.redirect_url || data.url;

        let redirectUrl;
        if (paymentUrl) {
            redirectUrl = paymentUrl;
        } else {
            // Fallback (Legacy)
            redirectUrl = `${PAYMENT_PAGE_BASE}?invoiceId=${thixOrderId}&returnUrl=${encodeURIComponent(finalReturnUrl)}`;
        }

        res.json({ invoiceId, redirectUrl });

    } catch (e) {
        console.error("Create Invoice Error:", e);
        res.status(500).json({ error: "Failed to create invoice" });
    }
}


// DEPRECATED: finalizeSuccessfulPayment and handlePaymentLogic moved to lib/finalize-payment.js
// Keeping file for createInvoiceLogic and checkPaymentStatusLogic

/* ---------- Logic: Payment Finalization (Centralized) ---------- */
// MOVED TO lib/finalize-payment.js


/* ---------- Logic: Status Check (Read Only) ---------- */
export async function checkPaymentStatusLogic(invoiceId) {
    if (!invoiceId) return { status: "ERROR", message: "Missing Invoice ID" };

    const tx = await findTransaction(invoiceId);
    if (!tx) {
        return { status: "NOT_FOUND", invoiceId };
    }

    // Lowercase keys from new sheets logic
    const { status: STATUS, created_at: CREATED_AT, token_price: TOKEN_PRICE, tokens_purchased: TOKENS_PURCHASED, wallet_address: WALLET_ADDRESS, amount: AMOUNT, currency: CURRENCY } = tx;

    if (STATUS === 'SUCCESS') {
        return {
            status: 'SUCCESS',
            invoiceId,
            amount: AMOUNT,
            currency: CURRENCY,
            tokenPrice: TOKEN_PRICE,
            tokens: TOKENS_PURCHASED,
            walletAddress: WALLET_ADDRESS
        };
    }

    if (STATUS === 'FAILED') {
        return { status: 'FAILED', invoiceId };
    }

    // CREATED Handling with 5-min rule
    if (STATUS === 'CREATED' || STATUS === 'AWAITING_FULFILLMENT') { // Handle new state
        const createdTime = new Date(CREATED_AT).getTime();

        let displayStatus = STATUS;
        if (STATUS === 'CREATED') displayStatus = 'CREATED';
        if (STATUS === 'AWAITING_FULFILLMENT') displayStatus = 'AWAITING_FULFILLMENT'; // Frontend can map this to 'Processing...'

        return {
            status: displayStatus,
            invoiceId,
            createdAt: CREATED_AT, // Expose for Auto-Heal
            message: "Waiting for payment verification..."
        };
    }

    // Fallback for any other status (shouldn't exist)
    return { status: 'CREATED', invoiceId, createdAt: CREATED_AT };
}


export function normalize3ThixStatus(s) {
    if (!s) return 'PENDING';
    s = s.toUpperCase();
    if (['PAID', 'COMPLETED', 'SUCCESS', 'INVOICE_PAID', 'ORDER_COMPLETED', 'APPROVED', 'SETTLED'].includes(s)) return 'SUCCESS';
    if (['CANCELLED', 'FAILED', 'ERROR', 'EXPIRED', 'ORDER_FAILED'].includes(s)) return 'FAILED';
    return 'PENDING';
}

function safeParse(str) {
    try { return JSON.parse(str); } catch (e) { return {}; }
}
