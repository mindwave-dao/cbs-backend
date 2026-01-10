const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

const {
  BREVO_API_KEY,
  EMAIL_FROM,
  EMAIL_FROM_NAME
} = process.env;

// SANDBOX references (commented for future debugging):
// THIX_API_URL=https://sandbox-api.3thix.com
// THIX_API_KEY=SANDBOX_API_KEY
// PAYMENT_PAGE_BASE=https://sandbox-pay.3thix.com

/**
 * Send payment success email to customer via Brevo (Sendinblue) API
 *
 * @param {string} to - Recipient email address
 * @param {string} name - Recipient name
 * @param {string} invoiceId - Invoice ID for reference
 * @returns {Promise<boolean>} - True if email sent successfully
 */
export async function sendPaymentSuccessEmail(to, name, invoiceId) {
  // Skip if no recipient email
  if (!to) {
    console.log("No recipient email provided, skipping customer email notification");
    return false;
  }

  // Skip if Brevo not configured
  if (!BREVO_API_KEY) {
    console.warn("BREVO_API_KEY not set, skipping customer email notification");
    return false;
  }

  const senderEmail = EMAIL_FROM || "payments@mindwavedao.com";
  const senderName = "Mindwave Payments";

  try {
    console.log("📧 Sending customer email to:", to);

    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          email: senderEmail,
          name: senderName
        },
        to: [
          {
            email: to,
            name: name || ""
          }
        ],
        subject: "Payment Successful – NILA Tokens",
        htmlContent: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="UTF-8" />
          </head>
          <body style="font-family: Arial, sans-serif; background:#f6f8fb; padding:20px;">
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center">
                  <table width="600" style="background:#ffffff; border-radius:8px; padding:24px;">

                    <tr>
                      <td align="center" style="padding-bottom:20px;">
                        <img src="https://www.mindwavedao.com/wp-content/uploads/nila-logo-alt.png" height="48" alt="NILA Token" />
                      </td>
                    </tr>

                    <tr>
                      <td>
                        <h2 style="color:#111;">Payment Successful 🎉</h2>

                        <p>Hi <strong>${name || "there"}</strong>,</p>

                        <p>
                          Your purchase of <strong>NILA Tokens</strong> has been completed successfully.
                        </p>

                        <table width="100%" style="margin:16px 0; border-collapse:collapse;">
                          <tr>
                            <td>Invoice ID</td>
                            <td align="right"><strong>${invoiceId}</strong></td>
                          </tr>
                        </table>

                        <p>
                          Your tokens are now available and ready for use.
                        </p>

                        <p style="margin-top:24px;">
                          Regards,<br/>
                          <strong>NILA Team</strong>
                        </p>
                      </td>
                    </tr>

                  </table>
                </td>
              </tr>
            </table>
          </body>
          </html>
        `
      })
    });

    console.log("📨 Brevo customer response:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Brevo customer email failed:", response.status, errorText);
      return false;
    }

    const result = await response.json();
    console.log("Customer payment success email sent:", result.messageId || "OK");
    return true;

  } catch (error) {
    console.error("Brevo customer email error:", error.message);
    // Don't throw - email failure should not affect payment flow
    return false;
  }
}

/**
 * Send payment failed notification email
 * (Optional - can be called manually if needed)
 */
export async function sendPaymentFailedEmail({
  to,
  name,
  amount,
  currency,
  invoiceId,
  errorMessage
}) {
  if (!to || !BREVO_API_KEY) {
    return false;
  }

  const senderEmail = EMAIL_FROM || "payments@mindwavedao.com";
  const senderName = EMAIL_FROM_NAME || "Mindwave Payments";

  try {
    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          email: senderEmail,
          name: senderName
        },
        to: [{ email: to, name: name || "" }],
        subject: "Payment Issue – NILA",
        htmlContent: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: #ef4444; padding: 30px; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Payment Issue</h1>
            </div>

            <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #eee; border-top: none;">
              <p>Hi ${name || "there"},</p>

              <p>Unfortunately, your payment could not be processed.</p>

              <table style="width: 100%; margin: 20px 0;">
                <tr><td style="padding: 8px 0;"><strong>Amount:</strong></td><td>${currency} ${amount}</td></tr>
                <tr><td style="padding: 8px 0;"><strong>Invoice ID:</strong></td><td style="font-family: monospace;">${invoiceId}</td></tr>
                ${errorMessage ? `<tr><td style="padding: 8px 0;"><strong>Reason:</strong></td><td>${errorMessage}</td></tr>` : ''}
              </table>

              <p>Please try again or contact support if the issue persists.</p>

              <p style="color: #888; font-size: 12px;">— The Mindwave Team</p>
            </div>
          </body>
          </html>
        `
      })
    });

    return response.ok;
  } catch (error) {
    console.error("Brevo email error:", error.message);
    return false;
  }
}

