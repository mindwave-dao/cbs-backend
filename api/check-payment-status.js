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





/**
 * Check payment status with 3Thix API - PRODUCTION CRITICAL
 * This is the single source of truth for payment verification
 */
async function checkPaymentStatusWith3Thix(invoiceId) {
  if (!THIX_API_KEY || !THIX_API_URL || !invoiceId) {
    console.error("❌ 3Thix API not configured or missing invoiceId");
    return null;
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
            const normalizedStatus = map3ThixStatus(status);
            console.log(`✅ 3Thix status for ${invoiceId}: ${status} → ${normalizedStatus}`);
            return {
              status: normalizedStatus,
              rawData: data
            };
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
    return null;

  } catch (err) {
    console.error("💥 Error checking 3Thix API:", err.message);
    return null;
  }
}

/**
 * Normalize 3Thix status as per rules
 */
function map3ThixStatus(thixStatus) {
  if (!thixStatus) return 'PENDING';

  const upperStatus = thixStatus.toUpperCase();
  if (['PAID', 'COMPLETED', 'SUCCESS'].includes(upperStatus)) {
    return 'SUCCESS';
  }
  if (['FAILED', 'CANCELLED'].includes(upperStatus)) {
    return 'FAILED';
  }
  return 'PENDING';
}

/**
 * Update payment status in PAYMENT_TRANSACTIONS sheet
 */
async function updatePaymentStatus(invoiceId, newStatus) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID || !invoiceId) return false;

  try {
    // Get all rows from PAYMENT_TRANSACTIONS sheet
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:F"  // Skip header row, get all columns
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
      return false;
    }

    // Update STATUS column (column B = index 1)
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `PAYMENT_TRANSACTIONS!B${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[newStatus]]
      }
    });

    console.log(`Updated status for invoice ${invoiceId} to ${newStatus}`);
    return true;
  } catch (err) {
    console.error("Error updating payment status:", err.message);
    return false;
  }
}

/**
 * Find payment status by invoice ID in PAYMENT_TRANSACTIONS sheet
 * Columns: INVOICE_ID | STATUS | EMAIL | NAME | EMAIL_SENT | EMAIL_SENT_AT
 */
async function findPaymentStatus(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    return { found: false, error: "Google Sheets not configured" };
  }

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:F"  // Skip header row
    });

    const rows = response.data.values || [];

    // Search for the invoice ID (column A = index 0)
    for (const row of rows) {
      const rowInvoiceId = row[0];  // Column A (0-indexed = 0)
      if (rowInvoiceId === invoiceId) {
        return {
          found: true,
          status: row[1] || 'PENDING',  // Column B - STATUS
          email: row[2] || '',          // Column C - EMAIL
          name: row[3] || '',           // Column D - NAME
          emailSent: row[4] || 'NO',    // Column E - EMAIL_SENT
          emailSentAt: row[5] || ''     // Column F - EMAIL_SENT_AT
        };
      }
    }

    // Invoice not found in ledger - payment is still pending
    return { found: false, status: 'PENDING' };

  } catch (err) {
    console.error("Error searching Google Sheets:", err);
    return { found: false, error: err.message };
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

  const { invoiceId } = req.query;

  // Validate invoiceId
  if (!invoiceId) {
    return res.status(400).json({
      error: "Missing required parameter: invoiceId"
    });
  }

  try {
    // Lookup invoiceId in PAYMENT_TRANSACTIONS column A
    const sheetData = await findPaymentStatus(invoiceId);

    // If not found, return 404
    if (!sheetData.found) {
      console.log(`❌ Invoice ${invoiceId} not found in PAYMENT_TRANSACTIONS`);
      return res.status(404).json({
        invoiceId,
        status: "NOT_FOUND"
      });
    }

    // Always call 3Thix API
    const thixResult = await checkPaymentStatusWith3Thix(invoiceId);
    if (!thixResult) {
      console.error(`❌ Could not get status from 3Thix for ${invoiceId}`);
      return res.status(200).json({
        invoiceId,
        status: "PENDING"
      });
    }

    const status = thixResult.status;
    console.log(`📊 3Thix status for ${invoiceId}: ${status}`);

    // If status === SUCCESS
    if (status === 'SUCCESS') {
      // Update STATUS in Google Sheet
      if (sheetData.status !== 'SUCCESS') {
        await updatePaymentStatus(invoiceId, 'SUCCESS');
      }

      // If EMAIL_SENT !== 'YES', send customer + admin email, update EMAIL_SENT = YES, EMAIL_SENT_AT
      if (sheetData.emailSent !== 'YES') {
        await processSuccessfulPayment(
          invoiceId,
          sheetData.email,
          sheetData.name,
          '', // amount not in sheet
          ''  // currency not in sheet
        );
      }
    }

    // Return JSON only
    return res.status(200).json({
      invoiceId,
      status
    });

  } catch (err) {
    console.error("💥 Check payment status error:", err);
    // On ANY error, log it and return PENDING
    return res.status(200).json({
      status: "PENDING"
    });
  }
}
