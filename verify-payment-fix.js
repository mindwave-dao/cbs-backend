
import crypto from 'crypto';

// 1. Mock Global Fetch
global.fetch = async (url, options) => {
    console.log(`[MOCK FETCH] ${url}`);
    if (url.includes('/order/payment/create')) {
        return {
            ok: true,
            text: async () => JSON.stringify({ invoice_id: 'inv_123', status: 'PENDING' }),
            json: async () => ({ invoice_id: 'inv_123', status: 'PENDING' })
        };
    }
    if (url.includes('/order/payment/update')) {
        return { ok: true };
    }
    if (url.includes('/invoice/issuer/get')) { // 3Thix check
        return {
            ok: true,
            json: async () => ({ invoice: { status: 'SUCCESS' } })
        };
    }
    return { ok: false, text: async () => "Mock Error" };
};

// 2. Mock Env
process.env.THIX_API_URL = 'https://api.3thix.com';
process.env.THIX_API_KEY = 'mock_key';
process.env.THIX_WEBHOOK_SECRET = 'secret123';
process.env.GOOGLE_SHEET_ID = 'mock_sheet';
// process.env.GOOGLE_SHEETS_CREDENTIALS = '{}'; // Leave unset to avoid real connection attempts causing crashes

// 3. Mock Helpers
class MockRes {
    constructor() {
        this.statusCode = 200;
        this.jsonData = null;
    }
    status(code) { this.statusCode = code; return this; }
    json(data) { this.jsonData = data; return this; }
    setHeader() { }
}

async function verifyCreateInvoice() {
    console.log("\n🔹 Test 1: Create Invoice API");
    try {
        const { createInvoiceLogic } = await import('./lib/payment.logic.js');

        const req = {
            method: 'POST',
            headers: { host: 'localhost:3000' },
            body: { name: 'Test', email: 'test@example.com', amount: 100, walletAddress: '0x1234567890123456789012345678901234567890' } // Valid ETH
        };
        const res = new MockRes();

        await createInvoiceLogic(req, res);

        if (res.statusCode === 200 && res.jsonData.invoiceId === 'inv_123') {
            console.log("✅ PASS: Create Invoice returned ID.");
            // Verify callback URL was set correctly (hard to check internal variable, but we checked the file)
        } else {
            console.error("❌ FAIL: Create Invoice", res.jsonData);
        }

    } catch (e) {
        console.error("❌ FAIL: Create Invoice Exception", e);
    }
}

async function verifyPaymentCallback() {
    console.log("\n🔹 Test 2: Payment Callback API (Hardened)");

    // Mock Tokens
    process.env.THIX_WEBHOOK_SECRET = 'secret123';
    process.env.WEBHOOK_AUTH_TOKEN = 'auth123';

    try {
        const { default: callbackHandler } = await import('./api/payment-callback.js');

        const payload = {
            invoice_id: 'inv_123',
            status: 'ORDER_COMPLETED', // Allowed Type
            metadata: JSON.stringify({ email: 'test@example.com', name: 'Test User' })
        };
        const signature = crypto.createHmac('sha256', process.env.THIX_WEBHOOK_SECRET)
            .update(JSON.stringify(payload))
            .digest('hex');

        // Case A: Valid Request
        console.log("  A) Testing Valid Request...");
        const reqSuccess = {
            method: 'POST',
            headers: {
                'x-webhook-signature': signature,
                'authorization': `Bearer ${process.env.WEBHOOK_AUTH_TOKEN}`
            },
            body: payload
        };
        const resSuccess = new MockRes();
        await callbackHandler(reqSuccess, resSuccess);

        if (resSuccess.statusCode === 200) {
            console.log("  ✅ PASS: Valid Callback processed.");
        } else {
            console.error("  ❌ FAIL: Valid Callback rejected", resSuccess.statusCode, resSuccess.jsonData);
        }

        // Case B: Idempotency (Repeat same request)
        console.log("  B) Testing Idempotency...");
        const resIdempotent = new MockRes();
        await callbackHandler(reqSuccess, resIdempotent);
        if (resIdempotent.statusCode === 200) {
            console.log("  ✅ PASS: Idempotent request handled (200 OK).");
        } else {
            console.error("  ❌ FAIL: Idempotent request failed", resIdempotent.statusCode);
        }

        // Case C: Invalid Token
        console.log("  C) Testing Invalid Token...");
        const reqInvalid = {
            method: 'POST',
            headers: {
                'x-webhook-signature': signature,
                'authorization': `Bearer WRONG_TOKEN`
            },
            body: payload
        };
        const resInvalid = new MockRes();
        await callbackHandler(reqInvalid, resInvalid);
        if (resInvalid.statusCode === 401) {
            console.log("  ✅ PASS: Invalid Token rejected (401).");
        } else {
            console.error("  ❌ FAIL: Invalid Token NOT rejected", resInvalid.statusCode);
        }

    } catch (e) {
        console.error("❌ FAIL: Callback exception", e);
    }
}

async function verifySafetyGuard() {
    console.log("\n🔹 Test 3: Status Safety Guard (15 min rule)");
    try {
        const { checkPaymentStatusLogic } = await import('./lib/payment-logic.js');

        // Mock Sheets for Injection
        const mockRow = {
            INVOICE_ID: 'inv_old',
            STATUS: 'CREATED',
            CREATED_AT: new Date(Date.now() - 20 * 60000).toISOString(), // 20 mins ago
            AMOUNT: '100'
        };

        const mockSheets = {
            spreadsheets: {
                values: {
                    get: async () => ({
                        data: {
                            values: [
                                // Header
                                [],
                                // Row (we mock findInPaymentTransactions behavior roughly, 
                                // but wait, `findInPaymentTransactions` calls `get` and parses.
                                // I need to mock the `get` response structure that `findInPaymentTransactions` EXPECTS.
                                ['inv_old', 'CREATED', 'test@test.com', 'Test', '0x123', 'ETH', '100', 'USD', mockRow.CREATED_AT]
                            ]
                        }
                    })
                }
            }
        };

        const result = await checkPaymentStatusLogic('inv_old', mockSheets);

        if (result.status === 'AWAITING_WEBHOOK') {
            console.log("✅ PASS: Correctly escalated to AWAITING_WEBHOOK after 15 mins");
        } else {
            console.error(`❌ FAIL: Expected AWAITING_WEBHOOK, got ${result.status}`);
        }

    } catch (e) {
        console.error("❌ FAIL: Safety Guard Exception", e);
    }
}

async function run() {
    await verifyCreateInvoice();
    await verifyPaymentCallback();
    await verifySafetyGuard();
}

run();
