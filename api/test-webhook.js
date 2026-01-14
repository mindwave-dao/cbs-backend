
import fetch from "node-fetch";
import crypto from "crypto";

const WEBHOOK_URL = "http://localhost:3000/api/webhooks/3thix";
const SECRET = process.env.WEBHOOK_SECRET; // Optional
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || "test-token"; // Default for local test

async function testWebhook(payload, useSecret = false, useToken = true) {
    console.log(`\nTesting Webhook: ${payload.type}`);

    const headers = { "Content-Type": "application/json" };

    if (useSecret && SECRET) {
        const signature = crypto.createHmac('sha256', SECRET).update(JSON.stringify(payload)).digest('hex');
        headers['x-3thix-signature'] = signature;
    }

    if (useToken) {
        headers['Authorization'] = `Bearer ${TOKEN}`;
    }

    try {
        const res = await fetch(WEBHOOK_URL, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        });

        console.log(`Status: ${res.status} ${res.statusText}`);
        const text = await res.text();
        console.log("Response:", text);

        if (res.ok) console.log("✅ PASS");
        else console.log("❌ FAIL");

    } catch (e) {
        console.error("Error:", e.message);
    }
}

async function run() {
    console.log("--- Webhook Verification ---");

    // Test 1: Valid Invoice Paid
    await testWebhook({
        type: "INVOICE_PAID",
        data: { invoice_id: "inv_123_test_webhook" }
    });

    // Test 2: Valid Status Changed
    await testWebhook({
        type: "INVOICE_STATUS_CHANGED",
        data: { id: "inv_456_test_webhook" } // check alternate ID path
    });

    // Test 3: Unauthorized (No Token)
    console.log("\nTesting Unauthorized:");
    await testWebhook({ type: "TEST" }, false, false);
}

run();
