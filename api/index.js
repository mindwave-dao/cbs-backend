require('dotenv').config();

if (!process.env.THIX_API_KEY || !process.env.THIX_API_URL) {
  console.error('Missing required environment variables: THIX_API_KEY and THIX_API_URL');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

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
    const country = req.headers['x-vercel-ip-country'];
    if (country === 'US') {
      return res.status(403).json({ error: 'Payments are not available in your region.' });
    }

    const { amount, currency, description, quantity = 1 } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount: must be a number greater than 0' });
    }

    if (!currency || typeof currency !== 'string') {
      return res.status(400).json({ error: 'Currency is required' });
    }

    if (!description || typeof description !== 'string') {
      return res.status(400).json({ error: 'Description is required' });
    }

    if (typeof quantity !== 'number' || quantity <= 0) {
      return res.status(400).json({ error: 'Invalid quantity: must be a number greater than 0' });
    }

    const merchant_ref_id = Date.now().toString();
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
      console.error('3Thix API error:', response.status, response.statusText);
      return res.status(500).json({ error: 'Payment gateway error' });
    }

    const data = await response.json();
    const invoiceId = data.invoice_id || data.invoice?.id || data.id;

    if (!invoiceId) {
      console.error('No invoice ID in response:', data);
      return res.status(500).json({ error: 'Failed to create invoice' });
    }

    res.json({
      invoiceId,
      merchant_ref_id
    });
  } catch (error) {
    console.error('Internal error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = app;
