
import fetch from "node-fetch";

const API_BASE = "http://localhost:3000/api";

async function testStatus(invoiceId, expectedStatus) {
    console.log(`\nTesting Invoice: ${invoiceId} (Expect: ${expectedStatus})`);
    try {
        const res = await fetch(`${API_BASE}/check-payment-status?invoiceId=${invoiceId}`);
        const data = await res.json();
        console.log("Response:", JSON.stringify(data, null, 2));

        if (data.status === expectedStatus) {
            console.log("✅ PASS");
        } else {
            console.log(`❌ FAIL (Got: ${data.status})`);
        }
    } catch (e) {
        console.error("Error:", e.message);
    }
}

async function run() {
    // You need real or mocked IDs here. Since I cannot mock 3Thix easily without a proxy or modifying code,
    // this script assumes you have some invoices in various states.
    // Replace with valid IDs for manual testing.

    console.log("--- Payment Status Verification ---");
    // await testStatus("inv_processing", "PROCESSING");
    // await testStatus("inv_success", "SUCCESS");
    // await testStatus("inv_fail", "FAILED");
    console.log("Please edit this script with valid invoice IDs to run real tests against your local server or deploy.");
}

run();
