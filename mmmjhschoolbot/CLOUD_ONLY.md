# Cloud-only ERP (100%) — @mmmjhschoolbot

**Do not touch @Vipinbellbot / NFC.**

## What changed

Browser **localStorage / IndexedDB are no longer the school roster**. Every open of the website:

1. Starts with an empty in-memory student list
2. Loads the full school snapshot from **Supabase** (via Render `/api/erp-cloud`)
3. Saves edits by **pushing to cloud** (auto ~0.6s after each save)
4. **Clears** `MMM_SchoolData_v6` and related local roster keys so old PCs cannot resurrect duplicates

Still local per PC (unchanged):

- Printer settings (`MMM_PrintSettings`)
- Website appearance (`MMM_AppearanceSettings`)
- Cancelled-receipt markers (`MMM_CancelledReceipts`)
- Logged-in user id

## Files to upload to Vercel (website folder)

Replace these on the live site (no website GitHub — folder upload):

1. `js/erp-cloud-config.js` — sets `ERP_CLOUD_ONLY = true`
2. `js/cloudSync.js` — cloud replace on pull, one-time local→cloud migrate if cloud empty
3. `js/app.js` — boot skips local roster; saves no longer write the roster to localStorage

Bump the script `?v=` query on `index.html` for all three so browsers do not keep the old hybrid files.

Example:

```html
<script src="js/erp-cloud-config.js?v=20260815_cloud_only"></script>
<script src="js/cloudSync.js?v=20260815_cloud_only"></script>
<script src="js/app.js?v=20260815_cloud_only"></script>
```

## Render / Supabase

No new SQL required if Phase 2 tables are already live. Keep Render env + site origin trust as before.

## First open after deploy

- If cloud already has students (your migrate did): site shows cloud count; local cache is wiped.
- If somehow cloud were empty but a browser still had old `MMM_SchoolData_v6`: that browser uploads once, then switches to cloud-only.
- Optional safety: Download Full Backup (.JSON) from Backup page after you confirm the student count.

## Turn hybrid back on (not recommended)

In `js/erp-cloud-config.js` set:

```js
window.ERP_CLOUD_ONLY = false;
```

That restores the old local+cloud merge behavior.

## NFC

Unchanged. Contact sync still uses the Telegram sheet for @mmmjhschoolbot. Attendance stays on @Vipinbellbot.
