/**
 * Run in Chrome/Edge while logged in to old ERP student list.
 *
 * 1. Open https://madanmohanmalviyaschool.com and sign in as admin
 * 2. Go to Student Information → Student Details (or /student/search)
 * 3. Select session + class, click Search so the table with photos appears
 * 4. Press F12 → Console → paste this whole file → Enter
 * 5. Downloads photo_manifest.csv — repeat per class if needed
 * 6. On PC: python extract_old_erp_student_photos.py --csv photo_manifest.csv -o photos_out --resize
 *
 * Optional: pass your session cookie to the Python script if direct download fails:
 *   F12 → Network → click any request → Headers → copy Cookie value
 */
(function exportOldErpPhotoManifest() {
  const BASE = 'https://madanmohanmalviyaschool.com/';
  const rows = [];
  const seen = new Set();

  function normalizeAdm(text) {
    const m = String(text || '').match(/\b(\d{3,5})\b/);
    return m ? m[1] : '';
  }

  function pickImg(tr) {
    const imgs = Array.from(tr.querySelectorAll('img[src]'));
    for (const img of imgs) {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;
      const low = src.toLowerCase();
      if (low.includes('logo') || low.includes('avatar') || low.includes('placeholder')) continue;
      if (low.includes('upload') || low.includes('student') || low.includes('photo') || low.includes('thumb')) {
        return new URL(src, BASE).href;
      }
    }
    return imgs[0] ? new URL(imgs[0].src, BASE).href : '';
  }

  document.querySelectorAll('table tbody tr').forEach(tr => {
    const adm = normalizeAdm(tr.innerText);
    const url = pickImg(tr);
    if (!adm || !url || seen.has(adm)) return;
    seen.add(adm);
    rows.push({ adm, url });
  });

  if (!rows.length) {
    console.warn('No rows found. Make sure the student table is visible on screen, then run again.');
    return;
  }

  const csv = ['AdmissionNo,PhotoUrl', ...rows.map(r => `${r.adm},${r.url}`)].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `photo_manifest_${document.title.replace(/\W+/g, '_').slice(0, 40)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  console.log(`Exported ${rows.length} photo URLs. Merge CSVs from each class, then run extract_old_erp_student_photos.py`);
})();
