import { appendToEmailLogs } from "../../lib/sheets.logic.js";

/**
 * Brevo Webhook Handler
 * Listens for transactional email events (delivered, opened, clicked, etc.)
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // AUTHENTICATION CHECK
    // Brevo doesn't sign requests by default, but we can enforce a secret token
    // Passed via ?token=... or Authorization: Bearer ...
    const secret = process.env.BREVO_WEBHOOK_SECRET;
    if (secret) {
        const { token } = req.query;
        const authHeader = req.headers['authorization'];

        const isTokenValid = (token === secret);
        const isHeaderValid = (authHeader === `Bearer ${secret}`);

        if (!isTokenValid && !isHeaderValid) {
            console.warn('[BREVO_WEBHOOK] Unauthorized access attempt');
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    try {
        const payload = req.body;
        console.log('[BREVO_WEBHOOK] Received:', JSON.stringify(payload));

        // Brevo might send a single object or an array of events
        const events = Array.isArray(payload) ? payload : [payload];

        for (const event of events) {
            const {
                event: eventName,
                email,
                date,
                "message-id": messageId,
                subject,
                reason,
                ip,
                "user-agent": userAgent
            } = event;

            if (!email || !eventName) continue;

            const timestamp = date || new Date().toISOString();

            // Format for EMAIL_LOGS: [Timestamp, MessageID, Email, Subject, Event, Status, Reason, IP, UserAgent]
            const row = [
                timestamp,
                messageId || "",
                email,
                subject || "",
                eventName,
                eventName.toUpperCase(), // Status usually matches event for transactional
                reason || "",
                ip || "",
                userAgent || ""
            ];

            await appendToEmailLogs(row);
        }

        return res.status(200).json({ success: true, received: true });

    } catch (error) {
        console.error('[BREVO_WEBHOOK_ERROR]', error);
        // Always return 200 to prevent Brevo from retrying indefinitely on logic errors
        return res.status(200).json({ success: false, error: error.message });
    }
}
