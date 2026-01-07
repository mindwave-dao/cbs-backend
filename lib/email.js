import fetch from "node-fetch";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

const {
  BREVO_API_KEY,
  EMAIL_FROM,
  EMAIL_FROM_NAME
} = process.env;

/**
 * Send payment success email via Brevo (Sendinblue) API
 * 
 * @param {Object} params
 * @param {string} params.to - Recipient email address
 * @param {string} params.name - Recipient name
 * @param {string|number} params.amount - Payment amount
 * @param {string} params.currency - Currency code (USD, EUR, etc.)
 * @param {string} params.invoiceId - Invoice ID for reference
 * @returns {Promise<boolean>} - True if email sent successfully
 */
export async function sendPaymentSuccessEmail({
  to,
  name,
  amount,
  currency,
  invoiceId
}) {
  // Skip if no recipient email
  if (!to) {
    console.log("No recipient email provided, skipping email notification");
    return false;
  }

  // Skip if Brevo not configured
  if (!BREVO_API_KEY) {
    console.warn("BREVO_API_KEY not set, skipping email notification");
    return false;
  }

  const senderEmail = EMAIL_FROM || "payments@mindwavedao.com";
  const senderName = EMAIL_FROM_NAME || "Mindwave Payments";

  try {
    console.log("📧 Sending email to:", to);

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
        subject: "🎉 Your NILA Token Purchase Was Successful",
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
                          <tr>
                            <td>Amount</td>
                            <td align="right"><strong>${currency} ${amount}</strong></td>
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

    console.log("📨 Brevo response:", response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Brevo email failed:", response.status, errorText);
      return false;
    }

    const result = await response.json();
    console.log("Payment success email sent:", result.messageId || "OK");
    return true;

  } catch (error) {
    console.error("Brevo email error:", error.message);
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
 * @param {Object} params
 * @param {string} params.name - Customer name
 * @param {string} params.userEmail - Customer email
 * @param {string} params.invoiceId - Invoice ID
 * @param {string|number} params.amount - Payment amount
 * @param {string} params.currency - Currency code (USD, EUR, etc.)
 * @returns {Promise<boolean>} - True if email sent successfully
 */
export async function sendAdminEmail({
  name,
  userEmail,
  invoiceId,
  amount,
  currency
}) {
  // Skip if Brevo not configured
  if (!BREVO_API_KEY) {
    console.warn("BREVO_API_KEY not set, skipping admin email notification");
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
        to: [
          {
            email: "haja@mindwavedao.com",
            name: "Mindwave Admin"
          }
        ],
        subject: "✅ NILA Token Purchased",
        htmlContent: `
          <!DOCTYPE html>
          <html>
          <body style="font-family: Arial, sans-serif;">
            <h3>New NILA Token Purchase</h3>

            <table cellpadding="6">
              <tr><td><strong>Name:</strong></td><td>${name || 'N/A'}</td></tr>
              <tr><td><strong>Email:</strong></td><td>${userEmail || 'N/A'}</td></tr>
              <tr><td><strong>Invoice ID:</strong></td><td>${invoiceId || 'N/A'}</td></tr>
              <tr><td><strong>Amount:</strong></td><td>${currency || 'USD'} ${amount || 'N/A'}</td></tr>
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
 * Centralized email triggering after successful ledger updates
 * This ensures emails are sent immediately when Google Sheets state becomes authoritative
 *
 * @param {Object} params
 * @param {string} params.invoiceId - Invoice ID
 * @param {string} params.status - Payment status
 * @param {string} params.emailSent - Current EMAIL_SENT flag
 * @param {string} params.userEmail - User email address
 * @param {string} params.userName - User name
 * @param {string|number} params.amount - Payment amount
 * @param {string} params.currency - Currency code
 * @returns {Promise<boolean>} - True if email was sent or already sent
 */
export async function triggerEmailsAfterLedgerUpdate({
  invoiceId,
  status,
  emailSent,
  userEmail,
  userName,
  amount,
  currency
}) {
  // Only send for successful payments
  if (status !== 'SUCCESS') {
    console.log(`Skipping email trigger: status is ${status}, not SUCCESS`);
    return false;
  }

  // Idempotency check - don't send if already sent
  if (emailSent === 'YES') {
    console.log(`Email already sent for invoice ${invoiceId}. Skipping.`);
    return true; // Already sent, consider this success
  }

  // Must have user email to send
  if (!userEmail) {
    console.log(`No user email found for invoice ${invoiceId}. Skipping email.`);
    return false;
  }

  console.log(`📧 Triggering emails for successful payment: ${invoiceId}`);

  try {
    // Send user email
    const userEmailPromise = sendPaymentSuccessEmail({
      to: userEmail,
      name: userName,
      amount: amount?.toString() || '',
      currency: currency || '',
      invoiceId: invoiceId
    }).catch(err => {
      console.error("Failed to send user email:", err.message);
      return false;
    });

    // Send admin email
    const adminEmailPromise = sendAdminEmail({
      name: userName,
      userEmail: userEmail,
      invoiceId: invoiceId,
      amount: amount?.toString() || '',
      currency: currency || ''
    }).catch(err => {
      console.error("Failed to send admin email:", err.message);
      return false;
    });

    // Wait for both emails
    const [userEmailSent, adminEmailSent] = await Promise.all([userEmailPromise, adminEmailPromise]);

    if (userEmailSent || adminEmailSent) {
      console.log(`✅ Emails sent successfully for ${invoiceId}: user=${userEmailSent}, admin=${adminEmailSent}`);
      return true;
    } else {
      console.log(`❌ Email sending failed for ${invoiceId}`);
      return false;
    }

  } catch (error) {
    console.error("Error in email triggering:", error.message);
    return false;
  }
}

                <a href="https://www.mindwavedao.com" style="color: #22c55e;">mindwavedao.com</a>

