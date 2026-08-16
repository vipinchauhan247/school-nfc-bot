# Bandwidth fix — why 5 GB vanished and what changed

## What was happening

`js/cloudSync.js` polled the cloud **every 5 seconds** and downloaded the **entire school snapshot** each time — all students with fee records, marks and attendance logs, plus the base64 logo and signature images embedded in the same JSON. There was no check for whether anything had changed.

Measured against a 675-student roster:

| | Bytes |
|---|---|
| One full `cloudPull`, uncompressed | **3,670,939** (3.67 MB) |
| 12 pulls (one minute at 5s) | 44,051,268 (42 MB) |

That is **2.5 GB per hour per open tab**. Three devices in an eight-hour day is roughly **59 GB**, so a 5 GB allowance is gone in about **2 hours**.

UptimeRobot did not cause this, but it removed the accidental brake: Render's free tier sleeps after 15 idle minutes, and the keep-alive pings meant every poll succeeded instead of hitting a sleeping service.

## What changed (no feature loss)

**1. Poll the timestamp, not the roster.** New `action=cloudVersion` returns only `savedAt` (**103 bytes**). The browser downloads the full snapshot **only when that timestamp differs** from what it already has.

**2. Poll interval 5s → 15s.** Still live for the office; the probe is so small the interval barely matters.

**3. Stop polling while the tab is hidden.** On returning to the tab it checks immediately, so nothing is stale.

**4. Gzip on API responses.** The full pull drops from 3.67 MB to **45,821 bytes** (80× smaller). Verified byte-for-byte identical after decoding.

**5. `action=health` / `/api/health`** returns `{"ok":true}` (**11 bytes**) with no database read — point UptimeRobot here, never at a data endpoint.

Nothing was removed. Live multi-device sync, cloud-only mode, dirty-edit protection and the boot prefetch all behave as before.

## Result

| | Before | After |
|---|---|---|
| Idle office, per tab | 2.5 GB/hour | ~25 KB/hour |
| 3 devices, 8h day, 200 edits | 59 GB/day | **27 MB/day** |
| 5 GB allowance lasts | 2 hours | **~6 months** |

**≈2,259× less traffic.**

If the server has not been updated yet, the browser detects the missing probe and falls back to a full pull every ~90 seconds instead of every 5 seconds — still far below the old rate.

## Deploy

**Both files must go out together** (client and server):

1. **Render** (or wherever the API runs): `api/erp-cloud.js`, `api/mmmjhs-bot.js`, `render-server.js`
2. **Vercel**: `js/cloudSync.js`, `js/erp-cloud-config.js` — bump `?v=`
3. **UptimeRobot**: change the monitor URL to `/api/health`, interval 5 minutes

## Moving off Render (free option)

Both API files already export `module.exports = async (req, res) => {…}`, which is exactly Vercel's serverless function signature, and they use no npm dependencies (`crypto`, `https`, built-in `fetch`). So:

1. Copy `api/erp-cloud.js` and `api/mmmjhs-bot.js` into the `api/` folder of the Vercel site (next to `index.html`)
2. Add the environment variables in Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ERP_CLOUD_SCHOOL_ID`, `ERP_CLOUD_SECRET`, `TELEGRAM_BOT_TOKEN` (plus any Google Sheet vars already on Render)
3. Uncomment this line in `js/erp-cloud-config.js`:
   ```js
   window.MMMJHS_BOT_API_URL = '/api/mmmjhs-bot';
   ```
4. Re-point the Telegram webhook:
   ```
   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://www.mmmjhschool.com/api/mmmjhs-bot
   ```
5. UptimeRobot can be switched off — serverless functions do not sleep

Vercel's free tier includes 100 GB/month. At the new rate (~27 MB/day) that is not a constraint. Note Vercel's Hobby plan is officially non-commercial; if the school pays for the ERP, use Pro.

Do **not** touch @Vipinbellbot (NFC bot) — it is separate.
