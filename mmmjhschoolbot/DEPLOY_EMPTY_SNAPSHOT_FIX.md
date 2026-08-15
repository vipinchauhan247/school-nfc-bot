# Deploy order — fix empty snapshot (824 native / 0 snapshot)

Codex was right: live snapshot `students = []` while `erp_students` has **824**.

Cursor cannot push to Vercel (website has no GitHub). Deploy in this order:

## 1) Render (required first)

Copy from branch `cursor/erp-cloud-only-ced2` / PR #8 into the Render bot repo and redeploy:

- `api/erp-cloud.js` — auto-rebuilds empty snapshot from native tables; rejects empty uploads
- `api/mmmjhs-bot.js` — allows `action=rebuildSnapshot`

After Render is live, either open the school site (pull auto-heals) or call:

```
POST https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot?action=rebuildSnapshot&schoolId=mmm-jhs&secret=YOUR_SECRET
```

Expect `studentCount` ≈ 824.

## 2) Vercel website (folder upload)

From the same branch, upload and bump `?v=` (example `20260815_cloud_rebuild_v1`) for:

- `js/erp-cloud-config.js`
- `js/cloudSync.js` (display cache + rebuild client)
- `js/app.js` (cloud-only boot)

Then Codex may re-apply **only** UI/TC/duplicate-checker edits on top of this `app.js` — do not replace `cloudSync.js` / `erp-cloud-config.js` with older files.
