# Cloud-native ERP (safe) — @mmmjhschoolbot only

**Do not touch @Vipinbellbot / NFC.**

## What this is now (Phase 2)

Supabase was already connected. Phase 2 makes the **database** hold real student and fee rows, not only one big snapshot.

| Layer | Role |
|-------|------|
| `erp_snapshots` | Full backup of ERP (still used by website) |
| `erp_students` | One row per admission (Chat ID, name, class) |
| `erp_payments` | One row per receipt |
| `erp_fee_sessions` | Due/paid months per student session |
| Browser localStorage | Offline cache only — cloud wins on sync |
| Google Sheet | Still updated by `/link` (parents) |
| Printer settings | Stay on each PC |

This is **cloud-synced ERP**, not “delete all local data”. Devices still work offline, then catch up.

## No more secret on every PC

After you update **Render** `api/erp-cloud.js`, teachers opening **https://www.mmmjhschool.com** do **not** need to paste a secret.

Render trusts the school website origin:

- `https://www.mmmjhschool.com`
- `https://mmmjhschool.com`

Random URLs and curl still need `ERP_CLOUD_SECRET`.

To turn this off later, set Render env: `ERP_CLOUD_TRUST_SITE_ORIGIN=0`

## You still copy files to the **bot** GitHub (Render), not a website GitHub

Replace on Render repo:

1. `api/erp-cloud.js`
2. `api/mmmjhs-bot.js` (only if you have not already)
3. `render-server.js` (root folder, already done)

Website GitHub is not required. The live Vercel site already talks to Render.

## Supabase SQL (run once)

You already ran student tables. Now run **only**:

`sql/erp_cloud_phase2_fees.sql`

In Supabase → SQL Editor → paste that file → Run.

You should then see tables:

- `erp_snapshots` (already there)
- `erp_students` (already there)
- `erp_payments` (new)
- `erp_fee_sessions` (new)

## After Render redeploy

1. Open https://www.mmmjhschool.com on a **second PC** (no Console secret). Save a fee. First PC should show it after a few seconds.
2. One-time migrate (browser or curl — secret still needed here because this is not from the website):

```
https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot?action=nativeMigrate&schoolId=mmm-jhs&secret=YOUR_SECRET
```

Use POST if GET is blocked:

```bash
curl -X POST "https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot?action=nativeMigrate&schoolId=mmm-jhs&secret=YOUR_SECRET"
```

Expected: `"ok": true` with `nativeUpserted` and `nativePayments`.

3. Check Supabase → Table Editor → `erp_payments` has receipt rows.

## Verify

```bash
curl "https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot?action=cloudConfig"
```

From the school website this should include `"siteTrusted": true` and `"requiresSecret": false`.

From a random curl it stays `"requiresSecret": true`.
