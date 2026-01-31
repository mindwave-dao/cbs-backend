/**
 * Centralized CORS middleware.
 * - Sets strict Access-Control-Allow-Origin
 * - Handles OPTIONS preflight with 204
 * - Allows critical headers including X-Webhook-Signature
 */
export function applyCors(req, res) {
    // STRICT ORIGIN
    res.setHeader("Access-Control-Allow-Origin", "https://buynow.mindwavedao.com");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PATCH,PUT,DELETE");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-Requested-With, X-Webhook-Signature, X-Ag-Request-Id"
    );
    res.setHeader("Access-Control-Max-Age", "86400"); // 24 hours

    if (req.method === "OPTIONS") {
        res.status(204).end();
        return true;
    }
    return false;
}
