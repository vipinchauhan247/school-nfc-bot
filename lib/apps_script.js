const { APPS_SCRIPT_URL } = require('./config');

async function appsScriptGet(params, timeoutMs = 25000) {
  if (!APPS_SCRIPT_URL) {
    console.log('[BOT] APPS_SCRIPT_URL missing');
    return null;
  }
  const url = new URL(APPS_SCRIPT_URL);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text.trim(), ok: resp.ok };
    }
  } catch (err) {
    clearTimeout(timer);
    console.error('[BOT] Apps Script error:', err);
    return null;
  }
}

module.exports = { appsScriptGet };
