/**
 * refresh-data.js
 * Fetches weekly + YTD data from Xero and budget from Google Sheets.
 * After a successful token refresh, updates the XERO_REFRESH_TOKEN env var
 * in Netlify so the next build doesn't fail with a stale token.
 */

const fs = require("node:fs");
const path = require("node:path");

const OUTPUT_PATH = path.join(__dirname, "..", "public", "data.json");

// ==================== TOKEN ROTATION ====================
// After a successful Xero token refresh, write the NEW refresh token back to
// Netlify's environment variables so the next build uses the rotated token.
async function persistNewRefreshToken(newRefreshToken) {
  const siteId = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const apiToken = process.env.NETLIFY_API_TOKEN;

  if (!siteId || !apiToken) {
    console.warn("⚠️  NETLIFY_API_TOKEN or SITE_ID not set — cannot persist rotated refresh token.");
    console.warn("    Add these to Netlify env vars to enable automatic token rotation.");
    return;
  }

  try {
    const res = await fetch(
      `https://api.netlify.com/api/v1/sites/${siteId}/env/XERO_REFRESH_TOKEN`,
      {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: newRefreshToken }),
      }
    );
    if (res.ok) {
      console.log("✅ Rotated XERO_REFRESH_TOKEN saved to Netlify env vars");
    } else {
      const body = await res.text();
      console.warn("⚠️  Failed to persist refresh token:", res.status, body);
    }
  } catch (err) {
    console.warn("⚠️  Error persisting refresh token:", err.message);
  }
}

