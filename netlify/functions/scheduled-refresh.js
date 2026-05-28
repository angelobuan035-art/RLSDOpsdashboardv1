/**
 * scheduled-refresh.js
 *
 * Netlify Scheduled Function. Triggers a redeploy via the build hook so
 * the data refresh script runs and produces a fresh data.json.
 *
 * Required env var: NETLIFY_BUILD_HOOK_URL
 */

exports.handler = async () => {
  const hook = process.env.NETLIFY_BUILD_HOOK_URL;
  if (!hook) {
    return { statusCode: 500, body: "NETLIFY_BUILD_HOOK_URL not set" };
  }
  try {
    const res = await fetch(hook, { method: "POST" });
    if (!res.ok) {
      return { statusCode: res.status, body: "Build hook failed: " + (await res.text()) };
    }
    return { statusCode: 200, body: "Triggered build at " + new Date().toISOString() };
  } catch (e) {
    return { statusCode: 500, body: "Error: " + e.message };
  }
};
