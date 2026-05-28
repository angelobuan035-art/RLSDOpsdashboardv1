/**
 * auth-init.js - Updated for 2026 Xero scopes
 */

require('dotenv').config({ path: '.env' });

const http = require("node:http");
const crypto = require("node:crypto");

console.log("✅ dotenv loaded. Checking environment variables...\n");

if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET || !process.env.XERO_REDIRECT_URI) {
  console.error("❌ ERROR: Missing environment variables in .env file!");
  console.error("Please ensure your .env file contains:");
  console.error("XERO_CLIENT_ID=...");
  console.error("XERO_CLIENT_SECRET=...");
  console.error("XERO_REDIRECT_URI=http://localhost:8080/auth/callback");
  process.exit(1);
}

// ✅ Updated scopes based on Xero Support recommendation (2026)
const SCOPES = [
  "offline_access",
  "accounting.invoices.read",
  "accounting.contacts.read",
  "accounting.settings.read",
  "accounting.reports.profitandloss.read"   // Most important report for your dashboard
].join(" ");

const state = crypto.randomBytes(16).toString("hex");

const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("client_id", process.env.XERO_CLIENT_ID);
authUrl.searchParams.set("redirect_uri", process.env.XERO_REDIRECT_URI);
authUrl.searchParams.set("scope", SCOPES);
authUrl.searchParams.set("state", state);

console.log("===========================================================");
console.log(" RIVERSTONE LOGISTICS — XERO AUTH INITIALISATION");
console.log("===========================================================\n");

console.log("1. Redirect URI:", process.env.XERO_REDIRECT_URI);
console.log("\n2. Open this URL in your browser and authorise the app:\n");
console.log(authUrl.toString() + "\n");
console.log("Waiting for callback on " + process.env.XERO_REDIRECT_URI + " ...");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:8080`);

  if (!url.searchParams.has("code")) {
    res.writeHead(400); 
    return res.end("Missing code");
  }

  if (url.searchParams.get("state") !== state) {
    res.writeHead(400); 
    return res.end("State mismatch");
  }

  const code = url.searchParams.get("code");

  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString("base64");

  const tokenRes = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: process.env.XERO_REDIRECT_URI,
    }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    console.error("Token exchange failed:", body);
    res.writeHead(500);
    return res.end("Token exchange failed");
  }

  const token = await tokenRes.json();

  const tenantsRes = await fetch("https://api.xero.com/connections", {
    headers: { "Authorization": `Bearer ${token.access_token}` },
  });
  const tenants = await tenantsRes.json();

  console.log("\n✅ SUCCESS! COPY THESE VALUES:\n");
  console.log("XERO_REFRESH_TOKEN =", token.refresh_token);
  console.log("XERO_TENANT_ID     =", tenants[0]?.tenantId || "Not found");

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>Authentication successful!</h1><p>Check your terminal for the tokens.</p>");
});

server.listen(8080);