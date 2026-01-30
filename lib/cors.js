export function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://buynow.mindwavedao.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
}
