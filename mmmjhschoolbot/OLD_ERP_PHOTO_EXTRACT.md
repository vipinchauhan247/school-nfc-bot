# Extract student photos from old Smart School ERP

**Your old ERP:** https://madanmohanmalviyaschool.com/student/search  
(Smart School by QDOCS — same product as the fee collection report import.)

Photos are stored under **`/uploads/`** on that server (example logo path already visible:  
`https://madanmohanmalviyaschool.com/uploads/school_content/admin_logo/...`).  
Student photos are usually in **`uploads/student_images/`** or a similar subfolder.

Your new ERP has **Students → Bulk Photo Upload**. Each file must be named by **admission number**:

| File name | Works? |
|-----------|--------|
| `1813.jpg` | Yes |
| `1813 Abhimanyu.jpg` | Yes |
| `adm-1813.png` | Yes |

---

## Fastest method for you (browser only, no server access)

### Step 1 — Export photo URLs from old ERP (while logged in)

1. Open https://madanmohanmalviyaschool.com and **Admin Login**.
2. Go to **Student Information → Student Details** (or the page that lists students with small photos).
3. Choose **session + one class**, click **Search** so the table loads.
4. Press **F12** → **Console** tab.
5. Open file `mmmjhschoolbot/scripts/old_erp_browser_photo_manifest.js`, copy all of it, paste in Console, press **Enter**.
6. A CSV file downloads (`photo_manifest_....csv`).
7. **Repeat for each class** (Class 6, Class 7, …) and merge the CSV files into one, or keep separate folders.

### Step 2 — Download and rename photos on your PC

```powershell
pip install requests pillow

cd C:\Users\vipin\Documents\Codex\2026-08-05\bu\outputs\school-erp

curl -o extract_photos.py https://raw.githubusercontent.com/vipinchauhan247/school-nfc-bot/cursor/exam-adm-role-ui-ced2/mmmjhschoolbot/scripts/extract_old_erp_student_photos.py

python extract_photos.py --csv photo_manifest.csv -o photos_for_erp --resize
```

If download fails (login required), while still logged in on old ERP:

1. F12 → **Network** → refresh the student list page  
2. Click any request → **Headers** → copy the full **Cookie** value  
3. Run:

```powershell
python extract_photos.py --csv photo_manifest.csv -o photos_for_erp --resize --cookie "PASTE_COOKIE_HERE"
```

### Step 3 — Upload into new ERP

1. Latest `js/app.js` on Vercel (has **Bulk Photo Upload**).
2. **Students → Bulk Photo Upload** → select files from `photos_for_erp` (**one class at a time**).
3. Click **Save Matched Photos**.

---

## Pick your situation

### Option 1 — You still have old ERP hosting (best)

1. Log in to **cPanel / FTP** on the old server.
2. Download folder: **`uploads/`** (often `uploads/student_images/` or similar inside it).
3. In **phpMyAdmin**, export table **`students`** columns:
   - `admission_no` (or `admission_no` / roll id field your school uses)
   - `image` (filename stored in uploads)
4. Save as `photo_manifest.csv` with headers:

```csv
AdmissionNo,FileName
1813,st_08172026_1813.jpg
1556,...
```

5. Run on your PC:

```bash
pip install requests pillow
python mmmjhschoolbot/scripts/extract_old_erp_student_photos.py ^
  --csv photo_manifest.csv ^
  --copy-from "C:\path\to\uploads\student_images" ^
  -o photos_for_mmm_erp ^
  --resize
```

6. In new ERP: **Students → Bulk Photo Upload** → select all files from `photos_for_mmm_erp`.

---

### Option 2 — Browser only (no server access)

1. Log in to **old ERP admin**.
2. Open **Student Information → Student List** (do **one class at a time** if the list is huge).
3. Scroll to the bottom so all rows load.
4. **Ctrl+S** → Save as **Web page, HTML only** (or Complete).
5. Repeat for each class → save as `class6.html`, `class7.html`, etc.

Run:

```bash
python mmmjhschoolbot/scripts/extract_old_erp_student_photos.py ^
  --html class6.html ^
  --base-url "https://YOUR-OLD-ERP-DOMAIN.com/" ^
  -o photos_class6 ^
  --resize
```

If downloads fail (login required), open one photo URL in browser while logged in, copy the **Cookie** from DevTools (F12 → Network), then:

```bash
python ... --cookie "ci_session=xxxx; ..." ...
```

Merge all class folders into one folder, then **Bulk Photo Upload** once.

---

### Option 3 — Photo URL column in CSV

If Antigravity or phpMyAdmin gives you a CSV with full image URLs:

```csv
AdmissionNo,PhotoUrl
1813,https://old-erp.com/uploads/student_images/st_xxx.jpg
```

```bash
python mmmjhschoolbot/scripts/extract_old_erp_student_photos.py ^
  --csv photo_urls.csv ^
  -o photos_out ^
  --resize
```

---

## Upload into new ERP

1. Deploy latest `js/app.js` (includes Bulk Photo Upload).
2. **Students → Bulk Photo Upload**
3. Select **one class folder at a time** (~40–50 photos), not all 678 at once.
4. Check preview table — green **Ready** rows only.
5. Click **Save Matched Photos** — syncs to cloud automatically.

Photos are stored as small JPEG inside the cloud roster (~15 KB each after resize).

---

## Prompt for Google Antigravity (copy-paste)

```
My old school ERP is Smart School (QDOCS) at:
https://madanmohanmalviyaschool.com/student/search

Student photos are under /uploads/ on that domain. I am logged in as admin in Chrome.

Task 1: Give me a browser console script that runs on the student search results table, reads each row's admission number and img src, and downloads photo_manifest.csv with columns AdmissionNo,PhotoUrl.

Task 2: Give me a Python script for Windows that reads that CSV, downloads each image with an optional Cookie header for auth, saves as {AdmissionNo}.jpg, resizes to 480x640 JPEG.

Task 3: phpMyAdmin SQL to export admission_no and image filename from students table where image is not empty.

Base URL: https://madanmohanmalviyaschool.com/
Do not store passwords. I will paste Cookie manually if needed.
```

---

## Security

- Do not commit old ERP passwords or session cookies to GitHub.
- Change old ERP admin password if it was ever pasted into a chat.
