


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
    appendToCardTransactions,
    findTransaction,
    updateTransactionStatus,
    getSheetsClient,
    markEmailSent
} from "./sheets.logic.js";
import { sendUserPaymentSuccessEmail, sendAdminPaymentNotification } from "./email.logic.js";
// Imports from shared logic (dash file)
import { validateWalletAddress, detectWalletNetwork } from "./payment-logic.js";
import { getAuthoritativePrice } from "./price.js";
import { finalizeSuccessfulPayment } from "./finalize-payment.js";

/**
 * Detects card type based on card number prefix (BIN)
 * @param {string|number} cardNumber 
 * @returns {string} Card type (Visa, Mastercard, Amex, Discover, Unknown)
 */
function detectCardType(cardNumber) {
    if (!cardNumber) return "Unknown";
    const num = String(cardNumber);

    // Amex: 34 or 37
    if (/^3[47]/.test(num)) return "Amex";

    // Visa: starts with 4
    if (/^4/.test(num)) return "Visa";

    // Mastercard: 51-55 or 2221-2720
    if (/^5[1-5]/.test(num) || /^2[2-7]/.test(num)) return "Mastercard";

    // Discover: 6011, 622126-622925, 644-649, 65
    if (/^6(?:011|5|4[4-9]|22)/.test(num)) return "Discover";

    return "Unknown";
}

