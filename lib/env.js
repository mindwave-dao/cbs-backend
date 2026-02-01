
export function validateEnv() {
    const REQUIRED_ENV = [
        "THIX_API_URL",
        "THIX_API_KEY",
        "THIX_MERCHANT_KEY",
        "THIX_GATEWAY_ID",
        "GOOGLE_SHEET_ID",
        "GOOGLE_SHEETS_CREDENTIALS",
        "BREVO_API_KEY",
        "EMAIL_FROM",
        "EMAIL_FROM_NAME",
        "ADMIN_EMAIL",
        "FRONTEND_BASE_URL",
        "BREVO_CRYPTO_USER_CONFIRMATION_TEMPLATE_ID",
        "BREVO_CRYPTO_ADMIN_SUBMISSION_TEMPLATE_ID"
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
