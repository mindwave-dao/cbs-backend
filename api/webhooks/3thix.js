import { google } from "googleapis";
import crypto from "crypto";
import { sendPaymentSuccessEmail, sendAdminEmail } from "../lib/email.js";

const {
  GOOGLE_SHEET_ID,
  GOOGLE_SHEETS_CREDENTIALS,
  THIX_WEBHOOK_SECRET
} = process.env;

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Webhook-Signature');
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
  "merchant_ref_id",
  "description",
  "amount",
  "currency",
  "status",
  "gateway",
  "invoice_id",
  "tokens_issued",
  "flags",
  "country",
  "notes",
  "timestamp",
  "email_sent",
  "email_sent_at"
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
      range: "Transactions!A2:O",
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
  "activity_id",
  "invoice_id",
  "merchant_ref_id",
  "event_type",
  "amount",
  "currency",
  "gateway",
  "country",
  "user_agent",
  "ip",
  "metadata",
  "timestamp"
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
 * Event types: INVOICE_CREATED, PAYMENT_REDIRECTED, PAYMENT_BLOCKED_US,
 *              WEBHOOK_RECEIVED, PAYMENT_SUCCESS, PAYMENT_FAILED,
 *              PAYMENT_CANCELLED, PAYMENT_TIMEOUT
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
  "invoice_id",
  "merchant_ref_id",
  "name",
  "email",
  "amount",
  "currency",
  "status",
  "created_at"
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
    console.log("🔔 3THIX WEBHOOK HIT");
    console.log("Payload:", JSON.stringify(req.body || req.query, null, 2));
    let data = req.method === 'GET' ? req.query : req.body;

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
        message: "Status not final, ledger not updated"
      });
    }

    // Check if this payment was already recorded (idempotency)
    const existingPaymentStatus = await checkExistingPayment(finalInvoiceId);
    const isNewPayment = !existingPaymentStatus;

    // Build notes based on status
    let notes = '';
    if (mappedStatus === 'FAILED' && finalErrorMessage) {
      notes = `Error: ${finalErrorMessage}`;
    } else if (mappedStatus === 'TIMEOUT') {
      notes = 'Payment interrupted/timed out after 2+ minutes';
    } else if (mappedStatus === 'CANCELLED') {
      notes = 'User cancelled payment';
    }

    // Append to Google Sheets ledger (main Transactions sheet)
    await appendToGoogleSheets([
      finalMerchantRefId || '',        // merchant_ref_id
      description || '',               // description
      amount?.toString() || '',        // amount
      currency || '',                  // currency
      mappedStatus,                    // status
      "3THIX",                         // gateway
      finalInvoiceId || '',            // invoice_id
      '',                              // tokens_issued (empty)
      parsedMetadata.paymentBlocked ? 'PAYMENT_BLOCKED_US' : '',  // flags
      country || '',                   // country
      notes,                           // notes
      new Date().toISOString(),        // timestamp
      '',                              // email_sent (empty initially)
      ''                               // email_sent_at (empty initially)
    ]);

    // On successful payment, also write to PaymentAdditionalInfo
    if (mappedStatus === 'SUCCESS') {
      const userName = parsedMetadata.name || '';
      const userEmail = parsedMetadata.email || '';

      // Only write if we have at least some user info
      if (userName || userEmail) {
        await appendToAdditionalInfo([
          finalInvoiceId || '',           // invoice_id
          finalMerchantRefId || '',       // merchant_ref_id
          userName,                        // name
          userEmail,                       // email
          amount?.toString() || '',        // amount
          currency || '',                  // currency
          'SUCCESS',                       // status
          new Date().toISOString()         // created_at
        ]);
      }

      // Check if email has already been sent (retry-safe)
      const emailAlreadySent = await checkEmailSent(finalInvoiceId);

      // Send email notification for successful payments (retry-safe)
      console.log("EMAIL CHECK:", {
        status: mappedStatus,
        email: userEmail,
        emailSentFlag: emailAlreadySent
      });

      if (userEmail && emailAlreadySent !== 'YES') {
        console.log(`Sending emails for invoice ${finalInvoiceId}`);

        // Non-blocking email send - failure does not affect payment flow
        const userEmailPromise = sendPaymentSuccessEmail({
          to: userEmail,
          name: userName,
          amount: amount?.toString() || '',
          currency: currency || '',
          invoiceId: finalInvoiceId || ''
        }).catch(err => {
          console.error("Failed to send payment success email:", err.message);
          return false;
        });

        // Send admin notification email
        const adminEmailPromise = sendAdminEmail({
          name: userName,
          userEmail: userEmail,
          invoiceId: finalInvoiceId || '',
          amount: amount?.toString() || '',
          currency: currency || ''
        }).catch(err => {
          console.error("Failed to send admin email:", err.message);
          return false;
        });

        // Wait for both emails to complete (but don't block on failure)
        const [userEmailSent, adminEmailSent] = await Promise.all([userEmailPromise, adminEmailPromise]);

        // Mark email as sent in Google Sheets if at least one email was sent successfully
        if (userEmailSent || adminEmailSent) {
          await markEmailAsSent(finalInvoiceId);
        }

        console.log(`Email sending completed for invoice ${finalInvoiceId}: user=${userEmailSent}, admin=${adminEmailSent}`);
      } else if (emailAlreadySent === 'YES') {
        console.log(`Email already sent for invoice ${finalInvoiceId}. Skipping.`);
      }
    }

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
