import { processSuccessfulPayment } from '../lib/email.js';

/*
  BREVO HEALTH CHECK ENDPOINT
  Usage: /api/test-brevo-email?email=your_email@example.com
*/

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const { email } = req.query;

    if (!email) {
        return res.status(400).json({ error: 'Missing ?email= param' });
    }

    try {
        console.log(`[BREVO HEALTH CHECK] Testing email to ${email}...`);

        // We reuse the updated processSuccessfulPayment logic but wrap it to not touch sheets if we pass a dummy invoice
        // Actually, processSuccessfulPayment tries to update sheets. 
        // The user asked for a "Simple transactional email via Brevo".
        // "Return { success: true, messageId } or { error }"
        // So we should probably call sendPaymentSuccessEmail directly? 
        // But sendPaymentSuccessEmail is exported. Yes. 
        // However, sendPaymentSuccessEmail is logic for "Payment Success".
        // The prompt says "Send a simple transactional email via Brevo... Validate Brevo independently of payment flow".
        // It's cleaner to duplicate the fetch logic briefly or export a generic sender. 
        // Given the prompt "Return { success: true, messageId } or { error }... Log full Brevo response", 
        // I will implementation a specific check here that mirrors the logic but separates concerns (no DB/Sheet updates).

        const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";
        const BREVO_API_KEY = process.env.BREVO_API_KEY;
        const EMAIL_FROM = process.env.EMAIL_FROM || "payments@mindwavedao.com";

        if (!BREVO_API_KEY) {
            throw new Error('BREVO_API_KEY not configured');
        }

        const payload = {
            sender: {
                email: EMAIL_FROM,
                name: "Mindwave Health Check"
            },
            to: [{ email }],
            subject: "Brevo Health Check - System Test",
            htmlContent: `
        <h1>Brevo Health Check</h1>
        <p>This is a test email to verify the Brevo integration.</p>
        <p>Timestamp: ${new Date().toISOString()}</p>
      `
        };

        const response = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": BREVO_API_KEY
            },
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        console.log('[BREVO HEALTH TEST]', {
            status: response.status,
            body: result
        });

        if (!response.ok || !result.messageId) {
            return res.status(500).json({
                success: false,
                error: 'Brevo returned error',
                details: result
            });
        }

        return res.json({
            success: true,
            messageId: result.messageId,
            fullResponse: result
        });

    } catch (err) {
        console.error('[BREVO HEALTH TEST ERROR]', err);
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
}
