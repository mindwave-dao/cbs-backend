import { setCors } from "../lib/cors.js";

export default async function handler(req, res) {
    setCors(res);

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    try {
        const r = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=mindwavedao&vs_currencies=usd",
            { headers: { accept: "application/json" } }
        );

        const data = await r.json();
        const price = data.mindwavedao?.usd;

        if (!price) throw new Error("Price not found");

        res.json({ price, source: "coingecko" });
    } catch (e) {
        res.status(500).json({ error: "PRICE_UNAVAILABLE" });
    }
}
