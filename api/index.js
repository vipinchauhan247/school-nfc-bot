const { SCHOOL_NAME } = require('../lib/config');

module.exports = function handler(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    `<h1>MMM School NFC Bot</h1>
<p>@Vipinbellbot — fast NFC on Vercel (in-memory cache + background Sheet sync)</p>
<ul>
<li><a href="/health">/health</a> — status check</li>
<li><a href="/warm">/warm</a> — reload card cache (UptimeRobot every 5 min)</li>
<li><a href="/setup">/setup</a> — connect Telegram webhook (open once after deploy)</li>
<li><code>/nfc?uid=CARDUID</code> — fast NFC gate for ESP8266</li>
</ul>`
  );
};
