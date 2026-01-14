import { google } from "googleapis";
import { processSuccessfulPayment } from "../lib/email.js";

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
 * Search logic for 'Transactions' Sheet
 * Invoice ID is in Column G (index 6)
 * Status is in Column E (index 4)
 * Returns 'SUCCESS' if found and status matches
 */
async function findInTransactions(sheets, invoiceId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "Transactions!A2:L" // Reading widely to catch columns
    });
    const rows = response.data.values || [];
    for (const row of rows) {
      if (row[6] === invoiceId) { // Column G
        const status = (row[4] || '').toUpperCase(); // Column E
        if (['SUCCESS', 'PAID', 'COMPLETED'].includes(status)) return 'SUCCESS';
        if (['FAILED', 'CANCELLED'].includes(status)) return 'FAILED';
      }
    }
  } catch (e) {
    console.warn("[Transactions Sheet Check Failed]", e.message);
  }
  return null;
}

/**
 * Search logic for 'TransactionActivityLog' Sheet
 * Invoice ID is in Column B (index 1)
 * Event Type is in Column D (index 3)
 * Returns 'SUCCESS' if PAYMENT_SUCCESS event exists
 */
async function findInActivityLog(sheets, invoiceId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "TransactionActivityLog!A2:D"
    });
    const rows = response.data.values || [];
    for (const row of rows) {
      if (row[1] === invoiceId) { // Column B
        const event = (row[3] || '').toUpperCase(); // Column D
        if (event === 'PAYMENT_SUCCESS') return 'SUCCESS';
      }
    }
  } catch (e) {
    console.warn("[ActivityLog Sheet Check Failed]", e.message);
  }
  return null;
}

/**
 * Search logic for 'PaymentAdditionalInfo' Sheet
 * Invoice ID is in Column A (index 0)
 * Status is in Column G (index 6)
 * Returns 'SUCCESS' if found (existence usually implies success here, but checking status)
 */
async function findInAdditionalInfo(sheets, invoiceId) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PaymentAdditionalInfo!A2:H"
    });
    const rows = response.data.values || [];
    for (const row of rows) {
      if (row[0] === invoiceId) { // Column A
        const status = (row[6] || '').toUpperCase(); // Column G
        if (['SUCCESS', 'PAID'].includes(status)) return 'SUCCESS';
      }
    }
  } catch (e) {
    console.warn("[AdditionalInfo Sheet Check Failed]", e.message);
  }
  return null;
}

/**
 * Search logic for 'PAYMENT_TRANSACTIONS' Sheet (The Sync Target)
 * Invoice ID is in Column A (index 0)
 * Status is in Column B (index 1)
 * Returns object with full row data if found
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
          rowIndex: i + 2, // 1-based index + header
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


/**
 * Try to find Email and Name from other sheets if missing
 * Priority: transactionActivityLog -> PaymentAdditionalInfo
 */
async function hydrateUserData(sheets, invoiceId, currentData) {
  let email = currentData.EMAIL;
  let name = currentData.NAME;
  let hydrated = false;

  // If we already have both, no need to look
  if (email && name) return { email, name, hydrated: false };

  console.log(`[HYDRATION CHECK] invoiceId=${invoiceId} - Missing email/name, searching other sheets...`);

  // 1. TransactionActivityLog (Metadata)
  if (!email || !name) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "TransactionActivityLog!A2:L"
      });
      const rows = response.data.values || [];
      // Traverse backwards to get latest
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][1] === invoiceId) { // Invoice ID column B
          // Metadata is in column K (index 10)
          try {
            const metadata = JSON.parse(rows[i][10] || '{}');
            if (!email && metadata.email) email = metadata.email;
            if (!name && metadata.name) name = metadata.name;
          } catch (e) { /* ignore json error */ }

          if (email && name) break;
        }
      }
    } catch (e) { console.warn("[Hydration] ActivityLog failed", e.message); }
  }

  // 2. PaymentAdditionalInfo
  if (!email || !name) {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: GOOGLE_SHEET_ID,
        range: "PaymentAdditionalInfo!A2:H"
      });
      const rows = response.data.values || [];
      for (const row of rows) {
        if (row[0] === invoiceId) { // Invoice ID Column A
          if (!name && row[2]) name = row[2]; // Name Column C
          if (!email && row[3]) email = row[3]; // Email Column D
        }
        if (email && name) break;
      }
    } catch (e) { console.warn("[Hydration] AdditionalInfo failed", e.message); }
  }

  // Check if we found anything new
  if (email !== currentData.EMAIL || name !== currentData.NAME) {
    console.log(`[EMAIL HYDRATED] invoiceId=${invoiceId} email=${email} name=${name}`);
    return { email, name, hydrated: true };
  }

  return { email, name, hydrated: false };
}

