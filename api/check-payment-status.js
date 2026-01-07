import { google } from "googleapis";

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
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
    });
    sheets = google.sheets({ version: "v4", auth });
    return sheets;
  } catch (err) {
    console.error("Failed to initialize Google Sheets:", err);
    return null;
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
