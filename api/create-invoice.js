import { applyCors } from "../lib/cors.js";

export default async function handler(req, res) {
    // 1. Handle CORS & OPTIONS
    if (applyCors(req, res)) return;

    // 2. Method Check
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Method not allowed" });
    }

    // 3. Logic
    try {
        const { createInvoiceLogic } = await import("../lib/payment.logic.js");
        return createInvoiceLogic(req, res);
    } catch (e) {
        console.error("Create Invoice Error:", e);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
