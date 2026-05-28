// netlify/functions/xero-auth-start.js
const crypto = require("node:crypto");

exports.handler = async (event) => {
  const clientId = process.env.XERO_CLIENT_ID;
  const redirectUri = process.env.XERO_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "text/html" },
      body: `<h2>Missing environment variables</h2><p>XERO_CLIENT_ID and XERO_REDIRECT_URI must be set.</p>`,
    };
  }

  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);

  // ✅ Correct scopes (matching what worked locally)
  const scopes = [
    "offline_access",
    "accounting.invoices.read",
    "accounting.contacts.read",
    "accounting.settings.read",
    "accounting.reports.profitandloss.read"
  ].join(" ");

  authUrl.searchParams.set("scope", scopes);

  return {
    statusCode: 302,
    headers: {
      Location: authUrl.toString(),
      "Set-Cookie": `xero_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`,
    },
    body: "",
  };
};