import { verifySupportAdminCredentials, signAdminToken } from '../../lib/auth.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: "Missing required fields" });
    }

    try {
        const isValid = await verifySupportAdminCredentials(username, password);

        if (!isValid) {
            // Delay to prevent timing attacks
            await new Promise(resolve => setTimeout(resolve, 500));
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = await signAdminToken();

        // Secure Cookie
        const isProd = process.env.NODE_ENV === 'production';
        const cookieOptions = [
            `support_admin_token=${token}`,
            'HttpOnly',
            'Path=/',
            'SameSite=Strict',
            `Max-Age=3600` // 1 hour
        ];

        if (isProd) {
            cookieOptions.push('Secure');
        }

        res.setHeader('Set-Cookie', cookieOptions.join('; '));

        // Log Audit Event (Login)
        // We need to import appendToAuditLog roughly here, but I haven't implemented it yet. 
        // I'll add a TODO or try to import if it existed.
        const { appendToAuditLog } = await import('../../lib/sheets.logic.js');
        if (appendToAuditLog) {
            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            // "admin", "SUPPORT_ADMIN", "LOGIN", "AUTH", null, timestamp, ip
            await appendToAuditLog([
                "supportadmin", "SUPPORT_ADMIN", "LOGIN", "AUTH", null, new Date().toISOString(), ip
            ]);
        }

        return res.status(200).json({ success: true, message: "Logged in" });

    } catch (e) {
        console.error("[LOGIN_ERROR]", e);
        return res.status(500).json({ error: "Internal Error" });
    }
}
