import { authenticateSupportAdmin } from '../../../lib/auth.js';
import {
    findCryptoPayment,
    updateCryptoPaymentStatus,
    appendToAuditLog
} from '../../../lib/sheets.logic.js';
import {
    sendCryptoUserConfirmationEmail,
    sendCryptoAdminConfirmationEmail
} from '../../../lib/email.logic.js';
import { applyCors } from '../../../lib/cors.js';

export default async function handler(req, res) {
    // Apply CORS
    if (applyCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // 1. Auth Check
        const isAuth = await authenticateSupportAdmin(req);
        if (!isAuth) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const { txHashLast6, email, status, notes } = req.body;

        if (!txHashLast6 || !email || !status) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        if (status !== 'VERIFIED' && status !== 'REJECTED') {
            return res.status(400).json({ error: "Invalid status" });
        }

        // 2. Fetch Current Record
        const current = await findCryptoPayment(txHashLast6, email);
        if (!current) {
            return res.status(404).json({ error: "Transaction not found" });
        }

        // 3. Verify Constraints
        if (current.status !== 'PENDING_VERIFICATION') {
            return res.status(400).json({ error: `Cannot update: Current status is ${current.status}` });
        }

        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const timestamp = new Date().toISOString();

        // 4. Update Status
        const success = await updateCryptoPaymentStatus(current.rowIndex, status === 'VERIFIED' ? 'CONFIRMED' : 'REJECTED');
        if (!success) {
            throw new Error("Failed to update sheet");
        }

        // 5. Audit Log
        await appendToAuditLog([
            timestamp, "supportadmin", "SUPPORT_ADMIN", status, "CRYPTO_PAYMENTS", txHashLast6, ip
        ]);

        // 6. Triggers (Only if Verified/Confirmed)
        if (status === 'VERIFIED') {
            const emailParams = {
                fullName: current.fullName,
                email: current.email,
                walletAddress: current.walletAddress,
                amount: current.amount,
                estimatedTokens: current.estimatedTokens,
                network: current.network,
                txHashLast6: current.txHashLast6,
                timestamp: current.timestamp // Original timestamp
            };

            // Async/Fire-and-forget emails
            Promise.all([
                sendCryptoUserConfirmationEmail(emailParams),
                sendCryptoAdminConfirmationEmail(emailParams)
            ]).catch(err => console.error("[CRYPTO_UPDATE_EMAIL_ERROR]", err));
        }

        return res.status(200).json({ success: true, message: "Status updated" });

    } catch (e) {
        console.error("[CRYPTO_UPDATE_ERROR]", e);
        return res.status(500).json({ error: "Internal Error" });
    }
}
