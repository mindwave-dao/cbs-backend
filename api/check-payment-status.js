import { google } from "googleapis";
import { processSuccessfulPayment } from "../lib/email.js";
import crypto from "crypto";
import fetch from "node-fetch";

// Environment validation (MANDATORY)
const THIX_API_URL = process.env.THIX_API_URL;
const THIX_API_KEY = process.env.THIX_API_KEY;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SHEETS_CREDENTIALS = process.env.GOOGLE_SHEETS_CREDENTIALS;

if (!THIX_API_URL.startsWith('https://api.3thix.com')) {
  throw new Error('INVALID CONFIG: THIX_API_URL must be https://api.3thix.com');
}
if (!THIX_API_KEY || !GOOGLE_SHEET_ID || !GOOGLE_SHEETS_CREDENTIALS) {
  throw new Error('INVALID CONFIG: Missing required environment variables');
}

/* ---------- Schemas (MANDATORY) ---------- */
const TRANSACTIONS_HEADERS = [
  "merchant_ref_id",
  "description",
  "amount",
  "currency",
  "status",
  "gateway",
  "invoice_id",
  "fee",
  "flag",
  "country",
  "notes",
  "timestamp"
];

const ADDITIONAL_INFO_HEADERS = [
  "invoice_id",
  "merchant_ref_id",
  "name",
  "email",
  "status",
  "amount",
  "currency",
  "timestamp"
];

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

/* ---------- CORS Setup ---------- */
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------- Safe Helper Functions ---------- */
async function getSheetsClient() {
  try {
    const creds = process.env.GOOGLE_SHEETS_CREDENTIALS;
    if (!creds) {
      console.warn("GOOGLE_SHEETS_CREDENTIALS not set");
      return null;
    }
    const credentials = JSON.parse(creds);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    return google.sheets({ version: "v4", auth });
  } catch (e) {
    console.error("[Sheets Init Failed]", e);
    return null;
  }
}

/**
 * Ensure Headers Exist
 */
