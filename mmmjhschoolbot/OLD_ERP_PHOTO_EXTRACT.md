# Extract student photos from old Smart School ERP

Your new ERP has **Students → Bulk Photo Upload**. Each file must be named by **admission number**:

| File name | Works? |
|-----------|--------|
| `1813.jpg` | Yes |
| `1813 Abhimanyu.jpg` | Yes |
| `adm-1813.png` | Yes |

This guide helps you pull photos out of the **old ERP** and rename them correctly.

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
I use Smart School ERP (QDOCS) for my old school system. I need a Python script on Windows to extract all student photos for migration.

Requirements:
1. Input: either (A) saved HTML of admin student list page, or (B) CSV with columns AdmissionNo + image filename from MySQL students table, plus local folder uploads/student_images/
2. Output: one file per student named {AdmissionNo}.jpg in an output folder
3. Skip placeholder/avatar images
4. Optional: resize to max 480x640 JPEG
5. If image URLs need login, support passing a Cookie header for requests

My old ERP base URL: [PASTE YOUR OLD ERP URL]
My admission number field in DB: admission_no
My image filename column: image
Upload path on server: uploads/student_images/

Also tell me the exact phpMyAdmin SQL to export AdmissionNo and image filename for active students only.

Do not store my ERP password in any file. I will paste cookies manually if needed.
```

Replace the bracketed values with your real old ERP URL and column names.

---

## Security

- Do not commit old ERP passwords or session cookies to GitHub.
- Change old ERP admin password if it was ever pasted into a chat.
