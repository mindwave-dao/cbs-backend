import { authenticateSupportAdmin } from '../../lib/auth.js';
import { applyCors } from '../../lib/cors.js';
import fetch from 'node-fetch';

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

        // 2. Fetch from Google Sheets (EMAIL_LOGS)
        const { getEmailLogs } = await import('../../lib/sheets.logic.js');
        const { limit = 50, email } = req.query;

        console.log(`[EMAIL_LOGS] Fetching logs for email: ${email || 'ALL'}, limit: ${limit}`);

        const { logs, error } = await getEmailLogs({ email, limit });

        if (error) {
            console.error(`[EMAIL_LOGS_FAIL] Sheets error: ${error}`);
            // Fallback to empty or error?
            return res.status(500).json({ error: "Failed to fetch logs from database" });
        }

        // 4. Audit Log
        const { appendToAuditLog } = await import('../../lib/sheets.logic.js');
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        // Don't log every refresh if it's frequent? Admin might refresh a lot.
        // User requirements: "Log every admin action: LOGIN | VIEW ... "
        // "Resource: EMAIL_LOGS"
        await appendToAuditLog([
            new Date().toISOString(), "supportadmin", "SUPPORT_ADMIN", "VIEW_EMAIL_LOGS", "BREVO", null, ip
        ]);

        return res.status(200).json({ logs });

    } catch (e) {
        console.error("[EMAIL_LOGS_ERROR]", e);
        return res.status(500).json({ error: "Internal Error" });
    }
}
