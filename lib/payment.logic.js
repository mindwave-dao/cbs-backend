


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
    const merchant_ref_id = `mw-${Date.now()}`;

    const userMetadata = {
        name,
        email,
        walletAddress,
        walletNetwork: network || ""
    };

    try {
        const response = await fetch(`${THIX_API_URL}/order/payment/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({
                rail: "CREDIT_CARD",
                currency: currency || "USD",
                amount: amount.toString(),
                merchant_ref_id,
                callback_url,
                // Return URL points to Success Page with Invoice ID
                return_url: `${FRONTEND_BASE_URL.replace(/\/$/, "")}/payment-success.html`,
                metadata: JSON.stringify(userMetadata),
                cart: [{ product_name: description, qty_unit: quantity, price_unit: (amount / quantity).toString() }]
            })
        });

        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error(`3Thix invalid response: ${text.substring(0, 100)}`); }

        const invoiceId = data.invoice_id || data.invoice?.id || data.id;
        if (!invoiceId) throw new Error("No invoice ID returned");

        const correlationId = req.headers['x-vercel-id'] || `req-${Date.now()}`;
        console.log(`[CREATE_INVOICE] [${correlationId}] Created Invoice ${invoiceId}`);

        // Update Return URL with Invoice ID (Optimistic)
        const returnUrl = `${FRONTEND_BASE_URL.replace(/\/$/, "")}/payment-success.html?invoiceId=${invoiceId}`;
        await fetch(`${THIX_API_URL}/order/payment/update/${invoiceId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({ return_url: returnUrl })
        }).catch(e => console.warn("Return URL update failed", e));

        // COMPLIANCE: Write to PAYMENT_TRANSACTIONS (CREATED)
        const createdAt = new Date().toISOString();
        // New Schema: invoice_id, status, email, name, wallet_address, wallet_network, amount, currency, token_price, tokens_purchased, email_sent_user, email_sent_admin, created_at, updated_at
        const initialRow = [
            invoiceId, "CREATED", email, name, walletAddress, network || "",
            amount.toString(), currency || "USD", "", "", "NO", "NO", createdAt, createdAt
        ];
        await appendToTransactions(initialRow);

        const redirectUrl = `${PAYMENT_PAGE_BASE}?invoiceId=${invoiceId}&returnUrl=${encodeURIComponent(returnUrl)}`;

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
