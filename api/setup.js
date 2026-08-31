const { BOT_TOKEN, TELEGRAM_API, publicBaseUrl } = require('../lib/config');

module.exports = async function handler(req, res) {
  if (!BOT_TOKEN || !TELEGRAM_API) {
    res.statusCode = 500;
    res.end('Set BOT_TOKEN in Vercel Environment first.');
    return;
  }

  const base = publicBaseUrl();
  if (!base) {
    res.statusCode = 500;
    res.end('VERCEL_URL / PUBLIC_BASE_URL missing.');
    return;
  }

  const webhookUrl = `${base}/bot_webhook`;
  try {
    const resp = await fetch(
      `${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=false`
    );
    const data = await resp.json();
    if (data.ok) {
      res.statusCode = 200;
      res.end(`Webhook OK: ${webhookUrl}`);
      return;
    }
    res.statusCode = 500;
    res.end(`Webhook failed: ${JSON.stringify(data)}`);
  } catch (err) {
    res.statusCode = 500;
    res.end(`Webhook error: ${err.message}`);
  }
};
