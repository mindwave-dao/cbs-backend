
import { getSheetsClient, findTransaction, updateTransactionStatus, markEmailSent } from "./sheets.logic.js";
import { sendUserPaymentSuccessEmail, sendAdminPaymentNotification } from "./email.logic.js";

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

/**
 * Helper to look up status in the raw "Transactions" sheet (legacy/3Thix)
 * Returns { status, amount, currency, timestamp } or null if not found.
 */
async function checkRawTransactionsSheet(invoiceId) {
    const client = await getSheetsClient();
    if (!client || !SHEET_ID) return null;

    try {
        const res = await client.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            // Header is row 1. Data starts row 2. 
            // Invoice ID is Column G (index 6). 
            // Status is Column E (index 4).
            // Amount is Column C (index 2).
            // Currency is Column D (index 3).
            // Timestamp is Column L (index 11).
            range: "Transactions!A2:L"
        });
        const rows = res.data.values || [];
        for (const row of rows) {
            if (row[6] === invoiceId) {
                return {
                    status: row[4],
                    amount: row[2],
                    currency: row[3],
                    timestamp: row[11]
                };
            }
        }
    } catch (e) {
        console.warn(`[FINALIZER] Failed to read Transactions sheet: ${e.message}`);
    }
    return null;
}

/**
 * Helper to fetch additional info (Wallet Address, Name, Email, Timestamp)
 * Returns { walletAddress, name, email, timestamp }
 */
async function fetchAdditionalInfo(invoiceId) {
    const client = await getSheetsClient();
    if (!client || !SHEET_ID) return {};

    try {
        const res = await client.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            // PaymentAdditionalInfo headers: merchant_ref_id, invoice_id, name, email, timestamp, wallet_address
            // Columns: A, B, C, D, E, F
            // Invoice ID is B (index 1).
            range: "PaymentAdditionalInfo!A:F"
        });
        const rows = res.data.values || [];
        for (const row of rows) {
            if (row[1] === invoiceId) {
                return {
                    name: row[2],
                    email: row[3],
                    timestamp: row[4],
                    walletAddress: row[5]
                };
            }
        }
    } catch (e) {
        console.warn(`[FINALIZER] Failed to read AdditionalInfo sheet: ${e.message}`);
    }
    return {};
}

/**
 * Finalizes payment status by checking both ledgers, reconciling, and sending emails.
 * @param {string} invoiceId 
 * @returns {Promise<object>} Standardized status object
 */
export async function finalizePaymentStatus(invoiceId) {
    // 1. Fetch current authoritative status from PAYMENT_TRANSACTIONS
    let tx = await findTransaction(invoiceId);

    // 2. Fetch raw status from Transactions
    const rawData = await checkRawTransactionsSheet(invoiceId);
    const rawStatus = rawData?.status;

    // 3. Fetch Additional Info (Wallet Address, etc)
    const additionalInfo = await fetchAdditionalInfo(invoiceId);

    // 4. Determine Final Status
    let currentStatus = tx ? tx.STATUS : null;
    let finalStatus = currentStatus || "PROCESSING"; // Default start state

    // Reconciliation Rule: If raw is SUCCESS, force SUCCESS
    if (rawStatus === 'SUCCESS' && currentStatus !== 'SUCCESS') {
        finalStatus = 'SUCCESS';
    } else if (!currentStatus && rawStatus) {
        finalStatus = rawStatus;
    }

    // 10 Minute Pending Rule
    // If status is PROCESSING (or effectively pending) and time > 10m, keep PROCESSING.
    // We don't change status based on time, just ensure we don't downgrade.
    // Logic: If already SUCCESS, stay SUCCESS. If FAILED, stay FAILED.
    // If pending, just report pending.

    // 5. Update PAYMENT_TRANSACTIONS status consistency
    if ((tx && tx.STATUS !== finalStatus) || (!tx && finalStatus)) {
        console.log(`[FINALIZER] Updating status for ${invoiceId}: ${currentStatus} -> ${finalStatus}`);
        await updateTransactionStatus(invoiceId, finalStatus, {
            email: additionalInfo.email,
            name: additionalInfo.name,
            // We persist minimal info in transactions, but wallet address is NOT here.
            // Token/Price info? We assume it might be in tx or passed in update.
            // If this is a hydration event, we might miss token info if not in AdditionalInfo.
            // But AdditionalInfo does not have tokens/price.
            // We can try to infer or leave blank.
        });
        // Reload tx
        tx = await findTransaction(invoiceId);
    }

    // 6. Trigger Emails (Only on SUCCESS)
    let emailSentUser = tx ? (tx.EMAIL_SENT === 'YES') : false;
    let emailSentAdmin = tx ? (tx.ADMIN_EMAIL_SENT === 'YES') : false;

    if (finalStatus === 'SUCCESS') {
        const amount = rawData?.amount || "1.00"; // Fallback
        const tokens = tx?.TOKENS_PURCHASED || "0";
        const tokenPrice = tx?.TOKEN_PRICE || "0.082"; // Fallback price?
        const wa = additionalInfo.walletAddress || "Not Provided";
        const email = tx?.EMAIL || additionalInfo.email;
        const name = tx?.NAME || additionalInfo.name;

        // User Email
        if (!emailSentUser) {
            console.log(`[FINALIZER] Triggering User Email for ${invoiceId}`);
            await sendUserPaymentSuccessEmail(
                email,
                name,
                invoiceId,
                tokens,
                tokenPrice,
                amount,
                wa
            );
            emailSentUser = true; // Assumed success for API response, logic handles actual update
        }

        // Admin Email
        if (!emailSentAdmin) {
            console.log(`[FINALIZER] Triggering Admin Email for ${invoiceId}`);
            await sendAdminPaymentNotification({
                invoiceId,
                amount,
                currency: rawData?.currency || "USD",
                tokenPrice,
                tokens,
                email,
                name,
                walletAddress: wa,
                source: "3THIX",
                timestamp: new Date().toISOString()
            });
            emailSentAdmin = true;
        }
    }

    // 7. Return Standardized Unified Status
    return {
        invoiceId,
        status: finalStatus,
        amount: rawData?.amount ? `${rawData.amount} ${rawData.currency || 'USD'}` : "1.00 USD",
        tokensPurchased: tx?.TOKENS_PURCHASED || "0",
        walletAddress: additionalInfo.walletAddress || null,
        emailSent: emailSentUser,
        timestamp: additionalInfo.timestamp || tx?.EMAIL_SENT_AT || new Date().toISOString()
    };
}
