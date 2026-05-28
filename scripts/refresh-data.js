/**
 * refresh-data.js — Complete dashboard refresh (May 28, 2026)
 * Fetches from Xero API + Google Sheets, writes public/data.json
 */

const fs = require("node:fs");
const path = require("node:path");

const OUTPUT_PATH = path.join(__dirname, "..", "public", "data.json");

// ==================== AUTH ====================
async function getAccessToken() {
  console.log("🔑 Authenticating with Xero...");

  const refreshToken = process.env.XERO_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("XERO_REFRESH_TOKEN is missing in environment variables");
  }

  const basic = Buffer.from(
    `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("❌ Token refresh failed:", res.status, errorText);
    console.log(
      "\n💡 ACTION REQUIRED: Generate a new refresh token with auth-init.js and update XERO_REFRESH_TOKEN in Netlify."
    );
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const tokenData = await res.json();

  if (tokenData.refresh_token && tokenData.refresh_token !== refreshToken) {
    console.log("\n🔄 NEW REFRESH TOKEN GENERATED:");
    console.log(tokenData.refresh_token);
    console.log(
      "→ Copy this and update XERO_REFRESH_TOKEN in Netlify Environment Variables.\n"
    );
  }

  console.log("✅ Successfully got Xero access token");
  return tokenData.access_token;
}

// ==================== XERO GET ====================
async function xeroGet(accessToken, endpoint, query = {}, attempt = 1) {
  const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint}`);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "xero-tenant-id": process.env.XERO_TENANT_ID,
        Accept: "application/json",
      },
    });

    if (res.status === 429 && attempt <= 5) {
      const wait = 1000 * Math.pow(2, attempt - 1);
      console.warn(`Rate limit — waiting ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
      return xeroGet(accessToken, endpoint, query, attempt + 1);
    }

    if (!res.ok) throw new Error(`Xero API error ${res.status} on ${endpoint}`);
    return res.json();
  } catch (err) {
    if (String(err).includes("429") && attempt <= 5) {
      await new Promise((r) =>
        setTimeout(r, 1000 * Math.pow(2, attempt - 1))
      );
      return xeroGet(accessToken, endpoint, query, attempt + 1);
    }
    throw err;
  }
}

// ==================== GOOGLE SHEETS BUDGET ====================
async function fetchBudget() {
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_API_KEY) {
    console.warn("⚠️ Google Sheet not configured — budget will be zero");
    return { revenue: 0, wages: 0, expenses: 0, net: 0, monthly: [] };
  }

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/Sheet1!A1:O100?key=${process.env.GOOGLE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const rows = data.values || [];

    let revenue = 0,
      wages = 0,
      expenses = 0;
    const monthly = Array.from({ length: 12 }, () => ({
      budget_revenue: 0,
      budget_wages: 0,
      budget_expenses: 0,
    }));

    rows.forEach((row) => {
      if (!row || !row[0]) return;
      const label = String(row[0]).trim().toLowerCase();
      const total = Number(row[14]) || 0; // Column O = FY Total

      if (label.includes("revenue")) {
        revenue = total;
        for (let i = 0; i < 12; i++)
          monthly[i].budget_revenue = Number(row[i + 1]) || 0;
      }
      if (label.includes("wages")) {
        wages += total;
        for (let i = 0; i < 12; i++)
          monthly[i].budget_wages += Number(row[i + 1]) || 0;
      }
      if (label.includes("direct expenses") || label.includes("indirect")) {
        expenses += total;
        for (let i = 0; i < 12; i++)
          monthly[i].budget_expenses += Number(row[i + 1]) || 0;
      }
    });

    console.log(
      `✅ Google Sheet budget → Rev: $${revenue} | Wages: $${wages} | Exp: $${expenses}`
    );
    return {
      revenue,
      wages,
      expenses,
      net: revenue - wages - expenses,
      monthly,
    };
  } catch (e) {
    console.warn("⚠️ Google Sheet failed:", e.message);
    return { revenue: 0, wages: 0, expenses: 0, net: 0, monthly: [] };
  }
}

// ==================== DATE HELPERS ====================
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day));
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

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function fyStart(d) {
  const date = new Date(d);
  const year = date.getMonth() >= 6 ? date.getFullYear() : date.getFullYear() - 1;
  return new Date(year, 6, 1);
}

// ==================== TRACKING ====================
function getLineTracking(line, categoryName) {
  if (!line?.Tracking) return null;
  const match = line.Tracking.find((t) => t.Name === categoryName);
  return match ? match.Option : null;
}

function aggregateWeek(invoices, creditNotes) {
  let jobs = invoices.length;
  let revenue = 0;
  const byClient = new Map();
  const byVehicle = new Map();

  for (const inv of invoices) {
    revenue += Number(inv.Total || 0);
    for (const line of inv.LineItems || []) {
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

  const creditTotal = creditNotes.reduce(
    (sum, cn) => sum + Number(cn.Total || 0),
    0
  );
  revenue = Math.max(0, revenue - creditTotal);

  return {
    jobs: Math.max(0, jobs - creditNotes.length),
    revenue: Math.round(revenue * 100) / 100,
    jobs_by_client: Array.from(byClient.values()).sort(
      (a, b) => b.revenue - a.revenue
    ),
    vehicle_use: Array.from(byVehicle.values()).sort(
      (a, b) => b.revenue - a.revenue
    ),
  };
}

// ==================== P&L HELPERS ====================
async function fetchFromPL(accessToken, fromDate, toDate, codes) {
  if (!codes?.length) return 0;
  const data = await xeroGet(accessToken, "Reports/ProfitAndLoss", {
    fromDate,
    toDate,
    standardLayout: "false",
  });
  let total = 0;
  for (const section of data.Reports?.[0]?.Rows || []) {
    for (const row of section.Rows || []) {
      const code = row.Cells?.[0]?.Attributes?.find(
        (a) => a.Id === "account"
      )?.Value;
      const value = Number(row.Cells?.[row.Cells.length - 1]?.Value) || 0;
      if (code && codes.includes(code)) total += value;
    }
  }
  return Math.round(total * 100) / 100;
}

async function fetchMonthPL(accessToken, fromDate, toDate, wageCodes, expenseCodes) {
  const data = await xeroGet(accessToken, "Reports/ProfitAndLoss", {
    fromDate,
    toDate,
    standardLayout: "false",
  });

  let revenue = 0,
    wages = 0,
    expenses = 0;

  for (const section of data.Reports?.[0]?.Rows || []) {
    const title = (section.Title || "").toLowerCase();
    const isIncome = title.includes("income") || title.includes("revenue");

    for (const row of section.Rows || []) {
      const code = row.Cells?.[0]?.Attributes?.find(
        (a) => a.Id === "account"
      )?.Value;
      const value = Number(row.Cells?.[row.Cells.length - 1]?.Value) || 0;

      if (isIncome && row.RowType !== "SummaryRow") revenue += value;
      if (code && wageCodes.includes(code)) wages += value;
      if (code && expenseCodes.includes(code)) expenses += value;
    }
  }

  return {
    revenue: Math.round(revenue),
    wages: Math.round(wages),
    expenses: Math.round(expenses),
  };
}

// ==================== AGED RECEIVABLES ====================
async function fetchAgedReceivables(accessToken) {
  try {
    const data = await xeroGet(
      accessToken,
      "Reports/AgedReceivablesByContact"
    );
    const report = data.Reports?.[0];
    if (!report)
      return {
        current: 0,
        "1_30": 0,
        "31_60": 0,
        "61_90": 0,
        over_90: 0,
        total: 0,
      };

    const summaryRow = (report.Rows || []).find(
      (r) => r.RowType === "SummaryRow"
    );
    if (!summaryRow?.Cells)
      return {
        current: 0,
        "1_30": 0,
        "31_60": 0,
        "61_90": 0,
        over_90: 0,
        total: 0,
      };

    const cells = summaryRow.Cells;
    const current = Number(cells[1]?.Value) || 0;
    const d1_30 = Number(cells[2]?.Value) || 0;
    const d31_60 = Number(cells[3]?.Value) || 0;
    const d61_90 = Number(cells[4]?.Value) || 0;
    const over_90 = Number(cells[5]?.Value) || 0;
    const total = Number(cells[6]?.Value) || current + d1_30 + d31_60 + d61_90 + over_90;

    console.log(`✅ Aged receivables total: $${total}`);
    return { current, "1_30": d1_30, "31_60": d31_60, "61_90": d61_90, over_90, total };
  } catch (e) {
    console.warn("⚠️ Aged receivables fetch failed:", e.message);
    return { current: 0, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0, total: 0 };
  }
}

// ==================== MONTHLY TREND ====================
async function fetchMonthlyTrend(accessToken, wageCodes, expenseCodes) {
  const now = new Date();
  const fy = fyStart(now);
  const months = [];

  let d = new Date(fy);
  while (d <= now) {
    const year = d.getFullYear();
    const month = d.getMonth();
    months.push({
      start: iso(new Date(year, month, 1)),
      end: iso(new Date(year, month + 1, 0)),
      label: `${year}-${String(month + 1).padStart(2, "0")}`,
    });
    d = new Date(year, month + 1, 1);
  }

  console.log(`📊 Fetching P&L for ${months.length} months...`);

  const BATCH_SIZE = 3;
  const results = [];
  for (let i = 0; i < months.length; i += BATCH_SIZE) {
    const batch = months.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map((m) =>
        fetchMonthPL(accessToken, m.start, m.end, wageCodes, expenseCodes)
      )
    );
    results.push(...batchResults);
  }

  console.log("✅ Monthly trend loaded");
  return months.map((m, i) => ({
    month: m.label,
    revenue: results[i].revenue,
    budget_revenue: 0,
    wages: results[i].wages,
    expenses: results[i].expenses,
  }));
}

// ==================== PAGINATED FETCH ====================
async function fetchAllPaginated(accessToken, endpoint, key, dateFrom, dateTo) {
  const all = [];
  let page = 1;
  while (true) {
    const data = await xeroGet(accessToken, endpoint, {
      DateFrom: dateFrom,
      DateTo: dateTo,
      page,
    });
    const batch = data[key] || [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// ==================== MAIN ====================
async function main() {
  console.log("🚀 Starting dashboard refresh...");

  if (
    !process.env.XERO_REFRESH_TOKEN ||
    !process.env.XERO_CLIENT_ID ||
    !process.env.XERO_CLIENT_SECRET ||
    !process.env.XERO_TENANT_ID
  ) {
    console.log(
      "⚠️ Xero credentials not configured — skipping refresh, keeping existing data.json"
    );
    process.exit(0);
  }

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (err) {
    console.warn(
      "⚠️ Xero authentication failed — keeping existing data.json"
    );
    console.warn("  Reason:", err.message);
    process.exit(0);
  }

  const now = new Date();
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(now);

  const priorWeekEnd = new Date(weekStart);
  priorWeekEnd.setDate(priorWeekEnd.getDate() - 1);
  const priorWeekStart = startOfWeek(priorWeekEnd);

  const ytdStartDate = fyStart(now);

  console.log(`📅 Week: ${iso(weekStart)} — ${iso(weekEnd)}`);
  console.log(`📅 Prior: ${iso(priorWeekStart)} — ${iso(priorWeekEnd)}`);
  console.log(`📅 FY start: ${iso(ytdStartDate)}`);

  // Phase 1: fetch invoices + credit notes for this week and prior week
  const [thisWeekInv, thisWeekCN, priorWeekInv, priorWeekCN] =
    await Promise.all([
      fetchAllPaginated(accessToken, "Invoices", "Invoices", iso(weekStart), iso(weekEnd)),
      fetchAllPaginated(accessToken, "CreditNotes", "CreditNotes", iso(weekStart), iso(weekEnd)),
      fetchAllPaginated(accessToken, "Invoices", "Invoices", iso(priorWeekStart), iso(priorWeekEnd)),
      fetchAllPaginated(accessToken, "CreditNotes", "CreditNotes", iso(priorWeekStart), iso(priorWeekEnd)),
    ]);

  console.log(
    `✅ Invoices: ${thisWeekInv.length} this week, ${priorWeekInv.length} prior week`
  );

  const thisWeek = aggregateWeek(thisWeekInv, thisWeekCN);
  const priorWeek = aggregateWeek(priorWeekInv, priorWeekCN);

  // Phase 2: budget from Google Sheets
  const budget = await fetchBudget();

  const wageCodes = (process.env.WAGE_ACCOUNT_CODES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const expenseCodes = (process.env.EXPENSE_ACCOUNT_CODES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Phase 3: P&L for this week + prior week + aged receivables
  const [wages, expenses, priorWages, priorExpenses, agedReceivables] =
    await Promise.all([
      fetchFromPL(accessToken, iso(weekStart), iso(weekEnd), wageCodes),
      fetchFromPL(accessToken, iso(weekStart), iso(weekEnd), expenseCodes),
      fetchFromPL(accessToken, iso(priorWeekStart), iso(priorWeekEnd), wageCodes),
      fetchFromPL(accessToken, iso(priorWeekStart), iso(priorWeekEnd), expenseCodes),
      fetchAgedReceivables(accessToken),
    ]);

  // Phase 4: monthly trend (batched sequential to respect rate limits)
  const monthlyTrend = await fetchMonthlyTrend(
    accessToken,
    wageCodes,
    expenseCodes
  );

  // Merge budget monthly data into trend if available
  if (budget.monthly.length) {
    monthlyTrend.forEach((m, i) => {
      if (budget.monthly[i]) {
        m.budget_revenue = budget.monthly[i].budget_revenue;
      }
    });
  }

  // Compute YTD from monthly trend
  const ytdRevenue = monthlyTrend.reduce((s, m) => s + m.revenue, 0);
  const ytdWages = monthlyTrend.reduce((s, m) => s + m.wages, 0);
  const ytdExpenses = monthlyTrend.reduce((s, m) => s + m.expenses, 0);

  const output = {
    _meta: {
      generated_at: new Date().toISOString(),
      data_source: "LIVE — Xero + Google Sheets",
      week_start: iso(weekStart),
      week_end: iso(weekEnd),
      prior_week_start: iso(priorWeekStart),
      prior_week_end: iso(priorWeekEnd),
      ytd_start: iso(ytdStartDate),
      currency: "AUD",
      timezone: "Australia/Sydney",
    },
    week: {
      jobs_total: thisWeek.jobs,
      jobs_prior_week: priorWeek.jobs,
      revenue: thisWeek.revenue,
      revenue_prior_week: priorWeek.revenue,
      wages,
      wages_prior_week: priorWages,
      expenses,
      expenses_prior_week: priorExpenses,
      gross_margin: Math.round(thisWeek.revenue - wages - expenses),
      avg_revenue_per_job: thisWeek.jobs
        ? Math.round((thisWeek.revenue / thisWeek.jobs) * 100) / 100
        : 0,
      aged_receivables: agedReceivables,
    },
    jobs_by_client: thisWeek.jobs_by_client,
    vehicle_use: thisWeek.vehicle_use,
    ytd: {
      revenue_actual: ytdRevenue,
      revenue_budget: budget.revenue,
      wages_actual: ytdWages,
      wages_budget: budget.wages,
      expenses_actual: ytdExpenses,
      expenses_budget: budget.expenses,
      net_actual: Math.round(ytdRevenue - ytdWages - ytdExpenses),
      net_budget: budget.net,
      months_elapsed: monthlyTrend.length,
      months_in_year: 12,
    },
    monthly_trend: monthlyTrend,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(
    `✅ SUCCESS — Jobs: ${thisWeek.jobs} | Revenue: $${thisWeek.revenue} | YTD Revenue: $${ytdRevenue}`
  );
}

main().catch((err) => {
  console.error("🔥 ERROR:", err.message);
  process.exit(1);
});
