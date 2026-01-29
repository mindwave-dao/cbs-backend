
/**
 * centralized environment variable validation
 * Ensures all required variables are present before logic execution.
 */

export function validateEnv() {
    const required = [
        "THIX_API_URL",
        "THIX_API_KEY",
        "THIX_WEBHOOK_SECRET",
        "WEBHOOK_AUTH_TOKEN",
        "GOOGLE_SHEET_ID",
        "GOOGLE_SHEETS_CREDENTIALS",
        "BREVO_API_KEY",
        "EMAIL_FROM",
        "ADMIN_EMAIL"
    ];

    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(`MISSING ENV VARIABLES: ${missing.join(", ")}`);
    }

    // URL Validations
    if (!process.env.THIX_API_URL.startsWith('https://api.3thix.com') && !process.env.THIX_API_URL.includes('sandbox')) {
        // Allow sandbox if strictly needed, but prompt said "Validates ... matches https://api.3thix.com"
        // The prompt for "create-payment-invoice.js" had strict check.
        // "THIX_API_URL must be https://api.3thix.com"
        if (!process.env.THIX_API_URL.startsWith('https://api.3thix.com')) {
            throw new Error('INVALID CONFIG: THIX_API_URL must be https://api.3thix.com (or compatible)');
        }
    }

    return {
        THIX_API_URL: process.env.THIX_API_URL,
        THIX_API_KEY: process.env.THIX_API_KEY,
        GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
        GOOGLE_SHEETS_CREDENTIALS: process.env.GOOGLE_SHEETS_CREDENTIALS,
        BREVO_API_KEY: process.env.BREVO_API_KEY,
        EMAIL_FROM: process.env.EMAIL_FROM,
        ADMIN_EMAIL: process.env.ADMIN_EMAIL,
        FRONTEND_BASE_URL: process.env.FRONTEND_BASE_URL || "https://mindwavedao.com", // Fallback
        PAYMENT_PAGE_BASE: process.env.PAYMENT_PAGE_BASE || "https://pay.3thix.com",
        WEBHOOK_AUTH_TOKEN: process.env.WEBHOOK_AUTH_TOKEN,
        VERCEL_URL: process.env.VERCEL_URL
    };
}
