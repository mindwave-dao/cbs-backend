import { sendConfirmedEmail } from "../../lib/email.js";

/*
  EMAIL HEALTH CHECK: GET /api/email/health?email=qa@example.com
  Sends a test email and returns sending logs.
*/

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { email } = req.query;
    if (!email) {
        return res.status(400).json({ error: "Missing 'email' query parameter" });
    }

    try {
        console.log(`[EMAIL HEALTH] Testing for ${email}`);
        const testSubject = `Health Check - ${new Date().toISOString()}`;
        const testHtml = `<p>This is a health check email from CBS Backend.</p><p>Time: ${new Date().toISOString()}</p>`;

        const result = await sendConfirmedEmail(email, "Health Check User", testSubject, testHtml);

        return res.status(200).json({
            status: "OK",
            sent: true,
            details: result
        });

    } catch (error) {
        console.error("[EMAIL HEALTH FAILED]", error);
        return res.status(500).json({
            status: "ERROR",
            sent: false,
            error: error.message,
            stack: error.stack
        });
    }
}
