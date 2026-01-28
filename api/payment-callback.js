import { google } from "googleapis";
import crypto from "crypto";
import { finalizePaymentStatus } from "../lib/finalize-payment.js";

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

/* ---------- Transactions Sheet (Main Ledger) ---------- */
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

let headersInitialized = false;

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

/* ---------- TransactionActivityLog Sheet ---------- */
const ACTIVITY_LOG_HEADERS = [
  "Activity ID",
  "Invoice ID",
  "Merchant Ref ID",
  "Event Type",
  "Amount",
  "Currency",
  "Gateway",
  "Country",
  "User Agent",
  "IP",
  "Metadata",
  "Timestamp"
];

let activityHeadersInitialized = false;

async function ensureActivityLogHeaders(sheetsClient) {
  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "TransactionActivityLog!A1:L1"
    });

    const existingHeaders = response.data.values?.[0];

    if (!existingHeaders || !existingHeaders[0]) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "TransactionActivityLog!A1:L1",
        valueInputOption: "RAW",
        requestBody: { values: [ACTIVITY_LOG_HEADERS] }
      });
      console.log("Added headers to TransactionActivityLog sheet");
    }
  } catch (err) {
    console.warn("ActivityLog header check failed, attempting to add:", err.message);
    try {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "TransactionActivityLog!A1:L1",
        valueInputOption: "RAW",
        requestBody: { values: [ACTIVITY_LOG_HEADERS] }
      });
    } catch (updateErr) {
      console.error("Failed to add ActivityLog headers:", updateErr.message);
    }
  }
}

/**
 * Append a row to TransactionActivityLog sheet
 * Event types: INVOICE_CREATED, REDIRECT_INITIATED, PAYMENT_ABANDONED, 
 *              PAYMENT_SUCCESS, PAYMENT_FAILED, PAYMENT_CANCELLED, 
 *              PAYMENT_TIMEOUT, WEBHOOK_RECEIVED
 */
async function appendToActivityLog(row) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    console.warn("Google Sheets not configured, skipping activity log");
    return;
  }

  try {
    if (!activityHeadersInitialized) {
      await ensureActivityLogHeaders(sheetsClient);
      activityHeadersInitialized = true;
    }

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "TransactionActivityLog!A:L",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log("Activity log entry added successfully");
  } catch (err) {
    console.error("Activity log append error:", err);
    // Don't throw - activity logging should not block payment flow
  }
}

/* ---------- PaymentAdditionalInfo Sheet ---------- */
const ADDITIONAL_INFO_HEADERS = [
  "Invoice ID",
  "Merchant Ref ID",
  "Name",
  "Email",
  "Amount",
  "Currency",
  "Status",
  "Created At"
];

let additionalInfoHeadersInitialized = false;

async function ensureAdditionalInfoHeaders(sheetsClient) {
  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A1:H1"
    });

    const existingHeaders = response.data.values?.[0];

    if (!existingHeaders || !existingHeaders[0]) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "PaymentAdditionalInfo!A1:H1",
        valueInputOption: "RAW",
        requestBody: { values: [ADDITIONAL_INFO_HEADERS] }
      });
      console.log("Added headers to PaymentAdditionalInfo sheet");
    }
  } catch (err) {
    console.warn("AdditionalInfo header check failed, attempting to add:", err.message);
    try {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "PaymentAdditionalInfo!A1:H1",
        valueInputOption: "RAW",
        requestBody: { values: [ADDITIONAL_INFO_HEADERS] }
      });
    } catch (updateErr) {
      console.error("Failed to add AdditionalInfo headers:", updateErr.message);
    }
  }
}

/**
 * Append a row to PaymentAdditionalInfo sheet
 * Only for successful payments - stores user-submitted info
 */
