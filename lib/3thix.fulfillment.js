
// Note: The new intent API uses public_key/secret_key in body, not x-api-key header
// For status checks, we still need to check if 3thix provides a separate endpoint
const THIX_PUBLIC_KEY = process.env.THIX_PUBLIC_KEY;
const THIX_SECRET_KEY = process.env.THIX_SECRET_KEY;
const THIX_API_URL = (process.env.THIX_API_URL || "https://webadmin.3thix.com").replace(/\/$/, "");

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
 * Fetches Intent/Invoice Details from 3Thix
 * 
 * NOTE: With the new intent-based API, payment status is primarily
 * communicated via webhook. This function is a fallback for reconciliation.
 * The new API may require a different status check endpoint.
 * 
 * @param {string} invoiceId - Our internal invoice ID (reference_id in 3thix)
 * @returns {Promise<{status: string, data?: object, error?: string}>}
 */
export async function get3ThixInvoiceDetails(invoiceId) {
    if (!THIX_PUBLIC_KEY || !THIX_SECRET_KEY || !THIX_API_URL || !invoiceId) {
        console.error('[3THIX LIB] Missing Config or InvoiceID');
        return { status: 'ERROR', error: 'Configuration Error' };
    }

    // NOTE: The new intent API does not have a documented status check endpoint.
    // Status updates come via webhook. This function attempts the old endpoint
    // as a fallback but may need to be updated when 3thix provides a new endpoint.

    console.warn('[3THIX LIB] Status check called - relying on internal DB is preferred');

    try {
        // Try the old endpoint format - may not work with new API
        const targetUrl = `${THIX_API_URL}/api/card/intent-status`;
        console.log(`[3THIX LIB] Attempting status check: ${targetUrl}`);

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                public_key: THIX_PUBLIC_KEY,
                secret_key: THIX_SECRET_KEY,
                reference_id: invoiceId
            })
        });

        if (!response.ok) {
            const txt = await response.text();
            console.warn(`[3THIX LIB] Status check failed: ${response.status} - ${txt}`);
            // Return PENDING as fallback - rely on webhook for updates
            return { status: 'PENDING', error: `API returned ${response.status}` };
        }

        const data = await response.json();
        const intent = data.data || data;

        // Determine Status
        let rawStatus = intent.status || 'PENDING';

        const status = normalize3ThixStatus(rawStatus);

        return {
            status,
            rawStatus,
            data: intent
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
