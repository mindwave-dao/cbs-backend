import { google } from "googleapis";
import fetch from "node-fetch";
import { processSuccessfulPayment } from "../lib/email.js";

const {
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS,
  THIX_API_KEY
} = process.env;

// Hardcoded as per rules
const THIX_API_URL = 'https://api.3thix.com';

// SANDBOX references (commented for future debugging):
// THIX_API_URL=https://sandbox-api.3thix.com
// THIX_API_KEY=SANDBOX_API_KEY
// PAYMENT_PAGE_BASE=https://sandbox-pay.3thix.com

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------- Google Sheets Setup (lazy init) ---------- */
let sheets = null;

function getGoogleSheets() {
  if (sheets) return sheets;
  
  if (!GOOGLE_SHEETS_CREDENTIALS) {
    console.warn("GOOGLE_SHEETS_CREDENTIALS not set, cannot check payment status");
    return null;
  }
  
  try {
    const credentials = JSON.parse(GOOGLE_SHEETS_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    sheets = google.sheets({ version: "v4", auth });
    return sheets;
  } catch (err) {
    console.error("Failed to initialize Google Sheets:", err);
    return null;
  }
}









/* ---------- Helper Functions ---------- */
async function findRowByInvoiceId(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    return null;
  }

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:H"  // Skip header row, include all columns
    });

    const rows = response.data.values || [];

    // Search for the invoice ID (column A = index 0)
    for (const row of rows) {
      const rowInvoiceId = row[0];  // Column A (0-indexed = 0)
      if (rowInvoiceId === invoiceId) {
        return {
          STATUS: row[1] || 'PENDING',
          EMAIL: row[2] || '',
          NAME: row[3] || '',
          EMAIL_SENT: row[4] || 'NO',
          EMAIL_SENT_AT: row[5] || '',
          AMOUNT: row[6] || '',
          CURRENCY: row[7] || ''
        };
      }
    }

    return null;  // Not found
  } catch (err) {
    console.error("Error searching Google Sheets:", err);
    return null;
  }
}

async function check3Thix(invoiceId) {
  if (!THIX_API_KEY || !THIX_API_URL || !invoiceId) {
    console.error("❌ 3Thix API not configured or missing invoiceId");
    return 'PENDING';
  }

  try {
    console.log(`🔍 Checking payment status with 3Thix API for invoice: ${invoiceId}`);

    // Try the most likely endpoint patterns for production
    const endpoints = [
      `${THIX_API_URL}/order/payment/${invoiceId}`,
      `${THIX_API_URL}/order/${invoiceId}`,
      `${THIX_API_URL}/payment/${invoiceId}`
    ];

    for (const endpoint of endpoints) {
      try {
        console.log(`📡 Trying 3Thix endpoint: ${endpoint}`);

        const response = await fetch(endpoint, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": THIX_API_KEY
          }
        });

        if (response.ok) {
          const data = await response.json();
          console.log(`📨 3Thix API response for ${invoiceId}:`, JSON.stringify(data, null, 2));

          // Extract status from various possible fields
          const status = data.status || data.payment_status || data.state || data.paymentState;

          if (status) {
            // Normalize status to our format
            const upperStatus = status.toUpperCase();
            if (['PAID', 'COMPLETED', 'SUCCESS'].includes(upperStatus)) {
              return 'SUCCESS';
            }
            if (['FAILED', 'CANCELLED'].includes(upperStatus)) {
              return 'FAILED';
            }
            return 'PENDING';
          }
        } else {
          console.log(`❌ 3Thix endpoint ${endpoint} returned ${response.status}`);
        }
      } catch (endpointErr) {
        console.log(`⚠️ Error with endpoint ${endpoint}:`, endpointErr.message);
        // Continue to next endpoint
      }
    }

    console.error(`❌ Could not get status from 3Thix for invoice ${invoiceId}`);
    return 'PENDING';

  } catch (err) {
    console.error("💥 Error checking 3Thix API:", err.message);
    return 'PENDING';
  }
}

