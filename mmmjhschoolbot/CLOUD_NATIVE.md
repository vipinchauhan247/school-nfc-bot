# Cloud-native ERP (safe) — @mmmjhschoolbot only

**Do not touch @Vipinbellbot / NFC.**

## What changed
1. Restored/added `api/erp-cloud.js` (snapshot sync + native `erp_students` rows)
2. `/link` + `/register` still update **Google Sheet**, and also upsert **Chat ID + username** into `erp_students`
3. ERP frontend `cloudSync.js` still uses snapshots (no feature wipe), then overlays native Chat IDs
4. Offline local cache remains for now (safe); cloud DB becomes source of truth for student links

## Feature impact
| Kept | Improved | Still hybrid for now |
|------|----------|----------------------|
| Fees, receipts, exams UI | `/link` → Sheet + DB | Full fee rows still in snapshot |
| Printer settings (local) | No NFC/Vipinbellbot changes | Full row-level fees = later phase |
| Telegram bot commands | Dual-write on every cloud push | |

## Deploy steps (safe order)
1. In **Supabase SQL**, run `sql/erp_cloud_native.sql`
2. If your existing snapshot table is not named `erp_snapshots`, set Render env:
   - `ERP_SNAPSHOT_TABLE=<your_table_name>`
3. Confirm Render already has:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ERP_CLOUD_SECRET`
4. Merge/deploy this branch to **mmmjhschoolbot** Render service
5. Call once (with secret):
   `POST /api/mmmjhs-bot?action=nativeMigrate&secret=YOUR_SECRET`
6. On Vercel site, deploy updated `js/cloudSync.js` (or sync from this repo)
7. Test: parent `/link <adm>` on **@mmmjhschoolbot** → Sheet + ERP Telegram Links

## Verify
```bash
curl "https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot?action=cloudConfig"
curl -H "X-ERP-Cloud-Secret: SECRET" \
  "https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot?action=nativeStudents&schoolId=mmm-jhs"
```
