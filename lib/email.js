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
        subject: "Payment Successful – NILA",
        htmlContent: `
          <!DOCTYPE html>
          <html>
          <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
          </head>
          <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Payment Successful ✓</h1>
            </div>
            
            <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; border: 1px solid #eee; border-top: none;">
              <p style="margin-top: 0;">Hi ${name || "there"},</p>

              <p>Great news! Your payment has been successfully processed.</p>

              <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                <tr>
                  <td style="padding: 12px; border-bottom: 1px solid #eee; font-weight: bold; width: 40%;">Amount:</td>
                  <td style="padding: 12px; border-bottom: 1px solid #eee;">${currency} ${amount}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border-bottom: 1px solid #eee; font-weight: bold;">Invoice ID:</td>
                  <td style="padding: 12px; border-bottom: 1px solid #eee; font-family: monospace; font-size: 12px;">${invoiceId}</td>
                </tr>
                <tr>
                  <td style="padding: 12px; border-bottom: 1px solid #eee; font-weight: bold;">Status:</td>
                  <td style="padding: 12px; border-bottom: 1px solid #eee;">
                    <span style="background: #22c55e; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px;">SUCCESS</span>
                  </td>
                </tr>
              </table>

              <p>Your NILA will be issued shortly. If you have any questions, please contact our support team.</p>

              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">

              <p style="color: #888; font-size: 12px; margin-bottom: 0;">
                — The Mindwave Team<br>
                <a href="https://www.mindwavedao.com" style="color: #667eea;">mindwavedao.com</a>
              </p>
            </div>
          </body>
          </html>
        `
      })
    });

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
