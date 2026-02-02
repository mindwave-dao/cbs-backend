# Brevo Email Templates for Crypto Payments

This folder contains HTML templates for Brevo. Copy each template into your Brevo dashboard.

## Template Variables (from Backend)

All templates receive these params:
- `{{ params.full_name }}` - Customer name
- `{{ params.wallet_address }}` - User's wallet address
- `{{ params.amount }}` - USD amount
- `{{ params.estimated_nila_tokens }}` - Estimated NILA tokens
- `{{ params.network }}` - Network (TRC-20, ERC-20, etc.)
- `{{ params.tx_hash_last6 }}` - Last 6 chars of transaction hash
- `{{ params.status }}` - PENDING_VERIFICATION or CONFIRMED

Admin templates also receive:
- `{{ params.email }}` - Customer email
- `{{ params.confirmed_at }}` - Confirmation timestamp
- `{{ params.original_timestamp }}` - Original submission timestamp

## Files

1. `user-submission.html` - Acknowledgement to user after crypto submission
2. `admin-submission.html` - Notification to admin of new crypto submission  
3. `user-confirmed.html` - Confirmation to user after admin approval
4. `admin-confirmed.html` - Record to admin of confirmed payment