// ==================== AUTH ====================
async function getAccessToken() {
  console.log("🔑 Authenticating with Xero...");
  const refreshToken = process.env.XERO_REFRESH_TOKEN;

  if (!refreshToken || !process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_TENANT_ID) {
    throw new Error("Missing Xero credentials");
  }

  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} — ${body}`);
  }

  const token = await res.json();
  console.log("✅ Got Xero access token");

  // Persist the rotated token so next build doesn't fail
  if (token.refresh_token && token.refresh_token !== refreshToken) {
    await persistNewRefreshToken(token.refresh_token);
  }

  return token.access_token;
}

// ==================== XERO GET ====================
async function xeroGet(accessToken, endpoint, query = {}, attempt = 1) {
  const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint}`);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "xero-tenant-id": process.env.XERO_TENANT_ID,
      "Accept": "application/json",
    },
  });

  if (res.status === 429 && attempt <= 5) {
    const waitMs = 1500 * Math.pow(2, attempt - 1);
    console.warn(`⚠️  Rate limited — waiting ${waitMs}ms (attempt ${attempt})`);
    await new Promise(r => setTimeout(r, waitMs));
    return xeroGet(accessToken, endpoint, query, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Xero ${endpoint} failed: ${res.status} — ${body}`);
  }
  return res.json();
}

// ==================== DATE HELPERS ====================
function toAEST(d) {
  // Returns a Date adjusted to Australia/Sydney (UTC+10 standard, +11 DST)
  // We use a simple offset approach: parse the ISO string in Sydney timezone
  return new Date(d.toLocaleString("en-AU", { timeZone: "Australia/Sydney" }));
}

function startOfWeek(d) {
  const local = toAEST(d);
  const day = local.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday-based week
  local.setDate(local.getDate() + diff);
  local.setHours(0, 0, 0, 0);
  return local;
}

function endOfWeek(d) {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}

function iso(d) {
  // Returns YYYY-MM-DD from a local Date object
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// ==================== INVOICE FETCH ====================
async function fetchInvoices(accessToken, dateFrom, dateTo) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await xeroGet(accessToken, "Invoices", {
      DateFrom: iso(dateFrom),
      DateTo: iso(dateTo),
      Statuses: "AUTHORISED,PAID",  // exclude DRAFT, VOIDED, DELETED
      page,
    });
    const batch = data.Invoices || [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

async function fetchCreditNotes(accessToken, dateFrom, dateTo) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await xeroGet(accessToken, "CreditNotes", {
      DateFrom: iso(dateFrom),
      DateTo: iso(dateTo),
      Statuses: "AUTHORISED,PAID",
      page,
    });
    const batch = data.CreditNotes || [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// ==================== TRACKING ====================
function getLineTracking(line, categoryName) {
  if (!line?.Tracking) return null;
  const match = line.Tracking.find(t => t.Name === categoryName);
  return match ? match.Option : null;
}

// ==================== WEEK AGGREGATION ====================
function aggregateWeek(invoices, creditNotes) {
  let revenue = 0;
  const byClient = new Map();
  const byVehicle = new Map();

  for (const inv of invoices) {
    revenue += Number(inv.Total || 0);
    for (const line of (inv.LineItems || [])) {
      const client = getLineTracking(line, "Client Sector") || "Other";
      const vehicle = getLineTracking(line, "Vehicle") || "Other / Sub";
      const amount = Number(line.LineAmount || 0);

      const c = byClient.get(client) || { sector: client, jobs: 0, revenue: 0 };
      c.jobs += 1;
      c.revenue += amount;
      byClient.set(client, c);

      const v = byVehicle.get(vehicle) || { vehicle, jobs: 0, revenue: 0 };
      v.jobs += 1;
      v.revenue += amount;
      byVehicle.set(vehicle, v);
    }
  }

  const creditTotal = creditNotes.reduce((sum, cn) => sum + Number(cn.Total || 0), 0);
  revenue = Math.max(0, revenue - creditTotal);
  const jobs = Math.max(0, invoices.length - creditNotes.length);

  return {
    jobs,
    revenue: Math.round(revenue * 100) / 100,
    jobs_by_client: Array.from(byClient.values()).sort((a, b) => b.revenue - a.revenue),
    vehicle_use: Array.from(byVehicle.values()).sort((a, b) => b.revenue - a.revenue),
  };
}

// ==================== P&L FETCH ====================
async function fetchFromPL(accessToken, fromDate, toDate, codes) {
  if (!codes?.length) return 0;

  const data = await xeroGet(accessToken, "Reports/ProfitAndLoss", {
    fromDate: iso(fromDate),
    toDate: iso(toDate),
    standardLayout: "false",
  });

  let total = 0;
  const codesSet = new Set(codes.map(c => c.trim().toUpperCase()));

  for (const section of (data.Reports?.[0]?.Rows || [])) {
    for (const row of (section.Rows || [])) {
      const accountCell = row.Cells?.[0];
      const amountCell = row.Cells?.[row.Cells.length - 1];
      if (!accountCell || !amountCell) continue;

      // Try matching by account code attribute first, then by cell value text
      const code = accountCell.Attributes?.find(a =>
        a.Id === "account" || a.Id === "accountCode"
      )?.Value?.toUpperCase();

      if (code && codesSet.has(code)) {
        const val = Number(amountCell.Value) || 0;
        total += val;
      }
    }
  }
  return Math.round(total * 100) / 100;
}

// ==================== AGED RECEIVABLES ====================
async function fetchAgedReceivables(accessToken) {
  try {
    const data = await xeroGet(accessToken, "Reports/AgedReceivablesByContact", {
      date: iso(toAEST(new Date())),
    });

    let current = 0, d1_30 = 0, d31_60 = 0, d61_90 = 0, over90 = 0;

    for (const section of (data.Reports?.[0]?.Rows || [])) {
      for (const row of (section.Rows || [])) {
        const cells = row.Cells || [];
        if (cells.length < 6) continue;
        // Columns: Name, Current, 1-30, 31-60, 61-90, 91+, Total
        const parseCell = (idx) => {
          const val = cells[idx]?.Value;
          return val ? (Number(val.replace(/,/g, "")) || 0) : 0;
        };
        current += parseCell(1);
        d1_30   += parseCell(2);
        d31_60  += parseCell(3);
        d61_90  += parseCell(4);
        over90  += parseCell(5);
      }
    }

    const total = current + d1_30 + d31_60 + d61_90 + over90;
    return {
      current:  Math.round(current * 100) / 100,
      "1_30":   Math.round(d1_30   * 100) / 100,
      "31_60":  Math.round(d31_60  * 100) / 100,
      "61_90":  Math.round(d61_90  * 100) / 100,
      over_90:  Math.round(over90  * 100) / 100,
      total:    Math.round(total   * 100) / 100,
    };
  } catch (err) {
    console.warn("⚠️  Aged receivables fetch failed:", err.message);
    return { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 };
  }
}

// ==================== MONTHLY TREND ====================
async function fetchMonthlyTrend(accessToken, fyStart) {
  const now = toAEST(new Date());
  const start = new Date(fyStart);
  const months = [];

  // Build list of months from FY start up to current month
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  const endMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  while (cur <= endMonth) {
    months.push(new Date(cur));
    cur.setMonth(cur.getMonth() + 1);
  }

  const wageCodes = (process.env.WAGE_ACCOUNT_CODES || "").split(",").map(s => s.trim()).filter(Boolean);
  const expenseCodes = (process.env.EXPENSE_ACCOUNT_CODES || "").split(",").map(s => s.trim()).filter(Boolean);

  const trend = [];
  for (const monthStart of months) {
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0); // last day of month
    const label = iso(monthStart).slice(0, 7); // YYYY-MM

    try {
      const [wages, expenses, invData] = await Promise.all([
        fetchFromPL(accessToken, monthStart, monthEnd, wageCodes),
        fetchFromPL(accessToken, monthStart, monthEnd, expenseCodes),
        fetchInvoices(accessToken, monthStart, monthEnd),
      ]);

      const revenue = invData.reduce((s, inv) => s + Number(inv.Total || 0), 0);
      trend.push({
        month: label,
        revenue: Math.round(revenue),
        budget_revenue: 0, // filled from Google Sheets below
        wages: Math.round(wages),
        expenses: Math.round(expenses),
      });

      // Small delay between months to avoid hammering the API
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.warn(`⚠️  Month ${label} trend failed:`, err.message);
      trend.push({ month: label, revenue: 0, budget_revenue: 0, wages: 0, expenses: 0 });
    }
  }

  return trend;
}

// ==================== GOOGLE SHEETS (BUDGET) ====================
async function fetchBudget() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!sheetId || !apiKey) {
    console.warn("⚠️  Google Sheets not configured — budget will show $0");
    return null;
  }

  try {
    // Read the first sheet — assumes budget data is there
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1?key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text();
      console.warn("⚠️  Google Sheets fetch failed:", res.status, body);
      return null;
    }
    const json = await res.json();
    return json.values || [];
  } catch (err) {
    console.warn("⚠️  Google Sheets error:", err.message);
    return null;
  }
}

/**
 * Parse the budget sheet. Expected layout (row 1 = header):
 *   Month | Revenue Budget | Wages Budget | Expenses Budget
 * Month column: YYYY-MM or Mon-YY or similar
 */
function parseBudget(rows) {
  if (!rows || rows.length < 2) return {};
  const budget = {};
  const header = rows[0].map(h => String(h).toLowerCase().trim());
  const monthIdx = header.findIndex(h => h.includes("month") || h.includes("date"));
  const revIdx   = header.findIndex(h => h.includes("revenue") || h.includes("income"));
  const wageIdx  = header.findIndex(h => h.includes("wage") || h.includes("payroll") || h.includes("labour"));
  const expIdx   = header.findIndex(h => h.includes("expense") || h.includes("opex") || h.includes("cost"));

  if (monthIdx < 0) {
    console.warn("⚠️  Budget sheet: can't find 'month' column in header:", header);
    return {};
  }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rawMonth = String(row[monthIdx] || "").trim();
    if (!rawMonth) continue;

    // Normalise month to YYYY-MM
    let key = null;
    if (/^\d{4}-\d{2}/.test(rawMonth)) {
      key = rawMonth.slice(0, 7);
    } else {
      // Try parsing as a date
      const d = new Date(rawMonth);
      if (!isNaN(d)) key = iso(d).slice(0, 7);
    }
    if (!key) continue;

    const parse = (idx) => idx >= 0 ? (Number(String(row[idx] || "0").replace(/[$,]/g, "")) || 0) : 0;
    budget[key] = {
      revenue: parse(revIdx),
      wages:   parse(wageIdx),
      expenses: parse(expIdx),
    };
  }

  console.log(`✅ Parsed budget for ${Object.keys(budget).length} months`);
  return budget;
}

// ==================== YTD AGGREGATION ====================
function calcYTD(trend, budget) {
  let revenueActual = 0, wagesActual = 0, expensesActual = 0;
  let revenueBudget = 0, wagesBudget = 0, expensesBudget = 0;

  for (const m of trend) {
    revenueActual  += m.revenue;
    wagesActual    += m.wages;
    expensesActual += m.expenses;

    const b = budget[m.month] || {};
    revenueBudget  += b.revenue  || 0;
    wagesBudget    += b.wages    || 0;
    expensesBudget += b.expenses || 0;
  }

  return {
    revenue_actual:  Math.round(revenueActual),
    revenue_budget:  Math.round(revenueBudget),
    wages_actual:    Math.round(wagesActual),
    wages_budget:    Math.round(wagesBudget),
    expenses_actual: Math.round(expensesActual),
    expenses_budget: Math.round(expensesBudget),
    net_actual:      Math.round(revenueActual - wagesActual - expensesActual),
    net_budget:      Math.round(revenueBudget - wagesBudget - expensesBudget),
    months_elapsed:  trend.length,
    months_in_year:  12,
  };
}

// ==================== MAIN ====================
async function main() {
  console.log("🚀 Starting dashboard refresh...");

  if (!process.env.XERO_REFRESH_TOKEN || !process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_TENANT_ID) {
    console.log("⚠️  Xero credentials not configured — skipping refresh, keeping existing data.json");
    process.exit(0);
  }

  const accessToken = await getAccessToken();
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd   = endOfWeek(now);
  const priorWeekStart = addDays(weekStart, -7);
  const priorWeekEnd   = addDays(weekEnd, -7);
  const fyStart = process.env.FY_START || "2025-07-01";

  console.log(`📅 This week:  ${iso(weekStart)} → ${iso(weekEnd)}`);
  console.log(`📅 Prior week: ${iso(priorWeekStart)} → ${iso(priorWeekEnd)}`);

  const wageCodes    = (process.env.WAGE_ACCOUNT_CODES    || "").split(",").map(s => s.trim()).filter(Boolean);
  const expenseCodes = (process.env.EXPENSE_ACCOUNT_CODES || "").split(",").map(s => s.trim()).filter(Boolean);

  // Fetch this week and prior week in parallel
  const [
    thisWeekInv, thisWeekCN,
    priorWeekInv, priorWeekCN,
    wages, expenses,
    priorWages, priorExpenses,
    agedReceivables,
    budgetRows,
  ] = await Promise.all([
    fetchInvoices(accessToken, weekStart, weekEnd),
    fetchCreditNotes(accessToken, weekStart, weekEnd),
    fetchInvoices(accessToken, priorWeekStart, priorWeekEnd),
    fetchCreditNotes(accessToken, priorWeekStart, priorWeekEnd),
    fetchFromPL(accessToken, weekStart, weekEnd, wageCodes),
    fetchFromPL(accessToken, weekStart, weekEnd, expenseCodes),
    fetchFromPL(accessToken, priorWeekStart, priorWeekEnd, wageCodes),
    fetchFromPL(accessToken, priorWeekStart, priorWeekEnd, expenseCodes),
    fetchAgedReceivables(accessToken),
    fetchBudget(),
  ]);

  const thisWeek  = aggregateWeek(thisWeekInv, thisWeekCN);
  const priorWeek = aggregateWeek(priorWeekInv, priorWeekCN);

  // Monthly trend (sequential to avoid rate limits)
  console.log("📊 Fetching monthly trend...");
  const trend = await fetchMonthlyTrend(accessToken, fyStart);

  // Budget
  const budget = parseBudget(budgetRows);

  // Merge budget_revenue into trend
  for (const m of trend) {
    if (budget[m.month]) m.budget_revenue = budget[m.month].revenue || 0;
  }

  const ytd = calcYTD(trend, budget);

  const output = {
    _meta: {
      generated_at:      new Date().toISOString(),
      data_source:       "LIVE — Xero + Google Sheets",
      week_start:        iso(weekStart),
      week_end:          iso(weekEnd),
      prior_week_start:  iso(priorWeekStart),
      prior_week_end:    iso(priorWeekEnd),
      ytd_start:         fyStart,
      currency:          "AUD",
      timezone:          "Australia/Sydney",
    },
    week: {
      jobs_total:           thisWeek.jobs,
      jobs_prior_week:      priorWeek.jobs,
      revenue:              thisWeek.revenue,
      revenue_prior_week:   priorWeek.revenue,
      wages:                wages,
      wages_prior_week:     priorWages,
      expenses:             expenses,
      expenses_prior_week:  priorExpenses,
      gross_margin:         Math.round(thisWeek.revenue - wages - expenses),
      avg_revenue_per_job:  thisWeek.jobs ? Math.round((thisWeek.revenue / thisWeek.jobs) * 100) / 100 : 0,
      aged_receivables:     agedReceivables,
    },
    jobs_by_client: thisWeek.jobs_by_client,
    vehicle_use:    thisWeek.vehicle_use,
    ytd,
    monthly_trend:  trend,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`✅ data.json written`);
  console.log(`   Jobs: ${thisWeek.jobs} | Revenue: $${thisWeek.revenue} | Wages: $${wages} | Expenses: $${expenses}`);
  console.log(`   YTD Revenue: $${ytd.revenue_actual} | YTD Budget: $${ytd.revenue_budget}`);
  console.log(`   AR Total: $${agedReceivables.total}`);
}

main().catch(err => {
  console.error("🔥 ERROR:", err.message);
  if (String(err.message).includes("429")) {
    console.error("Rate limit — build will be retried.");
    process.exit(0);
  }
  process.exit(1);
});
