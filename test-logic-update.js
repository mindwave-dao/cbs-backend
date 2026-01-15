
import { handlePaymentLogic } from "./lib/payment-logic.js";
import dotenv from 'dotenv';
dotenv.config();

async function test() {
    console.log("Testing handlePaymentLogic...");
    try {
        // Test with a fake ID to see default structure
        const result = await handlePaymentLogic("test-invoice-id-123", "TEST_SCRIPT");
        console.log("Result:", JSON.stringify(result, null, 2));

        if (result.hasOwnProperty('tokens') && result.hasOwnProperty('tokenPrice')) {
            console.log("PASS: Response contains 'tokens' and 'tokenPrice' fields.");
        } else {
            console.error("FAIL: Missing new fields.");
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

test();
