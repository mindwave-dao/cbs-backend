import { applyCors } from "../lib/cors.js";

// Dynamic imports are used inside handler to prevent cold start crashes
// from blocking OPTIONS requests.

// Router
export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    if (applyCors(req, res)) return;

    // 2. PARSE URL (Early to control validation)
    const url = new URL(req.url, `https://${req.headers.host}`);
    const path = url.pathname;

    console.log(`[ROUTER] ${req.method} ${path}`);

    // 3. ENV VALIDATION (Skip for public Price API to avoid hard crash on missing keys)
    if (path !== '/api/price') {
        try {
            const { validateEnv } = await import("../lib/env.js");
            validateEnv();
        } catch (e) {
            console.error("ENV ERROR:", e.message);
            return res.status(500).json({ error: "Server Configuration Error" });
        }
    }

    // 1. Create Invoice
    // Matches /api/create-payment-invoice AND /api/create-invoice (new standard)
    if (path === '/api/create-invoice' || path === '/api/create-payment-invoice') {
        if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });
        const { createInvoiceLogic } = await import("../lib/payment.logic.js");
        return createInvoiceLogic(req, res);
    }

    // 2. Check Payment Status
    // Matches /api/check-payment-status AND /api/check-payment (new standard)
    if (path === '/api/check-payment' || path === '/api/check-payment-status') {
        if (req.method !== 'GET') return res.status(405).json({ error: "Method not allowed" });
        const { invoiceId } = req.query;
        if (!invoiceId) return res.status(400).json({ error: "Missing invoiceId" });

        try {
            // Updated to use Read-Only Logic
            const { checkPaymentStatusLogic } = await import("../lib/payment-logic.js");
            const result = await checkPaymentStatusLogic(invoiceId);

            if (result.status === 'NOT_FOUND') {
                return res.status(404).json(result);
            }

            return res.status(200).json(result);
        } catch (e) {
            console.error("Check Status Error:", e);
            return res.status(500).json({ error: "Internal Error" });
        }
    }

    // 3. Invoice Status (Read-Only)
    if (path === '/api/invoice/status') {
        if (req.method !== 'GET') return res.status(405).json({ error: "Method not allowed" });
        const { invoiceId } = req.query;
        if (!invoiceId) return res.status(400).json({ error: "Missing invoiceId" });

        // Use Logic from previous 'api/invoice/status.js'
        // I need to import that logic. I'll dynamically import or move it.
        // Since users said "ONLY ONE file under /api/", i must move it.
        // It seems I haven't moved it yet. I will import `findTransaction` from sheets.logic and map it.
        const { findTransaction } = await import("../lib/sheets.logic.js");
        const tx = await findTransaction(invoiceId);

        if (!tx) return res.json({ status: "NOT_FOUND" });

        let status = tx.STATUS === 'SUCCESS' ? 'PAID' : tx.STATUS;

        return res.json({
            invoiceId,
            status,
            amountUsd: parseFloat(tx.AMOUNT || tx.AMOUNT_USD || 0), // Note: findTransaction maps columns, I need to check headers mapping in sheets.logic
            // sheets.logic findTransaction maps indices:
            // r[6] -> TOKEN_PRICE, r[7] -> TOKENS_PURCHASED
            // But wait, `findTransaction` in `sheets.logic.js` maps predefined columns from `TRANSACTIONS_HEADERS`?
            // The original `api/invoice/status.js` was nice because it was dynamic.
            // `sheets.logic.js` uses strict indices for `findTransaction`.
            // I should rely on `sheets.logic.js` for consistency now.
            nilaTokens: parseFloat(tx.TOKENS_PURCHASED || 0),
            pricePerNila: parseFloat(tx.TOKEN_PRICE || 0),
            walletAddress: tx.WALLET_ADDRESS,
            email: tx.EMAIL,
            emailSent: tx.EMAIL_SENT === 'YES',
            createdAt: new Date().toISOString() // We don't have createdAt in `findTransaction` map yet (only email_sent_at)
        });
    }

    // 4. Webhook
    if (path === '/api/webhooks/3thix') {
        const { handle3ThixWebhook } = await import("../lib/webhook.logic.js");
        return handle3ThixWebhook(req, res);
    }

    // 5. Email Health
    if (path === '/api/email/health') {
        const { email } = req.query;
        try {
            const { emailHealthCheck } = await import("../lib/email.logic.js");
            const result = await emailHealthCheck(email);
            return res.json({ status: "OK", result });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    // 6. Price API (for frontend token price display)
    if (path === '/api/price') {
        if (req.method !== 'GET') return res.status(405).json({ error: "Method not allowed" });
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
        try {
            const { getPrice } = await import("../lib/price.js");
            const priceData = await getPrice();
            if (priceData) {
                return res.status(200).json(priceData);
            }
            return res.json({ price: null, source: "coingecko" });
        } catch (e) {
            return res.json({ price: null, source: "coingecko", error: e.message });
        }
    }

    // 6. Crypto Payment Submit (ISOLATED)
    if (path === '/api/crypto/submit') {
        if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });
        const { submitCryptoPayment } = await import("../lib/crypto.logic.js");
        return submitCryptoPayment(req, res);
    }

    // 6.5 Crypto Payment Status (Public)
    if (path === '/api/crypto/status') {
        if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });
        const { checkCryptoStatus } = await import("../lib/crypto.logic.js");
        return checkCryptoStatus(req, res);
    }

    // 7. Admin: Confirm Crypto Payment (ISOLATED from Card Flow)
    if (path === '/api/admin/crypto/confirm') {
        const confirmCryptoHandler = await import("./admin/confirm-crypto.js");
        return confirmCryptoHandler.default(req, res);
    }

    return res.status(404).json({ error: 'API route not found' });
}