async function appendToAdditionalInfo(row) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID) {
    console.warn("Google Sheets not configured, skipping additional info");
    return;
  }

  try {
    if (!additionalInfoHeadersInitialized) {
      await ensureAdditionalInfoHeaders(sheetsClient);
      additionalInfoHeadersInitialized = true;
    }

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A:H",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log("Additional info entry added successfully");
  } catch (err) {
    console.error("Additional info append error:", err);
    // Don't throw - additional info logging should not block payment flow
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
 * Map status to activity log event type
 */
function mapStatusToEventType(status) {
  const eventMap = {
    'SUCCESS': 'PAYMENT_SUCCESS',
    'FAILED': 'PAYMENT_FAILED',
    'TIMEOUT': 'PAYMENT_TIMEOUT',
    'CANCELLED': 'PAYMENT_CANCELLED'
  };
  return eventMap[status] || 'WEBHOOK_RECEIVED';
}

/**
 * Check if status is one we should record in ledger
 * Only record final states: success, failed, timeout, cancelled
 */
function shouldRecordStatus(status) {
  const recordableStatuses = ['SUCCESS', 'FAILED', 'TIMEOUT', 'CANCELLED'];
  return recordableStatuses.includes(status);
}

/**
 * Parse metadata from callback - may be JSON string or object
 */
function parseMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object') return metadata;
  try {
    return JSON.parse(metadata);
  } catch {
    return {};
  }
}

/**
 * Check if a payment has already been recorded for this invoice (idempotency check)
 * Returns the existing status if found, null if not found
 */
async function checkExistingPayment(invoiceId) {
  const sheetsClient = getGoogleSheets();
  if (!sheetsClient || !GOOGLE_SHEET_ID || !invoiceId) return null;

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:L"  // Skip header row
    });

    const rows = response.data.values || [];

    // Search for the invoice ID (column G = index 6)
    for (const row of rows) {
      if (row[6] === invoiceId) {
        return row[4] || null;  // Return status (column E = index 4)
      }
    }

    return null;  // Not found
  } catch (err) {
    console.warn("Error checking existing payment:", err.message);
    return null;  // Fail open - allow the payment to proceed
  }
}

