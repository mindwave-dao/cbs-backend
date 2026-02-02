import { authenticateSupportAdmin } from '../../lib/auth.js';
import { applyCors } from '../../lib/cors.js';

export default async function handler(req, res) {
    // Apply CORS
    if (applyCors(req, res)) return;

    if (req.method !== 'GET') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // 1. Auth Check
        const isAuth = await authenticateSupportAdmin(req);
        if (!isAuth) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        // 2. Fetch from Brevo
        // Docs: https://developers.brevo.com/reference/get_smtp_emails
        // Params: limit, offset, startDate, endDate, sort, email
        const { limit = 20, email } = req.query;

        const url = new URL('https://api.brevo.com/v3/smtp/emails');
        url.searchParams.append('limit', limit);
        url.searchParams.append('sort', 'desc');
        if (email) url.searchParams.append('email', email);

        const brevoRes = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'api-key': process.env.BREVO_API_KEY
            }
        });

        if (!brevoRes.ok) {
            console.error(`[BREVO_LOGS_FAIL] ${brevoRes.status}`);
            return res.status(502).json({ error: "Failed to fetch logs from provider" });
        }

        const data = await brevoRes.json();
        const logs = data.transactionalEmails || [];

        // 3. Normalize Response
        const normalized = logs.map(log => ({
            messageId: log.messageId,
            email: log.email,
            subject: log.subject,
            status: log.status, // sent, deferred, queued, etc.
            timestamp: log.date, // ISO string likely
            event: log.event // delivered, request, etc? Need to check Brevo response structure. 
            // Brevo returns { ... "date": "...", "subject": "...", "messageId": "...", "email": "...", "status": "..." }
        }));

        // 4. Audit Log
        const { appendToAuditLog } = await import('../../lib/sheets.logic.js');
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        // Don't log every refresh if it's frequent? Admin might refresh a lot.
        // User requirements: "Log every admin action: LOGIN | VIEW ... "
        // "Resource: EMAIL_LOGS"
        await appendToAuditLog([
            new Date().toISOString(), "supportadmin", "SUPPORT_ADMIN", "VIEW_EMAIL_LOGS", "BREVO", null, ip
        ]);

        return res.status(200).json({ logs: normalized });

    } catch (e) {
        console.error("[EMAIL_LOGS_ERROR]", e);
        return res.status(500).json({ error: "Internal Error" });
    }
}
