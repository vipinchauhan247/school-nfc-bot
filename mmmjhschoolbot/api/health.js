/** Vercel health probe — 11 bytes, no database. Point UptimeRobot here on Vercel. */
module.exports = function health(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end('{"ok":true,"service":"erp-cloud"}');
};
