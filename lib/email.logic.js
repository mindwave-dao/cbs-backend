
import { findTransaction, markEmailSent } from "./sheets.logic.js";
import fetch from "node-fetch";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

/**
 * SEND 3THIX USER PAYMENT SUCCESS EMAIL
 * Triggered after successful card payment via 3thix.
 * Uses Brevo template for consistency.
 */
export async function sendUserPaymentSuccessEmail(to, name, invoiceId, tokens, tokenPrice, amount, walletAddress) {
    if (!to || !process.env.BREVO_API_KEY) return { success: false, emailSent: false };

    // Idempotency Check via Sheets
    const tx = await findTransaction(invoiceId);
    if (tx && tx.email_sent_user === 'YES') {
        console.log(`[EMAIL] Already sent to user for ${invoiceId}`);
        return { success: true, emailSent: true };
    }

    const templateId = parseInt(process.env.BREVO_3THIX_USER_CONFIRMED_TEMPLATE_ID);
    if (!templateId) {
        console.error("Missing BREVO_3THIX_USER_CONFIRMED_TEMPLATE_ID");
        return { success: false, emailSent: false };
    }

    try {
        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                to: [{ email: to, name: name || "" }],
                templateId: templateId,
                params: {
                    full_name: name || "Customer",
                    invoice_id: invoiceId,
                    amount: amount,
                    tokens: tokens,
                    token_price: tokenPrice,
                    wallet_address: walletAddress || "Not Provided",
                    status: "SUCCESS"
                }
            })
        });

        if (!res.ok) {
            const txt = await res.text();
            console.error(`[BREVO FAIL] ${res.status}: ${txt}`);
            throw new Error('BREVO_EMAIL_FAILED');
        }

        const data = await res.json();
        console.log(`[BREVO SENT] 3thix User: ${data.messageId}`);

        // Update Sheets
        await markEmailSent(invoiceId, 'USER');
        return { success: true, emailSent: true };

    } catch (e) {
        console.error(`[EMAIL ERROR] ${e.message}`);
        return { success: false, emailSent: false };
    }
}

/**
 * SEND 3THIX ADMIN PAYMENT NOTIFICATION
 * Triggered after successful card payment via 3thix.
 * Uses Brevo template for consistency.
 */
export async function sendAdminPaymentNotification(params) {
    const {
        invoiceId, amount, currency, tokenPrice, tokens,
        email, source, timestamp, name, walletAddress
    } = params;

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail || !process.env.BREVO_API_KEY) return false;

    // Idempotency: Check if admin email already sent
    const tx = await findTransaction(invoiceId);
    if (tx && tx.email_sent_admin === 'YES') {
        return true;
    }

    const templateId = parseInt(process.env.BREVO_3THIX_ADMIN_CONFIRMED_TEMPLATE_ID);
    if (!templateId) {
        console.error("Missing BREVO_3THIX_ADMIN_CONFIRMED_TEMPLATE_ID");
        return false;
    }

    try {
        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                to: [{ email: adminEmail, name: "Admin" }],
                templateId: templateId,
                params: {
                    invoice_id: invoiceId,
                    full_name: name || "Unknown",
                    email: email || "Unknown",
                    amount: amount,
                    currency: currency || "USD",
                    tokens: tokens,
                    token_price: tokenPrice,
                    wallet_address: walletAddress || "Not Provided",
                    source: source || "3THIX",
                    status: "SUCCESS",
                    timestamp: timestamp || new Date().toISOString()
                }
            })
        });

        if (!res.ok) {
            console.error(`[BREVO ADMIN FAIL] ${res.status}`);
            return false;
        }

        console.log(`[BREVO SENT] 3thix Admin notification`);
        await markEmailSent(invoiceId, 'ADMIN');
        return true;

    } catch (e) {
        console.error(`[ADMIN EMAIL ERROR] ${e.message}`);
        return false;
    }
}

export async function emailHealthCheck(targetEmail) {
    if (!process.env.BREVO_API_KEY) throw new Error("BREVO_API_KEY missing");

    const res = await fetch(BREVO_API_URL, {
        method: "POST",
        headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "api-key": process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
            sender: { email: process.env.EMAIL_FROM || "payments@mindwavedao.com", name: "Health Check" },
            to: [{ email: targetEmail }],
            subject: `Health Check - ${new Date().toISOString()}`,
            htmlContent: "<h1>Health Check OK</h1>"
        })
    });

    if (!res.ok) throw new Error("Brevo responded with error");
    return await res.json();
}

/**
 * SEND CRYPTO USER ACKNOWLEDGEMENT
 * Triggered immediately after crypto payment submission.
 * Status is always PENDING VERIFICATION.
 */
