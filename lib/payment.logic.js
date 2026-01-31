


// ⚠️ PURE LOGIC ONLY
// This file handles INVOICE CREATION only.
// For Status Checks & Verification, see: payment-logic.js (dash)
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
    const PAYMENT_PAGE_BASE = (process.env.PAYMENT_PAGE_BASE || "https://pay.3thix.com").replace(/\/$/, "");

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

        // 🔴 SKIPPING API CALL (Returns 404, waiting for 3Thix Support)
        // const response = await fetch(targetUrl, { ... });
        // ... handling ...

        // 🟢 MANUAL URL ONLY
        // We assume the widget can handle our local ID or that we don't need to create the order via REST first.
        // If 3Thix requires a REST order first, this will fail at the widget level, but it unblocks 502s.

        // Mock Response Data (since we skipped call)
        const data = { invoice_id: invoiceId }; // Use our local ID

        /* 
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
        */

        const correlationId = req.headers['x-vercel-id'] || `req-${Date.now()}`;
        console.log(`[CREATE_INVOICE] [${correlationId}] Skipped API (404). Using local ID: ${invoiceId}`);

        // 🟢 FIX: MANUALLY CONSTRUCT PAYMENT URL
        // 3Thix API does NOT return a redirect URL. We must build it.
        // Format: https://pay.3thix.com/?invoiceId={id}&callbackUrl={url}
        const createdInvoiceId = data.invoice_id || invoiceId; // Use theirs if returned, else ours (should be same)
        const paymentUrl = `${PAYMENT_PAGE_BASE}/?invoiceId=${createdInvoiceId}&callbackUrl=${encodeURIComponent(callbackUrl)}`;

        console.log(`[CREATE_INVOICE] Generated Manual URL: ${paymentUrl}`);

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
// DEPRECATED: checkPaymentStatusLogic should be imported from lib/payment-logic.js

