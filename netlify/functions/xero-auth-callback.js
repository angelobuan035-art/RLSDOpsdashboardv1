/**
 * xero-auth-callback.js
 */

exports.handler = async (event) => {
  console.log("Callback received with params:", event.queryStringParameters);

  const clientId = env("XERO_CLIENT_ID");
  const clientSecret = env("XERO_CLIENT_SECRET");
  const redirectUri = env("XERO_REDIRECT_URI") || getDefaultRedirectUri(event);

  if (!clientId || !clientSecret || !redirectUri) {
    return errorPage("Missing environment variables",
      "XERO_CLIENT_ID, XERO_CLIENT_SECRET and XERO_REDIRECT_URI must be set in Netlify.");
  }

  const params = event.queryStringParameters || {};

  if (params.error) {
    return errorPage("Xero returned an error",
      `<code>${params.error}</code>: ${params.error_description || ""}`);
  }

  if (!params.code) {
    return errorPage("Missing authorisation code",
      "No <code>code</code> parameter found in the callback URL.");
  }

  // Validate state (CSRF protection)
  const cookies = parseCookies(event.headers.cookie || event.headers.Cookie || "");
  const expectedState = cookies.xero_oauth_state;
  console.log("Expected state:", expectedState, "| Received state:", params.state);

  if (!expectedState || expectedState !== params.state) {
    return errorPage("State mismatch",
      "CSRF check failed. Please try again at <a href='/auth/start'>/auth/start</a>.");
  }

  // Exchange code for tokens
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  let tokenData;
  try {
    const tokenRes = await fetch("https://identity.xero.com/connect/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.code,
        redirect_uri: redirectUri,
      }),
    });

    const bodyText = await tokenRes.text();
    if (!tokenRes.ok) {
      console.error("Token exchange failed:", bodyText);
      return errorPage("Token exchange failed", `Xero responded with ${tokenRes.status}: <code>${bodyText}</code>`);
    }

    tokenData = JSON.parse(bodyText);
  } catch (err) {
    return errorPage("Network error", `Failed to reach Xero token endpoint: ${err.message}`);
  }

  // Fetch connected tenants
  let tenants = [];
  try {
    const tenantsRes = await fetch("https://api.xero.com/connections", {
      headers: { "Authorization": `Bearer ${tokenData.access_token}` },
    });
    tenants = await tenantsRes.json();
  } catch (e) {
    console.warn("Could not fetch tenants:", e.message);
  }

  const primaryTenantId = tenants[0]?.tenantId || "(unknown — check list below)";

  const tenantList = tenants.map(t =>
    `<li><strong>${t.tenantName || t.tenantId}</strong> — <code>${t.tenantId}</code></li>`
  ).join("\n");

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/html",
      "Set-Cookie": "xero_oauth_state=; Max-Age=0; Path=/",
    },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Xero Auth Complete</title>
  <style>
    body { font-family: sans-serif; max-width: 700px; margin: 40px auto; padding: 0 20px; color: #222; }
    h1 { color: #2E7D52; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; word-break: break-all; font-size: 0.9em; }
    .box { background: #f8f8f8; border: 1px solid #ddd; border-radius: 6px; padding: 16px; margin: 16px 0; }
    .box h3 { margin-top: 0; }
  </style>
</head>
<body>
  <h1>&#10003; Xero Authorisation Complete</h1>
  <p>Copy the values below into your Netlify environment variables, then trigger a new deploy.</p>

  <div class="box">
    <h3>XERO_REFRESH_TOKEN</h3>
    <code>${tokenData.refresh_token}</code>
  </div>

  <div class="box">
    <h3>XERO_TENANT_ID (primary tenant)</h3>
    <code>${primaryTenantId}</code>
  </div>

  ${tenants.length > 1 ? `<div class="box"><h3>All connected tenants</h3><ul>${tenantList}</ul></div>` : ""}

  <h3>Next steps</h3>
  <ol>
    <li>In the Netlify dashboard &rarr; <em>Site configuration &rarr; Environment variables</em>, add or update:
      <ul><li><code>XERO_REFRESH_TOKEN</code></li><li><code>XERO_TENANT_ID</code></li></ul>
    </li>
    <li>Also add <code>XERO_CLIENT_SECRET</code> if not already present.</li>
    <li>Trigger a new deploy (<em>Deploys &rarr; Trigger deploy &rarr; Clear cache and deploy site</em>) to pull live data.</li>
  </ol>
</body>
</html>`,
  };
};

// ---------- Helpers ----------

function env(name) {
  return process.env[name] || "";
}

function getDefaultRedirectUri(event) {
  const host = event.headers.host || event.headers.Host || "";
  const proto = event.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}/auth/callback`;
}

function parseCookies(cookieHeader) {
  const result = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try { result[key] = decodeURIComponent(val); } catch { result[key] = val; }
  }
  return result;
}

function errorPage(title, message) {
  return {
    statusCode: 400,
    headers: { "Content-Type": "text/html" },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Error — ${title}</title>
  <style>
    body { font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; }
    h1 { color: #B5403A; }
  </style>
</head>
<body>
  <h1>&#10007; ${title}</h1>
  <p>${message}</p>
  <p><a href="/auth/start">Try again</a></p>
</body>
</html>`,
  };
}
