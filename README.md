# Riverstone Logistics — Operations Dashboard

Internal weekly operations dashboard for Riverstone Logistics. Pulls live data from Xero (invoices, payroll via P&L, aged receivables) and a Google Sheet budget, then renders a static HTML dashboard hosted on Netlify.

## Key Technologies

- **Xero API** — invoices, credit notes, P&L reports, aged receivables
- **Google Sheets API** — budget data
- **Netlify Functions** — Xero OAuth flow and daily scheduled refresh
- **Chart.js** — client/vehicle charts and monthly trend visualization
- **Static HTML** — single-file dashboard, no framework

## How It Works

1. `scripts/refresh-data.js` runs at build time, authenticating with Xero and fetching weekly invoices, wages, expenses, and aged receivables. It also reads budget data from Google Sheets. The output is written to `public/data.json`.
2. `public/index.html` loads `data.json` on page load and renders KPIs, charts, and tables.
3. A Netlify Scheduled Function (`netlify/functions/scheduled-refresh.js`) triggers a daily redeploy via a build hook so the data stays fresh.
4. Xero OAuth functions handle token acquisition and refresh.

## Running Locally

1. Clone the repo.
2. Copy `.env.example` to `.env` and fill in the required values (see Environment Variables below).
3. Run `npm install` to install dependencies.
4. Run `node scripts/refresh-data.js` to pull live data into `public/data.json`.
5. Run `npx serve public` to preview the dashboard at `http://localhost:3000`.

## Environment Variables

All variables must be set in Netlify (Site settings > Environment variables):

| Variable | Description |
|---|---|
| `XERO_CLIENT_ID` | Xero Developer App client ID |
| `XERO_CLIENT_SECRET` | Xero Developer App client secret |
| `XERO_REFRESH_TOKEN` | Obtained via `scripts/auth-init.js` |
| `XERO_TENANT_ID` | Obtained via `scripts/auth-init.js` |
| `XERO_REDIRECT_URI` | `https://<site>.netlify.app/auth/callback` |
| `EXPENSE_ACCOUNT_CODES` | Comma-separated Xero account codes for operating expenses |
| `WAGE_ACCOUNT_CODES` | Comma-separated Xero account codes for wages |
| `FY_START` | Financial year start date (e.g. `2025-07-01`) |
| `GOOGLE_SHEET_ID` | Google Sheet ID from the sheet URL |
| `GOOGLE_API_KEY` | Google Cloud API key with Sheets API enabled |
| `NETLIFY_BUILD_HOOK_URL` | Build hook URL created in Netlify dashboard |
| `NODE_VERSION` | Node.js version (20 or higher) |

## Initial Setup

1. Run `node scripts/auth-init.js` locally to complete Xero OAuth and obtain the refresh token and tenant ID.
2. Create a Build Hook in the Netlify dashboard and set the URL as `NETLIFY_BUILD_HOOK_URL`.
3. Ensure the Google Sheet is shared with "Anyone with the link" as Viewer.
4. Deploy — the first build will pull live data automatically.
