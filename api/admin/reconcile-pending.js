import { reconcilePendingInvoices } from "../../lib/reconcile.logic.js";

// Vercel Cron API Endpoint
export default async function handler(req, res) {
    // 1. Method Check
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // 2. Authorization
    // Supports standard Bearer token
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    // We strictly require ADMIN_TOKEN. 
    // Cron jobs can be secured by CRON_SECRET if provided by Vercel, 
    // but user specified Bearer <ADMIN_TOKEN> in requirements.
    if (token !== process.env.ADMIN_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        // 3. Run Reconciliation
        const result = await reconcilePendingInvoices({
            minAgeMinutes: 3,   // Wait 3 mins before intervening
            maxAgeHours: 24     // Don't check ancient invoices
        });

        // 4. Return Stats
        return res.json({
            ok: true,
            reconciled: result.updated,
            skipped: result.skipped,
            errors: result.errors
        });

    } catch (error) {
        console.error("[CRON ERROR]", error);
        return res.status(500).json({
            ok: false,
            error: error.message
        });
    }
}
