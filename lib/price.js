// Native fetch is available in Node 18+
// import fetch from "node-fetch"; // REMOVED

// Cache structure: { price: number, timestamp: number, source: string }
let priceCache = null;
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getEnv() {
    return {
        COINGECKO_API_BASE: process.env.COINGECKO_API_BASE || "https://api.coingecko.com/api/v3",
        COINMARKETCAP_API_BASE: process.env.COINMARKETCAP_API_BASE || "https://pro-api.coinmarketcap.com",
        COINMARKETCAP_API_KEY: process.env.COINMARKETCAP_API_KEY
    };
}

/**
 * Standardized Pricing Engine
 * Returns authoritative token price and calculations.
 * Used by: Invoice Creation, Payment Finalization, UI Estimates
 * DO NOT use loose math elsewhere.
 */
export async function getAuthoritativePrice(currentAmountUSD = 0) {
    let priceItem = null;
    const now = Date.now();

    // 1. Try Cache
    if (priceCache && (now - priceCache.timestamp < CACHE_TTL_MS)) {
        priceItem = {
            price_usd: priceCache.price,
            source: priceCache.source + ' (cached)'
        };
    }

    // 2. Fetch Live
    if (!priceItem) {
        // Priority 1: DexScreener (Most reliable, no key, no IP blocks usually)
        let priceData = await fetchDexScreener();

        // Priority 2: CoinGecko (Good but often IP blocks servers)
        if (!priceData) {
            priceData = await fetchCoinGecko();
        }

        // Priority 3: CoinMarketCap (Requires Key)
        if (!priceData) {
            priceData = await fetchCoinMarketCap();
        }

        if (priceData) {
            priceCache = {
                price: priceData.price,
                timestamp: now,
                source: priceData.source
            };
            priceItem = {
                price_usd: priceData.price,
                source: priceData.source
            };
        }
    }

    // 3. Fallback / Error
    if (!priceItem) {
        console.error("[PRICE] All price sources failed. Using 0 to prevent block.");
        priceItem = { price_usd: 0, source: 'error' };
    }

    // 4. Calculate Tokens (Strict Rounding)
    // precision: 6 decimals
    const tokenPrice = priceItem.price_usd;
    let tokens = 0;

    if (tokenPrice > 0 && currentAmountUSD > 0) {
        tokens = Math.round(currentAmountUSD / tokenPrice);
    }

    return {
        symbol: 'NILA',
        price_usd: tokenPrice,
        price: tokenPrice, // Alias for frontend compatibility
        source: priceItem.source,
        tokens_estimated: tokens
    };
}

// Alias for legacy compat
export const getPrice = getAuthoritativePrice;

// --- Fetchers ---

async function fetchDexScreener() {
    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/0x00f8da33734feb9b946fec2228c25072d2e2e41f`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        if (data.pairs && data.pairs[0] && data.pairs[0].priceUsd) {
            return { price: parseFloat(data.pairs[0].priceUsd), source: 'dexscreener' };
        }
    } catch (e) {
        console.error("[PRICE] DexScreener error:", e.message);
    }
    return null;
}

async function fetchCoinGecko() {
    const { COINGECKO_API_BASE } = getEnv();
    try {
        const url = `${COINGECKO_API_BASE}/simple/price?ids=mindwavedao&vs_currencies=usd`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        if (data.mindwavedao && data.mindwavedao.usd) {
            return { price: data.mindwavedao.usd, source: 'coingecko' };
        }
    } catch (e) {
        console.error("[PRICE] CoinGecko error:", e.message);
    }
    return null;
}

async function fetchCoinMarketCap() {
    const { COINMARKETCAP_API_KEY, COINMARKETCAP_API_BASE } = getEnv();
    if (!COINMARKETCAP_API_KEY) return null;
    try {
        const url = `${COINMARKETCAP_API_BASE}/v1/cryptocurrency/quotes/latest?symbol=NILA`;
        const res = await fetch(url, {
            headers: { 'X-CMC_PRO_API_KEY': COINMARKETCAP_API_KEY }
        });
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data = await res.json();
        if (data.data?.NILA?.quote?.USD?.price) {
            return { price: data.data.NILA.quote.USD.price, source: 'coinmarketcap' };
        }
    } catch (e) {
        console.error("[PRICE] CoinMarketCap error:", e.message);
    }
    return null;
}

