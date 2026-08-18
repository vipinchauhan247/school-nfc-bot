# ERP data recovery guide (staff, Telegram, left students, TC)

## What happened

During an emergency cloud roster repair, the snapshot was rebuilt from the **student-only** native table. That table never stored:

- Staff logins (`staffUsers`)
- Teachers list
- Staff Telegram chat IDs
- Student left/inactive status
- Student Telegram chat IDs (in native copy)

**Fees and 677 active students were kept.** Separate tables kept some data:

| Data | Still in cloud? |
|------|-----------------|
| Active students + fees | Yes (677) |
| Issued TC register | Yes (`erp_tc_certificates` — permanent) |
| Staff logins | **Lost from snapshot** (only 2 emergency admins restored) |
| Teachers | **Lost from snapshot** |
| Telegram chat IDs in ERP | **Lost** (may still be on Google Sheet) |
| Left/inactive students | **Lost from snapshot** (recover partly from TC register) |

---

## Log in first

- **Username:** `vipin`
- **Password:** `vipin123`

---

## 1. Issued TCs (transfer certificates)

TCs are **not deleted** — they live in a separate permanent table.

1. Log in as Super Admin
2. Open **TC Register (Cloud)** from dashboard or `#tc-register`
3. You should see every TC ever issued (e.g. TC-2026-27-3000)

To restore **left/inactive student rows** from TC data (after API deploy):

1. **Left / Inactive Students** → **Recover from TC Register**
2. Or **TC Register** → **Recover Left Students**

This re-adds students who have an issued TC and marks them Left so **Bring Back** works again.

Students who left **without** a TC cannot be restored this way.

---

## 2. Student Telegram chat IDs

Chat IDs are usually still on the **Google Sheet** (Students tab) from parent `/link`.

1. Log in → **Telegram** → **Telegram Links** (or `#telegram-links`)
2. Click **Sync from Google Sheet** / run registration sync
3. Save pushes chat IDs back to cloud

---

## 3. Staff logins & teacher Telegram

Staff accounts must be **re-created** in **User Management**:

1. Add each teacher/staff again (username, password, role)
2. Teachers re-link Telegram on @mmmjhschoolbot:
   ```
   /stafflink their_username their_password
   ```

There is **no automatic restore** for deleted staff unless you use **Supabase point-in-time recovery** (see below).

---

## 4. Full restore from Supabase backup (best if many staff)

If you had many staff users and need everything back:

1. [Supabase Dashboard](https://supabase.com/dashboard) → your project
2. **Database** → **Backups** → **Point in time recovery** (Pro plan)
3. Restore to **before 17 Aug 2026 ~8:00 PM UTC**
4. Or export old `erp_snapshots.payload` if support can help

---

## 5. Prevent this again

Deploy latest:

- `api/erp-cloud.js` — blocks bad native rebuild, TC overlay on pull, `recoverFromTcRegister`
- `api/mmmjhs-bot.js`
- `js/app.js`, `js/cloudSync.js`

Never run **rebuild snapshot from native** unless students are completely empty **and** you accept losing staff metadata.

---

## Quick checklist

- [ ] Log in: vipin / vipin123
- [ ] TC Register — confirm issued TCs visible
- [ ] Recover from TC Register (left students)
- [ ] Telegram Links — sync from Google Sheet (student chat IDs)
- [ ] User Management — re-add staff teachers
- [ ] Teachers — `/stafflink` on Telegram bot
- [ ] Consider Supabase PITR if large staff list must be restored exactly
