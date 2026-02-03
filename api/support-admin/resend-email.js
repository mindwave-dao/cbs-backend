import { authenticateSupportAdmin } from '../../lib/auth.js';
import { findTransaction, appendToAuditLog } from '../../lib/sheets.logic.js';
import { sendUserPaymentSuccessEmail, sendAdminPaymentNotification } from '../../lib/email.logic.js';
import { applyCors } from '../../lib/cors.js';

export default async function handler(req, res) {
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

        const { invoiceId, type } = req.body; // type: 'user', 'admin', 'both'

        if (!invoiceId) {
            return res.status(400).json({ error: "Missing invoiceId" });
        }

        // 2. Fetch Transaction
        const tx = await findTransaction(invoiceId);
        if (!tx) {
            return res.status(404).json({ error: "Transaction not found" });
        }

        // 3. Status Check
        if (tx.status !== 'SUCCESS') {
            return res.status(400).json({ error: `Cannot resend email for status: ${tx.status}` });
        }

        const force = true; // ALWAYS FORCE RESEND
        let results = { user: 'skipped', admin: 'skipped' };

        // 4. Send Emails
        if (type === 'user' || type === 'both') {
            const result = await sendUserPaymentSuccessEmail(
                tx.email,
                tx.name,
                tx.invoice_id,
                tx.tokens_purchased,
                tx.token_price,
                tx.amount,
                tx.wallet_address,
                force
            );
            results.user = result.success ? 'sent' : 'failed';
        }

        if (type === 'admin' || type === 'both') {
            // Reconstruct params
            const params = {
                invoiceId: tx.invoice_id,
                amount: tx.amount,
                currency: tx.currency,
                tokens: tx.tokens_purchased,
                tokenPrice: tx.token_price,
                email: tx.email,
                name: tx.name,
                walletAddress: tx.wallet_address,
                source: "RESEND_ACTION",
                timestamp: new Date().toISOString()
            };
            const success = await sendAdminPaymentNotification(params, force);
            results.admin = success ? 'sent' : 'failed';
        }

        // 5. Audit Log
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await appendToAuditLog([
            new Date().toISOString(),
            "supportadmin", // We assume role here, ideally get from auth token if available
            "SUPPORT_ADMIN",
            "RESEND_EMAIL",
            invoiceId,
            `Type: ${type}, Result: ${JSON.stringify(results)}`,
            ip
        ]);

        return res.status(200).json({ success: true, results });

    } catch (e) {
        console.error("[RESEND_EMAIL_ERROR]", e);
        return res.status(500).json({ error: "Internal Error" });
    }
}
