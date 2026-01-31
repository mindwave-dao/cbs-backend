import { applyCors } from "../lib/cors.js";
import { createInvoiceLogic } from "../lib/payment.logic.js";
import { validateEnv } from "../lib/env.js"; // Import newly created env validator

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    if (applyCors(req, res)) return;

    // 2. Validate Env (Fail Fast)
    try {
        validateEnv();
    } catch (e) {
        console.error("ENV ERROR:", e.message);
        return res.status(500).json({ error: "Server Configuration Error" });
    }

    // 3. Method Check
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // 3. Logic
    try {
        return createInvoiceLogic(req, res);
    } catch (e) {
        console.error("Create Invoice Error:", e);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