async function ensureHeaders(sheets, sheetName, headers) {
  try {
    const endCol = String.fromCharCode(64 + headers.length);
    const range = `${sheetName}!A1:${endCol}1`;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range
    });

    if (!response.data.values || !response.data.values[0] || response.data.values[0].length !== headers.length) {
      console.log(`[SCHEMA ENFORCEMENT] Writing headers for ${sheetName}`);
      await sheets.spreadsheets.values.update({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `${sheetName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [headers] }
      });
    }
  } catch (e) {
    console.warn(`[HEADER CHECK FAILED] ${sheetName}`, e.message);
  }
}

/**
 * Idemptotency Helper
 * Check if invoiceId exists in a specific column of a sheet
 */
async function checkInvoiceExists(sheets, sheetName, invoiceId, columnIndex) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: `${sheetName}!A2:M` // Access columns A-M
    });
    const rows = response.data.values || [];
    // columnIndex is 0-based
    const exists = rows.some(row => row[columnIndex] === invoiceId);
    return exists;
  } catch (e) {
    console.warn(`[IDEMPOTENCY CHECK FAILED] ${sheetName}`, e.message);
    return true; // FAIL SAFE: Assume exists to prevent duplicates
  }
}

/**
 * Writers for Ledger Sheets (With Idempotency)
 */
async function appendToTransactions(sheets, row) {
  if (!sheets) return;
  try {
    await ensureHeaders(sheets, "Transactions", TRANSACTIONS_HEADERS);

    const invoiceId = row[6]; // Index 6 is invoice_id in schema
    const exists = await checkInvoiceExists(sheets, "Transactions", invoiceId, 6);

    if (exists) {
      console.log(`[IDEMPOTENT SKIP] Transactions sheet already has invoice ${invoiceId}`);
      return;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:L",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log(`[LEDGER WRITE] Transactions sheet updated for invoice ${invoiceId}`);
  } catch (e) {
    console.error("[LEDGER WRITE FAILED] Transactions", e.message);
  }
}

async function appendToActivityLog(sheets, row) {
  if (!sheets) return;
  try {
    await ensureHeaders(sheets, "TransactionActivityLog", ACTIVITY_LOG_HEADERS);

    // Activity log should allow multiple events for same invoice, but maybe not exact duplicate?
    // User requested "If exists → do not append again" to "Prevent duplicate rows during polling"
    // So distinct on invoice_id + event_type? Or just invoice_id for PAYMENT_SUCCESS?
    // Assuming unique PAYMENT_SUCCESS per invoice.

    const invoiceId = row[1]; // Index 1 is invoice_id
    const eventType = row[3];

    // We only want to prevent duplicate PAYMENT_SUCCESS
    if (eventType === 'PAYMENT_SUCCESS') {
      // We have to scan for invoice_id AND event_type
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: `TransactionActivityLog!A2:D`
      });
      const rows = response.data.values || [];
      const exists = rows.some(r => r[1] === invoiceId && r[3] === 'PAYMENT_SUCCESS');

      if (exists) {
        console.log(`[IDEMPOTENT SKIP] ActivityLog already has PAYMENT_SUCCESS for ${invoiceId}`);
        return;
      }
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "TransactionActivityLog!A2:L",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log(`[LEDGER WRITE] ActivityLog updated`);
  } catch (e) {
    console.error("[LEDGER WRITE FAILED] ActivityLog", e.message);
  }
}

async function appendToAdditionalInfo(sheets, row) {
  if (!sheets) return;
  try {
    await ensureHeaders(sheets, "PaymentAdditionalInfo", ADDITIONAL_INFO_HEADERS);

    const invoiceId = row[0]; // Index 0 is invoice_id
    const exists = await checkInvoiceExists(sheets, "PaymentAdditionalInfo", invoiceId, 0);

    if (exists) {
      console.log(`[IDEMPOTENT SKIP] AdditionalInfo already has invoice ${invoiceId}`);
      return;
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A2:H",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });
    console.log(`[LEDGER WRITE] AdditionalInfo updated`);
  } catch (e) {
    console.error("[LEDGER WRITE FAILED] AdditionalInfo", e.message);
  }
}


/**
 * Search logic for 'Transactions' Sheet
 * Invoice ID is in Column G (index 6)
 * Returns row data if found
 */
async function findInTransactions(sheets, invoiceId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:L"
    });
    const rows = response.data.values || [];
    for (const row of rows) {
      if (row[6] === invoiceId) {
        return {
          status: (row[4] || '').toUpperCase(),
          amount: row[2],
          currency: row[3],
          merchantRefId: row[0]
        };
      }
    }
  } catch (e) {
    console.warn("[Transactions Sheet Check Failed]", e.message);
  }
  return null;
}

async function hydrateFromLedgers(sheets, invoiceId) {
  let email = '';
  let name = '';

  // 1. Try PaymentAdditionalInfo
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A2:H"
    });
    for (const row of res.data.values || []) {
      if (row[0] === invoiceId) {
        name = row[2] || '';
        email = row[3] || '';
        if (email) return { email, name };
      }
    }
  } catch (e) { /* ignore */ }

  // 2. Try TransactionActivityLog metadata
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "TransactionActivityLog!A2:L"
    });
    if (res.data.values) {
      for (let i = res.data.values.length - 1; i >= 0; i--) {
        const row = res.data.values[i];
        if (row[1] === invoiceId && row[10]) {
          try {
            const meta = JSON.parse(row[10]);
            if (meta.email) return { email: meta.email, name: meta.name || meta.user_name || '' };
          } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (e) { /* ignore */ }

  return null;
}

/**
 * Search logic for 'PAYMENT_TRANSACTIONS' Sheet (The Sync Target)
 * Invoice ID is in Column A (index 0)
 * Status is in Column B (index 1)
 */
async function findInPaymentTransactions(sheets, invoiceId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:F"
    });
    const rows = response.data.values || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === invoiceId) {
        return {
          rowIndex: i + 2,
          STATUS: rows[i][1] || 'PENDING',
          EMAIL: rows[i][2] || '',
          NAME: rows[i][3] || '',
          EMAIL_SENT: rows[i][4] || 'NO',
          EMAIL_SENT_AT: rows[i][5] || ''
        };
      }
    }
  } catch (e) {
    console.warn("[PAYMENT_TRANSACTIONS Sheet Check Failed]", e.message);
  }
  return null;
}


async function updatePaymentTransactionRow(sheets, rowIndex, updates) {
  try {
    // updates is array of { col: 'B', val: '...' }
    // batchUpdate format
    const data = updates.map(u => ({
      range: `PAYMENT_TRANSACTIONS!${u.col}${rowIndex}`,
      values: [[u.val]]
    }));

    if (data.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: { valueInputOption: "RAW", data }
      });
      console.log(`[GSHEET UPDATED] Row ${rowIndex} updated.`);
    }
  } catch (e) {
    console.error(`[UPDATE FAILED] Row ${rowIndex}`, e.message);
  }
}

async function check3ThixSafe(invoiceId) {
  const apiKey = process.env.THIX_API_KEY;
  if (!apiKey || !THIX_API_URL || !invoiceId) return null;

  try {
    console.log(`🔍 Checking payment status with 3Thix API for invoice: ${invoiceId}`);

    // PRIMARY: POST /invoice/details/get (Authoritative)
    try {
      const response = await fetch(`${THIX_API_URL}/invoice/details/get`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify({ invoice_id: invoiceId })
      });

      if (response.ok) {
        const data = await response.json();
        // invoice validation might allow 'payment_status' or 'status'
        const status = data.payment_status || data.status;
        if (status) {
          console.log(`[3Thix Primary] Status: ${status}`);
          return { status: status.toUpperCase(), data };
        }
      }
    } catch (e) {
      console.warn(`[3Thix Primary Check Failed]`, e.message);
    }

    // SECONDARY: Fallback GET endpoints
    const endpoints = [
      `${THIX_API_URL}/order/payment/${invoiceId}`,
      `${THIX_API_URL}/order/${invoiceId}`,
      `${THIX_API_URL}/payment/${invoiceId}`
    ];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: "GET",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey }
        });
        if (response.ok) {
          const data = await response.json();
          const status = data.status || data.payment_status || data.state || data.paymentState;
          if (status) return { status: status.toUpperCase(), data };
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  } catch (err) {
    console.error("💥 Error checking 3Thix API:", err.message);
    return null;
  }
}

async function syncToPaymentTransactions(sheets, invoiceId, status, email, name) {
  if (!sheets || !GOOGLE_SHEET_ID) return;
  try {
    const existing = await findInPaymentTransactions(sheets, invoiceId);
    if (!existing) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "PAYMENT_TRANSACTIONS!A2:F",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [[invoiceId, status, email || '', name || '', 'NO', '']]
        }
      });
      console.log(`[SYNC] Inserted new row in PAYMENT_TRANSACTIONS for ${invoiceId}`);
    } else {
      // We can handle updates here if we want, but usually loop handles it
    }
  } catch (err) {
    console.error(`[SYNC FAILED] Could not sync ${invoiceId} to PAYMENT_TRANSACTIONS`, err);
  }
}


/* ---------- Control Flow & Logic ---------- */

export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { invoiceId } = req.query;
  if (!invoiceId) return res.status(400).json({ error: "invoiceId required" });

  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.json({ invoiceId, status: "PENDING" });

    let finalStatus = 'PENDING';
    let transactionData = null; // Data from 3Thix

    // 1. 3Thix API is the ONLY Authority (Primary + Secondary checks)
    const apiResult = await check3ThixSafe(invoiceId);

    if (apiResult) {
      const rawStatus = (apiResult.status || '').toUpperCase();

      // Strict Interpretation
      if (['PAID', 'COMPLETED', 'SUCCESS'].includes(rawStatus)) {
        finalStatus = 'SUCCESS';
      } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(rawStatus)) {
        finalStatus = 'FAILED';
      } else {
        finalStatus = 'PENDING';
      }

      transactionData = apiResult.data;
    } else {
      // If API fails or returns nothing, we default to PENDING.
      // We NEVER check sheets for success status.
      finalStatus = 'PENDING';
    }

    // 2. If SUCCESS, Write to Ledgers (Mirrors)
    if (finalStatus === 'SUCCESS' && transactionData) {
      console.log(`[SOURCE: API] 3Thix confirmed SUCCESS for ${invoiceId}`);

      // Parse metadata
      let metadata = {};
      try {
        metadata = typeof transactionData.metadata === 'string'
          ? JSON.parse(transactionData.metadata)
          : transactionData.metadata || {};
      } catch (e) { }

      // WRITE TO ALL LEDGERS (Idempotent)

      // A. Transactions Sheet (Financial Ledger)
      await appendToTransactions(sheets, [
        transactionData.merchant_ref_id || '',
        "NILA TOKEN - Mindwave",
        transactionData.amount || '',
        transactionData.currency || '',
        'SUCCESS',
        "3THIX",
        invoiceId,
        transactionData.fee || '0',
        metadata.paymentBlocked ? 'BLOCKED' : '',
        '', // country
        '', // notes
        new Date().toISOString()
      ]);

      // B. TransactionActivityLog (Event Timeline)
      await appendToActivityLog(sheets, [
        crypto.randomUUID(),
        invoiceId,
        transactionData.merchant_ref_id || '',
        "PAYMENT_SUCCESS",
        transactionData.amount || '',
        transactionData.currency || '',
        "3THIX",
        '',
        '',
        '',
        JSON.stringify(metadata),
        new Date().toISOString()
      ]);

      // C. PaymentAdditionalInfo (User Metadata)
      const name = metadata.name || '';
      const email = metadata.email || '';
      if (name || email) {
        await appendToAdditionalInfo(sheets, [
          invoiceId,
          transactionData.merchant_ref_id || '',
          name,
          email,
          'SUCCESS',
          transactionData.amount || '',
          transactionData.currency || '',
          new Date().toISOString()
        ]);
      }
    }

    // 3. Sync to PAYMENT_TRANSACTIONS (View Layer) & Handle Email
    let ptRow = await findInPaymentTransactions(sheets, invoiceId);

    if (!ptRow) {
      await syncToPaymentTransactions(sheets, invoiceId, finalStatus, null, null);
      ptRow = await findInPaymentTransactions(sheets, invoiceId); // Refresh
    }

    if (ptRow) {
      const updates = [];

      // Update Status if changed (e.g. PENDING -> SUCCESS or PENDING -> FAILED)
      if (ptRow.STATUS !== finalStatus) {
        updates.push({ col: 'B', val: finalStatus });
        ptRow.STATUS = finalStatus;
      }

      // Hydration & Email Logic ONLY on SUCCESS
      if (finalStatus === 'SUCCESS') {

        // Hydration: Try to fill missing email/name
        if (!ptRow.EMAIL) {
          let hydrated = null;

          // Try from current transaction data
          if (transactionData) {
            let metadata = {};
            try { metadata = typeof transactionData.metadata === 'string' ? JSON.parse(transactionData.metadata) : transactionData.metadata || {}; } catch (e) { }
            if (metadata.email) {
              hydrated = { email: metadata.email, name: metadata.name };
            }
          }

          // Fallback: Try ledgers
          if (!hydrated || !hydrated.email) {
            hydrated = await hydrateFromLedgers(sheets, invoiceId);
          }

          if (hydrated && hydrated.email) {
            updates.push({ col: 'C', val: hydrated.email });
            ptRow.EMAIL = hydrated.email;
            if (hydrated.name) {
              updates.push({ col: 'D', val: hydrated.name });
              ptRow.NAME = hydrated.name;
            }
            console.log(`[HYDRATED] Email recovered for ${invoiceId}: ${hydrated.email}`);
          }
        }

        // Commit updates before email attempt
        if (updates.length > 0) {
          await updatePaymentTransactionRow(sheets, ptRow.rowIndex, updates);
          // clear updates array as they are committed
          updates.length = 0;
        }

        // Email Sending (Strict Idempotency)
        if (ptRow.EMAIL_SENT !== 'YES') {
          const email = ptRow.EMAIL;
          const name = ptRow.NAME;

          if (email) {
            console.log(`[EMAIL TRIGGER] Attempting to send email to ${email}`);
            try {
              // STRICT: Only mark sent if this succeeds
              await processSuccessfulPayment(invoiceId, email, name);

              // Update Sheet
              await updatePaymentTransactionRow(sheets, ptRow.rowIndex, [
                { col: 'E', val: 'YES' },
                { col: 'F', val: new Date().toISOString() }
              ]);
              console.log(`[EMAIL SENT] Marked as YES for ${invoiceId}`);
            } catch (emailErr) {
              console.error(`[EMAIL FAILED] Could not send email for ${invoiceId}`, emailErr);
              // Do NOT mark as sent. Will retry next poll.
            }
          } else {
            console.warn(`[EMAIL SKIP] Success but no email found for ${invoiceId}`);
          }
        } else {
          console.log(`[EMAIL SKIPPED] Already sent for ${invoiceId}`);
        }
      } else {
        // If not success, just commit any status updates
        if (updates.length > 0) {
          await updatePaymentTransactionRow(sheets, ptRow.rowIndex, updates);
        }
      }
    }

    return res.json({
      invoiceId,
      status: finalStatus,
      source: '3THIX_API',
      emailSent: ptRow ? (ptRow.EMAIL_SENT === 'YES') : false
    });

  } catch (err) {
    console.error("[check-payment-status CRASH]", err);
    return res.json({ invoiceId: req.query.invoiceId, status: "PENDING" });
  }
}
