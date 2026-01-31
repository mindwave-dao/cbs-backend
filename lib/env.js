
export function validateEnv() {
    const REQUIRED_ENV = [
        "THIX_API_URL",
        "THIX_API_KEY",
        "THIX_WEBHOOK_URL",
        "THIX_WEBHOOK_SECRET",
        "WEBHOOK_AUTH_TOKEN",
        "GOOGLE_SHEET_ID",
        "GOOGLE_SHEETS_CREDENTIALS",
        "BREVO_API_KEY",
        "EMAIL_FROM",
        "EMAIL_FROM_NAME",
        "ADMIN_EMAIL",
        "FRONTEND_BASE_URL",
        "PAYMENT_PAGE_BASE"
    ];

    const missing = [];
    REQUIRED_ENV.forEach(key => {
        if (!process.env[key]) {
            missing.push(key);
        }
    });

    if (missing.length > 0) {
        throw new Error(`CRITICAL: Missing required env vars: ${missing.join(", ")}`);
    }

    console.log("[ENV] Loaded & validated");
}

// Canonical Webhook URL for creating invoices
// This ensures we never construct it dynamically.
export const THIX_WEBHOOK_URL = process.env.THIX_WEBHOOK_URL;

