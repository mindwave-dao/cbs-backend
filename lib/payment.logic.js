
import fetch from "node-fetch";
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

    // Validation
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });
    if (!walletAddress) walletAddress = "";
    else walletAddress = walletAddress.trim().substring(0, 128);

    const THIX_API_URL = process.env.THIX_API_URL;
    const THIX_API_KEY = process.env.THIX_API_KEY;
    const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "https://mindwavedao.com";
    // const VERCEL_URL = process.env.VERCEL_URL; // Using FRONTEND_BASE_URL as main reference

    // Webhook URL
    // const baseUrl = `https://${process.env.VERCEL_URL || req.headers.host}`; // Safer
    // Actually, explicit FRONTEND_BASE_URL is better if set.
    // Use origin from request if needed?
    // Let's use the one from env or construct from host.
    const hostname = req.headers.host;
    const protocol = hostname.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${hostname}`;
    const callback_url = `${baseUrl}/api/webhooks/3thix`;

    const description = "NILA TOKEN - Mindwave";
    const merchant_ref_id = `mw-${Date.now()}`;

    const userMetadata = { name, email, walletAddress };

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
                return_url: "https://example.com/pending", // Will update
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

        // Append CREATED to Sheets
        await appendToTransactions([
            invoiceId, "CREATED", email || "", name || "",
            "NO", "", "", "", "NO", walletAddress
        ]);

        // COMPLIANCE: Write to PAYMENT_TRANSACTIONS (CREATED)
        // COMPLIANCE: Write to PAYMENT_TRANSACTIONS (CREATED)
        const sheets = await getSheetsClient();
        if (sheets) {
            await createPaymentTransaction(sheets, {
                invoiceId,
                email,
                name,
                walletAddress,
                amount: amount.toString(),
                currency: currency || "USD"
            });
        }

        const network = detectWalletNetwork(walletAddress);
        const metaWithNetwork = { ...userMetadata, walletNetwork: network || "" };

        await appendToActivityLog([
            crypto.randomUUID(), invoiceId, merchant_ref_id, "INVOICE_CREATED",
            amount.toString(), currency || "USD", "3THIX",
            req.headers["x-vercel-ip-country"] || "", req.headers["user-agent"] || "", "",
            JSON.stringify(metaWithNetwork), new Date().toISOString()
        ]);

        const redirectUrl = `${process.env.PAYMENT_PAGE_BASE}?invoiceId=${invoiceId}&callbackUrl=${encodeURIComponent(returnUrl)}`;

        res.json({ invoiceId, redirectUrl });

    } catch (e) {
        console.error("Create Invoice Error:", e);
        res.status(500).json({ error: "Failed to create invoice" });
    }
}

/* ---------- Logic: Check/Process Status ---------- */
export async function handlePaymentLogic(invoiceId, sourceLabel = '3THIX_API', webhookData = null) {
    if (!invoiceId) return null;

    let finalStatus = 'PENDING';
    let transactionData = null;
    let apiData = null;

    // 1. Authoritative API Check
    try {
        const res = await fetch(`${process.env.THIX_API_URL}/invoice/issuer/get`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": process.env.THIX_API_KEY },
            body: JSON.stringify({ id: invoiceId })
        });
        if (res.ok) {
            apiData = await res.json();
        }
    } catch (e) { console.error("3Thix Check Fail", e); }

    // Determine Status
    let rawStatus = 'PENDING';
    if (apiData) {
        rawStatus = apiData.invoice?.status || apiData.status || apiData.order?.status || 'PENDING';
        transactionData = apiData;
    } else if (webhookData) {
        rawStatus = webhookData.status || webhookData.invoice?.status || 'PENDING';
        transactionData = webhookData;
    }

    finalStatus = normalizeStatus(rawStatus);

    // Fallback to Sheet status if API failed and no webhook
    if (finalStatus === 'PENDING' && !apiData && !webhookData) {
        const tx = await findTransaction(invoiceId);
        if (tx && tx.STATUS === 'SUCCESS') finalStatus = 'SUCCESS';
        else if (tx) finalStatus = tx.STATUS;
    }

    // Persist Raw Log
    if (apiData || webhookData) {
        await appendToRawResponses([invoiceId, sourceLabel, finalStatus, JSON.stringify(transactionData), new Date().toISOString()]);
    }

    // Update Transaction Sheet
    if (finalStatus !== 'PENDING') {
        // Extract metadata
        const meta = transactionData?.metadata ? (typeof transactionData.metadata === 'string' ? JSON.parse(transactionData.metadata) : transactionData.metadata) : {};
        const walletAddress = meta.walletAddress || "";
        const email = meta.email || "";
        const name = meta.name || "";
        const amount = transactionData?.amount || transactionData?.invoice?.amount || "0";

        // Helper to calculate tokens if SUCCESS
        let tokens = "", tokenPrice = "";
        if (finalStatus === 'SUCCESS') {
            try {
                const p = await getPrice();
                const price = p?.price_usd || 0.082; // Fallback?
                const amtVal = parseFloat(amount);
                if (price > 0 && amtVal > 0) {
                    tokenPrice = price.toString();
                    tokens = (amtVal / price).toFixed(6);
                }
            } catch (e) { }
        }

        await updateTransactionStatus(invoiceId, finalStatus, {
            email, name, walletAddress, tokens, tokenPrice
        });

        // Send Emails if SUCCESS
        if (finalStatus === 'SUCCESS') {
            // Admin Email
            await sendAdminPaymentNotification({
                invoiceId, amount, currency: "USD", tokenPrice, tokens,
                email, name, walletAddress, source: sourceLabel, timestamp: new Date().toISOString()
            });

            // User Email
            await sendUserPaymentSuccessEmail(email, name, invoiceId, tokens, tokenPrice, amount, walletAddress);

            // Log Activity
            await appendToActivityLog([
                crypto.randomUUID(), invoiceId, "", "PAYMENT_SUCCESS",
                amount, "USD", "3THIX", "", "", "", JSON.stringify(meta), new Date().toISOString()
            ]);

            if (email || name) {
                await appendToAdditionalInfo(["", invoiceId, name, email, new Date().toISOString()]);
            }
        }
    }

    // Return current state
    const tx = await findTransaction(invoiceId);
    return {
        invoiceId,
        status: finalStatus,
        emailSent: tx?.EMAIL_SENT === 'YES',
        source: sourceLabel
    };
}

function normalizeStatus(s) {
    if (!s) return 'PENDING';
    s = s.toUpperCase();
    if (['PAID', 'COMPLETED', 'SUCCESS'].includes(s)) return 'SUCCESS';
    if (['CANCELLED', 'FAILED', 'ERROR', 'EXPIRED'].includes(s)) return 'FAILED';
    if (['PROCESSING', 'APPROVED'].includes(s)) return 'PROCESSING';
    return 'PENDING';
}
