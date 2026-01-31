


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
/* ---------- Logic: Create Invoice ---------- */
export async function createInvoiceLogic(req, res) {
    const { amount, currency, quantity = 1, name, email } = req.body;
    let { walletAddress } = req.body;

    // 1. Input Validation
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    // Strict Email Validation (RFC 5322)
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

    // Load Envs
    const THIX_API_URL = (process.env.THIX_API_URL || "").replace(/\/$/, ""); // Remove trailing slash
    const THIX_API_KEY = process.env.THIX_API_KEY;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://buynow.mindwavedao.com";
    const THIX_WEBHOOK_URL = process.env.THIX_WEBHOOK_URL;

    if (!THIX_WEBHOOK_URL) {
        console.error("Missing THIX_WEBHOOK_URL env var");
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    const description = "NILA TOKEN - Mindwave";
    // Generate Invoice ID locally
    const invoiceId = `mw-${Date.now()}`;
    const merchant_ref_id = invoiceId;

    const userMetadata = {
        name,
        email,
        wallet_address: walletAddress,
        walletNetwork: network || "",
        invoiceId
    };

    // Construct Absolute URLs
    const cleanBaseUrl = FRONTEND_BASE_URL.replace(/\/$/, "");

    // MANDATORY: callbackUrl points to success page
    const finalCallbackUrl = `${cleanBaseUrl}/payment-success.html?invoiceId=${invoiceId}`;
    const cancelUrl = `${cleanBaseUrl}/payment-cancelled.html`;

    // STEP 2: Create invoice in DB FIRST
    try {
        const createdAt = new Date().toISOString();
        const initialRow = [
            invoiceId, "CREATED", email, name, walletAddress, network || "",
            amount.toString(), currency || "USD", "", "", "NO", "NO", createdAt, createdAt
        ];
        await appendToTransactions(initialRow);
    } catch (dbError) {
        console.error("Failed to save invoice to DB:", dbError);
        return res.status(500).json({ error: "Database Error" });
    }

    // STEP 3: Call 3thix API
    try {
        // 🔒 ABSOLUTE BASE URL
        const FRONTEND_BASE_URL_CLEAN = FRONTEND_BASE_URL.replace(/\/$/, '');

        // ✅ CALLBACK URL (AUTHORITATIVE)
        const callbackUrl = `${FRONTEND_BASE_URL_CLEAN}/payment-success.html?invoiceId=${invoiceId}`;

        // NO returnUrl, NO cancelUrl implicitly needed by strict requirements? 
        // User said: "USE callbackUrl (NOT returnUrl)"

        // Construct Payload
        const payload = {
            amount: Number(amount),
            currency: currency || "USD",

            // 🔴 DO NOT USE anonymous=true
            name,
            email,

            // 🔴 USE callbackUrl ONLY
            callbackUrl,

            // 🔴 SERVER-TO-SERVER
            webhook_url: THIX_WEBHOOK_URL,

            merchant_ref_id: invoiceId,

            metadata: userMetadata
        };

        const targetUrl = `${THIX_API_URL}/orders/payment`;
        console.log(`[CREATE_INVOICE] Target URL: ${targetUrl}`);

        const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": THIX_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const text = await response.text();

        // Check for HTTP Errors (404, 500, etc)
        if (!response.ok) {
            console.error(`[3THIX ERROR] ${response.status} ${response.statusText}`, text);
            return res.status(502).json({
                success: false,
                error: `Payment Gateway Error: ${response.status}`,
                details: text.substring(0, 500) // Truncate long HTML errors
            });
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error("3Thix invalid JSON:", text);
            return res.status(502).json({ success: false, error: "Invalid response from payment gateway", raw: text });
        }

        const correlationId = req.headers['x-vercel-id'] || `req-${Date.now()}`;
        console.log(`[CREATE_INVOICE] [${correlationId}] 3thix Response:`, JSON.stringify(data));

        // ✅ ACCEPT ALL POSSIBLE REDIRECT KEYS
        const paymentUrl =
            data.payment_url ||
            data.checkout_url ||
            data.redirect_url ||
            data.url ||
            data.hosted_payment_url;

        // Requirement 6: Handle Missing URL via 502
        if (!paymentUrl) {
            console.error("[3THIX ERROR] No redirect URL returned", data);
            return res.status(502).json({
                success: false,
                error: "3thix did not return redirect URL",
                raw: data
            });
        }

        // ✅ RETURN TO FRONTEND
        return res.json({
            success: true,
            invoiceId,
            redirectUrl: paymentUrl
        });

    } catch (e) {
        console.error("Create Invoice Unexpected Error:", e);
        res.status(500).json({ error: "Failed to initiate payment" });
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
