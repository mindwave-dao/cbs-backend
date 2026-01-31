# Payment System Environment Variables

The following environment variables are required for the hardened payment system to function correctly.

## Core API & Webhooks
| Variable | Description | Example |
|---|---|---|
| `THIX_API_URL` | Base URL for 3Thix API | `https://api.3thix.com` |
| `THIX_API_KEY` | API Key for 3Thix | `thix_live_...` |
| `THIX_WEBHOOK_URL` | The *exact* URL of your Vercel deployment's webhook endpoint | `https://your-project.vercel.app/api/payment-callback` |
| `THIX_WEBHOOK_SECRET` | Secret used to sign webhook payloads (HMAC-SHA256) | `whsec_...` |
| `WEBHOOK_AUTH_TOKEN` | Bearer token for webhook authorization | `secret-token-123` |

## Google Sheets
| Variable | Description | Example |
|---|---|---|
| `GOOGLE_SHEET_ID` | ID of the Google Sheet (from URL) | `1BxiM...` |
| `GOOGLE_SHEETS_CREDENTIALS` | JSON Service Account credentials | `{"type": "service_account", ...}` |

## Email (Brevo)
| Variable | Description | Example |
|---|---|---|
| `BREVO_API_KEY` | API Key for Brevo Email Service | `xkeysib-...` |
| `EMAIL_FROM` | Sender email address | `payments@mindwavedao.com` |
| `ADMIN_EMAIL` | Admin email for notifications | `admin@mindwavedao.com` |
| `ADMIN_TOKEN` | Token for protecting admin routes | `admin-secret-123` |

## Frontend
| Variable | Description | Example |
|---|---|---|
| `FRONTEND_BASE_URL` | Base URL of the frontend application | `https://buynow.mindwavedao.com` |
| `PAYMENT_PAGE_BASE` | 3Thix Hosted Payment Page URL | `https://pay.3thix.com` |

## Notes
- **CORS**: The system is strictly configured to allow requests from `https://buynow.mindwavedao.com`.
- **Validation**: Webhooks must have `Authorization: Bearer <WEBHOOK_AUTH_TOKEN>` and a valid `X-Webhook-Signature`.
