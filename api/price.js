import { applyCors } from "../lib/cors.js";

export default async function handler(req, res) {
    // 1. HARD CORS GUARD
    if (applyCors(req, res)) return;

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
            return res.json({ price: null, source: "coingecko" });
        }
    } catch (e) {
        return res.json({ price: null, source: "coingecko", error: e.message });
    }
}
