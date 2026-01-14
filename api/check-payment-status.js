import { google } from "googleapis";
import { processSuccessfulPayment } from "../lib/email.js";
import crypto from "crypto";

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
 * Writers for Ledger Sheets
 */
async function appendToTransactions(sheets, row) {
  if (!sheets) return;
  try {
    // Check if invoice already exists to avoid duplicates
    const invoiceId = row[6]; // Index 6 is Invoice ID in Transactions sheet

    // Note: For efficiency in high volume this should be optimized, 
    // but for now we rely on the caller to check existence via findInTransactions logic before calling this if possible,
    // or we just append. The requirement is to Ensure it is written.

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


async function updatePaymentTransactionRow(sheets, rowIndex, status, email, name, emailSent, emailSentAt) {
  try {
    const updates = [];
    if (status) updates.push({ range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] });
    if (email) updates.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[email]] });
    if (name) updates.push({ range: `PAYMENT_TRANSACTIONS!D${rowIndex}`, values: [[name]] });
    if (emailSent) updates.push({ range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[emailSent]] });
    if (emailSentAt) updates.push({ range: `PAYMENT_TRANSACTIONS!F${rowIndex}`, values: [[emailSentAt]] });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: { valueInputOption: "RAW", data: updates }
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
    // Check if exists first to avoid double append
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
      // If it exists but status is different, update it
      if (existing.STATUS !== status) {
        await updatePaymentTransactionRow(sheets, existing.rowIndex, status, null, null, null, null);
      }
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
    let transactionData = null; // Data from 3Thix or Ledger

    // 1. Check Ledgers FIRST (Transactions Sheet)
    const ledgerTrans = await findInTransactions(sheets, invoiceId);
    if (ledgerTrans && ['SUCCESS', 'PAID', 'COMPLETED'].includes(ledgerTrans.status)) {
      console.log(`[SOURCE: LEDGER] Found SUCCESS in Transactions sheet`);
      finalStatus = 'SUCCESS';
      transactionData = ledgerTrans;
    }

    // 2. If not in Ledger, Check 3Thix API
    if (finalStatus !== 'SUCCESS') {
      const apiResult = await check3ThixSafe(invoiceId);
      if (apiResult && ['SUCCESS', 'PAID', 'COMPLETED'].includes(apiResult.status)) {
        console.log(`[SOURCE: API] Found SUCCESS in 3Thix API`);
        finalStatus = 'SUCCESS';
        const data = apiResult.data;

        // Parse metadata safely
        let metadata = {};
        try { metadata = typeof data.metadata === 'string' ? JSON.parse(data.metadata) : data.metadata || {}; } catch (e) { }

        // WRITE TO ALL LEDGERS (Missing piece)
        // A. Transactions
        await appendToTransactions(sheets, [
          data.merchant_ref_id || '',
          "NILA TOKEN - Mindwave", // Description
          data.amount || '',
          data.currency || '',
          'SUCCESS',
          "3THIX",
          invoiceId,
          data.fee || '0',
          metadata.paymentBlocked ? 'BLOCKED' : '',
          '', // Country hard to get from here if not in metadata or response
          '', // Notes
          new Date().toISOString()
        ]);

        // B. TransactionActivityLog
        await appendToActivityLog(sheets, [
          crypto.randomUUID(),
          invoiceId,
          data.merchant_ref_id || '',
          "PAYMENT_SUCCESS",
          data.amount || '',
          data.currency || '',
          "3THIX",
          '', // Country
          '', // User Agent
          '', // IP
          JSON.stringify(metadata),
          new Date().toISOString()
        ]);

        // C. PaymentAdditionalInfo
        const name = metadata.name || '';
        const email = metadata.email || '';
        if (name || email) {
          await appendToAdditionalInfo(sheets, [
            invoiceId,
            data.merchant_ref_id || '',
            name,
            email,
            data.amount || '',
            data.currency || '',
            'SUCCESS',
            new Date().toISOString()
          ]);
        }
      }
    }

    // 3. Sync to PAYMENT_TRANSACTIONS (The View Layer)
    // We do this regardless of success/pending to ensure the row exists, but specifically handle success updates
    // Fetch current state in PAYMENT_TRANSACTIONS
    let ptRow = await findInPaymentTransactions(sheets, invoiceId);

    if (!ptRow) {
      // If it doesn't exist, we should create it (likely PENDING unless 3Thix found it)
      // However, create-payment-invoice should have created it. If missing, we create.
      // We try to get email/name from transactionData if available (from 3Thix check)
      // NOTE: We do NOT rely on other sheets for hydration anymore. 
      // If it's missing here, it might be a weird edge case.
      await syncToPaymentTransactions(sheets, invoiceId, finalStatus, null, null);
      ptRow = await findInPaymentTransactions(sheets, invoiceId); // Refresh
    } else {
      // If status changed to SUCCESS, update it
      if (ptRow.STATUS !== 'SUCCESS' && finalStatus === 'SUCCESS') {
        await updatePaymentTransactionRow(sheets, ptRow.rowIndex, 'SUCCESS', null, null, null, null);
        ptRow.STATUS = 'SUCCESS'; // Update local obj for next step
      }
    }

    // 4. Email Logic (The FINAL Step)
    if (finalStatus === 'SUCCESS' && ptRow && ptRow.EMAIL_SENT !== 'YES') {
      const email = ptRow.EMAIL;
      const name = ptRow.NAME;

      if (email) {
        console.log(`[EMAIL TRIGGER] Attempting to send email to ${email}`);
        try {
          // THIS MUST SUCCEED for us to mark as sent
          await processSuccessfulPayment(invoiceId, email, name);

          // If we get here, it succeeded
          await updatePaymentTransactionRow(sheets, ptRow.rowIndex, null, null, null, 'YES', new Date().toISOString());
          console.log(`[EMAIL SENT] Marked as YES for ${invoiceId}`);
        } catch (emailErr) {
          console.error(`[EMAIL FAILED] Could not send email for ${invoiceId}`, emailErr);
          // We do NOT mark as sent, so it will retry next polling
        }
      } else {
        console.warn(`[EMAIL SKIP] Success but no email in PAYMENT_TRANSACTIONS for ${invoiceId}`);
      }
    } else if (ptRow && ptRow.EMAIL_SENT === 'YES') {
      console.log(`[EMAIL SKIPPED - ALREADY SENT] ${invoiceId}`);
    }

    return res.json({ invoiceId, status: finalStatus });

  } catch (err) {
    console.error("[check-payment-status CRASH]", err);
    return res.json({ invoiceId: req.query.invoiceId, status: "PENDING" });
  }
}
