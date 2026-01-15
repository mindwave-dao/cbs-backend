
import { getPrice } from "../lib/price.js";

/*
  GET /api/price
  Public endpoint to get current NILA price.
*/

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const priceData = await getPrice();
        if (!priceData) {
            return res.status(503).json({ error: "Price service unavailable" });
        }
        res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=30');
        return res.json(priceData);
    } catch (e) {
        console.error("[PRICE ENDPOINT ERROR]", e);
        return res.status(500).json({ error: "Internal Server Error" });
    }
}
