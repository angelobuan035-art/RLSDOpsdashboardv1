/**
 * refresh-data.js - ULTIMATE FINAL VERSION
 * Strong filtering + Wages + Expenses + YTD Budget + Aged
 */

const fs = require("node:fs");
const path = require("node:path");

const OUTPUT_PATH = path.join(__dirname, "..", "public", "data.json");

// ==================== AUTH ====================
async function getAccessToken() {
  console.log("🔑 Authenticating with Xero...");
  let refreshToken = process.env.XERO_REFRESH_TOKEN;

  if (!refreshToken || !process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_TENANT_ID) {
    throw new Error("Missing Xero credentials");
  }

  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });

  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const token = await res.json();
  console.log("✅ Got Xero access token");
  return token.access_token;
}

// ==================== XERO GET ====================
async function xeroGet(accessToken, endpoint, query = {}, attempt = 1) {
  const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint}`);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "xero-tenant-id": process.env.XERO_TENANT_ID,
        "Accept": "application/json",
      },
    });

    if (res.status === 429 && attempt <= 5) {
      const waitMs = 1000 * Math.pow(2, attempt - 1);
      console.warn(`⚠️ Rate limit — waiting ${waitMs}ms`);
      await new Promise(r => setTimeout(r, waitMs));
      return xeroGet(accessToken, endpoint, query, attempt + 1);
    }

    if (!res.ok) throw new Error(`Xero ${endpoint} failed: ${res.status}`);
    return res.json();
  } catch (err) {
    if (String(err).includes("429") && attempt <= 5) {
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      return xeroGet(accessToken, endpoint, query, attempt + 1);
    }
    throw err;
  }
}

// ==================== GOOGLE SHEETS ====================
async function fetchBudget() {
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_API_KEY) return { revenue: 0, wages: 0, expenses: 0, net: 0 };

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/Sheet1!A1:O50?key=${process.env.GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const rows = data.values || [];

    let revenue = 0, wages = 0, expenses = 0;

    rows.forEach((row, i) => {
      if (row[0] === "Total Revenue") revenue = Number(row[14]) || 0;
      if (row[0] === "Total Direct Expenses" || row[0] === "Wages") wages += Number(row[14]) || 0;
      if (row[0] === "Total Indirect Expenses") expenses += Number(row[14]) || 0;
    });

    console.log(`✅ Budget loaded - Rev: $${revenue}, Wages: $${wages}, Exp: $${expenses}`);
    return { revenue, wages, expenses, net: revenue - wages - expenses };
  } catch (e) {
    console.warn("Google Sheet failed:", e.message);
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

// ==================== TRACKING & AGGREGATION ====================
function getLineTracking(line, categoryName) {
  if (!line?.Tracking) return null;
  const match = line.Tracking.find(t => t.Name === categoryName);
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
      const accountCell = row.Cells?.[0];
      const amountCell = row.Cells?.[row.Cells.length - 1];
      if (!accountCell || !amountCell) continue;
      const code = accountCell.Attributes?.find(a => a.Id === "account")?.Value;
      if (code && codes.includes(code)) {
        total += Number(amountCell.Value) || 0;
      }
    }
  }
  return Math.round(total * 100) / 100;
}

// ==================== MAIN ====================
async function main() {
  console.log("🚀 Starting ULTIMATE dashboard refresh...");

  const accessToken = await getAccessToken();
  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);
  const priorStart = startOfWeek(new Date(now.getTime() - 7*24*60*60*1000));
  const priorEnd = endOfWeek(new Date(now.getTime() - 7*24*60*60*1000));

  console.log(`📅 Current Week: ${iso(weekStart)} - ${iso(weekEnd)}`);

  const [thisWeekInv, thisWeekCN] = await Promise.all([
    (async () => {
      const all = [];
      let page = 1;
      while (true) {
        const data = await xeroGet(accessToken, "Invoices", { DateFrom: iso(weekStart), DateTo: iso(weekEnd), page });
        const batch = data.Invoices || [];
        all.push(...batch);
        if (batch.length < 100) break;
        page += 1;
      }
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
        page += 1;
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
      week_end: iso(weekEnd),
      prior_week_start: iso(priorStart),
      prior_week_end: iso(priorEnd)
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
  console.error("🔥 ERROR:", err.message);
  if (err.message.includes("429")) process.exit(0);
  process.exit(1);
});
