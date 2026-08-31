const {
  BOT_TOKEN,
  APPS_SCRIPT_URL,
  SCHOOL_NAME,
  TELEGRAM_API,
  publicBaseUrl,
} = require('../lib/config');
const { cacheStatus } = require('../lib/nfc_gate');

module.exports = function handler(req, res) {
  const cache = cacheStatus();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      ok: true,
      platform: 'vercel',
      service: '@Vipinbellbot NFC webhook',
      school: SCHOOL_NAME,
      botConfigured: Boolean(BOT_TOKEN && TELEGRAM_API),
      appsScriptConfigured: Boolean(APPS_SCRIPT_URL),
      publicBaseUrl: publicBaseUrl() || null,
      cache,
    })
  );
};