/* ---------- Logic: Create Invoice / Process Payment ---------- */
/* ---------- NEW 3THIX DIRECT PAYMENT API ---------- */
export async function createInvoiceLogic(req, res) {
    const {
        amount,
        currency = "USD",
        quantity = 1,
        name,
        email,
        // New fields for direct payment
        card_number,
        cvv,
        exp_date,
        billing_data,
        // Optional: for saved cards
        user_id,
        customer_vault_id
    } = req.body;

    console.log(`[CREATE_PAYMENT] Received request for ${email}, Amount: ${amount} ${currency}`);

    let { walletAddress } = req.body;

    // 1. Input Validation
    if (!amount || amount <= 0) {
        console.error(`[CREATE_PAYMENT] Invalid amount: ${amount}`);
        return res.status(400).json({ error: "Invalid amount" });
    }

    // Strict Email Validation (RFC 5322)
    const EMAIL_REGEX = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    // Card validation (required unless using saved card)
    if (!customer_vault_id) {
        if (!card_number || !cvv || !exp_date) {
            return res.status(400).json({ error: "Card details required (card_number, cvv, exp_date)" });
        }
    }

    // Billing data validation
    if (!billing_data || !billing_data.first_name || !billing_data.last_name) {
        return res.status(400).json({ error: "Billing data required (first_name, last_name)" });
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

    // Load Environment Variables
    // THIX_API_URL should be set to base URL: https://webadmin.3thix.com
    const THIX_API_URL = (process.env.THIX_API_URL || "https://webadmin.3thix.com").replace(/\/$/, "");
    const THIX_API_KEY = process.env.THIX_API_KEY; // Used as x-api-key header
    const THIX_MERCHANT_KEY = process.env.THIX_MERCHANT_KEY;
    const THIX_GATEWAY_ID = process.env.THIX_GATEWAY_ID;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://buynow.mindwavedao.com";

    if (!THIX_API_KEY || !THIX_MERCHANT_KEY || !THIX_GATEWAY_ID) {
        console.error("Missing required 3thix env vars (API_KEY, MERCHANT_KEY, GATEWAY_ID)");
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    // Generate Invoice ID locally
    const invoiceId = `mw-${Date.now()}`;

    // STEP 2: Create invoice in DB FIRST
    try {
        const createdAt = new Date().toISOString();
        const initialRow = [
            invoiceId, "PENDING", email, name, walletAddress, network || "",
            amount.toString(), currency || "USD", "", "", "NO", "NO", createdAt, createdAt
        ];
        await appendToTransactions(initialRow);
    } catch (dbError) {
        console.error("Failed to save invoice to DB:", dbError);
        return res.status(500).json({ error: "Database Error" });
    }

    // STEP 3: Call NEW 3thix Direct Payment API
    try {
        const targetUrl = `${THIX_API_URL}/api/payment`;
        console.log(`[CREATE_PAYMENT] [STEP 3] Calling 3thix API: ${targetUrl}`);

        // Construct payload per new API spec
        const payload = {
            merchant_key: THIX_MERCHANT_KEY,
            gateway_id: THIX_GATEWAY_ID,
            amount: Number(amount),
            user_email: email,
            billing_data: {
                first_name: billing_data.first_name,
                last_name: billing_data.last_name,
                company: billing_data.company || null,
                address_1: billing_data.address_1 || "",
                address_2: billing_data.address_2 || "",
                city: billing_data.city || "",
                state: billing_data.state || "",
                postcode: billing_data.postcode || "",
                country: billing_data.country || "US",
                email: email,
                phone: billing_data.phone || ""
            }
        };

        // Add user_id if provided (for saved cards feature)
        if (user_id) {
            payload.user_id = user_id;
        }

        // Add card details OR saved card ID
        if (customer_vault_id) {
            payload.customer_vault_id = customer_vault_id;
        } else {
            // NEVER log card numbers
            payload.card_number = Number(card_number);
            payload.cvv = Number(cvv);
            payload.exp_date = exp_date;
        }

        const response = await fetch(targetUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": THIX_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const text = await response.text();
        console.log(`[CREATE_PAYMENT] [STEP 4] 3thix Raw Response Status: ${response.status}`);

        // Check for HTTP Errors
        if (!response.ok) {
            console.error(`[3THIX ERROR] ${response.status} ${response.statusText}`, text);
            // Update DB status to FAILED
            await updateTransactionStatus(invoiceId, 'FAILED');
            return res.status(502).json({
                success: false,
                error: "Payment processing failed",
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
        console.log(`[CREATE_PAYMENT] [${correlationId}] 3thix Parsed Response:`, JSON.stringify(data));

        // Check for success
        if (!data.success) {
            console.error("[3THIX ERROR] Payment failed:", data.message);
            await updateTransactionStatus(invoiceId, 'FAILED');
            return res.status(400).json({
                success: false,
                error: data.message || "Payment declined"
            });
        }

        // Extract transaction ID from successful response
        const transactionId = data.data?.transaction_id;
        if (!transactionId) {
            console.warn("[3THIX] No transaction_id in success response", data);
        }

        // Update DB with SUCCESS status
        console.log(`[CREATE_PAYMENT] [STEP 5] Updating DB transaction status to SUCCESS`);
        await updateTransactionStatus(invoiceId, 'SUCCESS', {
            email,
            name,
            walletAddress,
            walletNetwork: network || "",
            amount,
            currency
        });

        // Log card transaction to separate sheet (PCI SAFE - last 4 only)
        const cardLast4 = card_number ? String(card_number).slice(-4) : "";
        const cardType = detectCardType(card_number);

        await appendToCardTransactions({
            invoiceId,
            transactionId,
            cardLast4,
            cardExp: exp_date || "",
            cardType,
            amount,
            currency,
            billingName: `${billing_data.first_name} ${billing_data.last_name}`,
            billingEmail: email,
            billingCountry: billing_data.country || "",
            status: "SUCCESS"
        });

        // Trigger email notifications and token calculation (async, don't block response)
        finalizeSuccessfulPayment(invoiceId, { source: "DIRECT_PAYMENT" })
            .then(result => console.log(`[CREATE_PAYMENT] Finalization complete:`, result.status))
            .catch(err => console.error(`[CREATE_PAYMENT] Finalization error:`, err.message));

        // ✅ RETURN SUCCESS TO FRONTEND (no redirect needed)
        console.log(`[CREATE_PAYMENT] [SUCCESS] Payment completed for ${invoiceId}`);
        return res.json({
            success: true,
            invoiceId,
            transactionId,
            message: data.message || "Payment successful",
            amount: data.data?.amount || amount
        });

    } catch (e) {
        console.error("Create Payment Unexpected Error:", e);
        await updateTransactionStatus(invoiceId, 'FAILED');
        return res.status(500).json({ error: "Failed to process payment" });
    }
}


// DEPRECATED: finalizeSuccessfulPayment and handlePaymentLogic moved to lib/finalize-payment.js
// DEPRECATED: checkPaymentStatusLogic should be imported from lib/payment-logic.js

