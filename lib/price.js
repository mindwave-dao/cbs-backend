import fetch from "node-fetch";

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
        // We do NOT throw here to avoid crashing the UI or blocking checking.
        // It is up to the caller to decide if 0 is fatal (e.g. for finalization, it might be acceptable if tokens=0?)
        // Actually for finalization we probably want to try hard.
    }

    // 4. Calculate Tokens (Strict Rounding)
    // precision: 6 decimals
    const tokenPrice = priceItem.price_usd;
    let tokens = 0;

    if (tokenPrice > 0 && currentAmountUSD > 0) {
        tokens = parseFloat((currentAmountUSD / tokenPrice).toFixed(6));
    }

    return {
        symbol: 'NILA',
        price_usd: tokenPrice,
        source: priceItem.source,
        tokens_estimated: tokens // Renamed to emphasize it's calculated
    };
}

// Alias for legacy compat if needed, but we should switch callers
export const getPrice = getAuthoritativePrice;


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
