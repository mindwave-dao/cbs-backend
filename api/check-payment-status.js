import { google } from "googleapis";

// Hardcoded as per rules
const THIX_API_URL = 'https://api.3thix.com';

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









async function findRowByInvoiceIdSafe(sheets, invoiceId) {
  if (!sheets || !process.env.GOOGLE_SHEET_ID) {
    return null;
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:H"  // Skip header row, include all columns
    });

    const rows = response.data.values || [];

    // Search for the invoice ID (column A = index 0)
    for (const row of rows) {
      const rowInvoiceId = row[0];  // Column A (0-indexed = 0)
      if (rowInvoiceId === invoiceId) {
        return {
          STATUS: row[1] || 'PENDING',
          EMAIL: row[2] || '',
          NAME: row[3] || '',
          EMAIL_SENT: row[4] || 'NO',
          EMAIL_SENT_AT: row[5] || '',
          AMOUNT: row[6] || '',
          CURRENCY: row[7] || ''
        };
      }
    }

    return null;  // Not found
  } catch (err) {
    console.error("Error searching Google Sheets:", err);
    return null;
  }
}

async function check3ThixSafe(invoiceId) {
  const apiKey = process.env.THIX_API_KEY;
  if (!apiKey || !THIX_API_URL || !invoiceId) {
    console.error("❌ 3Thix API not configured or missing invoiceId");
    return 'PENDING';
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
            "x-api-key": apiKey
          }
        });

        if (response.ok) {
          const data = await response.json();
          console.log(`📨 3Thix API response for ${invoiceId}:`, JSON.stringify(data, null, 2));

          // Extract status from various possible fields
          const status = data.status || data.payment_status || data.state || data.paymentState;

          if (status) {
            // Normalize status to our format
            const upperStatus = status.toUpperCase();
            if (['PAID', 'COMPLETED', 'SUCCESS'].includes(upperStatus)) {
              return 'SUCCESS';
            }
            if (['FAILED', 'CANCELLED'].includes(upperStatus)) {
              return 'FAILED';
            }
            return 'PENDING';
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
    return 'PENDING';

  } catch (err) {
    console.error("💥 Error checking 3Thix API:", err.message);
    return 'PENDING';
  }
}

async function markSuccessSafe(sheets, invoiceId) {
  if (!sheets || !process.env.GOOGLE_SHEET_ID || !invoiceId) return;

  try {
    // Get all rows from PAYMENT_TRANSACTIONS sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:H"  // Skip header row, get all columns
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
      return;
    }

    // Update STATUS column (column B = index 1)
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `PAYMENT_TRANSACTIONS!B${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [['SUCCESS']]
      }
    });

    console.log(`Updated status for invoice ${invoiceId} to SUCCESS`);
  } catch (err) {
    console.error("Error updating payment status:", err.message);
  }
}

async function markFailedSafe(sheets, invoiceId) {
  if (!sheets || !process.env.GOOGLE_SHEET_ID || !invoiceId) return;

  try {
    // Get all rows from PAYMENT_TRANSACTIONS sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:H"  // Skip header row, get all columns
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
      return;
    }

    // Update STATUS column (column B = index 1)
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `PAYMENT_TRANSACTIONS!B${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [['FAILED']]
      }
    });

    console.log(`Updated status for invoice ${invoiceId} to FAILED`);
  } catch (err) {
    console.error("Error updating payment status:", err.message);
  }
}

async function sendEmailsSafe(sheets, invoiceId) {
  try {
    // Get the row data to check if emails were already sent
    const row = await findRowByInvoiceIdSafe(sheets, invoiceId);
    if (!row) return;

    // Only send if not already sent
    if (row.EMAIL_SENT !== 'YES') {
      // Lazy-load email module to prevent import-time crashes
      const { processSuccessfulPayment } = await import("../lib/email.js");

      await processSuccessfulPayment(
        invoiceId,
        row.EMAIL,
        row.NAME,
        row.AMOUNT,
        row.CURRENCY
      );

      // Mark email as sent in the sheet
      if (sheets && process.env.GOOGLE_SHEET_ID) {
        // Get all rows to find the row index
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEET_ID,
          range: "PAYMENT_TRANSACTIONS!A2:H"
        });

        const rows = response.data.values || [];
        let rowIndex = -1;

        for (let i = 0; i < rows.length; i++) {
          if (rows[i][0] === invoiceId) {
            rowIndex = i + 2; // +2 because we start from A2
            break;
          }
        }

        if (rowIndex !== -1) {
          // Update EMAIL_SENT (E) and EMAIL_SENT_AT (F)
          await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SHEET_ID,
            range: `PAYMENT_TRANSACTIONS!E${rowIndex}:F${rowIndex}`,
            valueInputOption: "RAW",
            requestBody: {
              values: [["YES", new Date().toISOString()]]
            }
          });
        }
      }
    }
  } catch (err) {
    console.error("Error sending emails:", err);
    // Don't throw - email failure should not affect status response
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

  try {
    const { invoiceId } = req.query;

    if (!invoiceId) {
      return res.status(400).json({ error: "invoiceId required" });
    }

    const sheets = await getSheetsClient();
    if (!sheets) {
      return res.json({ invoiceId, status: "PENDING" });
    }

    const row = await findRowByInvoiceIdSafe(sheets, invoiceId);
    if (!row) {
      return res.status(404).json({ invoiceId, status: "NOT_FOUND" });
    }

    if (row.STATUS === "SUCCESS" || row.STATUS === "FAILED") {
      return res.json({ invoiceId, status: row.STATUS });
    }

    const thixStatus = await check3ThixSafe(invoiceId);

    if (thixStatus === "SUCCESS") {
      await markSuccessSafe(sheets, invoiceId);
      await sendEmailsSafe(sheets, invoiceId);
      return res.json({ invoiceId, status: "SUCCESS" });
    }

    if (thixStatus === "FAILED") {
      await markFailedSafe(sheets, invoiceId);
      return res.json({ invoiceId, status: "FAILED" });
    }

    return res.json({ invoiceId, status: "PENDING" });

  } catch (err) {
    console.error("[check-payment-status CRASH]", err);
    return res.json({ invoiceId: req.query.invoiceId, status: "PENDING" });
  }
}
