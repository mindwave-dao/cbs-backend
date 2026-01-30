import { getSheetsClient } from "../lib/sheets.logic.js";
import { check3ThixAuthoritative, normalize3ThixStatus } from "../lib/payment-logic.js";
import { setCors } from "../lib/cors.js";

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    setCors(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Method Check
    if (req.method !== "POST" && req.method !== "GET") { // Allow GET for browser trigger
        return res.status(405).json({ error: "Method not allowed" });
    }

    // 3. Env Check
    try {
        const { validateEnv } = await import("../lib/env.js");
        validateEnv();
    } catch (e) {
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    const { WEBHOOK_AUTH_TOKEN, GOOGLE_SHEET_ID } = process.env;

    // Security Check
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.includes(WEBHOOK_AUTH_TOKEN)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const sheets = await getSheetsClient();
        if (!sheets) return res.status(500).json({ error: "Database unavailable" });

        // 1. Fetch all transactions
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: "PAYMENT_TRANSACTIONS!A2:B" // Fetch ID and STATUS only
        });

        const rows = response.data.values || [];
        const reconciled = [];
        const errors = [];
        let checkedCount = 0;

        // 2. Filter for pending/processing
        const targetStatuses = ['CREATED', 'PROCESSING', 'PENDING', 'AWAITING_PAYMENT'];
        const pendingRows = rows.filter(row => targetStatuses.includes(row[1]));

        console.log(`[RECONCILIATION] Found ${pendingRows.length} pending transactions out of ${rows.length} total.`);

        for (const row of pendingRows) {
            const invoiceId = row[0];
            if (!invoiceId) continue;
            checkedCount++;

            try {
                // 3. Check 3THIX Status
                const apiResult = await check3ThixAuthoritative(invoiceId);
                if (apiResult) {
                    const status = normalize3ThixStatus(apiResult.status);

                    // 4. Upgrade if SUCCESS
                    if (status === 'SUCCESS') {
                        console.log(`[RECONCILIATION] Upgrading ${invoiceId} to SUCCESS`);
                        try {
                            const { finalizeSuccessfulPayment } = await import("../lib/finalize-payment.js");
                            const result = await finalizeSuccessfulPayment(invoiceId, authResult.data, 'ADMIN_RECONCILE');
                        } catch (e) {
                            // Handle error if finalizeSuccessfulPayment fails or authResult.data is undefined
                            console.error(`[RECONCILIATION ERROR] Failed to finalize payment for ${invoiceId}:`, e);
                            errors.push({ invoiceId, error: e.message });
                        }
                        reconciled.push({ invoiceId, result: result.status });
                    }
                }

                // Rate limit slightly to avoid hammering API if many
                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (err) {
                console.error(`[RECONCILIATION ERROR] ${invoiceId}`, err);
                errors.push({ invoiceId, error: err.message });
            }
        }

        return res.status(200).json({
            message: "Reconciliation complete",
            totalPending: pendingRows.length,
            checked: checkedCount,
            reconciledCount: reconciled.length,
            reconciled,
            errors
        });

    } catch (err) {
        console.error("Reconciliation failed:", err);
        return res.status(500).json({ error: err.message });
    }
}
