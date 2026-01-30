import { setCorsHeaders } from "../lib/cors.js";

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // 2. Method Check
    if (req.method !== 'GET') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { getPrice } = await import("../lib/price.js");
        const priceData = await getPrice();
        if (priceData) {
            return res.status(200).json(priceData);
        } else {
            return res.status(500).json({ error: "Failed to fetch price" });
        }
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
