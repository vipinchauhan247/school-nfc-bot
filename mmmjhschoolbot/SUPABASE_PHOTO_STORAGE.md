# Option C — Student photos in Supabase Storage

Best long-term setup: photos live in **Supabase Storage** (like Google Drive for the school). The ERP cloud roster stores only a short **URL** per student — not the image file inside JSON.

## Why this is best

| | Base64 in cloud JSON | assets/ folder (Vercel Drop) | **Supabase Storage** |
|---|---|---|---|
| Survives refresh | ❌ (too big / failed) | ✅ after you copy files to Vercel | ✅ automatic |
| Works from any PC | ✅ | ✅ | ✅ |
| Manual ZIP / redeploy | No | **Yes, every batch** | **No** |
| Bandwidth | Heavy | Light | Light |
| Setup | None | Easy | One-time bucket + API deploy |

---

## What you do (one time, ~10 minutes)

### Step 1 — Create the storage bucket in Supabase

1. Open [Supabase Dashboard](https://supabase.com/dashboard) → your project (same one as `SUPABASE_URL`).
2. Go to **Storage** (left menu).
3. Click **New bucket**.
4. Settings:
   - **Name:** `student-photos` (exact spelling — or set env `ERP_STUDENT_PHOTO_BUCKET` to your name)
   - **Public bucket:** **ON** (students photos must load in `<img>` tags on the website)
5. Click **Create bucket**.

No SQL required for basic public bucket.

### Step 2 — Deploy the updated API

The code adds action `photoStorageUpload` in:

- `api/erp-cloud.js`
- `api/mmmjhs-bot.js`

**Vercel** (if your site uses `/api/mmmjhs-bot` on mmmjhschool.com):

- Merge PR or copy those two files into your Vercel project `api/` folder and redeploy.

**Render** (Telegram bot server — only if browsers still call Render for ERP):

- Push same files to GitHub → Render auto-redeploy.

Env vars must already exist (same as ERP cloud):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ERP_CLOUD_SCHOOL_ID` = `mmm-jhs`

Optional:

- `ERP_STUDENT_PHOTO_BUCKET` = `student-photos` (default if omitted)

### Step 3 — Upload new ERP website files (Vercel Drop)

From `mmmjhschoolbot/` copy to your PC deploy folder:

- `js/app.js`
- `js/cloudSync.js`

Hard refresh the ERP: **Ctrl+F5**.

---

## What teachers do (every time)

1. Open **Bulk Student Photo Upload**
2. Select photos named by admission number (`1740.jpg`, etc.)
3. Click **Save Matched Photos**
4. Wait for: **"Saved X photo(s) to Supabase Storage. Refresh is safe"**
5. Done — no ZIP, no Vercel redeploy

Upload **one class at a time** (max 25 per batch).

---

## How it works (technical)

```
Browser  →  POST photoStorageUpload (25 JPEGs as small JSON batches)
         →  Vercel/Render API uploads each file to Supabase Storage
         →  Path: student-photos/mmm-jhs/1740.jpg
         →  Public URL saved in erp_snapshots student.photo
         →  All PCs pull the URL on refresh
```

Example URL stored in cloud:

```text
https://YOUR_PROJECT.supabase.co/storage/v1/object/public/student-photos/mmm-jhs/1740.jpg
```

---

## Fallback if bucket not ready yet

If Storage is not set up or API not deployed, ERP automatically falls back to **assets folder mode**:

- Saves `assets/students/1740.jpg` in cloud
- Downloads a ZIP for you to copy into Vercel Drop

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `bucket "student-photos" is missing` | Create public bucket in Supabase (Step 1) |
| `Photo storage API is not deployed` | Deploy `api/erp-cloud.js` + `api/mmmjhs-bot.js` (Step 2) |
| Photo broken after refresh | Open the public URL in browser — if 404, re-upload that student |
| Still get ZIP download | Storage not active — complete Steps 1–2 |

---

## Free tier notes

- Supabase free tier includes **1 GB storage** — enough for ~80,000 passport-size JPEGs at 12 KB each.
- Egress (download) is separate; passport photos are small so cost stays low.
- Render/Vercel bandwidth stays low because roster JSON only has URLs.
