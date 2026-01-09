import { google } from "googleapis";
import fetch from "node-fetch";
import { processSuccessfulPayment } from "../lib/email.js";

const {
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS,
  THIX_API_KEY,
  THIX_API_URL
} = process.env;

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
 * Mark email as sent in Google Sheets
 */
async function markEmailAsSent(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID || !invoiceId) return;

  try {
    // Find the row with this invoice ID
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:O"
    });

    const rows = response.data.values || [];
    let rowIndex = -1;

    for (let i = 0; i < rows.length; i++) {
      if (rows[i][6] === invoiceId) {  // Column G = index 6
        rowIndex = i + 2;  // +2 because we start from A2 and arrays are 0-indexed
        break;
      }
    }

    if (rowIndex === -1) {
      console.warn(`Could not find row for invoice ${invoiceId} to mark email as sent`);
      return;
    }

    // Update EMAIL_SENT and EMAIL_SENT_AT columns (M and N = indices 12 and 13)
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `Transactions!M${rowIndex}:N${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["YES", new Date().toISOString()]]
      }
    });

    console.log(`Marked email as sent for invoice ${invoiceId}`);
  } catch (err) {
    console.error("Error marking email as sent:", err.message);
    // Don't throw - this shouldn't block the payment flow
  }
}

/**
 * Get user info from PaymentAdditionalInfo sheet
 */
async function getUserInfo(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID || !invoiceId) return { name: '', email: '' };

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A2:H"
    });

    const rows = response.data.values || [];

    // Search for the invoice ID (column A = index 0)
    for (const row of rows) {
      if (row[0] === invoiceId) {
        return {
          name: row[2] || '',  // Column C = index 2
          email: row[3] || ''  // Column D = index 3
        };
      }
    }

    return { name: '', email: '' };  // Not found
  } catch (err) {
    console.warn("Error getting user info:", err.message);
    return { name: '', email: '' };  // Fail open
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
 * Map 3Thix status to our internal status
 */
function map3ThixStatus(thixStatus) {
  if (!thixStatus) return 'PENDING';

  const statusMap = {
    'COMPLETED': 'SUCCESS',
    'SUCCESS': 'SUCCESS',
    'PAID': 'SUCCESS',
    'APPROVED': 'SUCCESS',
    'CAPTURED': 'SUCCESS',
    'SETTLED': 'SUCCESS',
    'FAILED': 'FAILED',
    'DECLINED': 'FAILED',
    'ERROR': 'FAILED',
    'REJECTED': 'FAILED',
    'CANCELLED': 'CANCELLED',
    'CANCELED': 'CANCELLED',
    'ABANDONED': 'TIMEOUT',
    'EXPIRED': 'TIMEOUT',
    'TIMEOUT': 'TIMEOUT',
    'PENDING': 'PENDING',
    'PROCESSING': 'PENDING',
    'CREATED': 'PENDING'
  };

  return statusMap[thixStatus.toUpperCase()] || thixStatus;
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

  if (!invoiceId) {
    return res.status(400).json({
      error: "Missing required parameter: invoiceId"
    });
  }

  console.log(`🔍 Checking payment status for invoice: ${invoiceId}`);

  try {
    // ALWAYS call 3Thix API first - this is the single source of truth
    console.log(`📡 Calling 3Thix API directly for ${invoiceId}`);
    const thixResult = await checkPaymentStatusWith3Thix(invoiceId);

    if (!thixResult) {
      console.error(`❌ Could not get status from 3Thix for ${invoiceId}`);
      return res.status(200).json({
        status: 'PENDING',
        emailSent: false,
        invoiceId,
        message: "Could not verify payment status with 3Thix"
      });
    }

    const realStatus = thixResult.status;
    console.log(`📊 3Thix reports status: ${realStatus} for invoice ${invoiceId}`);

    // Get current Google Sheet data
    const sheetData = await findPaymentStatus(invoiceId);
    let emailSent = false;

    // If 3Thix says PAID/SUCCESS, update Google Sheet and send emails
    if (realStatus === 'SUCCESS') {
      console.log(`💰 Payment confirmed SUCCESS by 3Thix for ${invoiceId}`);

      // Update Google Sheet status to SUCCESS (if not already)
      if (sheetData.status !== 'SUCCESS') {
        console.log(`📝 Updating Google Sheet status to SUCCESS for ${invoiceId}`);
        const updateSuccess = await updatePaymentStatus(invoiceId, 'SUCCESS');
        if (updateSuccess) {
          console.log(`✅ Google Sheet updated to SUCCESS for ${invoiceId}`);
        } else {
          console.error(`❌ Failed to update Google Sheet for ${invoiceId}`);
        }
      }

      // Send emails if not already sent (idempotent)
      if (sheetData.found && sheetData.emailSent !== 'YES') {
        console.log(`📧 Processing emails for ${invoiceId}`);
        const emailResult = await processSuccessfulPayment(
          invoiceId,
          sheetData.email,
          sheetData.name,
          sheetData.amount,
          sheetData.currency
        );
        emailSent = emailResult.emailSent;
      } else if (sheetData.emailSent === 'YES') {
        console.log(`📧 Emails already sent for ${invoiceId}`);
        emailSent = true;
      }

      return res.status(200).json({
        status: 'SUCCESS',
        emailSent: emailSent,
        invoiceId
      });

    } else {
      // Payment not successful according to 3Thix
      console.log(`⏳ Payment status from 3Thix: ${realStatus} for ${invoiceId}`);
      return res.status(200).json({
        status: realStatus,
        emailSent: false,
        invoiceId
      });
    }

  } catch (err) {
    console.error("💥 Check payment status error:", err);
    return res.status(500).json({
      error: "EMAIL_FAILED",
      message: err.message,
      invoiceId
    });
  }
}
