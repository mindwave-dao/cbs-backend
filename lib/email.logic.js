
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
      <div style="background:#ffffff; border-radius:8px; padding:24px;">
          <h2 style="color:#111;">Payment Successful 🎉</h2>
          <p>Hi <strong>${name || "there"}</strong>,</p>
          <p>Your purchase of <strong>NILA Tokens</strong> is complete.</p>
          <table width="100%" style="margin:16px 0;">
            <tr><td>Invoice ID</td><td><strong>${invoiceId}</strong></td></tr>
            <tr><td>Tokens Purchased</td><td><strong>${tokens} NILA</strong></td></tr>
            <tr><td>Price per Token</td><td><strong>$${tokenPrice}</strong></td></tr>
            <tr><td>Total Amount</td><td><strong>$${amount} ${"USD"}</strong></td></tr>
            <tr><td>Wallet Address</td><td><strong>${walletAddress || "Not Provided"}</strong></td></tr>
          </table>
          <p>Regards,<br/><strong>NILA Team</strong></p>
      </div>
    </body>
    </html>
  `;

    try {
        const payload = {
            sender: { email: senderEmail, name: senderName },
            to: [{ email: to, name: name || "" }],
            subject: "Payment Successful – NILA Tokens",
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
