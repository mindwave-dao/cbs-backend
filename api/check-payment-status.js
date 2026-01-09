import { google } from "googleapis";
import { handlePostSuccessActions } from "../lib/email.js";

const {
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS
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
 * Find payment status by invoice ID in Google Sheets
 * Transactions sheet columns:
 * A: INVOICE_ID
 * B: STATUS
 * C: EMAIL
 * D: NAME
 * E: EMAIL_SENT
 * F: EMAIL_SENT_AT
 * G: AMOUNT
 * H: CURRENCY
 * I: CREATED_AT
 */
async function findPaymentStatus(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    return { found: false, error: "Google Sheets not configured" };
  }

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:I"  // Skip header row
    });

    const rows = response.data.values || [];

    // Search for the invoice ID (column A = index 0)
    for (const row of rows) {
      const rowInvoiceId = row[0];  // Column A (0-indexed = 0)
      if (rowInvoiceId === invoiceId) {
        return {
          found: true,
          status: row[1] || 'PENDING',  // Column B
          email: row[2] || '',          // Column C
          name: row[3] || '',           // Column D
          emailSent: row[4] || '',      // Column E
          emailSentAt: row[5] || '',    // Column F
          amount: row[6] || null,       // Column G
          currency: row[7] || null,     // Column H
          createdAt: row[8] || null     // Column I
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

    // If STATUS=SUCCESS and EMAIL_SENT=NO → trigger email
    if (result.status === 'SUCCESS' && result.found && result.emailSent !== 'YES') {
      console.log(`Triggering email for successful payment: ${invoiceId}`);

      // Trigger centralized email function
      await handlePostSuccessActions({
        invoiceId: invoiceId,
        status: result.status,
        userEmail: result.email,
        userName: result.name,
        amount: result.amount,
        currency: result.currency
      });
    }

    return res.status(200).json({
      status: result.status,
      invoiceId,
      found: result.found,
      ...(result.amount && { amount: result.amount }),
      ...(result.currency && { currency: result.currency }),
      ...(result.createdAt && { createdAt: result.createdAt })
    });

  } catch (err) {
    console.error("Check payment status error:", err);
    return res.status(500).json({
      error: "Failed to check payment status",
      message: err.message
    });
  }
}