/**
 * Send admin notification email for successful payments
 *
 * @param {string} name - Customer name
 * @param {string} userEmail - Customer email
 * @param {string} invoiceId - Invoice ID
 * @returns {Promise<boolean>} - True if email sent successfully
 */
export async function sendAdminEmail(name, userEmail, invoiceId) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn("ADMIN_EMAIL not set, skipping admin email notification");
    return false;
  }

  // Skip if Brevo not configured
  if (!BREVO_API_KEY) {
    console.warn("BREVO_API_KEY not set, skipping admin email notification");
    return false;
  }

  const senderEmail = EMAIL_FROM || "payments@mindwavedao.com";
  const senderName = "Mindwave Payments";

  try {
    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          email: senderEmail,
          name: senderName
        },
        to: [
          {
            email: adminEmail,
            name: "Mindwave Admin"
          }
        ],
        subject: `New NILA Purchase – ${invoiceId}`,
        htmlContent: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif;">
            <h3>New NILA Token Purchase</h3>

            <table cellpadding="6">
              <tr><td><strong>Name:</strong></td><td>${name || 'N/A'}</td></tr>
              <tr><td><strong>Email:</strong></td><td>${userEmail || 'N/A'}</td></tr>
              <tr><td><strong>Invoice ID:</strong></td><td>${invoiceId || 'N/A'}</td></tr>
              <tr><td><strong>Timestamp:</strong></td><td>${new Date().toISOString()}</td></tr>
            </table>
          </body>
          </html>
        `
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Brevo admin email failed:", response.status, errorText);
      return false;
    }

    const result = await response.json();
    console.log("Admin email sent:", result.messageId || "OK");
    return true;

  } catch (error) {
    console.error("Brevo admin email error:", error.message);
    // Don't throw - email failure should not affect payment flow
    return false;
  }
}
/**
 * Process successful payment - shared function for webhook and check-status endpoint
 * Ensures idempotent email sending: STATUS = SUCCESS AND EMAIL_SENT != YES
 *
 * @param {string} invoiceId - Invoice ID
 * @param {string} userEmail - User email address
 * @param {string} userName - User name
 * @returns {Promise<{success: boolean, emailSent: boolean}>}
 */
export async function processSuccessfulPayment(invoiceId, userEmail, userName) {
  console.log(`🎯 Processing successful payment for invoice: ${invoiceId}`);

  // Must have user email to send
  if (!userEmail) {
    console.log(`❌ No user email found for invoice ${invoiceId}. Skipping email.`);
    return { success: false, emailSent: false };
  }

  // Check if emails have already been sent (idempotency check)
  const currentEmailStatus = await checkEmailSentStatus(invoiceId);
  console.log(`[EMAIL CHECK] invoiceId=${invoiceId} emailSent=${currentEmailStatus || 'NO'}`);

  if (currentEmailStatus === 'YES') {
    console.log(`📧 Emails already sent for invoice ${invoiceId} - skipping`);
    return { success: true, emailSent: true };
  }

  try {
    // Send user email
    const userEmailPromise = sendPaymentSuccessEmail(userEmail, userName, invoiceId).catch(err => {
      console.error("❌ Failed to send user email:", err.message);
      return false;
    });

    // Send admin email
    const adminEmailPromise = sendAdminEmail(userName, userEmail, invoiceId).catch(err => {
      console.error("❌ Failed to send admin email:", err.message);
      return false;
    });

    // Wait for both emails
    const [userEmailSent, adminEmailSent] = await Promise.all([userEmailPromise, adminEmailPromise]);

    // Mark as sent in Google Sheets if at least one email succeeded
    if (userEmailSent || adminEmailSent) {
      await markEmailSentInSheets(invoiceId);
      console.log(`[EMAIL SENT] invoiceId=${invoiceId}`);
      return { success: true, emailSent: true };
    } else {
      console.log(`❌ Email sending failed for invoice ${invoiceId}`);
      return { success: true, emailSent: false };
    }

  } catch (error) {
    console.error(`💥 Error in processing successful payment for ${invoiceId}:`, error.message);
    return { success: false, emailSent: false };
  }
}

/**
 * Handle post-success actions after Google Sheets update
 * This MUST be called immediately after writing STATUS = SUCCESS to sheets
 *
 * @param {Object} params
 * @param {string} params.invoiceId - Invoice ID
 * @param {string} params.status - Payment status
 * @param {string} params.userEmail - User email address
 * @param {string} params.userName - User name
 * @param {string|number} params.amount - Payment amount
 * @param {string} params.currency - Currency code
 * @returns {Promise<boolean>} - True if email was sent or already sent
 */
export async function handlePostSuccessActions({
  invoiceId,
  status,
  userEmail,
  userName,
  amount,
  currency
}) {
  // Only process successful payments
  if (status !== 'SUCCESS') {
    console.log(`Skipping post-success actions: status is ${status}, not SUCCESS`);
    return false;
  }

  const result = await processSuccessfulPayment(invoiceId, userEmail, userName, amount, currency);
  return result.emailSent;
}

/**
 * Mark email as sent in PAYMENT_TRANSACTIONS sheet
 * This is called after successful email sending
 */
async function markEmailSentInSheets(invoiceId) {
  const { google } = require("googleapis");

  const sheetsClient = getGoogleSheetsClient();
  if (!sheetsClient || !process.env.GOOGLE_SHEET_ID || !invoiceId) return;

  try {
    // Get all rows from PAYMENT_TRANSACTIONS sheet
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:F"
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
      console.warn(`Could not find row for invoice ${invoiceId} to mark email as sent`);
      return;
    }

    // Update EMAIL_SENT and EMAIL_SENT_AT columns (E and F = indices 4 and 5)
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `PAYMENT_TRANSACTIONS!E${rowIndex}:F${rowIndex}`,
      valueInputOption: "RAW",
      requestBody: {
        values: [["YES", new Date().toISOString()]]
      }
    });

    console.log(`✅ EMAIL_SENT marked as YES for invoice ${invoiceId}`);
    console.log(`✅ EMAIL_SENT_AT set for invoice ${invoiceId}`);
  } catch (err) {
    console.error("Error marking email as sent:", err.message);
  }
}

/**
 * Check if email has already been sent for an invoice
 * @param {string} invoiceId - Invoice ID to check
 * @returns {Promise<string|null>} - 'YES' if sent, null/empty if not
 */
async function checkEmailSentStatus(invoiceId) {
  const sheetsClient = getGoogleSheetsClient();
  if (!sheetsClient || !process.env.GOOGLE_SHEET_ID || !invoiceId) return null;

  try {
    const response = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: "PAYMENT_TRANSACTIONS!A2:F"
    });

    const rows = response.data.values || [];

    // Find the row with matching INVOICE_ID (column A = index 0)
    for (const row of rows) {
      if (row[0] === invoiceId) {
        return row[4] || null;  // Return EMAIL_SENT (column E = index 4)
      }
    }

    return null;  // Not found
  } catch (err) {
    console.warn("Error checking email sent status:", err.message);
    return null;  // Fail open
  }
}

/**
 * Get Google Sheets client (helper for markEmailSentInSheets)
 */
function getGoogleSheetsClient() {
  if (!process.env.GOOGLE_SHEETS_CREDENTIALS) {
    console.warn("GOOGLE_SHEETS_CREDENTIALS not set");
    return null;
  }

  try {
    const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    return google.sheets({ version: "v4", auth });
  } catch (err) {
    console.error("Failed to initialize Google Sheets:", err);
    return null;
  }
}
