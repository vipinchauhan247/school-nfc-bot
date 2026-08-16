# Staff / user delete fix

## What went wrong
1. **Empty student roster wiped logins** — when cloud students were empty (or no snapshot yet), the site forced `staffUsers = []`, so real users disappeared.
2. **Deleted users came back** — sync merge preferred “non-empty” staff lists, so a stale PC / delayed merge could resurrect deleted logins.
3. **Demo seed** — hardcoded USR-001…005 could reappear if cloud sync was broken or missing.

## What we fixed
- Empty student apply **keeps** existing staff/teachers unless cloud explicitly sends those arrays.
- Staff/teachers membership follows the same authority rules as students (delete sticks).
- Create/delete staff uses an exact cloud upload (no merge that can revive ghosts).
- Demo USR-001…005 seed removed.
- Student `wipeRoster` keeps staffUsers + teachers on the server.

## Deploy (required)
Upload to Vercel and bump `?v=` on **both**:
- `js/cloudSync.js` (must be the real file, not a copy of app.js)
- `js/app.js`
- `js/mockData.js` (empty shell — no demo staff)
- `js/erp-cloud-config.js` (`ERP_CLOUD_ONLY = true`)

Redeploy **Render** if `api/erp-cloud.js` changed (wipeRoster staff preserve).

## After deploy
1. Open User Management — you should see only cloud logins.
2. Delete one test user → wait for “saved to cloud” → refresh → user must stay gone.
3. Create one user → refresh → user must stay.
4. If originals are missing from cloud, recreate them once; they will now persist.
