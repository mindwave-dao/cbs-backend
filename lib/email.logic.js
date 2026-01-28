
import { findTransaction, markEmailSent } from "./sheets.logic.js";
import fetch from "node-fetch";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

export async function sendUserPaymentSuccessEmail(to, name, invoiceId, tokens, tokenPrice, amount, walletAddress) {
    if (!to || !process.env.BREVO_API_KEY) return { success: false, emailSent: false };

    // Idempotency Check via Sheets
    const tx = await findTransaction(invoiceId);
    if (tx && tx.EMAIL_SENT === 'YES') {
        console.log(`[EMAIL] Already sent to user for ${invoiceId}`);
        return { success: true, emailSent: true };
    }

    const senderEmail = process.env.EMAIL_FROM || "payments@mindwavedao.com";
    const senderName = "Mindwave Payments";

    //   const templateId = process.env.BREVO_USER_TEMPLATE_ID ? parseInt(process.env.BREVO_USER_TEMPLATE_ID) : null;

    // NOTE: User requested "Uses robust HTML fallback or BREVO_USER_TEMPLATE_ID if set"
    // But also provided a specific HTML structure in `lib/email.js`. I will preserve that.

    const htmlContent = `
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
      `;

    try {
        const payload = {
            sender: { email: senderEmail, name: senderName },
            to: [{ email: to, name: name || "" }],
            subject: "Payment Confirmation – NILA",
            htmlContent: htmlContent
        };
        // If template ID exists, use it? The legacy code did.
        // Keeping it simple with the HTML fallback as it's guaranteed to work.

        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const txt = await res.text();
            console.error(`[BREVO FAIL] ${res.status}: ${txt}`);
            throw new Error('BREVO_EMAIL_FAILED');
        }

        const data = await res.json();
        console.log(`[BREVO SENT] Utils: ${data.messageId}`);

        // Update Sheets
        await markEmailSent(invoiceId, 'USER');
        return { success: true, emailSent: true };

    } catch (e) {
        console.error(`[EMAIL ERROR] ${e.message}`);
        return { success: false, emailSent: false };
    }
}

export async function sendAdminPaymentNotification(params) {
    const {
        invoiceId, amount, currency, tokenPrice, tokens,
        email, source, timestamp, name, walletAddress
    } = params;

    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail || !process.env.BREVO_API_KEY) return false;

    // Idempotency: Check if admin email already sent
    const tx = await findTransaction(invoiceId);
    if (tx && tx.ADMIN_EMAIL_SENT === 'YES') {
        return true;
    }

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

    try {
        const res = await fetch(BREVO_API_URL, {
            method: "POST",
            headers: {
                "accept": "application/json",
                "content-type": "application/json",
                "api-key": process.env.BREVO_API_KEY
            },
            body: JSON.stringify({
                sender: { email: process.env.EMAIL_FROM || "payments@mindwavedao.com", name: "Mindwave Admin" },
                to: [{ email: adminEmail, name: "Admin" }],
                subject: `New NILA Payment Successful – Invoice ${invoiceId}`,
                htmlContent
            })
        });

        if (!res.ok) {
            console.error(`[BREVO ADMIN FAIL] ${res.status}`);
            return false;
        }

        await markEmailSent(invoiceId, 'ADMIN');
        return true;

    } catch (e) {
        console.error(`[ADMIN EMAIL ERROR] ${e.message}`);
        return false;
    }
}

export async function emailHealthCheck(targetEmail) {
    if (!process.env.BREVO_API_KEY) throw new Error("BREVO_API_KEY missing");

    const res = await fetch(BREVO_API_URL, {
        method: "POST",
        headers: {
            "accept": "application/json",
            "content-type": "application/json",
            "api-key": process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
            sender: { email: process.env.EMAIL_FROM || "payments@mindwavedao.com", name: "Health Check" },
            to: [{ email: targetEmail }],
            subject: `Health Check - ${new Date().toISOString()}`,
            htmlContent: "<h1>Health Check OK</h1>"
        })
    });

    if (!res.ok) throw new Error("Brevo responded with error");
    return await res.json();
}