async function updatePaymentTransactionRow(sheets, rowIndex, status, email, name, emailSent, emailSentAt) {
  try {
    const updates = [];

    // Column B (Status)
    if (status) updates.push({ range: `PAYMENT_TRANSACTIONS!B${rowIndex}`, values: [[status]] });
    // Column C (Email)
    if (email) updates.push({ range: `PAYMENT_TRANSACTIONS!C${rowIndex}`, values: [[email]] });
    // Column D (Name)
    if (name) updates.push({ range: `PAYMENT_TRANSACTIONS!D${rowIndex}`, values: [[name]] });
    // Column E (Email Sent)
    if (emailSent) updates.push({ range: `PAYMENT_TRANSACTIONS!E${rowIndex}`, values: [[emailSent]] });
    // Column F (Email Sent At)
    if (emailSentAt) updates.push({ range: `PAYMENT_TRANSACTIONS!F${rowIndex}`, values: [[emailSentAt]] });

    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: GOOGLE_SHEET_ID,
        requestBody: {
          valueInputOption: "RAW",
          data: updates
        }
      });
      console.log(`[GSHEET UPDATED] Row ${rowIndex} updated.`);
    }
  } catch (e) {
    console.error(`[UPDATE FAILED] Row ${rowIndex}`, e.message);
  }
}

async function handleForcedSuccess(sheets, invoiceId, rowData) {
  console.log(`[GSHEET FOUND] invoiceId=${invoiceId}`);

  let status = rowData.STATUS;
  let email = rowData.EMAIL;
  let name = rowData.NAME;
  let rowIndex = rowData.rowIndex;
  let emailSent = rowData.EMAIL_SENT;

  // 1. Force Success
  if (status.toUpperCase() === 'PENDING') {
    console.log(`[FORCED SUCCESS] invoiceId=${invoiceId}`);
    status = 'SUCCESS';
    // We will perform the update shortly
  }

  // 2. Hydrate
  const hydration = await hydrateUserData(sheets, invoiceId, rowData);
  if (hydration.hydrated) {
    email = hydration.email;
    name = hydration.name;
  }

  // 3. Update Sheet (Status + Hydrated Data)
  // We update if status changed OR if we hydrated data
  if (status !== rowData.STATUS || hydration.hydrated) {
    await updatePaymentTransactionRow(sheets, rowIndex, status, email, name, null, null);
  }

  // 4. Send Email (Idempotent)
  if (status === 'SUCCESS' && emailSent !== 'YES' && email) {
    console.log(`[EMAIL TRIGGER] invoiceId=${invoiceId} sending to ${email}`);
    await processSuccessfulPayment(invoiceId, email, name);

    // Update Email Sent Flag
    await updatePaymentTransactionRow(sheets, rowIndex, null, null, null, 'YES', new Date().toISOString());
    console.log(`[EMAIL SENT] invoiceId=${invoiceId}`);
  } else if (emailSent === 'YES') {
    console.log(`[EMAIL SKIPPED - ALREADY SENT] invoiceId=${invoiceId}`);
  } else if (!email) {
    console.warn(`[EMAIL SKIP] invoiceId=${invoiceId} - No email found even after hydration`);
  }

  return 'SUCCESS';
}

/**
 * Search logic for other sheets (Secondary)
 * Checks Transactions, PaymentAdditionalInfo, TransactionActivityLog
 * Returns 'SUCCESS' if found in any of them
 */