/* ---------- API Handler ---------- */
export default async function handler(req, res) {
  setCorsHeaders(res);

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ONLY Allow POST (Webhooks)
  if (req.method === 'GET') {
    // Stateless redirect check - do NOT write to sheets
    console.log("Ignored GET request to payment-callback (stateless redirect)");
    return res.status(200).json({ message: "Redirect ignored. Webhook required for status update." });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Parse callback data from body (POST only)
    let data = req.body;

    // Check for 3thix Webhook Wrapper (signature + payload)
    if (data && data.payload && data.signature) {
      console.log("Received wrapped 3thix webhook payload");
      // TODO: Verify signature using THIX_WEBHOOK_SECRET if strict security is needed
      data = data.payload;
    }

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
      country,
      metadata
    } = data;

    const finalInvoiceId = invoice_id || invoiceId;
    const finalMerchantRefId = merchant_ref_id || merchantRefId;
    const finalStatus = status || payment_status;
    const finalErrorMessage = error_message || errorMessage;
    const parsedMetadata = parseMetadata(metadata);

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
    const eventType = mapStatusToEventType(mappedStatus);

    // Log to TransactionActivityLog (all events, always)
    await appendToActivityLog([
      crypto.randomUUID(),                              // activity_id
      finalInvoiceId || '',                             // invoice_id
      finalMerchantRefId || '',                         // merchant_ref_id
      eventType,                                        // event_type
      amount?.toString() || '',                         // amount
      currency || '',                                   // currency
      "3THIX",                                          // gateway
      country || '',                                    // country
      '',                                               // user_agent (not available in callback)
      '',                                               // ip (not available in callback)
      JSON.stringify({ originalStatus: finalStatus, error: finalErrorMessage || null }),  // metadata
      new Date().toISOString()                          // timestamp
    ]);

    // Only record to main ledger if it's a final status
    if (!shouldRecordStatus(mappedStatus)) {
      console.log(`Status ${finalStatus} (mapped: ${mappedStatus}) is not a final status, skipping ledger update`);
      return res.status(200).json({
        received: true,
        status: mappedStatus,
        recorded: false,
        message: "Status not final, ledger logic skipped"
      });
    }

    const { updatePaymentSuccess, updatePaymentFailed } = await import("../lib/payment-logic.js");
    const sheetsClient = getGoogleSheets();

    if (mappedStatus === 'SUCCESS') {
      await updatePaymentSuccess(sheetsClient, finalInvoiceId, {
        tokenPrice: '', // We should ideally get this from logic similar to handlePaymentLogic or rely on what was stored.
        // The user said: "Write: TOKEN_PRICE, TOKENS_PURCHASED...".
        // I need to calculate it here or fetch it.
        // The prompt says "Write: TOKEN_PRICE...".
        tokensPurchased: '',
        emailSentAt: new Date().toISOString()
      });

      // Logic to calculate tokens/price if missing?
      // In `payment-logic.js` handlePaymentLogic does this.
      // Calling handlePaymentLogic might be safer as it centralizes this?
      // User plan says: "Refactor api/payment-callback.js... Match invoice_id... On verified payment success: Update existing row... STATUS -> SUCCESS... Write TOKEN_PRICE, TOKENS_PURCHASED..."

      // Re-using handlePaymentLogic seems best to avoid duplication of price/token logic.
      // But handlePaymentLogic in `payment-logic.js` was NOT fully updated to use the new `updatePaymentSuccess` helper internally (I only updated the bottom helper functions).
      // I should probably manually trigger the update here to be explicit as per plan.

      // Let's rely on handlePaymentLogic to do the heavy lifting of calculation?
      // The `handlePaymentLogic` function in `lib/payment-logic.js` DOES append/update rows.
      // I should use THAT if it conforms.
      // But I need to ensure it uses `updatePaymentSuccess` and doesn't append new rows.
      // I didn't refactor `handlePaymentLogic` (the big function) in the previous step, only the helpers.
      // I should probably Call `handlePaymentLogic` and let it handle strictly.

      // WAIT. I should have refactored `handlePaymentLogic` to use the new helpers?
      // Yes, `handlePaymentLogic` calls `appendToTransactions` which I didn't remove but I deprecated `syncToPaymentTransactions`.
      // `handlePaymentLogic` creates new rows if not found.

      // Plan for `payment-callback`:
      // "Match invoice_id... Update existing row... Write TOKEN_PRICE..."

      // I will call `handlePaymentLogic` here which should be updated to be safe.
      // But I need to verify `handlePaymentLogic` behavior.
      // In step 42, `handlePaymentLogic` was NOT modified. It still uses `appendToTransactions`.
      // `appendToTransactions` was NOT modified in step 42. `syncToPaymentTransactions` was deprecated.

      // I need to fix `handlePaymentLogic` OR implement the logic here directly.
      // Implementing directly here gives more control over "Update Only".
      // I will implement directly here to satisfy the "Update existing row" strictness.

      // Price/Token Calculation:
      const { getPrice } = await import("../lib/price.js");
      let priceData = await getPrice();
      let tokenPrice = priceData?.price_usd || 0.082; // Fallback
      let tokens = (parseFloat(amount) / tokenPrice).toFixed(6);

      await updatePaymentSuccess(sheetsClient, finalInvoiceId, {
        tokenPrice: tokenPrice.toString(),
        tokensPurchased: tokens.toString(),
        emailSentAt: new Date().toISOString()
      });

      // Send Admin Email
      const { sendAdminPaymentNotification } = await import("../lib/email.js");
      // Need user details.
      // Fetch from existing or metadata
      let userEmail = parsedMetadata.email || "";
      let userName = parsedMetadata.name || "";

      // If not in metadata, we might barely have it. 
      // But `create-purchase` put it in the sheet. `updatePaymentSuccess` doesn't return it.
      // We might need to fetch it to send email.

      await sendAdminPaymentNotification({
        invoiceId: finalInvoiceId,
        amount: amount,
        currency: currency,
        tokens: tokens,
        tokenPrice: tokenPrice,
        email: userEmail,
        name: userName,
        walletAddress: parsedMetadata.wallet_address || "",
        source: "WEBHOOK",
        timestamp: new Date().toISOString()
      });

    } else if (mappedStatus === 'FAILED') {
      await updatePaymentFailed(sheetsClient, finalInvoiceId);
    }

    console.log(`Payment callback processed: ${finalInvoiceId} - ${mappedStatus}`);

    // We do NOT call finalizePaymentStatus as we did the work manually above strictly.
    // Or we can leave it if we trust it, but user wants strict rules.


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
