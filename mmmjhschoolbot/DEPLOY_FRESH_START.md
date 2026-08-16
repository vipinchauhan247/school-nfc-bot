# Fresh start after deleting students

You deleted the roster on purpose. Empty cloud is **valid** — not an error.

## What changed
- Website no longer shows “Cloud snapshot could not be applied” / cloud failed for an empty list
- Empty roster = ready for fresh upload
- Auto-restore from old native `erp_students` (824) is **off**
- Empty cloud push / `wipeRoster` clears leftover native rows so old students do not come back

## Deploy
1. **Vercel** (removes the error): upload `js/app.js` + `js/cloudSync.js` (+ config), bump `?v=` e.g. `20260815_fresh_empty_ok`
2. **Render** (clears leftover 824 in native tables): copy `api/erp-cloud.js` + `api/mmmjhs-bot.js`, redeploy, then either:
   - open the site once and save/upload empty, or
   - `POST ...?action=wipeRoster&schoolId=mmm-jhs&secret=...`

Then import your fresh student file.
