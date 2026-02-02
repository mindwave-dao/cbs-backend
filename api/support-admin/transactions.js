import { authenticateSupportAdmin } from '../../lib/auth.js';
import { getAllTransactions, appendToAuditLog } from '../../lib/sheets.logic.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        // 1. Auth Check
        const isAuth = await authenticateSupportAdmin(req);
        if (!isAuth) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        // 2. Fetch Data
        const { type, status, dateFrom, dateTo } = req.query;
        const result = await getAllTransactions({ type, status, dateFrom, dateTo });

        // 3. Audit Log (View Action)
        // Only log periodically or on specific filters? 
        // User requirements said "Log every admin action: LOGIN | VIEW ... "
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await appendToAuditLog([
            new Date().toISOString(), "supportadmin", "SUPPORT_ADMIN", "VIEW_TRANSACTIONS", "ALL", null, ip
        ]);

        return res.status(200).json(result);

    } catch (e) {
        console.error("[ADMIN_TRANSACTIONS_ERROR]", e);
        return res.status(500).json({ error: "Internal Error" });
    }
}
