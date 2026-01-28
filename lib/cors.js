
/**
 * Strict CORS Middleware
 * 
 * Requirements:
 * 1. Allow only specific Mindwave origins.
 * 2. Reject all others.
 * 3. Handle OPTIONS globally (return 200, no logic).
 * 4. Set required headers (Origin, Methods, Headers, Max-Age).
 */

const ALLOWED_ORIGINS = [
    "https://buynow.mindwavedao.com"
];

/**
 * Applies CORS headers and handles OPTIONS requests.
 * @param {Object} req - HTTP Request
 * @param {Object} res - HTTP Response
 * @returns {boolean} - Returns `true` if the request was handled (e.g. OPTIONS) and should stop execution. Returns `false` to continue.
 */
export function applyCors(req, res) {
    const origin = req.headers.origin;

    // 1. Validate & Set Origin
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
    }

    // 2. Set Common Headers
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours

    // 3. Handle OPTIONS Globally
    if (req.method === "OPTIONS") {
        res.status(200).end();
        return true; // Stop execution
    }

    return false; // Continue execution
}
