require('dotenv').config();

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

module.exports = app;
