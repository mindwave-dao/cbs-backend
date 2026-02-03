# Payment System Environment Variables

The following environment variables are required for the hardened payment system to function correctly.

## Core API (3thix Card Payment - Intent Flow)
| Variable | Description | Example |
|---|---|---|
| `THIX_API_URL` | Base URL for 3Thix API (optional, defaults to webadmin.3thix.com) | `https://webadmin.3thix.com` |
| `THIX_PUBLIC_KEY` | Public API Key for 3thix | `yuh0esdx1lu...` |
| `THIX_SECRET_KEY` | Secret API Key for 3thix | `hi5w2whxjgm...` |

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
| `EMAIL_FROM_NAME` | Sender display name | `Mindwave DAO` |
| `ADMIN_EMAIL` | Admin email for notifications | `admin@mindwavedao.com` |
| `ADMIN_TOKEN` | Token for protecting admin routes | `admin-secret-123` |

## Frontend
| Variable | Description | Example |
|---|---|---|
| `FRONTEND_BASE_URL` | Base URL of the frontend application | `https://buynow.mindwavedao.com` |

## 3thix Card Payment Templates (Brevo)
| Variable | Description | Example |
|---|---|---|
| `BREVO_3THIX_USER_CONFIRMED_TEMPLATE_ID` | Template for user payment confirmation | `1` |
| `BREVO_3THIX_ADMIN_CONFIRMED_TEMPLATE_ID` | Template for admin payment notification | `2` |

## Crypto Payment Templates (Brevo)
| Variable | Description | Example |
|---|---|---|
| `BREVO_CRYPTO_USER_SUBMISSION_TEMPLATE_ID` | Template for user acknowledgement (pending) | `5` |
| `BREVO_CRYPTO_ADMIN_SUBMISSION_TEMPLATE_ID` | Template for admin notification (new submission) | `6` |
| `BREVO_CRYPTO_USER_CONFIRMED_TEMPLATE_ID` | Template for user confirmation (approved) | `7` |
| `BREVO_CRYPTO_ADMIN_CONFIRMED_TEMPLATE_ID` | Template for admin confirmation record | `8` |

## Notes
- **CORS**: The system is strictly configured to allow requests from `https://buynow.mindwavedao.com`.
- **New API**: The payment system now uses 3thix intent-based API (`/api/card/create-intent`) which returns a payment URL for iframe/redirect.
- **Card Security**: Card data is collected directly by 3thix via their hosted payment page (iframe). No card data touches our servers.
- **Integration Types**: 
  - `iframe`: Payment form is embedded in your page. Listen for `postMessage` events for completion.
  - `url`: User is redirected to 3thix payment page. Requires `success_url` and `cancel_url`.
- **Crypto Admin Endpoint**: Use `POST /api/admin/crypto/confirm` with `x-admin-token` header to confirm crypto payments.

