


import crypto from "crypto";
import {
    appendToTransactions,
    appendToActivityLog,
    appendToRawResponses,
    appendToAdditionalInfo,
    findTransaction,
    updateTransactionStatus,
    getSheetsClient
} from "./sheets.logic.js";
import { sendUserPaymentSuccessEmail, sendAdminPaymentNotification } from "./email.logic.js";
// Imports from shared logic (dash file)
import { createPaymentTransaction, validateWalletAddress, detectWalletNetwork } from "./payment-logic.js";


/* ---------- Logic: Create Invoice ---------- */
export async function createInvoiceLogic(req, res) {
    const { amount, currency, quantity = 1, name, email } = req.body;
    let { walletAddress } = req.body;

    // 1. Input Validation
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    // Strict Email Validation
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !EMAIL_REGEX.test(email)) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    // Wallet Validation & Network Detection
    if (!walletAddress) walletAddress = "";
    else walletAddress = walletAddress.trim().substring(0, 128);

    const network = detectWalletNetwork(walletAddress);
    if (walletAddress && !network) {
        // If wallet provided but not valid ETH/TRON, reject or allow? 
        // Plan says: "Validate name, email, walletAddress". User rules says "wallet validation MUST pass".
        // Use common validator.
        if (!validateWalletAddress(walletAddress)) {
            return res.status(400).json({ error: "Invalid wallet address" });
        }
    }

    const THIX_API_URL = process.env.THIX_API_URL;
    const THIX_API_KEY = process.env.THIX_API_KEY;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://mindwavedao.com";

    // Hostname detection for webhooks
    const hostname = req.headers.host;
    const protocol = hostname.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${hostname}`;
    // User Requirement: Use payment-callback API
    const callback_url = `${baseUrl}/api/payment-callback`;

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
                return_url: "https://example.com/pending", // Placeholder, updated below
                metadata: JSON.stringify(userMetadata),
                cart: [{ product_name: description, qty_unit: quantity, price_unit: (amount / quantity).toString() }]
            })
        });

        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error(`3Thix invalid response: ${text.substring(0, 100)}`); }

        const invoiceId = data.invoice_id || data.invoice?.id || data.id;
        if (!invoiceId) throw new Error("No invoice ID returned");

        // Update Return URL (Stateless Redirect)
        const returnUrl = `${FRONTEND_BASE_URL.replace(/\/$/, "")}/payment-success.html?invoiceId=${invoiceId}`;
        await fetch(`${THIX_API_URL}/order/payment/update/${invoiceId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({ return_url: returnUrl })
        }).catch(e => console.warn("Return URL update failed", e));

        // COMPLIANCE: Write ONLY to PAYMENT_TRANSACTIONS (CREATED)
        // Removed appendToTransactions (Legacy)
        const sheets = await getSheetsClient();
        if (sheets) {
            await createPaymentTransaction(sheets, {
                invoiceId,
                email,
                name,
                walletAddress,
                walletNetwork: network,
                amount: amount.toString(),
                currency: currency || "USD"
            });
        }

        // Log Activity (Non-blocking)
        await appendToActivityLog([
            crypto.randomUUID(), invoiceId, merchant_ref_id, "INVOICE_CREATED",
            amount.toString(), currency || "USD", "3THIX",
            req.headers["x-vercel-ip-country"] || "", req.headers["user-agent"] || "", "",
            JSON.stringify(userMetadata), new Date().toISOString()
        ]);

        const redirectUrl = `${process.env.PAYMENT_PAGE_BASE}?invoiceId=${invoiceId}&callbackUrl=${encodeURIComponent(returnUrl)}`;

        res.json({ invoiceId, redirectUrl });

    } catch (e) {
        console.error("Create Invoice Error:", e);
        res.status(500).json({ error: "Failed to create invoice" });
    }
}

