
// Mock Env
process.env.THIX_API_URL = 'https://api.3thix.com';
process.env.THIX_API_KEY = 'mock_key';
process.env.GOOGLE_SHEETS_CREDENTIALS = '{}'; // Will cause sheets init to fail or return dummy
process.env.GOOGLE_SHEET_ID = 'mock_sheet';

// Mock Fetch
global.fetch = async (url, options) => {
    console.log(`[MOCK FETCH] ${url}`);
    if (url.includes('purchase/create')) {
        return {
            ok: true,
            json: async () => ({
                invoice_id: 'inv_mock_123',
                id: 'inv_mock_123'
            })
        };
    }
    return { ok: true, json: async () => ({}) };
};

// Mock Response
class MockRes {
    constructor() {
        this.statusCode = 200;
        this.jsonData = null;
    }
    status(code) {
        this.statusCode = code;
        return this;
    }
    json(data) {
        this.jsonData = data;
        return this;
    }
    setHeader() { }
    end() { }
}

async function testCreatePurchase() {
    console.log("🔹 Testing Create Purchase (Wallet Address Capture)...");
    try {
        const { default: handler } = await import('./api/create-purchase.js');
        const req = {
            method: 'POST',
            headers: {},
            body: {
                amount: 10,
                currency: 'USD',
                description: 'Test Item',
                wallet_address: '0x123...abc'
            }
        };
        const res = new MockRes();
        await handler(req, res);

        // We can't easily inspect if appendToAdditionalInfo was called with specific args unless we mock the library.
        // But we can check if it didn't crash and returned success.
        if (res.statusCode === 200 && res.jsonData.invoiceId) {
            console.log("✅ Create Purchase API returned 200.");
        } else {
            console.error("❌ Create Purchase API failed:", res.jsonData);
        }

    } catch (e) {
        console.error("❌ Create Purchase Test Exception:", e);
    }
}

async function testStatusAPI() {
    console.log("\n🔹 Testing Status API...");
    try {
        const { default: handler } = await import('./api/status.js');
        const req = {
            method: 'GET',
            query: { invoiceId: 'inv_mock_123' }
        };
        const res = new MockRes();

        await handler(req, res);

        // It should try to verify logic. Since sheets fails, it might return NOT_FOUND or UNKNOWN or Error.
        // check finalize-payment.js: catch -> warn. returns default NOT_FOUND object involved.

        console.log("Status API Response:", JSON.stringify(res.jsonData));

        if (res.statusCode === 200 || res.statusCode === 500) {
            // 500 might happen if sheets throws badly, but we have try/catch blocks.
            // We expect 200 even if not found (returns status: NOT_FOUND)
            if (res.jsonData && (res.jsonData.status === 'NOT_FOUND' || res.jsonData.status === 'UNKNOWN')) {
                console.log("✅ Status API handled missing sheets gracefully.");
            } else {
                console.warn("⚠️ Status API response unexpected (might be fine if logic differs):", res.jsonData);
            }
        }

    } catch (e) {
        console.error("❌ Status API Test Exception:", e);
    }
}

async function run() {
    await testCreatePurchase();
    await testStatusAPI();
}

run();
