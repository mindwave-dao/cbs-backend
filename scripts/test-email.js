import { emailHealthCheck } from "../lib/email.logic.js";
import dotenv from "dotenv";
dotenv.config();

async function runTest() {
    const target = process.argv[2] || process.env.ADMIN_EMAIL || "test@example.com";
    console.log(`Starting Brevo Email Health Check to: ${target}...`);

    try {
        const result = await emailHealthCheck(target);
        console.log("Health Check SUCCESS:", result);
    } catch (error) {
        console.error("Health Check FAILED:", error.message);
        if (error.stack) console.error(error.stack);
    }
}

runTest();