/* ---------- Logic: Check/Process Status ---------- */
export async function handlePaymentLogic(invoiceId, sourceLabel = '3THIX_API', importData = null) {
    if (!invoiceId) return null;

    // 1. Fetch Existing State (Source of Truth)
    const tx = await findTransaction(invoiceId);
    const textStatus = tx ? tx.STATUS : null;

    // 2. Determine Incoming Status
    let incomingStatus = 'PENDING';
    let incomingData = null;

    // Resolve Data Source
    if (importData) {
        // Webhook or Direct Import
        const raw = importData.internalStatusOverride || importData.status || importData.payment_status || (importData.invoice ? importData.invoice.status : null);
        incomingStatus = normalizeStatus(raw);
        incomingData = importData;
    } else {
        // Authoritative Fetch (Fallback)
        try {
            // Only fetch if we really need to (e.g. not a webhook)
            // But hardening plan says "Authoritative API Check".
            // If source is WEBHOOK, we trust the importData (verified).
            if (sourceLabel !== 'WEBHOOK') {
                const res = await fetch(`${process.env.THIX_API_URL}/invoice/issuer/get`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-api-key": process.env.THIX_API_KEY },
                    body: JSON.stringify({ id: invoiceId })
                });
                if (res.ok) {
                    const apiData = await res.json();
                    const raw = apiData.invoice?.status || apiData.status || apiData.order?.status || 'PENDING';
                    incomingStatus = normalizeStatus(raw);
                    incomingData = apiData;
                }
            }
        } catch (e) { console.error("3Thix Check Fail", e.message); }
    }

    // 3. Strict Transition Rules
    // Rules:
    // CREATED -> SUCCESS : OK
    // CREATED -> FAILED : OK
    // SUCCESS -> SUCCESS : OK (Idempotent)
    // SUCCESS -> anything : IGNORE
    // FAILED -> anything : IGNORE
    // * -> PROCESSING : IGNORE (Strict rule: Never auto-upgrade to PROCESSING)

    if (textStatus === 'SUCCESS') {
        // Idempotency: Already success, do nothing.
        // Return success state.
        const meta = safeParse(incomingData?.metadata);

        // PII Redacted Log (Optional debug)
        console.log(`[PAYMENT] Idempotent Success Check for ${invoiceId.slice(-4)}`);

        return {
            invoiceId,
            status: 'SUCCESS',
            emailSent: tx?.EMAIL_SENT === 'YES',
            source: 'CACHE'
        };
    }

    if (textStatus === 'FAILED') {
        console.log(`[PAYMENT] Ignored update for FAILED invoice ${invoiceId.slice(-4)}`);
        return { invoiceId, status: 'FAILED', source: 'CACHE' };
    }

    // If new status is PENDING/PROCESSING, and we are CREATED, do NOT update.
    // We only update on final states.
    if (incomingStatus !== 'SUCCESS' && incomingStatus !== 'FAILED') {
        // Pending/Processing updates are ignored to prevent phantom writes.
        return { invoiceId, status: textStatus || 'CREATED', source: 'CACHE' };
    }

    // 4. Apply Update (CREATED -> SUCCESS/FAILED)

    // Extract Metadata safely
    const rawMeta = incomingData?.metadata ? (typeof incomingData.metadata === 'string' ? safeParse(incomingData.metadata) : incomingData.metadata) : {};
    const walletAddress = rawMeta.walletAddress || "";
    const email = rawMeta.email || "";
    const name = rawMeta.name || "";
    const amount = incomingData?.amount || incomingData?.invoice?.amount || "0";

    // PII Redaction for Logs
    const redactedMeta = { ...rawMeta };
    if (redactedMeta.email) redactedMeta.email = "***";
    if (redactedMeta.name) redactedMeta.name = "***";
    if (redactedMeta.walletAddress) redactedMeta.walletAddress = "***";

    // Persist Raw Log (Redacted)
    // We only log if it's a state change to avoid spam
    if (incomingData) {
        // We shouldn't log full JSON if it has PII.
        // Let's log a sanitized version or just essential fields.
        const safeLogData = { status: incomingStatus, invoiceId, timestamp: new Date().toISOString() };
        await appendToRawResponses([invoiceId, sourceLabel, incomingStatus, JSON.stringify(safeLogData), new Date().toISOString()]);
    }

    if (incomingStatus === 'SUCCESS') {
        // Calculate Tokens
        let tokens = "", tokenPrice = "";
        try {
            const p = await getPrice();
            const price = p?.price_usd || 0.082;
            const amtVal = parseFloat(amount);
            if (price > 0 && amtVal > 0) {
                tokenPrice = price.toString();
                tokens = (amtVal / price).toFixed(6);
            }
        } catch (e) { }

        // Update Sheet
        await updateTransactionStatus(invoiceId, 'SUCCESS', {
            email, name, walletAddress, tokens, tokenPrice
        });

        // Send Emails
        // Admin
        const redactedWallet = walletAddress ? `${walletAddress.substring(0, 6)}...` : "";
        await sendAdminPaymentNotification({
            invoiceId, amount, currency: "USD", tokenPrice, tokens,
            email, name, walletAddress, source: sourceLabel, timestamp: new Date().toISOString()
        });
        // User
        await sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress);

        // Activity Log (Redacted)
        await appendToActivityLog([
            crypto.randomUUID(), invoiceId, "", "PAYMENT_SUCCESS",
            "***", "USD", "3THIX", "", "", "", JSON.stringify(redactedMeta), new Date().toISOString()
        ]);

        // Additional Info (Keep PII here as it is the secure storage)
        if (email || name) {
            await appendToAdditionalInfo(["", invoiceId, name, email, new Date().toISOString(), walletAddress]);
        }
    } else if (incomingStatus === 'FAILED') {
        await updateTransactionStatus(invoiceId, 'FAILED', {});
        await appendToActivityLog([
            crypto.randomUUID(), invoiceId, "", "PAYMENT_FAILED",
            "***", "USD", "3THIX", "", "", "", JSON.stringify(redactedMeta), new Date().toISOString()
        ]);
    }

    return {
        invoiceId,
        status: incomingStatus,
        emailSent: incomingStatus === 'SUCCESS',
        source: sourceLabel
    };
}

function normalizeStatus(s) {
    if (!s) return 'PENDING';
    s = s.toUpperCase();
    if (['PAID', 'COMPLETED', 'SUCCESS', 'INVOICE_PAID', 'ORDER_COMPLETED'].includes(s)) return 'SUCCESS';
    if (['CANCELLED', 'FAILED', 'ERROR', 'EXPIRED', 'ORDER_FAILED'].includes(s)) return 'FAILED';
    return 'PENDING'; // Everything else is PENDING, including PROCESSING
}

function safeParse(str) {
    try { return JSON.parse(str); } catch (e) { return {}; }
}
