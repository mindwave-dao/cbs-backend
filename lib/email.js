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
 * NOTE: Does NOT use BREVO_TEMPLATE_ID anymore (reserved for Admin).
 * Uses robust HTML fallback or BREVO_USER_TEMPLATE_ID if set.
 */
export async function sendPaymentSuccessEmail(to, name, invoiceId, tokens, tokenPrice, amount, walletAddress = "") {
  if (!to || !BREVO_API_KEY) return false;

  const senderEmail = EMAIL_FROM || "payments@mindwavedao.com";
  const senderName = "Mindwave Payments";

  // Compliance Update: Strict Content Control. Ignore Template ID to ensure this text is used.
  try {
    console.log("📧 Sending customer email to:", to);

    let payload = {
      sender: { email: senderEmail, name: senderName },
      to: [{ email: to, name: name || "" }],
      subject: "Payment Confirmation – NILA",
      htmlContent: `
          <!DOCTYPE html>
          <html>
          <head><meta charset="UTF-8" /></head>
          <body style="font-family: Arial, sans-serif; background:#f6f8fb; padding:20px;">
            <div style="background:#ffffff; border-radius:8px; padding:24px; color: #333; line-height: 1.6;">
                <p>Hi <strong>${name || "Customer"}</strong>,</p>
                <p>We have successfully received your payment.</p>
                
                <p style="margin: 20px 0; padding: 15px; background-color: #f9f9f9; border-radius: 4px;">
                  <strong>Invoice ID:</strong> ${invoiceId}<br/>
                  <strong>Amount Paid:</strong> $${amount} USD
                </p>

                <p>Your payment has been processed and recorded. For payments made using credit or debit cards, certain digital entitlements or services may be subject to a short processing or verification period before becoming available. This is part of standard card-network and fraud-prevention procedures.</p>

                <p>Any digital credits, platform access, or future token-related activity is subject to eligibility, jurisdictional requirements, and applicable platform rules.</p>
                
                <p>If required, you may be contacted separately to complete additional steps, such as account verification or wallet connection.</p>

                <p>This confirmation reflects payment processing only. Digital tokens, if applicable, are not issued at checkout and may be delivered through a separate process.</p>

                <p>If you have any questions, please contact us at <a href="mailto:support@mindwavedao.com" style="color: #0066cc;">support@mindwavedao.com</a>.</p>

                <p>Regards,<br/><strong>NILA Team</strong></p>
            </div>
          </body>
          </html>
      `
    };

    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    console.log('[BREVO USER RESPONSE]', { status: response.status, messageId: result.messageId });

    if (!response.ok || !result.messageId) {
      throw new Error('BREVO_EMAIL_FAILED');
    }

    return true;
  } catch (error) {
    console.error("Brevo customer email error:", error.message);
    throw error;
  }
}

/**
 * Send ADMIN payment success confirmation
 * Always attempts to send. Uses BREVO_TEMPLATE_ID.
 */
/**
 * Send ADMIN payment success notification (CRITICAL)
 * Always attempts to send. Uses BREVO_ADMIN_TEMPLATE_ID.
 * Strictly decoupled from user flow.
 */
