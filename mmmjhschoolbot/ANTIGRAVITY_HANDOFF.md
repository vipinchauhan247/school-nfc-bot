# Antigravity Handoff — MMM Jr High School ERP

Use this document when continuing work in **Google Antigravity** (or any new agent) after uploading the project folder. It explains architecture, recent changes, deploy steps, and precautions so live settings are not disturbed.

**Repo:** https://github.com/vipinchauhan247/school-nfc-bot  
**Live site:** https://www.mmmjhschool.com  
**Main code folder:** `mmmjhschoolbot/`

---

## 1. What this project is (four separate pieces)

| Piece | Where it lives | What it does |
|--------|----------------|--------------|
| **Website (ERP UI)** | https://www.mmmjhschool.com via **Vercel Drop** | `index.html`, `js/app.js`, `js/cloudSync.js`, `css/styles.css` — browser ERP for staff |
| **API (cloud + bot)** | **Vercel** `/api/mmmjhs-bot` + `/api/erp-cloud` (and optionally **Render**) | Reads/writes **Supabase**, Telegram fee bot, photo storage |
| **Database** | **Supabase** (free plan — **no PITR backup**) | Students, fees, snapshots, staff, photos bucket |
| **NFC attendance bot** | **Render** + **Google Sheet** | **@Vipinbellbot** — gate taps, parent alerts. **Do NOT mix with ERP** |

### Two Telegram bots — never swap webhooks

| Bot | Purpose | Host |
|-----|---------|------|
| **@Vipinbellbot** | NFC sheet + gate attendance | Render NFC service (`school-nfc-bot.onrender.com`) |
| **@mmmjhschoolbot** | Fees, receipts, ERP messages | Vercel `/api/mmmjhs-bot` |

ERP **reads** the NFC attendance sheet (sync button). It **never writes** to that sheet or changes NFC webhooks.

---

## 2. Recent work (branches & PRs)

Prioritize merging/deploying in this order:

| PR | Branch | Topic |
|----|--------|--------|
| **#24** | `cursor/data-loss-subjects-fix-ced2` | Blank website fix, subjects/timetable restore, cloud merge (no empty wipe) |
| **#25** | `cursor/report-attendance-fee-ced2` | Report portrait/landscape print, PEN in profile, attendance sync, range reports |
| **#23** | `cursor/report-admit-marks-ui-ced2` | Report card PEN/profile, marks columns, admit 3-per-page |
| **#22** | `cursor/exam-adm-role-ui-ced2` | Bulk photos, exam UI, TC register |
| **#21** | `cursor/cloud-bandwidth-fix-ced2` | Browser cloud sync via Vercel (save Render bandwidth) |

### PR #24 — critical fixes

| Issue | Fix |
|--------|-----|
| **Blank website** | Restored missing `openEditSubjectModal()` in `app.js` (JavaScript syntax error) |
| **Timetable crash** | `periodSettings` stored as `{}` from cloud — normalize + default 8 periods |
| **Subjects lost** | Auto-restore from exam configs or standard list; **Restore Subjects** button |
| **Cloud wipe bug** | Empty `subjects:[]` / `staffUsers:[]` no longer overwrites good data on background pull |

### PR #25 — latest features

| Feature | Where in ERP |
|---------|----------------|
| Report card **A4 Portrait / Landscape** print dropdown | Report card preview modals (Half-Yearly, Final, Combined) |
| **PEN** in student profile | Profile modal → Parent & Contact |
| **Sync from NFC Sheet** | Attendance page + Reports page |
| **Register date picker** | Attendance — view/mark any date |
| **Reports filters** | Class + From Date + To Date |
| **CSV exports** | Attendance range, fee payments range, combined fee+attendance |

---

## 3. How we approach changes (do not disturb settings)

### Golden rules

