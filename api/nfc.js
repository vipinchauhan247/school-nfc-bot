const { waitUntil } = require('@vercel/functions');
const { processNfcTap } = require('../lib/nfc_gate');

module.exports = async function handler(req, res) {
  const uid =
    req.query?.uid ||
    req.query?.UID ||
    (typeof req.body === 'object' && req.body?.uid) ||
    '';

  const { text, backgrounds } = processNfcTap(uid);
  for (const bg of backgrounds) {
    waitUntil(bg());
  }

  console.log(`[NFC] uid=${uid} -> ${text}`);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(text);
};
