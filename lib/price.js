
import fetch from "node-fetch";

// Cache structure: { price: number, timestamp: number, source: string }
let priceCache = null;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Environment variables
const COINGECKO_API_BASE = process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3";
const COINMARKETCAP_API_BASE = process.env.COINMARKETCAP_API_BASE || "https://pro-api.coinmarketcap.com";
const COINMARKETCAP_API_KEY = process.env.COINMARKETCAP_API_KEY;

export async function getPrice() {
    const now = Date.now();
    if (priceCache && (now - priceCache.timestamp < CACHE_TTL_MS)) {
        return {
            symbol: 'NILA',
            price_usd: priceCache.price,
            source: priceCache.source + ' (cached)'
        };
    }

    let priceData = await fetchCoinGecko();

    if (!priceData) {
        console.warn("[PRICE] CoinGecko failed, trying CoinMarketCap...");
        priceData = await fetchCoinMarketCap();
    }

    if (priceData) {
        priceCache = {
            price: priceData.price,
            timestamp: now,
            source: priceData.source
        };
        return {
            symbol: 'NILA',
            price_usd: priceData.price,
            source: priceData.source
        };
    }

    // If both fail, return hardcoded fallback or error? 
    // Requirement said "fetch and persist live NILA price". 
    // If getting live price fails completely, maybe throw or return 0? 
    // Let's return null to indicate failure so caller can decide (e.g. queue retry or fail).
    // Or return a safe default if authorized? No, safer to fail for now.
    console.error("[PRICE] All price sources failed.");
    return null;
}

async function fetchCoinGecko() {
    try {
        const url = `${COINGECKO_API_BASE}/simple/price?ids=mindwavedao&vs_currencies=usd`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        // Structure: { "mindwavedao": { "usd": 0.123 } }
        if (data.mindwavedao && data.mindwavedao.usd) {
            return { price: data.mindwavedao.usd, source: 'coingecko' };
        }
    } catch (e) {
        console.error("[PRICE] CoinGecko error:", e.message);
    }
    return null;
}

async function fetchCoinMarketCap() {
    if (!COINMARKETCAP_API_KEY) return null;
    try {
        // Assuming we search by symbol 'NILA' or ID if known. 
        // Docs: /v1/cryptocurrency/quotes/latest?symbol=NILA
        const url = `${COINMARKETCAP_API_BASE}/v1/cryptocurrency/quotes/latest?symbol=NILA`;
        const res = await fetch(url, {
            headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }
        });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        // Structure: data.data.NILA.quote.USD.price
        if (data.data?.NILA?.quote?.USD?.price) {
            return { price: data.data.NILA.quote.USD.price, source: 'coinmarketcap' };
        }
    } catch (e) {
        console.error("[PRICE] CoinMarketCap error:", e.message);
    }
    return null;
}