1. **Minimal diff** — change only what is needed; no unrelated refactors.
2. **Cloud-safe merge** — never apply empty arrays over non-empty data (`mergeSubjectsLists`, `mergeStaffUsersLists` in `cloudSync.js`).
3. **Normalize `{}` to arrays** — `periodSettings: {}` and `subjects: {}` from cloud must become arrays before use.
4. **Local vs cloud split** (`js/erp-cloud-config.js`):
   - **Cloud (Supabase):** students, fees, staff, teachers, subjects, marks, sessions
   - **Stays local per PC:** printer settings, theme/appearance, cancelled-receipt markers, logged-in user id
5. **Do NOT delete `js/mockData.js`** — required shell loaded before `app.js`; real data comes from cloud.
6. **Do NOT touch NFC Python/bot files** unless explicitly requested.
7. **Always JSON backup** before deploy (`Settings → Backup`).

### Key files

| File | Role |
|------|------|
| `js/app.js` | Main ERP UI — fees, exams, attendance, reports, profiles |
| `js/cloudSync.js` | Push/pull Supabase, photo batching, merge logic |
| `js/erp-cloud-config.js` | `ERP_CLOUD_ONLY`, API URL, school id |
| `js/mockData.js` | Empty `SchoolData` shell (required) |
| `css/styles.css` | Marks sticky columns, mobile touch scroll |
| `api/erp-cloud.js` | Supabase snapshot, photos, native tables |
| `api/mmmjhs-bot.js` | API router + @mmmjhschoolbot Telegram |

### Related docs in this folder

| File | Contents |
|------|----------|
| `CLOUD_ONLY.md` | Cloud-only mode, Vercel upload list, empty snapshot recovery |
| `MOCKDATA.md` | Why `mockData.js` must exist |
| `DATA_RECOVERY.md` | Restore after data loss |
| `DEPLOY_FRESH_START.md` | Empty roster / wipe workflow |
| `SUPABASE_PHOTO_STORAGE.md` | Bulk student photos bucket |
| `ROLE_PERMISSIONS_AND_ADMIT_CARD.md` | Admit card + permissions |

---

## 4. Two deploy paths

### A) Website UI — Vercel Drop (usual workflow)

Upload to live site folder:

1. `js/app.js`
2. `js/cloudSync.js`
3. `css/styles.css` (if changed)
4. Sometimes `js/erp-cloud-config.js`, `js/mockData.js`

Then **bump `?v=`** on every script/stylesheet link in HTML and **Ctrl+F5**.

**Vercel Drop alone does NOT update the API.** Photo storage, cloud rebuild, and auth fixes need Git deploy (below).

### B) API — GitHub → Vercel (or Render)

Push changes to:

- `api/erp-cloud.js`
- `api/mmmjhs-bot.js`

Vercel auto-deploys from the connected GitHub repo.

**Render** (`render.yaml`, service `mmm-school-erp`, root `mmmjhschoolbot`):

- Telegram webhook (long-running)
- ESP8266 NFC firmware endpoint
- Fallback if Vercel API fails

**Browser ERP traffic should use Vercel `/api/`** (configured in `erp-cloud-config.js`) to avoid Render free-tier bandwidth limits.

---

## 5. Safe deploy checklist (every time)

```
1. Settings → Download Full Backup (.json)
2. Note current student count on dashboard
3. Upload js/app.js + js/cloudSync.js (+ css if changed)
4. Bump ?v= on ALL script/style tags in index.html
5. Ctrl+F5 hard refresh
6. Smoke test: login, student count, subjects list, timetable, one attendance row
7. If API changed: git push → wait Vercel deploy → test cloud pull or photo upload
```

**Never deploy without backup.** A prior incident (Aug 2026) wiped staff/subjects until JSON restore.

---

## 6. Supabase — risks & precautions

| Risk | What happens | Precaution |
|------|----------------|------------|
| Empty cloud snapshot | Site shows 0 students or error | Do not push empty roster unless intentional wipe; backup first |
| Cloud pull overwrites meta | Subjects/staff/classes wiped | Fixed in PR #24 — still backup before deploy |
| No PITR backup | Deleted rows hard to recover | JSON backup + keep CSV exports |
| Native table rebuild | Snapshot rebuild can drop meta if API wrong | Deploy API + website together after meta fixes |
| Photo bucket missing | Bulk upload fails | Create `student-photos` bucket; deploy `api/erp-cloud.js` |

