const { THIX_API_URL, THIX_API_KEY } = process.env;

/**
 * Creates a fulfillment for the given invoice ID.
 * @param {string} invoiceId 
 * @returns {Promise<string>} The fulfillment ID
 */
async function createFulfillment(invoiceId) {
    if (!THIX_API_URL || !THIX_API_KEY) {
        throw new Error("Missing 3THIX credentials");
    }

    const res = await fetch(`${THIX_API_URL}/fulfillment/create`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": THIX_API_KEY
        },
        body: JSON.stringify({ invoice_id: invoiceId })
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Fulfillment creation failed: ${res.status} ${text}`);
    }

    const data = await res.json();
    return data.fulfillment_id || data.id;
}

/**
 * Polls the fulfillment status until terminal state or max retries.
 * @param {string} fulfillmentId 
 * @returns {Promise<string>} Final status (e.g., COMPLETED, SETTLED, FAILED)
 */
async function pollFulfillmentStatus(fulfillmentId) {
    const MAX_RETRIES = 3;
    const DELAY_MS = 5000;

    for (let i = 0; i < MAX_RETRIES; i++) {
        await new Promise(r => setTimeout(r, DELAY_MS));

        try {
            const res = await fetch(`${THIX_API_URL}/fulfillment/${fulfillmentId}`, {
                method: "GET",
                headers: { "x-api-key": THIX_API_KEY }
            });

            if (!res.ok) continue;

            const data = await res.json();
            const status = (data.status || "").toUpperCase();

            console.log(`[FULFILLMENT] ${fulfillmentId} status: ${status} (Attempt ${i + 1}/${MAX_RETRIES})`);

            if (["COMPLETED", "SETTLED"].includes(status)) {
                return status;
            }
            if (["FAILED", "CANCELLED", "ERROR"].includes(status)) {
                return status;
            }
        } catch (e) {
            console.warn(`[FULFILLMENT POLL ERROR] ${e.message}`);
        }
    }

    return "TIMEOUT";
}

/**
 * Orchestrates fulfillment verification.
 * 1. Create Fulfillment
 * 2. Poll Status
 * 3. Return true only if COMPLETED/SETTLED
 * @param {string} invoiceId 
 * @returns {Promise<{success: boolean, status: string, fulfillmentId: string}>}
 */
export async function verifyFulfillment(invoiceId) {
    try {
        console.log(`[FULFILLMENT] Starting verification for ${invoiceId}`);
        const fulfillmentId = await createFulfillment(invoiceId);

        if (!fulfillmentId) {
            console.error(`[FULFILLMENT] No ID returned for ${invoiceId}`);
            return { success: false, status: "NO_ID" };
        }

        const status = await pollFulfillmentStatus(fulfillmentId);

        if (["COMPLETED", "SETTLED"].includes(status)) {
            console.log(`[FULFILLMENT] Success: ${status}`);
            return { success: true, status, fulfillmentId };
        }

        console.error(`[FULFILLMENT] Failed or Timeout. Final Status: ${status}`);
        return { success: false, status, fulfillmentId };

    } catch (err) {
        console.error(`[FULFILLMENT ERROR] ${invoiceId}`, err);
        return { success: false, status: "ERROR", error: err.message };
    }
}
