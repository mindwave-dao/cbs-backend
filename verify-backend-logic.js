
// Mock Env BEFORE imports
process.env.THIX_API_URL = 'https://api.3thix.com';
process.env.PAYMENT_PAGE_BASE = 'https://pay.3thix.com';
process.env.THIX_API_KEY = 'mock_key';
process.env.BREVO_API_KEY = 'mock_brevo';
process.env.EMAIL_FROM = 'test@example.com';
process.env.ADMIN_EMAIL = 'admin@example.com';
process.env.GOOGLE_SHEET_ID = 'mock_sheet';
process.env.GOOGLE_SHEETS_CREDENTIALS = '{}';

// Mock Response Object
class MockRes {
    constructor() {
        this.statusCode = 200;
        this.jsonData = null;
        this.headers = {};
    }
    status(code) {
        this.statusCode = code;
        return this;
    }
    json(data) {
        this.jsonData = data;
        return this;
    }
    setHeader(key, val) {
        this.headers[key] = val;
    }
    end() { }
}

async function verifyDuplicatePrevention() {
    console.log("🔹 Testing Duplicate Invoice Prevention...");

    // Dynamic import to pick up env vars
    const { default: createInvoiceHandler } = await import('./api/create-payment-invoice.js');

    const req = {
        method: 'POST',
        headers: {},
        body: {
            invoiceIdFromSession: 'inv_123_resume_test',
            amount: 100,
            currency: 'USD'
        }
    };
    const res = new MockRes();

    try {
        await createInvoiceHandler(req, res);

        if (res.jsonData && res.jsonData.invoiceId === 'inv_123_resume_test' && res.jsonData.resume === true) {
            console.log("✅ PASS: Correctly resumed invoice");
        } else {
            console.error("❌ FAIL: Did not return resume data", res.jsonData);
        }
    } catch (e) {
        console.error("❌ FAIL: Error during execution", e);
    }
}

async function verifyStatusContract() {
    console.log("\n🔹 Testing Status Contract (Error Case)...");

    const { default: checkStatusHandler } = await import('./api/check-payment-status.js');

    // We expect the handler to catch errors (since we don't have real connection/env) 
    // BUT still return the strict JSON structure even in error/fallback path.
    const req = {
        method: 'GET',
        query: { invoiceId: 'inv_test_contract' }
    };
    const res = new MockRes();

    try {
        await checkStatusHandler(req, res);

        const data = res.jsonData;
        console.log("Response:", JSON.stringify(data));

        const allowedKeys = ['invoiceId', 'status', 'source', 'emailSent', 'error'];

        const actualKeys = Object.keys(data);
        const unexpectedKeys = actualKeys.filter(k => !allowedKeys.includes(k));

        if (data.invoiceId === 'inv_test_contract' && data.status) {
            if (unexpectedKeys.length === 0) {
                console.log("✅ PASS: Contract structure maintained.");
            } else {
                console.error(`❌ FAIL: Unexpected keys found: ${unexpectedKeys.join(', ')}`);
            }
        } else {
            console.error("❌ FAIL: Invalid structure", data);
        }

    } catch (e) {
        console.error("❌ FAIL: Handler crashed", e);
    }
}

async function run() {
    await verifyDuplicatePrevention();
    await verifyStatusContract();
}

run();
