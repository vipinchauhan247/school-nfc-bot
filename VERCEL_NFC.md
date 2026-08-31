# Vercel NFC gate (fast taps)

Render free tier sleeps; this bot is deployed on **Vercel** with the same fast-path design as `nfc_gate.py`:

1. **`/nfc`** — instant reply from in-memory cache (target &lt; 1s on a warm instance)
2. **Background** — Google Sheet + Telegram via Apps Script (`waitUntil` on Vercel)
3. **`/warm`** — reload student + attendance cache without blocking the HTTP response

## Why taps were 10–20 seconds

A plain Vercel port that calls Google Apps Script **on every tap** adds ~5–15s per request. The Render version avoided that with `nfc_gate.py`.

## UptimeRobot (important on Vercel)

Unlike Render, serverless has **no always-on process**. Point UptimeRobot at:

- **URL:** `https://school-nfc-bot.vercel.app/warm`
- **Interval:** every **5 minutes**

`/health` only checks config; **`/warm` keeps an instance warm and reloads the card cache** so the first morning tap is fast.

## Vercel environment variables

Same as Render:

- `BOT_TOKEN`
- `APPS_SCRIPT_URL`
- `ADMIN_CHAT_ID` (optional)
- `SCHOOL_NAME` (optional)

Vercel sets `VERCEL_URL` automatically for webhook `/setup`.

## ESP8266 firmware

```cpp
const char* SERVER_BASE = "https://school-nfc-bot.vercel.app";
// builds URL: SERVER_BASE + "/nfc?uid=" + uid
```

Do **not** monitor `/nfc` in UptimeRobot (fake taps).

## Cold start

First request after long idle may still take ~2–3s (serverless boot). UptimeRobot every 5 min minimizes this. If cache is empty, OLED shows `ERROR` once — tap again after `/warm` completes.
