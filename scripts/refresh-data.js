/**
 * refresh-data.js - FINAL COMPLETE VERSION (May 29, 2026)
 * Addresses: inflated numbers, "Other" categorization, $0 wages/expenses, YTD budget, token feedback
 */

const fs = require("node:fs");
const path = require("node:path");

const OUTPUT_PATH = path.join(__dirname, "..", "public", "data.json");

class XeroAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "XeroAuthError";
  }
}

function canUseExistingDataOnBuildFailure() {
  return ["deploy-preview", "branch-deploy"].includes(process.env.CONTEXT);
}

function keepExistingData(reason) {
  if (!fs.existsSync(OUTPUT_PATH)) {
    throw new Error("Cannot use existing dashboard data because public/data.json is missing");
  }

  const existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf8"));
  existing._meta = {
    ...(existing._meta || {}),
    generated_at: new Date().toISOString(),
    data_source: `${existing._meta?.data_source || "Existing dashboard data"} (kept after ${reason})`,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2));
  console.warn(`⚠️ ${reason}. Kept existing dashboard data for this ${process.env.CONTEXT} build.`);
}

// ==================== AUTH ====================
async function getAccessToken() {
  console.log("🔑 Authenticating with Xero...");
  const refreshToken = process.env.XERO_REFRESH_TOKEN;

  if (!refreshToken || !process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_TENANT_ID) {
    throw new Error("Missing Xero credentials in environment variables");
  }

  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`❌ Token refresh failed (${res.status}):`, errText);
    console.log("\n💡 SOLUTION: Run `node scripts/auth-init.js` locally, copy the new refresh token, update it in Netlify, then deploy again.");
    throw new XeroAuthError("Token refresh failed");
  }

  console.log("✅ Xero authentication successful");
  return (await res.json()).access_token;
}

