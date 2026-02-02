import { applyCors } from '../../lib/cors.js';

export default async function handler(req, res) {
    // Apply CORS
    if (applyCors(req, res)) return;

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // Clear Cookie
        res.setHeader('Set-Cookie', [
            'support_admin_token=',
            'HttpOnly',
            'Path=/',
            'SameSite=Strict',
            'Max-Age=0', // Expire immediately
            'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        ].join('; '));

        const { authenticateSupportAdmin } = await import('../../lib/auth.js');
        const isAuth = await authenticateSupportAdmin(req);

        if (isAuth) {
            const { appendToAuditLog } = await import('../../lib/sheets.logic.js');
            if (appendToAuditLog) {
                const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
                await appendToAuditLog([
                    "supportadmin", "SUPPORT_ADMIN", "LOGOUT", "AUTH", null, new Date().toISOString(), ip
                ]);
            }
        }

        return res.status(200).json({ success: true, message: "Logged out" });

    } catch (e) {
        console.error("[LOGOUT_ERROR]", e);
        return res.status(500).json({ error: "Internal Error" });
    }
}
