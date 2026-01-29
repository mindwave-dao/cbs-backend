// MOCK ENV BEFORE IMPORT
process.env.THIX_WEBHOOK_SECRET = "test_secret";
process.env.WEBHOOK_AUTH_TOKEN = "test_token";

import crypto from 'crypto';
// import handler from '../api/payment-callback.js'; // Removed static import
// Mock Google Auth to prevent real sheets call or just mock the logic
// Since we can't easily mock the internal imports of the handler without a mocking library,
// We will focus on the SECURITY and PARSING logic which happens BEFORE imports are heavily used (except applyCors).
// Wait, `applyCors` is imported. If we run this, it will try to import `../lib/cors.js`.
// Node should handle relative imports fine if files exist.

// We need to Mock `res` object.
const createRes = () => {
    const res = {
        _status: 200,
        _json: null,
        status: function (s) { this._status = s; return this; },
        json: function (j) { this._json = j; return this; },
        setHeader: function (k, v) { return this; }, // Mock impl
        end: function () { return this; }
    };
    return res;
};

// We need to Mock `req` object as an Async Iterable for `getRawBody`
const createReq = (method, headers, bodyString) => {
    const req = {
        method,
        headers,
        [Symbol.asyncIterator]: async function* () {
            yield Buffer.from(bodyString);
        }
    };
    return req;
};

async function runTests() {
    const { default: handler } = await import('../api/payment-callback.js');
    console.log("--- STARTING LOCAL WEBHOOK TESTS ---");

    // TEST 1: INVALID METHOD
    {
        const req = createReq("GET", {}, "");
        const res = createRes();
        await handler(req, res);
        console.log(`Test 1 (GET): Status ${res._status} (Expected 200 ignored)`);
    }

    // TEST 2: MISSING AUTH
    {
        const req = createReq("POST", {}, "{}");
        const res = createRes();
        await handler(req, res);
        console.log(`Test 2 (No Auth): Status ${res._status} (Expected 401)`);
    }

    // TEST 3: INVALID AUTH
    {
        const req = createReq("POST", { authorization: "Bearer wrong" }, "{}");
        const res = createRes();
        await handler(req, res);
        console.log(`Test 3 (Bad Auth): Status ${res._status} (Expected 401)`);
    }

    // TEST 4: MISSING SIGNATURE
    {
        const req = createReq("POST", { authorization: "Bearer test_token" }, "{}");
        const res = createRes();
        await handler(req, res);
        console.log(`Test 4 (No Sig): Status ${res._status} (Expected 401)`); // Or 500 if config error check comes first, but likely 401
    }

    // TEST 5: INVALID SIGNATURE
    {
        const payload = JSON.stringify({ event: "TEST" });
        const req = createReq("POST", {
            authorization: "Bearer test_token",
            "x-webhook-signature": "invalid_sig"
        }, payload);
        const res = createRes();
        await handler(req, res);
        console.log(`Test 5 (Bad Sig): Status ${res._status} (Expected 401)`);
    }

    // TEST 6: VALID SIGNATURE + SUCCESS EVENT
    // Note: This will try to call `handlePaymentLogic`. We haven't mocked it. 
    // It might fail or error out. Use try/catch in handler to see 500.
    {
        const payload = JSON.stringify({
            invoice_id: "inv_123",
            event: "INVOICE_PAID",
            metadata: { walletAddress: "0x123", email: "test@example.com" }
        });
        const hmac = crypto.createHmac('sha256', process.env.THIX_WEBHOOK_SECRET);
        const sig = hmac.update(Buffer.from(payload)).digest('hex');

        const req = createReq("POST", {
            authorization: "Bearer test_token",
            "x-webhook-signature": sig
        }, payload);

        const res = createRes();
        // It will fail at handlePaymentLogic probably due to real DB connection missing in environment or missing deps
        // But we want to see it pass security.
        try {
            await handler(req, res);
            console.log(`Test 6 (Valid Sig): Status ${res._status} (Expected 200 or 500 if DB fails)`);
            if (res._status === 500) console.log("   -> Error likely due to DB connection (Expected in dry run)");
        } catch (e) {
            console.log("Test 6 Exception:", e.message);
        }
    }

    console.log("--- TESTS COMPLETED ---");
}

runTests();
