


// ⚠️ PURE LOGIC ONLY
// This file handles PAYMENT INTENT CREATION only.
// For Status Checks & Verification, see: payment-logic.js (dash)
// Card data is now handled by 3thix iframe - we never see it

import {
    appendToTransactions,
    updateTransactionStatus
} from "./sheets.logic.js";
// Imports from shared logic (dash file)
import { validateWalletAddress, detectWalletNetwork } from "./payment-logic.js";

/* ---------- Logic: Create Payment Intent ---------- */
/* ---------- NEW 3THIX CREATE-INTENT API (Iframe/URL Flow) ---------- */
export async function createInvoiceLogic(req, res) {
    const {
        amount,
        currency = "USD",
        quantity = 1,
        name,
        email,
        billing_data,
        // Integration type: "iframe" (default per user request for smoother UX)
        integration_type = "iframe",
        // Required for URL integration
        success_url,
        cancel_url,
        fail_url
    } = req.body;

    console.log(`[CREATE_INTENT] Received request for ${email}, Amount: ${amount} ${currency}`);

    let { walletAddress } = req.body;

    // 1. Input Validation
    if (!amount || amount <= 0) {
        console.error(`[CREATE_INTENT] Invalid amount: ${amount}`);
        return res.status(400).json({ error: "Invalid amount" });
    }

    if (!name) {
        return res.status(400).json({ error: "Name is required" });
    }

    // Strict Email Validation (RFC 5322)
    const EMAIL_REGEX = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    // URL integration requires success_url and cancel_url
    // RELAXED VALIDATION: We will generate default URLs with InvoiceID if not provided
    // if (integration_type === "url") {
    //     if (!success_url || !cancel_url) {
    //         return res.status(400).json({ error: "success_url and cancel_url are required for URL integration" });
    //     }
    // }

    // Wallet Validation & Network Detection
    if (!walletAddress) walletAddress = "";
    else walletAddress = walletAddress.trim().substring(0, 128);

    const network = detectWalletNetwork(walletAddress);
    if (walletAddress && !network) {
        if (!validateWalletAddress(walletAddress)) {
            return res.status(400).json({ error: "Invalid wallet address" });
        }
    }

    // Load Environment Variables for NEW API
    const THIX_API_URL = (process.env.THIX_API_URL || "https://webadmin.3thix.com").replace(/\/$/, "");
    const THIX_PUBLIC_KEY = process.env.THIX_PUBLIC_KEY;
    const THIX_SECRET_KEY = process.env.THIX_SECRET_KEY;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://buynow.mindwavedao.com";

    if (!THIX_PUBLIC_KEY || !THIX_SECRET_KEY) {
        console.error("Missing required 3thix env vars (THIX_PUBLIC_KEY, THIX_SECRET_KEY)");
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    // Generate Invoice ID locally (used as reference_id)
    const invoiceId = `mw-${Date.now()}`;

    // STEP 2: Create invoice in DB FIRST with PENDING status
    try {
        const createdAt = new Date().toISOString();
        const initialRow = [
            invoiceId, "PENDING", email, name, walletAddress, network || "",
            amount.toString(), currency || "USD", "", "", "NO", "NO", createdAt, createdAt
        ];
        await appendToTransactions(initialRow);
        console.log(`[CARD_FLOW] [STEP 2] Saved PENDING transaction to DB: ${invoiceId}`);
    } catch (dbError) {
        console.error("[CARD_FLOW] Failed to save invoice to DB:", dbError);
        return res.status(500).json({ error: "Database Error" });
    }

    // STEP 3: Call NEW 3thix create-intent API
    try {
        const targetUrl = `${THIX_API_URL}/api/card/create-intent`;
        console.log(`[CARD_FLOW] [STEP 3] Calling 3thix create-intent API: ${targetUrl}`);

        // Build billing object
        const billingInfo = billing_data ? {
            first_name: billing_data.first_name || name.split(' ')[0] || name,
            last_name: billing_data.last_name || name.split(' ').slice(1).join(' ') || "",
            address_1: billing_data.address_1 || "",
            city: billing_data.city || "",
            postcode: billing_data.postcode || "",
            country: billing_data.country || "US",
            email: email
        } : {
            first_name: name.split(' ')[0] || name,
            last_name: name.split(' ').slice(1).join(' ') || "",
            email: email
        };

        // Construct payload per 3thix create-intent API spec
        const totalAmount = Number(amount) * (Number(quantity) || 1);

        const payload = {
            public_key: THIX_PUBLIC_KEY,
            secret_key: THIX_SECRET_KEY,
            reference_id: invoiceId,
            amount: totalAmount,  // Direct amount field
            currency: currency.toUpperCase(),
            integration_type: integration_type,
            email: email,
            name: name,
            // Order items array
            order_items: [
                {
                    name: "NILA Token Purchase",
                    description: "NILA Token Purchase",
                    price: Number(amount),
                    quantity: Number(quantity) || 1,
                    amount: totalAmount
                }
            ],
            // Billing info
            billing: billingInfo,
            // Custom metadata
            metadata: {
                wallet_address: walletAddress,
                wallet_network: network || "",
                source: "CBS_FRONTEND",
                invoice_id: invoiceId
            }
        };


        // Add URL integration fields if integration_type is "url"
        if (integration_type === "url") {
            // Remove query params to avoid double-? issues. 3thix should append order_id/reference_id.
            const baseUrl = FRONTEND_BASE_URL.replace(/\/$/, "");

            // Helper to append param
            const appendParam = (url, key, value) => {
                const separator = url.includes('?') ? '&' : '?';
                return `${url}${separator}${key}=${value}`;
            };

            let successUrl = success_url || `${baseUrl}/payment-success`;
            let cancelUrl = cancel_url || `${baseUrl}/payment-cancelled`;

            // Append invoiceId
            successUrl = appendParam(successUrl, 'invoiceId', invoiceId);
            cancelUrl = appendParam(cancelUrl, 'invoiceId', invoiceId);

            payload.success_url = successUrl;
            payload.cancel_url = cancelUrl;
            payload.return_url = payload.success_url; // Compatibility alias

            if (fail_url) {
                payload.fail_url = fail_url;
            }
        }

        console.log(`[CREATE_INTENT] Payload (without secrets):`, JSON.stringify({
            ...payload,
            public_key: "[REDACTED]",
            secret_key: "[REDACTED]"
        }));

        const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const text = await response.text();
        console.log(`[CREATE_INTENT] [STEP 4] 3thix Raw Response Status: ${response.status}`);

        // Check for HTTP Errors
        if (!response.ok) {
            console.error(`[3THIX ERROR] ${response.status} ${response.statusText}`, text);
            // Update DB status to FAILED
            await updateTransactionStatus(invoiceId, 'FAILED');
            return res.status(502).json({
                success: false,
                error: "Payment intent creation failed",
                details: text.substring(0, 500)
            });
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            console.error("3Thix invalid JSON:", text);
            return res.status(502).json({ success: false, error: "Invalid response from payment gateway" });
        }

        const correlationId = req.headers['x-vercel-id'] || `req-${Date.now()}`;
        console.log(`[CARD_FLOW] [STEP 4] 3thix Response [${correlationId}]:`, JSON.stringify(data));

        // Check for success
        if (!data.success) {
            console.error("[3THIX ERROR] Intent creation failed:", data.message || data.error);
            await updateTransactionStatus(invoiceId, 'FAILED');
            return res.status(400).json({
                success: false,
                error: data.message || data.error || "Failed to create payment intent"
            });
        }

        // Extract intent data from successful response
        const intentId = data.data?.intent_id;
        const paymentUrl = data.data?.payment_url;
        const intentStatus = data.data?.status; // "requires_payment"

        if (!paymentUrl) {
            console.error("[3THIX ERROR] No payment_url in response", data);
            await updateTransactionStatus(invoiceId, 'FAILED');
            return res.status(502).json({
                success: false,
                error: "Payment gateway did not return payment URL"
            });
        }

        // Update DB with intent ID (keep status as PENDING - waiting for user to pay)
        console.log(`[CREATE_INTENT] [STEP 5] Intent created: ${intentId}, Status: ${intentStatus}`);

        // ✅ RETURN PAYMENT URL TO FRONTEND
        // Frontend will display this in an iframe or redirect to it
        console.log(`[CARD_FLOW] [STEP 5] Intent successfully created for ${invoiceId}. Payment URL: ${paymentUrl}`);
        return res.json({
            success: true,
            invoiceId,
            intentId,
            status: intentStatus || "requires_payment",
            paymentUrl,
            amount: data.data?.amount || amount,
            integration_type: integration_type
        });

    } catch (e) {
        console.error("Create Intent Unexpected Error:", e);
        await updateTransactionStatus(invoiceId, 'FAILED');
        return res.status(500).json({ error: "Failed to create payment intent" });
    }
}


// DEPRECATED: finalizeSuccessfulPayment and handlePaymentLogic moved to lib/finalize-payment.js
// DEPRECATED: checkPaymentStatusLogic should be imported from lib/payment-logic.js

