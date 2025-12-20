require('dotenv').config();

if (!process.env.THIX_API_KEY || !process.env.THIX_API_URL || !process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SHEETS_CREDENTIALS) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const fetch = global.fetch || require('node-fetch');
const { google } = require('googleapis');

const app = express();

app.use(cors());
app.use(express.json());

async function appendToGoogleSheets(rowData) {
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SHEETS_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Transactions!A:L',
      valueInputOption: 'RAW',
      resource: {
        values: [rowData]
      }
    });
  } catch (error) {
    console.error('Google Sheets append error:', error);
  }
}

app.get('/', (req, res) => {
  res.type('text/plain').send('Mindwave Credits API is running');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Mindwave Credits API',
    timestamp: new Date().toISOString()
  });
});

app.post('/create-payment-invoice', async (req, res) => {
  try {
    const country = req.headers['x-vercel-ip-country'] || 'UNKNOWN';

    if (country === 'US') {
      return res.status(403).json({
        error: 'Payments are not available in your region.'
      });
    }

    const { amount, currency, description, quantity = 1 } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    if (!currency || typeof currency !== 'string') {
      return res.status(400).json({ error: 'Currency is required' });
    }

    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'Description is required' });
    }

    if (typeof quantity !== 'number' || quantity <= 0) {
      return res.status(400).json({ error: 'Invalid quantity' });
    }

    const merchant_ref_id = `mw-${Date.now()}`;
    const price_unit = amount / quantity;

    const payload = {
      rail: 'CREDIT_CARD',
      currency,
      amount: amount.toString(),
      merchant_ref_id,
      cart: [{
        product_name: description,
        qty_unit: quantity,
        price_unit: price_unit.toString()
      }]
    };

    const response = await fetch(`${process.env.THIX_API_URL}/order/payment/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.THIX_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error('3Thix API error:', response.status);
      return res.status(500).json({ error: 'Payment gateway error' });
    }

    const data = await response.json();
    const invoiceId = data.invoice_id || data.invoice?.id || data.id;

    if (!invoiceId) {
      console.error('Invalid 3Thix response:', data);
      return res.status(500).json({ error: 'Failed to create invoice' });
    }

    res.json({ invoiceId, merchant_ref_id });

    appendToGoogleSheets([
      merchant_ref_id,
      description,
      amount.toString(),
      currency,
      'INVOICE_CREATED',
      '3THIX',
      invoiceId,
      '0',
      '',
      '',
      '',
      new Date().toISOString()
    ]);

  } catch (error) {
    console.error('Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;
