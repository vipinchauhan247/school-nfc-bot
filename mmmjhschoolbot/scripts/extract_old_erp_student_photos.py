#!/usr/bin/env python3
"""Download student photos from the old Smart School ERP for bulk upload into MMM ERP.

The new ERP bulk uploader matches files by admission number in the filename:
  1813.jpg, 1813 Abhimanyu.jpg, adm-1813.png, IMG_1813.jpeg

Output of this script: one JPEG per student named {AdmissionNo}.jpg

Three ways to use it (pick the one that matches what you have):

  A) Saved student list HTML from old ERP admin (browser Save Page As)
     python extract_old_erp_student_photos.py --html student_list.html -o photos_out

  B) CSV with admission number + photo URL (export from DB or scrape once)
     python extract_old_erp_student_photos.py --csv photo_manifest.csv -o photos_out

  C) Folder already copied from old server uploads/ (rename by manifest)
     python extract_old_erp_student_photos.py --csv manifest.csv --copy-from uploads/student_images -o photos_out

Getting photo URLs without server access:
  1. Log in to old ERP admin.
  2. Open Student Details → Student List (all classes or one class at a time).
  3. Scroll to load all rows, then Save Page As → Web Page, Complete OR Single File HTML.
  4. Run mode A on that HTML file.

If you have cPanel / FTP on old hosting:
  1. Download folder: uploads/student_images/ (or entire uploads/)
  2. Export students table column `image` from phpMyAdmin as CSV (id, admission_no, image).
  3. Build manifest: AdmissionNo, FileName — then use mode C.

Requires: Python 3.8+, pip install requests pillow (optional resize)
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    import requests
except ImportError:
    requests = None  # type: ignore

try:
    from PIL import Image
except ImportError:
    Image = None  # type: ignore


def normalize_adm(value: str) -> str:
    s = str(value or "").strip().replace("#", "")
    m = re.search(r"\d{2,}", s)
    return m.group(0) if m else s


def resize_jpeg(path: Path, max_w: int = 480, max_h: int = 640, quality: int = 85) -> None:
    if Image is None:
        return
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
            im.save(path, "JPEG", quality=quality, optimize=True)
    except Exception as exc:
        print(f"  warn: could not resize {path.name}: {exc}", file=sys.stderr)


class StudentListHtmlParser(HTMLParser):
    """Best-effort: each table row with an admission number and an img → one photo."""

    def __init__(self, base_url: str = "") -> None:
        super().__init__()
        self.base_url = base_url
        self.in_tr = False
        self.in_td = False
        self.row_text: list[str] = []
        self.row_imgs: list[str] = []
        self.pairs: list[tuple[str, str]] = []
        self._cell_text = ""
        self._all_imgs: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        attr = dict(attrs)
        if tag == "tr":
            self.in_tr = True
            self.row_text = []
            self.row_imgs = []
        elif tag == "td" and self.in_tr:
            self.in_td = True
            self._cell_text = ""
        elif tag == "img":
            src = attr.get("src") or attr.get("data-src") or ""
            if not src or src.startswith("data:"):
                return
            url = urljoin(self.base_url, src) if self.base_url else src
            if self.in_tr:
                self.row_imgs.append(url)
            else:
                self._all_imgs.append(url)

    def handle_endtag(self, tag: str) -> None:
        if tag == "td" and self.in_td:
            self.in_td = False
            self.row_text.append(re.sub(r"\s+", " ", self._cell_text).strip())
        elif tag == "tr" and self.in_tr:
            self.in_tr = False
            adm = self._find_adm_in_row(self.row_text)
            img = self._pick_student_img(self.row_imgs)
            if adm and img:
                self.pairs.append((adm, img))

    def handle_data(self, data: str) -> None:
        if self.in_td:
            self._cell_text += data

    @staticmethod
    def _find_adm_in_row(cells: list[str]) -> str:
        for cell in cells:
            adm = normalize_adm(cell)
            if adm and re.fullmatch(r"\d{2,}", adm):
                return adm
        joined = " ".join(cells)
        m = re.search(r"\b(\d{3,5})\b", joined)
        return m.group(1) if m else ""

    @staticmethod
    def _pick_student_img(urls: list[str]) -> str:
        if not urls:
            return ""
        for u in urls:
            low = u.lower()
            if any(x in low for x in ("student", "upload", "photo", "profile", "thumb")):
                return u
            if "placeholder" in low or "avatar" in low or "user.jpg" in low:
                continue
        return urls[0]


def parse_html_file(path: Path, base_url: str = "") -> list[tuple[str, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    parser = StudentListHtmlParser(base_url=base_url)
    parser.feed(text)
    pairs = list(parser.pairs)

    # Fallback: img URLs with admission in path/filename
    if not pairs:
        for m in re.finditer(
            r'src=["\']([^"\']*(?:uploads|student)[^"\']*)["\']',
            text,
            re.I,
        ):
            url = m.group(1)
            adm_m = re.search(r"(\d{3,5})", url)
            if adm_m:
                full = urljoin(base_url, url) if base_url else url
                pairs.append((adm_m.group(1), full))

    # De-dupe by admission
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for adm, url in pairs:
        if adm in seen:
            continue
        seen.add(adm)
        out.append((adm, url))
    return out


def read_csv_manifest(path: Path) -> list[tuple[str, str]]:
    rows: list[tuple[str, str]] = []
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            return rows
        fields = {h.strip().lower(): h for h in reader.fieldnames}
        adm_key = next(
            (fields[k] for k in fields if k in ("admissionno", "admission_no", "adm", "admission no", "admission number")),
            None,
        )
        url_key = next(
            (fields[k] for k in fields if k in ("photourl", "photo_url", "photo", "image", "image_url", "url", "filename", "file")),
            None,
        )
        if not adm_key:
            raise SystemExit(f"CSV needs an AdmissionNo column. Found: {reader.fieldnames}")
        if not url_key:
            raise SystemExit(f"CSV needs PhotoUrl or FileName column. Found: {reader.fieldnames}")

        for row in reader:
            adm = normalize_adm(row.get(adm_key, ""))
            val = str(row.get(url_key, "") or "").strip()
            if adm and val:
                rows.append((adm, val))
    return rows


def download_photo(url: str, dest: Path, session: requests.Session, timeout: int = 30) -> bool:
    if requests is None:
        raise SystemExit("Install requests: pip install requests")
    try:
        r = session.get(url, timeout=timeout, stream=True)
        r.raise_for_status()
        dest.write_bytes(r.content)
        return True
    except Exception as exc:
        print(f"  fail download {url}: {exc}", file=sys.stderr)
        return False


def copy_local_file(src_folder: Path, filename: str, dest: Path) -> bool:
    name = filename.strip().replace("\\", "/").split("/")[-1]
    candidates = [
        src_folder / name,
        src_folder / filename.strip(),
    ]
    for c in candidates:
        if c.is_file():
            shutil.copy2(c, dest)
            return True
    return False


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract old ERP student photos → {AdmissionNo}.jpg")
    ap.add_argument("-o", "--output", type=Path, required=True, help="Output folder for renamed photos")
    ap.add_argument("--html", type=Path, help="Saved student list HTML from old ERP")
    ap.add_argument("--csv", type=Path, help="CSV manifest: AdmissionNo + PhotoUrl or FileName")
    ap.add_argument("--base-url", default="", help="Old ERP site root, e.g. https://old-school.com/ (for relative img src)")
    ap.add_argument("--copy-from", type=Path, help="Local uploads folder when CSV FileName column is a filename only")
    ap.add_argument("--cookie", default="", help="Optional Cookie header if downloads need login session")
    ap.add_argument("--resize", action="store_true", help="Resize to max 480x640 JPEG (needs pillow)")
    ap.add_argument("--dry-run", action="store_true", help="List matches only, do not write files")
    args = ap.parse_args()

    pairs: list[tuple[str, str]] = []
    if args.html:
        pairs.extend(parse_html_file(args.html, base_url=args.base_url))
    if args.csv:
        pairs.extend(read_csv_manifest(args.csv))

    if not pairs:
        ap.error("No photos found. Pass --html and/or --csv.")

    # De-dupe
    merged: dict[str, str] = {}
    for adm, ref in pairs:
        merged[adm] = ref

    args.output.mkdir(parents=True, exist_ok=True)
    session = requests.Session() if requests else None
    if session and args.cookie:
        session.headers["Cookie"] = args.cookie

    ok = skip = 0
    for adm, ref in sorted(merged.items(), key=lambda x: int(x[0]) if x[0].isdigit() else x[0]):
        dest = args.output / f"{adm}.jpg"
        if args.dry_run:
            print(f"{adm} <- {ref}")
            ok += 1
            continue

        is_url = ref.startswith("http://") or ref.startswith("https://")
        is_local = Path(ref).is_file()

        if is_local:
            shutil.copy2(ref, dest)
            success = True
        elif is_url and session:
            success = download_photo(ref, dest, session)
        elif args.copy_from:
            success = copy_local_file(args.copy_from, ref, dest)
        else:
            print(f"  skip {adm}: not a URL and --copy-from not set ({ref})", file=sys.stderr)
            skip += 1
            continue

        if success:
            if args.resize:
                resize_jpeg(dest)
            print(f"ok {adm}.jpg")
            ok += 1
        else:
            skip += 1

    print(f"\nDone: {ok} saved, {skip} skipped → {args.output.resolve()}")
    print("Next: MMM ERP → Students → Bulk Photo Upload → select all files from that folder.")


if __name__ == "__main__":
    main()
