import { processSuccessfulPayment, sendAdminPaymentNotification } from "./email.js";
import { getPrice } from "./price.js";
import crypto from "crypto";

// Unified Imports from sheets.logic.js
import {
    getSheetsClient,
    findTransaction,
    findTransactionByTransactionId,
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
// DEPRECATED: finalizeSuccessfulPayment and check3ThixAuthoritative removed.
// Use lib/finalize-payment.js for official logic.

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

// READ-ONLY check by Transaction ID
export async function checkPaymentStatusByTransactionIdLogic(transactionId) {
    const tx = await findTransactionByTransactionId(transactionId);

    // IF NOT FOUND -> 404
    if (!tx) {
        return {
            found: false,
            status: "NOT_FOUND",
            transactionId
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
        transactionId: tx.transactionId || transactionId,
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
