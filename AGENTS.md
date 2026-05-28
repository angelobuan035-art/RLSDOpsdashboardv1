# AGENTS.md — Riverstone Logistics Dashboard

## Project Architecture

This is a static-site dashboard hosted on Netlify. There is no frontend framework — `public/index.html` is a single HTML file with inline CSS and JavaScript that reads from `public/data.json`.

### Directory Structure

```
├── public/
│   ├── index.html          # Dashboard UI (single file, inline JS/CSS, Chart.js via CDN)
│   ├── data.json           # Data file — overwritten by refresh script on every build
│   └── 404.html            # Custom 404 page
├── scripts/
│   ├── refresh-data.js     # Build command — fetches from Xero API + Google Sheets, writes data.json
│   └── auth-init.js        # One-time local script — seeds Xero OAuth refresh token
├── netlify/
│   └── functions/
│       ├── scheduled-refresh.js   # Daily cron — triggers build via hook
│       ├── xero-auth-start.js     # OAuth start redirect
│       └── xero-auth-callback.js  # OAuth callback handler
├── netlify.toml            # Build config, function schedule, redirects, headers
└── package.json
```

### Data Flow

1. **Build time**: `node scripts/refresh-data.js` runs as the Netlify build command. It authenticates with Xero, fetches invoices/credit notes/P&L/aged receivables for the current week, reads budget data from Google Sheets, and writes `public/data.json`.
2. **Runtime**: `index.html` fetches `data.json` client-side and renders KPIs, Chart.js charts, and tables.
3. **Daily refresh**: The `scheduled-refresh` function fires at 20:00 UTC (06:00 AEST) and POSTs to the build hook, triggering a fresh deploy.

### Key Conventions

- All Xero API calls go through the `xeroGet()` helper in `refresh-data.js`, which handles rate limiting with exponential backoff.
- Tracking categories "Client Sector" and "Vehicle" on invoice line items drive the per-client and per-vehicle breakdowns.
- Wage and expense totals come from P&L report filtering by account codes (env vars `WAGE_ACCOUNT_CODES` and `EXPENSE_ACCOUNT_CODES`).
- The `data.json` in the repo contains sample data so the dashboard renders without live credentials. The "Sample data" badge appears when `_meta.data_source` contains "sample".

### Non-Obvious Decisions

- The build command is `node scripts/refresh-data.js` (not a typical static site generator). If credentials are missing, the build fails and the existing deployed `data.json` remains.
- `node_bundler = "esbuild"` is set in `netlify.toml` for faster function bundling.
- The scheduled function only triggers a build hook (it does not fetch data itself) because the data refresh needs to write to `public/data.json` at build time.
- `Cache-Control: no-cache` is set on `data.json` to ensure browsers always fetch fresh data after a deploy.
- CSP headers allow connections to `api.xero.com` and `identity.xero.com` for the auth flow.