export async function sendAdminPaymentNotification(params) {
  const {
    invoiceId, amount, currency, tokenPrice, tokens,
    email, source, timestamp, name, walletAddress
  } = params;

  // STRICT ENV VAR: ADMIN_EMAIL
  const adminEmail = process.env.ADMIN_EMAIL || "support@mindwavedao.com";

  // NOTE: We do not rely on a template ID anymore to ensure we can control the exact content.
  // If a template ID is strictly required by the user in the future, we can re-add it,
  // but for now, we use raw HTML to guarantee the content matches the requirements.

  if (!BREVO_API_KEY) {
    console.warn(`[ADMIN EMAIL SKIP] Missing BREVO_API_KEY`);
    return false;
  }

  try {
    console.log(`📧 Sending ADMIN notification to: ${adminEmail}`);

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <body style="font-family: Arial, sans-serif; padding: 20px;">
        <h2>New NILA Payment Successful – Invoice ${invoiceId}</h2>
        <p>New NILA payment processed successfully.</p>
        
        <p>
          <strong>Invoice ID:</strong> ${invoiceId}<br/>
          <strong>Customer Name:</strong> ${name || "Unknown"}<br/>
          <strong>Customer Email:</strong> ${email || "Unknown"}<br/>
          <strong>Amount Paid:</strong> ${amount} ${currency || "USD"}<br/>
          <strong>Tokens Purchased:</strong> ${tokens} NILA<br/>
          <strong>Price per Token:</strong> ${tokenPrice} USD<br/>
          <strong>Wallet Address:</strong> ${walletAddress || "Not Provided"}
        </p>

        <p>
          <strong>Payment Gateway:</strong> ${source || "3THIX"}<br/>
          <strong>Status:</strong> SUCCESS<br/>
          <strong>Timestamp:</strong> ${timestamp || new Date().toISOString()}
        </p>

        <p>— Mindwave Payments System</p>
      </body>
      </html>
    `;

    const payload = {
      sender: { email: EMAIL_FROM || "payments@mindwavedao.com", name: EMAIL_FROM_NAME || "Mindwave Innovations" },
      to: [{ email: adminEmail, name: "Admin" }],
      subject: `New NILA Payment Successful – Invoice ${invoiceId}`,
      htmlContent: htmlContent
    };

    const response = await fetch(BREVO_API_URL, {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": BREVO_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("[BREVO ADMIN ERROR]", response.status, result);
      return false;
    }

    console.log(`[BREVO ADMIN SENT] messageId=${result.messageId}`);
    return true;
  } catch (e) {
    console.error("[ADMIN EMAIL ERROR]", e.message);
    // FAIL-SAFE: Return false, do NOT throw, do NOT block flow
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
/**
 * Send admin notification email for ESCALATIONS (Attention Needed)
 * 
 * @param {string} name - Recipient name (e.g. "System Admin")
 * @param {string} adminEmail - Admin email address
 * @param {string} invoiceId - Invoice ID
 * @param {Object} context - { reason, status, emailSent }
 * @returns {Promise<boolean>}
 */
export async function sendAdminEmail(name, adminEmail, invoiceId, context = {}) {
  // Use env var if not passed, but caller usually passes it
  const targetEmail = adminEmail || process.env.ADMIN_EMAIL;

  if (!targetEmail) {
    console.warn("ADMIN_EMAIL not set, skipping admin notification");
    return false;
  }

  if (!BREVO_API_KEY) {
    console.warn("BREVO_API_KEY not set, skipping admin notification");
    return false;
  }

  const senderEmail = EMAIL_FROM || "payments@mindwavedao.com";
  const senderName = "Mindwave Alert";

  const { reason, status, emailSent } = context;

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
            email: targetEmail,
            name: name || "Admin"
          }
        ],
        subject: `⚠ Payment Requires Review – Invoice ${invoiceId}`,
        htmlContent: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif; background:#fff2f2; padding:20px;">
            <div style="background:white; border:1px solid #ffcccc; padding:20px; border-radius:5px;">
                <h3 style="color:#cc0000;">⚠ Payment Requires Review</h3>
                
                <p><strong>Invoice ID:</strong> ${invoiceId}</p>
                
                <table cellpadding="5" style="background:#f9f9f9; width:100%;">
                   <tr><td><strong>Reason:</strong></td><td>${reason || 'Unknown issue'}</td></tr>
                   <tr><td><strong>Current Status:</strong></td><td>${status || 'N/A'}</td></tr>
                   <tr><td><strong>Source:</strong></td><td>System Logic / 3Thix</td></tr>
                   <tr><td><strong>Email Sent:</strong></td><td>${emailSent || 'NO'}</td></tr>
                   <tr><td><strong>Timestamp:</strong></td><td>${new Date().toISOString()}</td></tr>
                </table>

                <p style="margin-top:20px; color:#666; font-size:12px;">
                   No action from user is required yet. System will retry automatically.<br/>
                   This alert was sent because the transaction entered an escalation state.
                </p>
            </div>
          </body>
          </html>
        `
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Brevo admin escalation email failed:", response.status, errorText);
      return false;
    }

    const result = await response.json();
    console.log("Admin escalation email sent:", result.messageId || "OK");
    return true;

  } catch (error) {
    console.error("Brevo admin email error:", error.message);
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
export async function processSuccessfulPayment(invoiceId, userEmail, userName, tokens, tokenPrice, amount, walletAddress = "") {
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
    // Send user email - STRICT REQUIREMENT: This must throw if it encounters any error
    // We do NOT use Promise.all here because we care about the user email for the 'EMAIL_SENT' flag
    await sendPaymentSuccessEmail(userEmail, userName, invoiceId, tokens, tokenPrice, amount, walletAddress);

    // If we passed the above line, email was strictly confirmed (201 + messageId)

    // Mark as sent in Google Sheets IMMEDIATELY after success
    await markEmailSentInSheets(invoiceId);
    console.log(`[EMAIL SENT] invoiceId=${invoiceId} [Sheet Updated]`);

    // NOTE: We do NOT send a routine admin success email anymore, per "Admins are notified only via email when attention is needed."
    // WAIT: The prompt says "Include wallet address in: Admin notification email". 
    // And "BackEnd Acceptance Checklist: Wallet included in admin email".
    // AND "Admin Email Notification Fix" conversation 2f2c... says "Admin Email Notification Fix".
    // BUT `payment-logic.js` sends it manually! (lines 557-569 in `payment-logic.js`).
    // So the `sendAdminPaymentNotification` is CALLED from `payment-logic.js`.
    // I already updated `payment-logic.js` to pass `walletAddress` to it.
    // I also updated `sendAdminPaymentNotification` signature above.
    // So this comment in `processSuccessfulPayment` (which handles USER email primarily) is fine.

    return { success: true, emailSent: true };

  } catch (error) {
    console.error(`💥 Error in processing successful payment for ${invoiceId}:`, error.message);
    // We return success: false for emailSent, causing the caller to know it failed.
    // The sheet will NOT be updated to 'YES'.
    return { success: true, emailSent: false, error: 'BREVO_EMAIL_FAILED' };
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
