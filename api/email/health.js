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
            subject: `Health Check - ${new Date().toISOString()}`,
            htmlContent: `
                <h1>Health Check</h1>
                <p>This is a health check email from CBS Backend.</p>
                <p>Time: ${new Date().toISOString()}</p>
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

        console.log('[EMAIL HEALTH RESULT]', {
            status: response.status,
            body: result
        });

        if (!response.ok || !result.messageId) {
            console.error("[EMAIL HEALTH FAILED]", result);
            return res.status(500).json({
                status: "ERROR",
                message: "Failed to send email",
                error: result
            });
        }

        return res.status(200).json({
            status: "OK",
            message: "Email queued successfully",
            messageId: result.messageId
        });

    } catch (error) {
        console.error("[EMAIL HEALTH CRASH]", error);
        return res.status(500).json({
            status: "ERROR",
            message: "Internal Server Error",
            error: error.message
        });
    }
}
