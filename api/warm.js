const { waitUntil } = require('@vercel/functions');
const {
  refreshStudentCache,
  cacheStatus,
  scheduleCacheRefresh,
} = require('../lib/nfc_gate');

module.exports = async function handler(req, res) {
  const forceBg = scheduleCacheRefresh(true);
  if (forceBg) {
    waitUntil(forceBg());
  } else {
    waitUntil(refreshStudentCache(true));
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      ok: true,
      message:
        'Warming NFC student + attendance cache in background. Point UptimeRobot here every 5 min.',
      cache: cacheStatus(),
      platform: 'vercel',
    })
  );
};