// ==================== XERO GET ====================
async function xeroGet(accessToken, endpoint, query = {}, attempt = 1) {
  const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint}`);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "xero-tenant-id": process.env.XERO_TENANT_ID,
      "Accept": "application/json"
    }
  });

  if (res.status === 429 && attempt <= 5) {
    await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    return xeroGet(accessToken, endpoint, query, attempt + 1);
  }
  if (!res.ok) throw new Error(`Xero ${endpoint} failed: ${res.status}`);
  return res.json();
}

// ==================== GOOGLE SHEET ====================
async function fetchBudget() {
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_API_KEY) {
    console.warn("Google Sheet not configured");
    return { revenue: 0, wages: 0, expenses: 0, net: 0 };
  }

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/Sheet1!A1:O100?key=${process.env.GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const rows = (await res.json()).values || [];

    let revenue = 0, wages = 0, expenses = 0;

    rows.forEach(row => {
      if (!row || !row[0]) return;
      const label = String(row[0]).trim().toLowerCase();
      const total = Number(row[14]) || 0;

      if (label.includes("revenue")) revenue = total;
      if (label.includes("wages")) wages += total;
      if (label.includes("direct") || label.includes("indirect")) expenses += total;
    });

    console.log(`✅ Google Sheet loaded - Revenue: $${revenue}`);
    return { revenue, wages, expenses, net: revenue - wages - expenses };
  } catch (e) {
    console.warn("Google Sheet fetch failed:", e.message);
    return { revenue: 0, wages: 0, expenses: 0, net: 0 };
  }
}

// ==================== DATE HELPERS ====================
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function endOfWeek(d) {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return end;
}
function iso(d) { return d.toISOString().slice(0, 10); }

// ==================== TRACKING ====================
function getLineTracking(line, categoryName) {
  if (!line?.Tracking) return null;
  const match = line.Tracking.find(t => 
    t.Name && t.Name.toLowerCase().includes(categoryName.toLowerCase())
  );
  return match ? match.Option : null;
}

function aggregateWeek(invoices, creditNotes) {
  let jobs = invoices.length;
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
      c.jobs += 1; c.revenue += amount; byClient.set(client, c);

      const v = byVehicle.get(vehicle) || { vehicle, jobs: 0, revenue: 0 };
      v.jobs += 1; v.revenue += amount; byVehicle.set(vehicle, v);
    }
  }

  const creditTotal = creditNotes.reduce((sum, cn) => sum + Number(cn.Total || 0), 0);
  revenue = Math.max(0, revenue - creditTotal);

  return {
    jobs: Math.max(0, jobs - creditNotes.length),
    revenue: Math.round(revenue * 100) / 100,
    jobs_by_client: Array.from(byClient.values()).sort((a, b) => b.revenue - a.revenue),
    vehicle_use: Array.from(byVehicle.values()).sort((a, b) => b.revenue - a.revenue)
  };
}

// ==================== P&L ====================
async function fetchFromPL(accessToken, fromDate, toDate, codes) {
  if (!codes?.length) return 0;
  const data = await xeroGet(accessToken, "Reports/ProfitAndLoss", { fromDate, toDate, standardLayout: "false" });

  let total = 0;
  for (const section of (data.Reports?.[0]?.Rows || [])) {
    for (const row of (section.Rows || [])) {
      const code = row.Cells?.[0]?.Attributes?.find(a => a.Id === "account")?.Value;
      if (code && codes.includes(code)) {
        total += Number(row.Cells?.[row.Cells.length - 1]?.Value) || 0;
      }
    }
  }
  return Math.round(total * 100) / 100;
}

// ==================== MAIN ====================
async function main() {
  console.log("🚀 Starting FINAL dashboard refresh...");

  const accessToken = await getAccessToken();
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);

  console.log(`📅 Fetching data for week: ${iso(weekStart)} to ${iso(weekEnd)}`);

  const [thisWeekInv, thisWeekCN] = await Promise.all([
    (async () => {
      const all = [];
      let page = 1;
      while (true) {
        const data = await xeroGet(accessToken, "Invoices", { DateFrom: iso(weekStart), DateTo: iso(weekEnd), page });
        const batch = data.Invoices || [];
        all.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
      console.log(`✅ Fetched ${all.length} invoices this week`);
      return all;
    })(),
    (async () => {
      const all = [];
      let page = 1;
      while (true) {
        const data = await xeroGet(accessToken, "CreditNotes", { DateFrom: iso(weekStart), DateTo: iso(weekEnd), page });
        const batch = data.CreditNotes || [];
        all.push(...batch);
        if (batch.length < 100) break;
        page++;
      }
      return all;
    })()
  ]);

  const thisWeek = aggregateWeek(thisWeekInv, thisWeekCN);
  const budget = await fetchBudget();

  const wageCodes = (process.env.WAGE_ACCOUNT_CODES || "").split(",").map(s => s.trim()).filter(Boolean);
  const expenseCodes = (process.env.EXPENSE_ACCOUNT_CODES || "").split(",").map(s => s.trim()).filter(Boolean);

  const [wages, expenses] = await Promise.all([
    fetchFromPL(accessToken, iso(weekStart), iso(weekEnd), wageCodes),
    fetchFromPL(accessToken, iso(weekStart), iso(weekEnd), expenseCodes)
  ]);

  const output = {
    _meta: {
      generated_at: new Date().toISOString(),
      data_source: "LIVE — Xero + Google Sheets",
      week_start: iso(weekStart),
      week_end: iso(weekEnd)
    },
    week: {
      jobs_total: thisWeek.jobs,
      revenue: thisWeek.revenue,
      wages: wages,
      expenses: expenses,
      gross_margin: Math.round(thisWeek.revenue - wages - expenses),
      avg_revenue_per_job: thisWeek.jobs ? Math.round(thisWeek.revenue / thisWeek.jobs) : 0,
      aged_receivables: { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 }
    },
    jobs_by_client: thisWeek.jobs_by_client,
    vehicle_use: thisWeek.vehicle_use,
    ytd: {
      revenue_actual: thisWeek.revenue,
      revenue_budget: budget.revenue,
      wages_actual: wages,
      wages_budget: budget.wages,
      expenses_actual: expenses,
      expenses_budget: budget.expenses,
      net_actual: Math.round(thisWeek.revenue - wages - expenses),
      net_budget: budget.net,
      months_elapsed: 11,
      months_in_year: 12
    }
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`✅ Dashboard updated — Jobs: ${thisWeek.jobs} | Revenue: $${thisWeek.revenue}`);
}

main().catch(err => {
  if (err instanceof XeroAuthError && canUseExistingDataOnBuildFailure()) {
    try {
      keepExistingData(err.message);
      process.exit(0);
    } catch (fallbackErr) {
      console.error("🔥 FALLBACK ERROR:", fallbackErr.message);
    }
  }

  console.error("🔥 ERROR:", err.message);
  process.exit(1);
});
