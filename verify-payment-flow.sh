#!/bin/bash

# Configuration
BASE_URL="https://your-project.vercel.app" # CHANGE THIS
TOKEN="your-webhook-auth-token"            # CHANGE THIS
SECRET="your-webhook-secret"               # CHANGE THIS

echo "1. Testing CORS Preflight (OPTIONS /api/create-invoice)"
curl -v -X OPTIONS "$BASE_URL/api/create-invoice" \
  -H "Origin: https://buynow.mindwavedao.com" \
  -H "Access-Control-Request-Method: POST"

echo ""
echo "---------------------------------------------------"
echo "2. Testing Webhook (POST /api/payment-callback)"

# Payload
PAYLOAD='{"id":"test-invoice-123","status":"PAID","amount":"100","metadata":{"email":"test@example.com"}}'
# Calculate Signature (Mac only)
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

echo "Payload: $PAYLOAD"
echo "Signature: $SIGNATURE"

curl -v -X POST "$BASE_URL/api/payment-callback" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Webhook-Signature: $SIGNATURE" \
  -d "$PAYLOAD"

echo ""
echo "---------------------------------------------------"
echo "3. Testing Admin Reconciliation (POST /api/reconcile-invoices)"
curl -v -X POST "$BASE_URL/api/reconcile-invoices" \
  -H "Authorization: Bearer $TOKEN"
