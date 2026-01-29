import { getSheetsClient } from "./sheets.logic.js";
import { check3ThixAuthoritative } from "./payment-logic.js";
import { finalizeSuccessfulPayment, normalize3ThixStatus } from "./payment.logic.js";

/**
 * Scans for pending CREATED invoices and reconciles them with 3THIX.
 * @param {Object} options
 * @param {number} options.minAgeMinutes - Minimum age in minutes to check (default 3)
 * @param {number} options.maxAgeHours - Maximum age in hours to check (default 24)
 * @returns {Promise<{updated: number, skipped: number, errors: number}>}
 */
export async function reconcilePendingInvoices({ minAgeMinutes = 3, maxAgeHours = 24 } = {}) {
    const sheets = await getSheetsClient();
    if (!sheets) {
        throw new Error("Google Sheets client unavailable");
    }

    const sheetId = process.env.GOOGLE_SHEET_ID;
    const stats = { updated: 0, skipped: 0, errors: 0 };

    console.log(`[RECONCILE] Starting scan. Min age: ${minAgeMinutes}m, Max age: ${maxAgeHours}h`);

    try {
        // 1. Fetch all transactions (A=ID, B=Status, I=Created At)
        // We fetch columns A to I to cover CREATED_AT (index 8)
        const range = "PAYMENT_TRANSACTIONS!A:I";
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
        const rows = res.data.values || [];

        // Skip headers (row 0)
        const pendingCandidates = [];
        const now = Date.now();
        const minAgeMs = minAgeMinutes * 60 * 1000;
        const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

        // Iterate rows
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const invoiceId = row[0];
            const status = row[1];
            const createdAtStr = row[8]; // Column I is index 8

            if (!invoiceId) continue;

            // Filter for CREATED (or AWAITING_PAYMENT if used)
            if (status !== "CREATED") continue;

            // Check Age
            if (!createdAtStr) continue;
            const createdTime = new Date(createdAtStr).getTime();
            if (isNaN(createdTime)) continue;

            const age = now - createdTime;

            if (age < minAgeMs) {
                // Too young, likely user is still paying or webhook is in flight
                continue;
            }

            if (age > maxAgeMs) {
                // Too old, stop retrying indefinitely (optional safety)
                continue;
            }

            pendingCandidates.push({ invoiceId, rowIndex: i + 1 });
        }

        console.log(`[RECONCILE] Found ${pendingCandidates.length} candidates.`);

        // 2. Process Candidates
        // Use sequential processing to avoid rate limits if many
        for (const candidate of pendingCandidates) {
            try {
                const { invoiceId } = candidate;

                // Authoritative check
                const apiResult = await check3ThixAuthoritative(invoiceId);
                if (!apiResult) {
                    stats.skipped++;
                    continue; // 404 or error
                }

                const status = normalize3ThixStatus(apiResult.status);

                if (status === 'SUCCESS') {
                    console.log(`[RECONCILE] Upgrading ${invoiceId} to SUCCESS`);

                    // Use centralized finalizer
                    await finalizeSuccessfulPayment({
                        invoiceId,
                        authoritativeSource: "ADMIN_CRON",
                        thixPayload: apiResult.data || apiResult
                    });

                    stats.updated++;
                } else {
                    // Still PENDING or FAILED
                    // We do NOT downgrade. We wait.
                    stats.skipped++;
                }

            } catch (err) {
                console.error(`[RECONCILE ERROR] Candidate ${candidate.invoiceId}`, err);
                stats.errors++;
            }
        }

    } catch (err) {
        console.error("[RECONCILE FATAL]", err);
        throw err;
    }

    console.log(`[RECONCILE] Done. Updated: ${stats.updated}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`);
    return stats;
}
