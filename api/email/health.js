import { processSuccessfulPayment } from "../../lib/email.js";

export default async function handler(req, res) {
    // CORS Setup
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email } = req.query;
    const targetEmail = email || process.env.ADMIN_EMAIL; // Default to admin if no email provided

    if (!targetEmail) {
        return res.status(400).json({ error: 'No target email available (query param or ADMIN_EMAIL env var)' });
    }

    try {
        console.log(`[EMAIL HEALTH CHECK] Sending test email to ${targetEmail}`);

        // We reuse the existing function but with a dummy invoice ID
        const result = await processSuccessfulPayment(
            'HEALTH-CHECK-' + Date.now(),
            targetEmail,
            'Health Check User'
        );

        return res.status(200).json({
            status: 'OK',
            message: 'Email service is healthy',
            details: result
        });

    } catch (error) {
        console.error('[EMAIL HEALTH CHECK FAILED]', error);
        return res.status(500).json({
            status: 'ERROR',
            message: 'Email service failed',
            error: error.message
        });
    }
}
