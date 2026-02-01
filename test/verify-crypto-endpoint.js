// test/verify-crypto-endpoint.js
import { submitCryptoPayment } from '../lib/crypto.logic.js';

// Mock dependencies
const mockReq = (body) => ({
    method: 'POST',
    body,
    headers: { host: 'localhost:3000' }
});

const mockRes = () => {
    const res = {};
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (data) => {
        res.data = data;
        return res;
    };
    return res;
};

// Mock the external logic functions to prevent actual API calls during basic logic test
// In a real integration test we might want to call them, but here we just verify the handler logic.
// We can't easily mock ES modules without a loader hooks or jest. 
// So this script will actually TRY to call sheets/email if we run it directly with node.
// To avoid side effects, we rely on the fact that missing env vars will just log errors but not crash,
// EXCEPT validateEnv might run? No, submitCryptoPayment doesn't call validateEnv.

console.log("--- STARTING CRYPTO ENDPOINT VERIFICATION ---");

async function testMissingFields() {
    console.log("\n1. Test Missing Fields");
    const req = mockReq({ fullName: "Test" }); // Missing others
    const res = mockRes();

    await submitCryptoPayment(req, res);

    if (res.statusCode === 400 && res.data.error === "Missing required fields") {
        console.log("✅ PASS: Correctly rejected missing fields");
    } else {
        console.error("❌ FAIL: ", res.data);
    }
}

async function testInvalidEmail() {
    console.log("\n2. Test Invalid Email");
    const req = mockReq({
        fullName: "Test",
        email: "invalid-email",
        walletAddress: "0x123",
        amount: 100,
        estimatedTokens: 1000,
        network: "TRC",
        txHashLast6: "123456"
    });
    const res = mockRes();

    await submitCryptoPayment(req, res);

    if (res.statusCode === 400 && res.data.error === "Invalid email format") {
        console.log("✅ PASS: Correctly rejected invalid email");
    } else {
        console.error("❌ FAIL: ", res.data);
    }
}

async function testInvalidHash() {
    console.log("\n3. Test Invalid Hash Length");
    const req = mockReq({
        fullName: "Test",
        email: "test@example.com",
        walletAddress: "0x123",
        amount: 100,
        estimatedTokens: 1000,
        network: "TRC",
        txHashLast6: "123" // Too short
    });
    const res = mockRes();

    await submitCryptoPayment(req, res);

    if (res.statusCode === 400 && res.data.error.includes("exactly 6 alphanumeric characters")) {
        console.log("✅ PASS: Correctly rejected invalid hash length");
    } else {
        console.error("❌ FAIL: ", res.data);
    }
    // Test 3b: Non-Alphanumeric
    console.log("\n3b. Test Non-Alphanumeric Hash");
    const req2 = mockReq({
        fullName: "Test",
        email: "test@example.com",
        walletAddress: "0x123",
        amount: 100,
        estimatedTokens: 1000,
        network: "TRC",
        txHashLast6: "AB!@#$"
    });
    const res2 = mockRes();
    await submitCryptoPayment(req2, res2);

    if (res2.statusCode === 400 && res2.data.error.includes("alphanumeric")) {
        console.log("✅ PASS: Correctly rejected non-alphanumeric hash");
    } else {
        console.error("❌ FAIL: ", res2.data);
    }
}

async function testSuccessFlow() {
    console.log("\n4. Test Success Flow (Dry Run)");
    // This will attempt real calls if env vars are present, or log errors if not.
    // We expect 200 OK regardless of downstream failures (soft fail strategy).

    const req = mockReq({
        fullName: "Unit Test User",
        email: "test@example.com",
        walletAddress: "0x1234567890abcdef",
        amount: 100,
        estimatedTokens: 1000,
        network: "TRC",
        txHashLast6: "ABCDEF"
    });
    const res = mockRes();

    await submitCryptoPayment(req, res);

    // Logic catches errors and returns 500 if sheets fails hard, 
    // OR 200 if fire-and-forget promises fail later?
    // Wait, submitCryptoPayment awaits appendToCryptoPayments.
    // So if sheets fails, it catches and returns 500.
    // We expect 500 here because we don't have real creds loaded in this script process likely,
    // UNLESS we load dotenv.

    if (res.statusCode === 200) {
        console.log("✅ PASS: Success 200 OK");
    } else if (res.statusCode === 500) {
        console.log("⚠️ WARN: 500 Error (Expected if Env Vars missing/invalid for Sheets)");
        console.log("   Message: " + res.data.message);
    } else {
        console.error("❌ FAIL: Unexpected status " + res.statusCode);
        console.log(res.data);
    }
}

(async () => {
    await testMissingFields();
    await testInvalidEmail();
    await testInvalidHash();
    await testSuccessFlow();
})();