**Emergency restore:** Settings → Restore Database → upload saved `.json` backup.

---

## 7. Render — risks & precautions

| Risk | Precaution |
|------|------------|
| Free tier sleep | First request slow; normal for @Vipinbellbot |
| Bandwidth exceeded | Keep browser cloud sync on Vercel `/api/`, not Render |
| Wrong webhook URL | @mmmjhschoolbot → Vercel; @Vipinbellbot → Render NFC — never swap |
| Missing env vars | `ERP_CLOUD_SECRET`, Supabase URL/key must match Vercel/Render dashboards |

---

## 8. GitHub — risks & precautions

| Risk | Precaution |
|------|------------|
| Many open PR branches | Merge #24 + #25 first; test before merging #22 (photos need API) |
| Vercel Drop vs Git out of sync | After merge, upload Drop files OR connect static hosting to Git |
| Wrong branch deploy | Use `cursor/*-ced2` branches; base = `main` |

---

## 9. What breaks if… (quick reference)

| If you… | Result |
|---------|--------|
| Upload `app.js` with syntax error | **Entire site blank** (shell only, no content) |
| Cloud has `subjects:[]` + old merge logic | Subjects/staff disappear after ~15s background pull |
| Upload API without photo bucket | Bulk photo upload fails |
| `ERP_CLOUD_SECRET` mismatch | Cloud sync 403; roster may not load |
| Change NFC bot webhook to fee bot | Gate taps stop / wrong parent alerts |
| Skip `?v=` cache bump | Users keep old broken JavaScript |
| Wipe roster without backup | **Permanent data loss** (no Supabase PITR) |
| Delete `mockData.js` | Site crash: `SchoolData is not defined` |

---

## 10. Antigravity starter prompt (copy-paste)

```
Project: MMM Jr High School ERP
Repo: github.com/vipinchauhan247/school-nfc-bot
Live: https://www.mmmjhschool.com (Vercel Drop for static JS)

Architecture:
- Browser ERP → Vercel /api/mmmjhs-bot + /api/erp-cloud → Supabase
- NFC gate → Render @Vipinbellbot + Google Sheet (ERP attendance sync is read-only)
- Cloud-only: ERP_CLOUD_ONLY=true in js/erp-cloud-config.js

Do NOT:
- Delete js/mockData.js
- Mix the two Telegram bots or change NFC webhooks
- Deploy app.js without JSON backup first
- Let empty cloud arrays overwrite subjects/staff (use merge helpers in cloudSync.js)
- Touch NFC Python unless explicitly asked

Recent branches (merge/deploy order):
1. cursor/data-loss-subjects-fix-ced2 (PR #24)
2. cursor/report-attendance-fee-ced2 (PR #25)

Deploy website: Vercel Drop app.js + cloudSync.js, bump ?v=
Deploy API: git push → Vercel auto-deploy api/*.js

Read first: ANTIGRAVITY_HANDOFF.md, CLOUD_ONLY.md, MOCKDATA.md, DATA_RECOVERY.md
```

---

## 11. Suggested next tasks (not yet done)

- Term attendance entry on report cards (teacher register totals vs NFC read-only)
- Optional: auto NFC sheet pull every 15s on attendance page (currently manual **Sync** button)
- Merge PR #22 bulk photos (requires API deploy + Supabase `student-photos` bucket)
- Restore exact custom subjects from JSON backup if school had non-standard list

---

## 12. Login & recovery (if locked out)

- Default admin was restored in a prior incident: check `DATA_RECOVERY.md` in repo
- Staff list empty → cloud snapshot may have wiped `staffUsers`; restore from JSON backup
- Cloud loading stuck → hard refresh; check Vercel `/api/` health; verify Supabase not paused

---

*Last updated: August 2026 — Cursor Cloud Agent session (PRs #24, #25)*
