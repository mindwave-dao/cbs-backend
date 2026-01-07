import { google } from "googleapis";
import { handlePostSuccessActions } from "../lib/email.js";

const {
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS
} = process.env;

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
 * Check if email has already been sent for this invoice
 * Returns the EMAIL_SENT status ('YES' or empty/null)
 */
async function checkEmailSent(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID || !invoiceId) return null;

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:O"  // Include new columns
    });

    const rows = response.data.values || [];

    // Search for the invoice ID (column G = index 6)
    for (const row of rows) {
      if (row[6] === invoiceId) {
        return row[12] || null;  // Return EMAIL_SENT (column M = index 12)
      }
    }

    return null;  // Not found
  } catch (err) {
    console.warn("Error checking email sent status:", err.message);
    return null;  // Fail open
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
 * Find payment status by invoice ID in Google Sheets
 * Transactions sheet columns:
 * A: merchant_ref_id
 * B: description
 * C: amount
 * D: currency
 * E: status
 * F: gateway
 * G: invoice_id
 * H: tokens_issued
 * I: flags
 * J: country
 * K: notes
 * L: timestamp
 */
async function findPaymentStatus(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    return { found: false, error: "Google Sheets not configured" };
  }
  
  try {
    // Fetch Invoice ID (column G) and Status (column E) from all rows
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:L"  // Skip header row
    });
    
    const rows = response.data.values || [];
    
    // Search for the invoice ID (column G = index 6)
    for (const row of rows) {
      const rowInvoiceId = row[6];  // Column G (0-indexed = 6)
      if (rowInvoiceId === invoiceId) {
        const status = row[4];  // Column E (0-indexed = 4)
        return {
          found: true,
          status: status || 'PENDING',
          invoiceId: rowInvoiceId,
          merchantRefId: row[0] || null,
          amount: row[2] || null,
          currency: row[3] || null,
          timestamp: row[11] || null
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

  console.log(`Checking payment status for invoice: ${invoiceId}`);
  
  try {
    const result = await findPaymentStatus(invoiceId);

    if (result.error) {
      console.error(`Error checking status for ${invoiceId}:`, result.error);
      // Return PENDING if we can't check (graceful degradation)
      return res.status(200).json({
        status: 'PENDING',
        invoiceId,
        message: "Unable to verify status, please try again"
      });
    }

    console.log(`Payment status for ${invoiceId}: ${result.status}`);

    // Trigger emails immediately after finding successful payment in ledger
    if (result.status === 'SUCCESS' && result.found) {
      // Get current email status from ledger
      const emailAlreadySent = await checkEmailSent(invoiceId);

      // Get user info from PaymentAdditionalInfo sheet
      const { name: userName, email: userEmail } = await getUserInfo(invoiceId);

      // Trigger centralized email function
      await handlePostSuccessActions({
        invoiceId: invoiceId,
        status: result.status,
        userEmail: userEmail,
        userName: userName,
        amount: result.amount,
        currency: result.currency
      });
    }

    return res.status(200).json({
      status: result.status,
      invoiceId,
      found: result.found,
      ...(result.merchantRefId && { merchantRefId: result.merchantRefId }),
      ...(result.amount && { amount: result.amount }),
      ...(result.currency && { currency: result.currency }),
      ...(result.timestamp && { timestamp: result.timestamp })
    });
    
  } catch (err) {
    console.error("Check payment status error:", err);
    return res.status(500).json({
      error: "Failed to check payment status",
      message: err.message
    });
  }
}