async function markSuccessInSheet(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID || !invoiceId) return;

  try {
    // Get all rows from PAYMENT_TRANSACTIONS sheet
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:H"  // Skip header row, get all columns
    });

    const rows = response.data.values || [];
    let rowIndex = -1;

    // Find the row with matching INVOICE_ID (column A = index 0)
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === invoiceId) {
        rowIndex = i + 2;  // +2 because we start from A2 and arrays are 0-indexed
        break;
      }
    }

    if (rowIndex === -1) {
      console.warn(`Could not find row for invoice ${invoiceId}`);
      return;
    }

    // Update STATUS column (column B = index 1)
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `PAYMENT_TRANSACTIONS!B${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [['SUCCESS']]
      }
    });

    console.log(`Updated status for invoice ${invoiceId} to SUCCESS`);
  } catch (err) {
    console.error("Error updating payment status:", err.message);
  }
}

async function markFailedInSheet(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID || !invoiceId) return;

  try {
    // Get all rows from PAYMENT_TRANSACTIONS sheet
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:H"  // Skip header row, get all columns
    });

    const rows = response.data.values || [];
    let rowIndex = -1;

    // Find the row with matching INVOICE_ID (column A = index 0)
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === invoiceId) {
        rowIndex = i + 2;  // +2 because we start from A2 and arrays are 0-indexed
        break;
      }
    }

    if (rowIndex === -1) {
      console.warn(`Could not find row for invoice ${invoiceId}`);
      return;
    }

    // Update STATUS column (column B = index 1)
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `PAYMENT_TRANSACTIONS!B${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [['FAILED']]
      }
    });

    console.log(`Updated status for invoice ${invoiceId} to FAILED`);
  } catch (err) {
    console.error("Error updating payment status:", err.message);
  }
}

async function sendEmailsIfNotSent(invoiceId) {
  try {
    // Get the row data to check if emails were already sent
    const row = await findRowByInvoiceId(invoiceId);
    if (!row) return;

    // Only send if not already sent
    if (row.EMAIL_SENT !== 'YES') {
      await processSuccessfulPayment(
        invoiceId,
        row.EMAIL,
        row.NAME,
        row.AMOUNT,
        row.CURRENCY
      );
    }
  } catch (err) {
    console.error("Error sending emails:", err);
    // Don't throw - email failure should not affect status response
  }
}

/* ---------- API Handler ---------- */
export default async function handler(req, res) {
  setCorsHeaders(res);

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only accept GET requests
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { invoiceId } = req.query;

    if (!invoiceId) {
      return res.status(400).json({ error: "invoiceId required" });
    }

    // 1. Read from Google Sheet FIRST
    const row = await findRowByInvoiceId(invoiceId);

    if (!row) {
      return res.status(404).json({ invoiceId, status: "NOT_FOUND" });
    }

    const currentStatus = row.STATUS;

    // 2. If already final → return immediately
    if (currentStatus === "SUCCESS") {
      return res.json({ invoiceId, status: "SUCCESS" });
    }

    if (currentStatus === "FAILED") {
      return res.json({ invoiceId, status: "FAILED" });
    }

    // 3. Only now check 3Thix
    const thixStatus = await check3Thix(invoiceId);

    if (thixStatus === "SUCCESS") {
      await markSuccessInSheet(invoiceId);
      await sendEmailsIfNotSent(invoiceId);
      return res.json({ invoiceId, status: "SUCCESS" });
    }

    if (thixStatus === "FAILED") {
      await markFailedInSheet(invoiceId);
      return res.json({ invoiceId, status: "FAILED" });
    }

    // 4. Still pending
    return res.json({ invoiceId, status: "PENDING" });

  } catch (err) {
    console.error("[check-payment-status]", err);
    // NEVER FAIL USER FLOW
    return res.json({ invoiceId: req.query.invoiceId, status: "PENDING" });
  }
}