export async function sendCryptoUserAcknowledgementEmail(to, name, walletAddress, amount, estimatedTokens, network, txHash) {
    if (!to || !process.env.BREVO_API_KEY) return { success: false };

    const templateId = parseInt(process.env.BREVO_CRYPTO_USER_SUBMISSION_TEMPLATE_ID);
    if (!templateId) {
        console.error("Missing BREVO_CRYPTO_USER_SUBMISSION_TEMPLATE_ID");
        return { success: false };
    }

    try {
        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                to: [{ email: to, name: name || "" }],
                templateId: templateId,
                params: {
                    full_name: name,
                    wallet_address: walletAddress,
                    amount: amount,
                    estimated_nila_tokens: estimatedTokens,
                    network: network,
                    tx_hash_last6: txHash,
                    status: "PENDING_VERIFICATION"
                }
            })
        });

        if (!res.ok) {
            console.error(`[BREVO CRYPTO FAIL] ${res.status}`);
            return { success: false };
        }
        return { success: true };
    } catch (e) {
        console.error(`[EMAIL ERROR] ${e.message}`);
        return { success: false };
    }
}

/**
 * SEND CRYPTO ADMIN NOTIFICATION
 * Triggered immediately after crypto submission.
 * CTA: Verify & Approve
 */
export async function sendCryptoAdminNotificationEmail(params) {
    const {
        fullName, email, walletAddress, amount, estimatedTokens, network, txHash, timestamp
    } = params;

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail || !process.env.BREVO_API_KEY) return false;

    const templateId = parseInt(process.env.BREVO_CRYPTO_ADMIN_SUBMISSION_TEMPLATE_ID);
    if (!templateId) {
        console.error("Missing BREVO_CRYPTO_ADMIN_SUBMISSION_TEMPLATE_ID");
        return false;
    }

    try {
        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                to: [{ email: adminEmail, name: "Admin" }],
                templateId: templateId,
                params: {
                    full_name: fullName,
                    email: email,
                    wallet_address: walletAddress,
                    amount: amount,
                    estimated_nila_tokens: estimatedTokens,
                    network: network,
                    tx_hash_last6: txHash,
                    status: "PENDING_VERIFICATION",
                    cta_url: process.env.FRONTEND_BASE_URL || "https://buynow.mindwavedao.com"
                }
            })
        });

        if (!res.ok) {
            console.error(`[BREVO ADMIN CRYPTO FAIL] ${res.status}`);
            return false;
        }
        return true;
    } catch (e) {
        console.error(`[ADMIN EMAIL ERROR] ${e.message}`);
        return false;
    }
}

/**
 * SEND CRYPTO USER CONFIRMATION (APPROVED)
 * Triggered when Admin confirms the crypto payment.
 * Status is CONFIRMED.
 */
export async function sendCryptoUserConfirmationEmail(params) {
    const { email, fullName, walletAddress, amount, estimatedTokens, network, txHashLast6 } = params;

    if (!email || !process.env.BREVO_API_KEY) return { success: false };

    const templateId = parseInt(process.env.BREVO_CRYPTO_USER_CONFIRMED_TEMPLATE_ID);
    if (!templateId) {
        console.error("Missing BREVO_CRYPTO_USER_CONFIRMED_TEMPLATE_ID");
        return { success: false };
    }

    try {
        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                to: [{ email: email, name: fullName || "" }],
                templateId: templateId,
                params: {
                    full_name: fullName,
                    wallet_address: walletAddress,
                    amount: amount,
                    estimated_nila_tokens: estimatedTokens,
                    network: network,
                    tx_hash_last6: txHashLast6,
                    status: "CONFIRMED"
                }
            })
        });

        if (!res.ok) {
            console.error(`[BREVO CRYPTO USER CONFIRM FAIL] ${res.status}`);
            return { success: false };
        }
        console.log(`[EMAIL] Crypto confirmation sent to user: ${email}`);
        return { success: true };
    } catch (e) {
        console.error(`[EMAIL ERROR] ${e.message}`);
        return { success: false };
    }
}

/**
 * SEND CRYPTO ADMIN CONFIRMATION (APPROVED RECORD)
 * Triggered when Admin confirms the crypto payment.
 * Sends a record email to admin confirming the action.
 */
export async function sendCryptoAdminConfirmationEmail(params) {
    const { fullName, email, walletAddress, amount, estimatedTokens, network, txHashLast6, timestamp } = params;

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail || !process.env.BREVO_API_KEY) return false;

    const templateId = parseInt(process.env.BREVO_CRYPTO_ADMIN_CONFIRMED_TEMPLATE_ID);
    if (!templateId) {
        console.error("Missing BREVO_CRYPTO_ADMIN_CONFIRMED_TEMPLATE_ID");
        return false;
    }

    try {
        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                to: [{ email: adminEmail, name: "Admin" }],
                templateId: templateId,
                params: {
                    full_name: fullName,
                    email: email,
                    wallet_address: walletAddress,
                    amount: amount,
                    estimated_nila_tokens: estimatedTokens,
                    network: network,
                    tx_hash_last6: txHashLast6,
                    status: "CONFIRMED",
                    confirmed_at: new Date().toISOString(),
                    original_timestamp: timestamp
                }
            })
        });

        if (!res.ok) {
            console.error(`[BREVO ADMIN CRYPTO CONFIRM FAIL] ${res.status}`);
            return false;
        }
        console.log(`[EMAIL] Crypto confirmation sent to admin`);
        return true;
    } catch (e) {
        console.error(`[ADMIN EMAIL ERROR] ${e.message}`);
        return false;
    }
}