async function findInOtherSheets(sheets, invoiceId) {
  console.log(`[SECONDARY SHEET CHECK] invoiceId=${invoiceId}`);

  // 1. Check Transactions (Ledger)
  const transactionsStatus = await findInTransactions(sheets, invoiceId);
  if (transactionsStatus === 'SUCCESS') {
    console.log(`[STATUS RESOLVED FROM GSHEET] SUCCESS (Transactions Sheet)`);
    return 'SUCCESS';
  }

  // 2. Check PaymentAdditionalInfo
  const infoStatus = await findInAdditionalInfo(sheets, invoiceId);
  if (infoStatus === 'SUCCESS') {
    console.log(`[STATUS RESOLVED FROM GSHEET] SUCCESS (PaymentAdditionalInfo Sheet)`);
    return 'SUCCESS';
  }

  // 3. Check TransactionActivityLog
  const activityStatus = await findInActivityLog(sheets, invoiceId);
  if (activityStatus === 'SUCCESS') {
    console.log(`[STATUS RESOLVED FROM GSHEET] SUCCESS (TransactionActivityLog Sheet)`);
    return 'SUCCESS';
  }

  return null;
}

async function check3ThixSafe(invoiceId) {
  const apiKey = process.env.THIX_API_KEY;
  if (!apiKey || !THIX_API_URL || !invoiceId) {
    console.error("❌ 3Thix API not configured or missing invoiceId");
    return 'PENDING';
  }

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
          if (status) {
            const upperStatus = status.toUpperCase();
            if (['PAID', 'COMPLETED', 'SUCCESS'].includes(upperStatus)) return 'SUCCESS';
            if (['FAILED', 'CANCELLED'].includes(upperStatus)) return 'FAILED';
          }
        }
      } catch (e) { /* ignore */ }
    }
    return 'PENDING';
  } catch (err) {
    console.error("💥 Error checking 3Thix API:", err.message);
    return 'PENDING';
  }
}

async function syncToPaymentTransactions(sheets, invoiceId, status) {
  if (!sheets || !GOOGLE_SHEET_ID || status !== 'SUCCESS') return;

  try {
    // Insert New Row (We assume it doesn't exist if we are calling this from Step 2 or 3)
    // The caller handles the check.
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:F",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[invoiceId, 'SUCCESS', '', '', 'NO', '']]
      }
    });
    console.log(`[SYNC] Inserted new row in PAYMENT_TRANSACTIONS for ${invoiceId}`);
  } catch (err) {
    console.error(`[SYNC FAILED] Could not sync ${invoiceId} to PAYMENT_TRANSACTIONS`, err);
  }
}

async function sendEmailsSafe(sheets, invoiceId) {
  // Logic moved to handleForcedSuccess to ensure strict order
  // Keeping this as a potential standalone helper if needed, but unused in main flow now
}

/* ---------- API Handler ---------- */
export default async function handler(req, res) {
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { invoiceId } = req.query;
  if (!invoiceId) return res.status(400).json({ error: "invoiceId required" });

  try {
    const sheets = await getSheetsClient();
    if (!sheets) return res.json({ invoiceId, status: "PENDING" });

    // STEP 1: PAYMENT_TRANSACTIONS (PRIMARY)
    let paymentTransaction = await findInPaymentTransactions(sheets, invoiceId);
    if (paymentTransaction) {
      const status = await handleForcedSuccess(sheets, invoiceId, paymentTransaction);
      return res.json({ invoiceId, status });
    }

    // STEP 2: Other Sheets (SECONDARY)
    const otherSheetStatus = await findInOtherSheets(sheets, invoiceId);
    if (otherSheetStatus === 'SUCCESS') {
      console.log(`[STEP 2] Found in other sheets, syncing...`);
      await syncToPaymentTransactions(sheets, invoiceId, 'SUCCESS');

      // Re-fetch to handle via standard flow
      paymentTransaction = await findInPaymentTransactions(sheets, invoiceId);
      if (paymentTransaction) {
        await handleForcedSuccess(sheets, invoiceId, paymentTransaction);
      }
      return res.json({ invoiceId, status: "SUCCESS" });
    }

    // STEP 3: 3Thix API (LAST RESORT)
    const apiStatus = await check3ThixSafe(invoiceId);
    if (apiStatus === 'SUCCESS') {
      if (newRow) {
        await handleForcedSuccess(sheets, invoiceId, newRow);
      }
      return res.json({ invoiceId, status: "SUCCESS" });
    }

    console.log(`[STATUS CHECK] invoiceId=${invoiceId} status=${apiStatus}`);
    return res.json({ invoiceId, status: apiStatus });

  } catch (err) {
    console.error("[check-payment-status CRASH]", err);
    return res.json({ invoiceId: req.query.invoiceId, status: "PENDING" });
  }
}
