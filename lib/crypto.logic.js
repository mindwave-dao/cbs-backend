import { appendToCryptoPayments } from "./sheets.logic.js";
import { sendCryptoUserAcknowledgementEmail, sendCryptoAdminNotificationEmail } from "./email.logic.js";

/**
 * Validates email format strictly
 */
function isValidEmail(email) {
    const EMAIL_REGEX = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
    return EMAIL_REGEX.test(email);


}

/**
 * Basic sanitization to prevent injection
 */
function sanitize(input) {
    if (typeof input !== 'string') return input;
    return input.trim()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * Basic sanitization to prevent injection
 */


/**
 * POST /api/crypto/submit
 * Handles manual crypto payment submissions.
 * 
 * 1. Validates input
 * 2. logs to CRYPTO_PAYMENTS sheet (PENDING VERIFICATION)
 * 3. Sends acknowledgement to User
 * 4. Sends notification to Admin
 * 
 * FAILURE STRATEGY:
 * - If inputs invalid -> 400
 * - If sheets/email fail -> Log error but return 200 "Pending Verification" to user
 *   (Don't alarm user if our backend glitches, we can recover from logs)
 */
export async function submitCryptoPayment(req, res) {
    const {
        fullName,
        email,
        walletAddress,
        amount,
        estimatedTokens,
        network,
        txHashLast6
    } = req.body;

    // 1. Input Validation
    if (!fullName || !email || !walletAddress || !amount || !network || !txHashLast6) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    if (!isValidEmail(email)) {
        return res.status(400).json({ error: "Invalid email format" });
    }

    if (!/^[a-zA-Z0-9]{6}$/.test(txHashLast6)) {
        return res.status(400).json({ error: "Transaction hash must be exactly 6 alphanumeric characters" });
    }

    console.log(`[CRYPTO_SUBMIT] Processing payment for ${email} (${amount} USD)`);

    // 2. Prepare Data
    const timestamp = new Date().toISOString();

    // Order matches CRYPTO_PAYMENTS_HEADERS in sheets.logic.js
    // [timestamp, full_name, email, wallet_address, amount, estimated_tokens, network, tx_hash_last6, status]
    const sheetRow = [
        timestamp,
        fullName.trim(),
        email.trim(),
        walletAddress.trim(),
        amount.toString(),
        (estimatedTokens || "0").toString(),
        network,
        txHashLast6,
        "PENDING_VERIFICATION"
    ];

    try {
        // 3. Write to Sheets
        await appendToCryptoPayments(sheetRow);

        // 4. Send Emails (Fire & Forget / Async)
        // We don't want email failure to block the UI success response
        const emailParams = {
            fullName,
            email,
            walletAddress,
            amount,
            estimatedTokens,
            network,
            txHash: txHashLast6,
            timestamp
        };

        const emailPromises = [
            sendCryptoUserAcknowledgementEmail(email, fullName, walletAddress, amount, estimatedTokens, network, txHashLast6),
            sendCryptoAdminNotificationEmail(emailParams)
        ];

        Promise.all(emailPromises)
            .then(results => {
                const [userRes, adminRes] = results;
                console.log(`[CRYPTO_EMAILS] User: ${userRes?.success}, Admin: ${adminRes}`);
            })
            .catch(err => console.error(`[CRYPTO_EMAIL_ERROR] ${err.message}`));

        // 5. Return Success
        return res.status(200).json({
            success: true,
            status: "PENDING_VERIFICATION",
            message: "Transaction submitted for verification"
        });

    } catch (e) {
        console.error(`[CRYPTO_SUBMIT_ERROR] ${e.message}`);
        // Even if sheets fail, we might want to tell the user "Pending" and rely on logs?
        // But if sheets failed, we have no record. Safe to return 500 here so they retry.
        return res.status(500).json({
            success: false,
            status: "PENDING_VERIFICATION", // UI shows "Verification in progress" instead of "Error"
            message: "System busy, please check email for confirmation"
        });
    }
}
