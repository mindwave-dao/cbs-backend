


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
import { getPrice } from "./price.js";


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
                return_url: "https://example.com/pending", // Placeholder
                metadata: JSON.stringify(userMetadata),
                cart: [{ product_name: description, qty_unit: quantity, price_unit: (amount / quantity).toString() }]
            })
        });

        const text = await response.text();
        let data;
        try { data = JSON.parse(text); } catch (e) { throw new Error(`3Thix invalid response: ${text.substring(0, 100)}`); }

        const invoiceId = data.invoice_id || data.invoice?.id || data.id;
        if (!invoiceId) throw new Error("No invoice ID returned");

        // Update Return URL
        const returnUrl = `${FRONTEND_BASE_URL.replace(/\/$/, "")}/payment-success.html?invoiceId=${invoiceId}`;
        await fetch(`${THIX_API_URL}/order/payment/update/${invoiceId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "x-api-key": THIX_API_KEY },
            body: JSON.stringify({ return_url: returnUrl })
        }).catch(e => console.warn("Return URL update failed", e));

        // COMPLIANCE: Write to PAYMENT_TRANSACTIONS (CREATED)
        // Using local logic to match schema
        const createdAt = new Date().toISOString();
        const initialRow = [
            invoiceId, "CREATED", email, name, walletAddress, network || "",
            amount.toString(), currency || "USD", createdAt,
            "NO", "NO", "", "", "", createdAt
        ];
        await appendToTransactions(initialRow);

        // Log Activity
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


/* ---------- Logic: Payment Finalization (Centralized) ---------- */
export async function finalizeSuccessfulPayment({
    invoiceId,
    authoritativeSource, // e.g. "WEBHOOK", "ADMIN_RECONCILE"
    thixPayload // The raw payload or data object from 3THIX
}) {
    // 1. Check current status (idempotent)
    // 1. Check current status (idempotent vs repair)
    const tx = await findTransaction(invoiceId);
    if (tx && tx.STATUS === 'SUCCESS') {
        const hasTokens = tx.TOKENS_PURCHASED && Number(tx.TOKENS_PURCHASED) > 0;

        if (hasTokens) {
            console.log(`[PAYMENT_FINALIZER] Idempotent Success Check for ${invoiceId.slice(-4)}`);
            return { invoiceId, status: 'SUCCESS', source: 'CACHE', idempotent: true };
        }

        console.log(`[PAYMENT_FINALIZER] Repairing SUCCESS for ${invoiceId.slice(-4)} (Missing Tokens)`);
        // Proceed to logic (tokens calc + email send)
    }

    // Extract Metadata
    const incomingData = thixPayload || {};
    const rawMeta = incomingData.metadata ? (typeof incomingData.metadata === 'string' ? safeParse(incomingData.metadata) : incomingData.metadata) : {};

    // Normalize Fields
    const walletAddress = rawMeta.walletAddress || rawMeta.wallet_address || "";
    const email = rawMeta.email || "";
    const name = rawMeta.name || "";
    const amount = incomingData.amount || incomingData.invoice?.amount || "0";
    const currency = incomingData.currency || incomingData.invoice?.currency || "USD";
    const network = detectWalletNetwork(walletAddress);

    // 2. Calculate Tokens
    let tokens = "", tokenPrice = "";
    try {
        const p = await getPrice();
        const price = p?.price_usd || 0.082;
        const amtVal = parseFloat(amount);
        if (price > 0 && amtVal > 0) {
            tokenPrice = price.toString();
            tokens = (amtVal / price).toFixed(6);
        }
    } catch (e) {
        console.warn(`[PAYMENT_FINALIZER] Price fetch failed for ${invoiceId}`, e);
    }

    // 3. Update Sheet via updateTransactionStatus (Handles STATUS=SUCCESS)
    // This updates PAYMENT_TRANSACTIONS (status, tokens, price, etc.)
    await updateTransactionStatus(invoiceId, 'SUCCESS', {
        email, name, walletAddress, walletNetwork: network,
        amount, currency, tokens, tokenPrice
    });

    // 4. Trigger Emails
    try {
        // Admin
        await sendAdminPaymentNotification({
            invoiceId, amount, currency: currency || "USD", tokenPrice, tokens,
            email, name, walletAddress, source: authoritativeSource, timestamp: new Date().toISOString()
        });
        await markEmailSent(invoiceId, 'ADMIN');

        // User
        await sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress);
        await markEmailSent(invoiceId, 'USER');
    } catch (emailErr) {
        console.error(`[PAYMENT_FINALIZER] Email failed for ${invoiceId}`, emailErr);
    }

    // 5. Activity Log
    await appendToActivityLog([
        crypto.randomUUID(), invoiceId, "", "PAYMENT_SUCCESS",
        amount, currency, authoritativeSource, "", "", "",
        JSON.stringify({ ...rawMeta, email: '***', name: '***', walletAddress: '***' }),
        new Date().toISOString()
    ]);

    // 6. Additional Info
    if (email || name) {
        await appendToAdditionalInfo(["", invoiceId, name, email, new Date().toISOString(), walletAddress]);
    }

    return {
        invoiceId,
        status: 'SUCCESS',
        source: authoritativeSource,
        tokens,
        tokenPrice
    };
}

export async function handlePaymentLogic(invoiceId, sourceLabel = '3THIX_API', importData = null) {
    if (!invoiceId) return null;

    // 1. Fetch Existing State
    const tx = await findTransaction(invoiceId);
    const textStatus = tx ? tx.STATUS : null;

    // 2. Determine Incoming Status
    let incomingStatus = 'PENDING';
    let incomingData = null;

    if (importData) {
        const raw = importData.internalStatusOverride || importData.status || importData.payment_status || (importData.invoice ? importData.invoice.status : null);
        incomingStatus = normalize3ThixStatus(raw);
        incomingData = importData;
    } else {
        // Authoritative Fetch if needed (only if strictly required, usually webhook provides data)
        // For simplicity and speed in webhook, we trust importData if from WEBHOOK source.
        if (sourceLabel !== 'WEBHOOK') {
            try {
                const res = await fetch(`${process.env.THIX_API_URL}/invoice/issuer/get`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-api-key": process.env.THIX_API_KEY },
                    body: JSON.stringify({ id: invoiceId })
                });
                if (res.ok) {
                    const apiData = await res.json();
                    const raw = apiData.invoice?.status || apiData.status || apiData.order?.status || 'PENDING';
                    incomingStatus = normalize3ThixStatus(raw);
                    incomingData = apiData;
                }
            } catch (e) { console.error("3Thix Check Fail", e.message); }
        }
    }

    // 3. Strict Transition Rules
    // 3. Strict Transition Rules
    if (textStatus === 'SUCCESS') {
        // Already SUCCESS: Check for repair need
        if (incomingStatus === 'SUCCESS') {
            const hasTokens = tx.TOKENS_PURCHASED && Number(tx.TOKENS_PURCHASED) > 0;
            if (hasTokens) {
                console.log(`[PAYMENT] Idempotent Success Check for ${invoiceId.slice(-4)}`);
                return { invoiceId, status: 'SUCCESS', source: 'CACHE' };
            }
            console.log(`[PAYMENT] Triggering Repair for SUCCESS invoice ${invoiceId.slice(-4)}`);
            // Fall through to allow finalizeSuccessfulPayment to run repair
        } else {
            // Downgrade attempt?
            console.log(`[PAYMENT] Ignored downgrade for SUCCESS invoice ${invoiceId.slice(-4)}`);
            return { invoiceId, status: 'SUCCESS', source: 'CACHE' };
        }
    }

    if (textStatus === 'FAILED') {
        // TERMINAL state.
        return { invoiceId, status: 'FAILED', source: 'CACHE' };
    }

    // Never auto-upgrade to PROCESSING. Only SUCCESS or FAILED allowed from CREATED.
    if (incomingStatus !== 'SUCCESS' && incomingStatus !== 'FAILED') {
        return { invoiceId, status: textStatus || 'CREATED', source: 'CACHE' };
    }

    // 4. Update Logic
    const rawMeta = incomingData?.metadata ? (typeof incomingData.metadata === 'string' ? safeParse(incomingData.metadata) : incomingData.metadata) : {};
    const walletAddress = rawMeta.walletAddress || rawMeta.wallet_address || "";
    const email = rawMeta.email || "";
    const name = rawMeta.name || "";
    const amount = incomingData?.amount || incomingData?.invoice?.amount || "0";
    const currency = incomingData?.currency || incomingData?.invoice?.currency || "USD";
    const network = detectWalletNetwork(walletAddress);

    // Logging (Redacted)
    if (incomingData) {
        const safeLogData = { status: incomingStatus, invoiceId, timestamp: new Date().toISOString() };
        await appendToRawResponses([invoiceId, sourceLabel, incomingStatus, JSON.stringify(safeLogData), new Date().toISOString()]);
    }

    if (incomingStatus === 'SUCCESS') {
        // Updated to use Centralized Finalizer
        const result = await finalizeSuccessfulPayment({
            invoiceId,
            authoritativeSource: sourceLabel,
            thixPayload: incomingData
        });

        // Return structured result consistent with old return if needed, or just let it fall through
        // The rest of the function (emails, logs) was MOVED to finalizeSuccessfulPayment.
        // We can just break or return here, but existing logic returned { invoiceId, status, source }.
        // finalizeSuccessfulPayment returns a bit more, but we can stick to the contract.

    } else if (incomingStatus === 'FAILED') {
        await updateTransactionStatus(invoiceId, 'FAILED', {});
        await appendToActivityLog([
            crypto.randomUUID(), invoiceId, "", "PAYMENT_FAILED",
            amount, currency, sourceLabel, "", "", "",
            JSON.stringify({ ...rawMeta, email: '***' }),
            new Date().toISOString()
        ]);
    }

    return {
        invoiceId,
        status: incomingStatus,
        source: sourceLabel
    };
}

/* ---------- Logic: Status Check (Read Only) ---------- */
export async function checkPaymentStatusLogic(invoiceId) {
    if (!invoiceId) return { status: "ERROR", message: "Missing Invoice ID" };

    const tx = await findTransaction(invoiceId);
    if (!tx) {
        return { status: "NOT_FOUND", invoiceId };
    }

    const { STATUS, CREATED_AT, TOKEN_PRICE, TOKENS_PURCHASED, WALLET_ADDRESS, AMOUNT, CURRENCY } = tx;

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
    if (STATUS === 'CREATED') {
        const createdTime = new Date(CREATED_AT).getTime();
        const now = Date.now();
        const diffMinutes = (now - createdTime) / 60000;

        if (!isNaN(diffMinutes) && diffMinutes > 5) {
            return { status: 'AWAITING_WEBHOOK', invoiceId, message: "Payment confirmation pending." };
        }
        return { status: 'CREATED', invoiceId, message: "Waiting for payment..." };
    }

    // Fallback for any other status (shouldn't exist)
    return { status: 'CREATED', invoiceId };
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
