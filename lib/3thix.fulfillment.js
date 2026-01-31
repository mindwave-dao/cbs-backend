
const { THIX_API_KEY } = process.env;
const THIX_API_URL = (process.env.THIX_API_URL || "").replace(/\/$/, ""); // Remove trailing slash

/**
 * Normalizes 3Thix status to internal standard
 */
export function normalize3ThixStatus(rawStatus) {
    if (!rawStatus) return 'PENDING';
    const s = rawStatus.toUpperCase();
    if (['PAID', 'COMPLETED', 'SUCCESS', 'INVOICE_PAID', 'ORDER_COMPLETED', 'APPROVED', 'SETTLED'].includes(s)) return 'SUCCESS';
    if (['CANCELLED', 'FAILED', 'ERROR', 'EXPIRED', 'ORDER_FAILED'].includes(s)) return 'FAILED';
    if (['PARTIALLY_PAID', 'PARTIAL'].includes(s)) return 'PARTIAL';
    return 'PENDING';
}

/**
 * Fetches Invoice Details from 3Thix
 * POST /invoice/details/get
 * Returns structured { status, data }
 */
export async function get3ThixInvoiceDetails(invoiceId) {
    if (!THIX_API_KEY || !THIX_API_URL || !invoiceId) {
        console.error('[3THIX LIB] Missing Config or InvoiceID');
        return { status: 'ERROR', error: 'Configuration Error' };
    }

    try {
        const targetUrl = `${THIX_API_URL}/invoice/details/get`;
        console.log(`[3THIX LIB] Details Target URL: ${targetUrl}`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                "Content-Type": "application/json",
                "x-api-key": THIX_API_KEY
            },
            body: JSON.stringify({ id: invoiceId })
        });

        if (!response.ok) {
            const txt = await response.text();
            console.warn(`[3THIX LIB] Details fetch failed: ${response.status} ${txt}`);
            return { status: 'ERROR', error: txt };
        }

        const data = await response.json();
        const invoice = data.invoice || data; // Handle wrapper

        // Determine Status
        let rawStatus = invoice.status || invoice.payment_status || 'PENDING';

        // Check fulfillment specifically if invoice is open but might be fulfilled?
        // Usually invoice.status is authoritative.

        const status = normalize3ThixStatus(rawStatus);

        return {
            status,
            rawStatus,
            data: invoice
        };

    } catch (e) {
        console.error(`[3THIX LIB] Exception: ${e.message}`);
        return { status: 'ERROR', error: e.message };
    }
}

/**
 * Checks Fulfillment Status (Authoritative Fallback)
 * Combined check: Invoice Details -> Normalization
 */
export async function check3ThixStatus(invoiceId) {
    return await get3ThixInvoiceDetails(invoiceId);
}
