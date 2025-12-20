import { google } from "googleapis";

const {
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS,
  THIX_WEBHOOK_SECRET
} = process.env;

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Webhook-Signature');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------- Google Sheets Setup (lazy init) ---------- */
let sheets = null;

function getGoogleSheets() {
  if (sheets) return sheets;
  
  if (!GOOGLE_SHEETS_CREDENTIALS) {
    console.warn("GOOGLE_SHEETS_CREDENTIALS not set, skipping sheets integration");
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

// Header row for the Transactions sheet
const SHEET_HEADERS = [
  "Merchant Ref ID",
  "Description",
  "Amount",
  "Currency",
  "Status",
  "Provider",
  "Invoice ID",
  "Fee",
  "Blocked Status",
  "Country",
  "Notes",
  "Timestamp"
];

async function ensureHeadersExist(sheetsClient) {
  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A1:L1"
    });
    
    const existingHeaders = response.data.values?.[0];
    
    if (!existingHeaders || !existingHeaders[0]) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Transactions!A1:L1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_HEADERS] }
      });
      console.log("Added headers to Transactions sheet");
    }
  } catch (err) {
    console.warn("Header check failed, attempting to add:", err.message);
    try {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "Transactions!A1:L1",
        valueInputOption: "RAW",
        requestBody: { values: [SHEET_HEADERS] }
      });
    } catch (updateErr) {
      console.error("Failed to add headers:", updateErr.message);
    }
  }
}

let headersInitialized = false;

async function appendToGoogleSheets(row) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) return;
  
  try {
    if (!headersInitialized) {
      await ensureHeadersExist(sheetsClient);
      headersInitialized = true;
    }
    
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:L",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log("Ledger entry added successfully");
  } catch (err) {
    console.error("Google Sheets append error:", err);
    throw err;
  }
}

/**
 * Map 3Thix payment status to our ledger status
 * Valid statuses we want to record:
 * - SUCCESS: Payment completed successfully
 * - FAILED: Payment failed
 * - TIMEOUT: Payment interrupted/abandoned (>2 min timeout)
 * - CANCELLED: User cancelled payment
 */
function mapPaymentStatus(thixStatus) {
  const statusMap = {
    'COMPLETED': 'SUCCESS',
    'SUCCESS': 'SUCCESS',
    'PAID': 'SUCCESS',
    'FAILED': 'FAILED',
    'DECLINED': 'FAILED',
    'ERROR': 'FAILED',
    'TIMEOUT': 'TIMEOUT',
    'EXPIRED': 'TIMEOUT',
    'ABANDONED': 'TIMEOUT',
    'CANCELLED': 'CANCELLED',
    'CANCELED': 'CANCELLED'
  };
  
  return statusMap[thixStatus?.toUpperCase()] || thixStatus;
}

/**
 * Check if status is one we should record in ledger
 * Only record final states: success, failed, timeout, cancelled
 */
function shouldRecordStatus(status) {
  const recordableStatuses = ['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED'];
  return recordableStatuses.includes(status);
}

/* ---------- API Handler ---------- */
export default async function handler(req, res) {
  setCorsHeaders(res);

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Accept both GET (redirect callbacks) and POST (webhooks)
  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Parse callback data from either query params (GET) or body (POST)
    const data = req.method === 'GET' ? req.query : req.body;
    
    console.log("Payment callback received:", JSON.stringify(data, null, 2));
    
    // Extract payment information from callback
    // 3Thix typically sends: invoice_id, merchant_ref_id, status, amount, currency, etc.
    const {
      invoice_id,
      invoiceId,
      merchant_ref_id,
      merchantRefId,
      status,
      payment_status,
      amount,
      currency,
      fee,
      error_message,
      errorMessage,
      description,
      country
    } = data;
    
    const finalInvoiceId = invoice_id || invoiceId;
    const finalMerchantRefId = merchant_ref_id || merchantRefId;
    const finalStatus = status || payment_status;
    const finalErrorMessage = error_message || errorMessage;
    
    if (!finalInvoiceId && !finalMerchantRefId) {
      console.error("Missing invoice_id and merchant_ref_id in callback");
      return res.status(400).json({ 
        error: "Missing required fields: invoice_id or merchant_ref_id" 
      });
    }
    
    if (!finalStatus) {
      console.error("Missing status in callback");
      return res.status(400).json({ error: "Missing required field: status" });
    }
    
    // Map the status to our internal representation
    const mappedStatus = mapPaymentStatus(finalStatus);
    
    // Only record to ledger if it's a final status
    if (!shouldRecordStatus(mappedStatus)) {
      console.log(`Status ${finalStatus} (mapped: ${mappedStatus}) is not a final status, skipping ledger update`);
      return res.status(200).json({ 
        received: true, 
        status: mappedStatus,
        recorded: false,
        message: "Status not final, ledger not updated"
      });
    }
    
    // Build notes based on status
    let notes = '';
    if (mappedStatus === 'FAILED' && finalErrorMessage) {
      notes = `Error: ${finalErrorMessage}`;
    } else if (mappedStatus === 'TIMEOUT') {
      notes = 'Payment interrupted/timed out after 2+ minutes';
    } else if (mappedStatus === 'CANCELLED') {
      notes = 'User cancelled payment';
    }
    
    // Append to Google Sheets ledger
    await appendToGoogleSheets([
      finalMerchantRefId || '',
      description || '',
      amount?.toString() || '',
      currency || '',
      mappedStatus,
      "3THIX",
      finalInvoiceId || '',
      fee?.toString() || '0',
      '',
      country || '',
      notes,
      new Date().toISOString()
    ]);
    
    console.log(`Payment callback processed: ${finalInvoiceId} - ${mappedStatus}`);
    
    // Return success response
    return res.status(200).json({ 
      received: true, 
      status: mappedStatus,
      recorded: true,
      invoice_id: finalInvoiceId,
      merchant_ref_id: finalMerchantRefId
    });
    
  } catch (err) {
    console.error("Payment callback error:", err);
    return res.status(500).json({ 
      error: "Failed to process payment callback",
      message: err.message
    });
  }
}
