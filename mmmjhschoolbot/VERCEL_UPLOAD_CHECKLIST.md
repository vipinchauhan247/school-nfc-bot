# Vercel Upload Checklist — MMM Jr High School ERP

Use this **every time** you upload to Vercel (Drop or Git). Follow in order so bandwidth stays fixed, cloud sync works, and Supabase/Render settings are not disturbed.

**Live site:** https://www.mmmjhschool.com  
**Repo:** https://github.com/vipinchauhan247/school-nfc-bot

See also: `ANTIGRAVITY_HANDOFF.md`, `BANDWIDTH_FIX.md`, `CLOUD_ONLY.md`

---

## Before you upload (5 minutes)

- [ ] **Settings → Download Full Backup (.json)** — save to PC with today’s date
- [ ] Note **student count** on dashboard (e.g. ~824)
- [ ] Note **subjects count** in Subjects Directory (should not be 0 after PR #24)
- [ ] Confirm you have the **latest files** from branch `cursor/report-attendance-fee-ced2` or merged `main`

---

## Files to upload

### Always upload (website — Vercel Drop or folder deploy)

| File | Why |
|------|-----|
| `index.html` | Entry page — **must bump `?v=`** on script/style links |
| `js/app.js` | Main ERP UI |
| `js/cloudSync.js` | **Critical** — cloudVersion polling (bandwidth fix) |
| `js/erp-cloud-config.js` | Routes browser to `/api/mmmjhs-bot` on Vercel, not Render |
| `js/mockData.js` | Required shell — **do not delete** |
| `css/styles.css` | Styles (if changed) |

### Upload via Git / full Vercel project (API — not Drop alone)

| File | Why |
|------|-----|
| `api/erp-cloud.js` | Supabase pull/push, cloudVersion, gzip, photos |
| `api/mmmjhs-bot.js` | API router + @mmmjhschoolbot Telegram |
| `vercel.json` | Serverless function limits, no-cache headers |

### Do NOT need on live website (docs only — optional)

- `*.md` files (ANTIGRAVITY_HANDOFF, this checklist, etc.) — safe to include in repo, not required for site to run

---

## Bump cache version in index.html

Change **every** script and stylesheet query string, for example:

```html
<script src="js/erp-cloud-config.js?v=20260818_v2"></script>
<script src="js/cloudSync.js?v=20260818_v2"></script>
<script src="js/mockData.js?v=20260818_v2"></script>
<script src="js/app.js?v=20260818_v2"></script>
<link rel="stylesheet" href="css/styles.css?v=20260818_v2">
```

Then on each PC: **Ctrl+F5** (hard refresh).

---

## Vercel environment variables (API deploy only)

If deploying **`api/`** via Git or Antigravity full project, set in **Vercel → Project → Settings → Environment Variables** (copy from Render if already working):

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Database |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access |
| `ERP_CLOUD_SECRET` | Must match value browsers use for sync |
| `ERP_CLOUD_SCHOOL_ID` | `mmm-jhs` |
| `TELEGRAM_BOT_TOKEN` | @mmmjhschoolbot fee/receipt bot |

**You are NOT creating a new Supabase project** — same keys, same data.

---

## What stays unchanged (do not redo)

| Service | Action |
|---------|--------|
| **Supabase** | No reset, no new project — same students/fees |
| **Render @Vipinbellbot** | Keep running — NFC gate bot only |
| **Google NFC sheet** | Unchanged — ERP sync is read-only |
| **Printer / theme settings** | Local per PC — upload does not touch these |

---

## Bandwidth fix — must stay active

Upload **together**:

1. `js/cloudSync.js` — polls `cloudVersion` (~103 bytes), full pull only on change, 15s interval
2. `js/erp-cloud-config.js` — `MMMJHS_BOT_API_URL = '/api/mmmjhs-bot'` on live domain
3. `api/erp-cloud.js` on Vercel — implements `cloudVersion`, gzip, `health`

**Wrong:** upload only old `app.js` → bandwidth problem returns (~2.5 GB/hour per tab).

**Browser must call:** `https://www.mmmjhschool.com/api/mmmjhs-bot?action=cloudVersion...`  
**Not:** `mmmjhschoolbot.onrender.com` for cloud sync.

---

## UptimeRobot (one-time check)

| Setting | Value |
|---------|--------|
| URL | `https://www.mmmjhschool.com/api/health` |
| Interval | 5 minutes |
| **Avoid** | Pinging `cloudPull` or Render data URLs |

Vercel serverless does not sleep like Render free tier — ERP uptime does not depend on waking Render.

---

## After upload — smoke test (2 minutes)

- [ ] Site loads — not blank content area
- [ ] Login works (e.g. vipin / your password)
- [ ] Dashboard shows correct **student count**
- [ ] **Subjects Directory** has subjects (not empty)
- [ ] **Timetable** opens without red error box
- [ ] **F12 → Network**: cloud calls use **`/api/mmmjhs-bot`**, not Render
- [ ] **Attendance → Sync from NFC Sheet** (optional test)
- [ ] Collect fee or open one student profile (quick sanity check)

---

## If something breaks

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Blank page / no modules | Syntax error in `app.js` | Restore backup JSON; upload fixed `app.js` from GitHub branch |
| 0 students | Cloud secret mismatch or API down | Check Vercel env vars; check `/api/health` |
| Subjects/staff vanished after 15s | Old `cloudSync.js` without merge fix | Upload PR #24 `cloudSync.js` + `app.js` |
| Bandwidth spikes again | Old sync or Render URL | Upload `cloudSync.js` + `erp-cloud-config.js`; verify Network tab |
| Photos upload fail | API not deployed or no Supabase bucket | Git deploy `api/erp-cloud.js`; see `SUPABASE_PHOTO_STORAGE.md` |
| Fee Telegram bot silent | Webhook URL wrong | @mmmjhschoolbot webhook → Vercel `/api/mmmjhs-bot` |

**Emergency restore:** Settings → Restore Database → upload saved `.json` backup.

---

## Two deploy methods — pick one

### Method A — Vercel Drop (usual)

1. Backup JSON
2. Upload `js/app.js`, `js/cloudSync.js`, `js/erp-cloud-config.js`, `css/styles.css`
3. Bump `?v=` in `index.html`
4. Ctrl+F5

**Requires:** Vercel project already has `api/` from a prior Git deploy.

### Method B — Full Vercel / Git (Antigravity recommended)

1. Backup JSON
2. Push repo or connect GitHub to Vercel
3. Ensure `api/`, `vercel.json`, env vars set
4. Deploy — static + API together
5. Bump `?v=` if needed; Ctrl+F5

---

## Tell Antigravity / any agent

```
Upload to Vercel per VERCEL_UPLOAD_CHECKLIST.md.
Do NOT point browser cloud sync back to Render.
Keep /api/mmmjhs-bot on Vercel with same Supabase env vars.
Do NOT touch @Vipinbellbot Render NFC service.
Always JSON backup before deploy.
```

---

*Last updated: August 2026*
