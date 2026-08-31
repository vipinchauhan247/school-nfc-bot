"""
Fast NFC gate for ESP8266.
Reply from in-memory cache first; sync Google Sheet + Telegram in background.
OLED response format stays identical to Apps Script:
  SUCCESS:Name:IN:HH:mm:ss | SUCCESS:Name:OUT:HH:mm:ss
  DUPLICATE:Name:HH:mm:ss
  INVALID CARD

Never block the ESP request on Google Apps Script (avoids HTTP -11 timeouts).
Attendance memory is reconciled from the Sheet so deleted rows clear DUPLICATE.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Dict
from zoneinfo import ZoneInfo

import bot

IST = ZoneInfo("Asia/Kolkata")
CACHE_TTL_SEC = 120
IN_CUTOFF_HOUR = 11  # before 11:00 = IN, else OUT

_lock = threading.Lock()
_students_by_uid: Dict[str, dict] = {}
_students_by_adm: Dict[str, dict] = {}
_attendance_today: Dict[str, dict] = {}  # admission -> {"date", "in", "out"}
_cache_loaded_at = 0.0
_cache_loading = False
_last_refresh_error = ""


def _now_ist() -> datetime:
    return datetime.now(IST)


def _normalize_uid(raw: str) -> str:
    return str(raw or "").replace(" ", "").replace(":", "").replace("-", "").upper()


def _safe_name(name: str) -> str:
    """OLED-safe ASCII; keep readable."""
    clean = "".join(ch for ch in str(name or "Student") if 32 <= ord(ch) <= 126).strip()
    return (clean or "Student")[:40]


def _apply_today_attendance_map(payload: dict) -> None:
    """Replace today's in-memory attendance from Sheet truth."""
    if not isinstance(payload, dict) or not payload.get("ok"):
        return
    day = str(payload.get("date") or _now_ist().strftime("%Y-%m-%d"))
    raw_map = payload.get("attendance") or {}
    if not isinstance(raw_map, dict):
        return
    rebuilt: Dict[str, dict] = {}
    for adm_key, row in raw_map.items():
        if not isinstance(row, dict):
            continue
        adm = bot.normalize_admission(row.get("admissionNo") or adm_key).lower()
        if not adm:
            continue
        rebuilt[adm] = {
            "date": day,
            "in": str(row.get("in") or "").strip(),
            "out": str(row.get("out") or "").strip(),
        }
    with _lock:
        # Drop stale same-day memory not on sheet (deleted rows)
        for key in list(_attendance_today.keys()):
            row = _attendance_today.get(key) or {}
            if row.get("date") == day and key not in rebuilt:
                del _attendance_today[key]
        for key, row in rebuilt.items():
            _attendance_today[key] = row
    print(f"[NFC] attendance reconciled from sheet: {len(rebuilt)} rows for {day}")


def refresh_attendance_from_sheet() -> bool:
    try:
        payload = bot.apps_script_get({"action": "today_attendance"}, timeout=45)
        if isinstance(payload, dict):
            _apply_today_attendance_map(payload)
            return True
    except Exception as e:
        print(f"[NFC] attendance refresh error: {e}")
    return False


def refresh_student_cache(force: bool = False) -> bool:
    """Load students from Apps Script. Call from background / startup only."""
    global _cache_loaded_at, _cache_loading, _students_by_uid, _students_by_adm, _last_refresh_error
    if not bot.APPS_SCRIPT_URL:
        _last_refresh_error = "APPS_SCRIPT_URL not set in environment"
        print(f"[NFC] {_last_refresh_error}")
        return False
    now = time.time()
    with _lock:
        if not force and _students_by_uid and (now - _cache_loaded_at) < CACHE_TTL_SEC:
            return True
        if _cache_loading:
            return bool(_students_by_uid)
        _cache_loading = True

    try:
        rows = bot.get_all_students()
        by_uid: Dict[str, dict] = {}
        by_adm: Dict[str, dict] = {}
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            adm = bot.normalize_admission(row.get("admissionNo", ""))
            if not adm:
                continue
            student = {
                "admissionNo": adm,
                "name": str(row.get("name") or "").strip() or f"Student {adm}",
                "className": str(row.get("className") or "").strip(),
                "nfcUid": _normalize_uid(row.get("nfcUid", "")),
                "telegramChatId": bot.normalize_chat_id(row.get("telegramChatId", "")),
            }
            by_adm[adm.lower()] = student
            if student["nfcUid"]:
                by_uid[student["nfcUid"]] = student
        with _lock:
            if by_adm:  # don't wipe good cache on empty/failed fetch
                _students_by_uid = by_uid
                _students_by_adm = by_adm
                _cache_loaded_at = time.time()
                _last_refresh_error = ""
            else:
                _last_refresh_error = "get_all_uids returned no students (check Apps Script)"
        print(f"[NFC] cache refreshed: {len(by_adm)} students, {len(by_uid)} cards")
        # Keep DUPLICATE memory aligned with Attendance tab
        refresh_attendance_from_sheet()
        return True
    except Exception as e:
        _last_refresh_error = str(e)
        print(f"[NFC] cache refresh error: {e}")
        return False
    finally:
        with _lock:
            _cache_loading = False


def _schedule_cache_refresh(force: bool = False) -> None:
    """Non-blocking cache refresh so /nfc never waits on Google Script."""
    with _lock:
        age = time.time() - _cache_loaded_at if _cache_loaded_at else 99999
        loading = _cache_loading
        has_cache = bool(_students_by_uid)
    if loading:
        return
    if not force and has_cache and age < CACHE_TTL_SEC:
        return
    threading.Thread(
        target=refresh_student_cache, kwargs={"force": force}, daemon=True
    ).start()


def invalidate_student_cache() -> None:
    global _cache_loaded_at
    with _lock:
        _cache_loaded_at = 0.0
    _schedule_cache_refresh(force=True)


def _attendance_bucket(admission: str, day: str) -> dict:
    key = admission.lower()
    with _lock:
        row = _attendance_today.get(key)
        if not row or row.get("date") != day:
            row = {"date": day, "in": "", "out": ""}
            _attendance_today[key] = row
        return row


def _mark_local(admission: str, day: str, scan_type: str, time_str: str) -> None:
    row = _attendance_bucket(admission, day)
    with _lock:
        if scan_type == "IN":
            row["in"] = time_str
        else:
            row["out"] = time_str


def _clear_local_scan(admission: str, day: str, scan_type: str) -> None:
    row = _attendance_bucket(admission, day)
    with _lock:
        if scan_type == "IN":
            row["in"] = ""
        else:
            row["out"] = ""


def _background_sheet_sync(uid: str) -> None:
    """Let Apps Script write Attendance + send Telegram (source of truth)."""
    try:
        result = bot.apps_script_get({"uid": uid}, timeout=45)
        print(f"[NFC] background sheet sync {uid} -> {result}")
        raw = ""
        if isinstance(result, dict):
            raw = str(result.get("raw") or "")
        else:
            raw = str(result or "")
        # After write, pull Sheet attendance so memory matches
        refresh_attendance_from_sheet()
        print(f"[NFC] sync raw={raw[:120]}")
    except Exception as e:
        print(f"[NFC] background sync error: {e}")


def _reconcile_duplicate(uid: str, admission: str, day: str, scan_type: str) -> None:
    """If Attendance row was deleted on Sheet, clear Render memory so next tap is SUCCESS."""
    try:
        peek = bot.apps_script_get({"action": "peek_uid", "uid": uid}, timeout=30)
        if not isinstance(peek, dict) or not peek.get("ok"):
            refresh_attendance_from_sheet()
            return
        if not peek.get("found"):
            # UID removed from Students → next tap NEW CARD is correct
            with _lock:
                _students_by_uid.pop(_normalize_uid(uid), None)
            print(f"[NFC] peek: UID {uid} no longer on Students")
            return
        att = peek.get("attendance") or {}
        sheet_val = (att.get("inTime") if scan_type == "IN" else att.get("outTime")) or ""
        if not str(sheet_val).strip():
            _clear_local_scan(admission, day, scan_type)
            print(f"[NFC] cleared local {scan_type} for {admission} (deleted on sheet)")
        else:
            # Keep sheet time as truth
            _mark_local(admission, day, scan_type, str(sheet_val).strip())
    except Exception as e:
        print(f"[NFC] reconcile error: {e}")


def _background_admin_new_card(uid: str) -> None:
    try:
        refresh_student_cache(force=True)
        with _lock:
            if uid in _students_by_uid:
                print(f"[NFC] UID {uid} appeared after refresh — skip admin alert")
                return
        bot.send_telegram_message(
            bot.ADMIN_CHAT_ID,
            "🆕 <b>New Unregistered NFC Card Scanned!</b>\n\n"
            f"<b>Card UID:</b> <code>{bot.escape_html(uid)}</code>\n\n"
            "To link this card to a student, reply:\n"
            f"👉 <code>/link {bot.escape_html(uid)} &lt;Admission No&gt;</code>",
        )
        bot.apps_script_get({"uid": uid}, timeout=45)
    except Exception as e:
        print(f"[NFC] new-card notify error: {e}")


def process_nfc_tap(raw_uid: str) -> str:
    """
    Fast path for ESP OLED. Always returns plain text (no JSON).
    Must not block on Google Apps Script.
    """
    uid = _normalize_uid(raw_uid)
    if not uid:
        return "INVALID CARD"

    _schedule_cache_refresh(force=False)

    with _lock:
        student = _students_by_uid.get(uid)
        cache_empty = not _students_by_uid

    if cache_empty:
        _schedule_cache_refresh(force=True)
        return "ERROR"

    if not student:
        threading.Thread(target=_background_admin_new_card, args=(uid,), daemon=True).start()
        return "INVALID CARD"

    now = _now_ist()
    day = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M:%S")
    scan_type = "IN" if now.hour < IN_CUTOFF_HOUR else "OUT"
    name = _safe_name(student.get("name") or "Student")
    admission = bot.normalize_admission(student.get("admissionNo", ""))

    bucket = _attendance_bucket(admission, day)
    with _lock:
        existing = bucket.get("in") if scan_type == "IN" else bucket.get("out")

    if existing:
        # Sheet may have been cleared — reconcile in background; tap again in a few seconds
        threading.Thread(
            target=_reconcile_duplicate,
            args=(uid, admission, day, scan_type),
            daemon=True,
        ).start()
        return f"DUPLICATE:{name}:{existing}"

    _mark_local(admission, day, scan_type, time_str)
    threading.Thread(target=_background_sheet_sync, args=(uid,), daemon=True).start()
    return f"SUCCESS:{name}:{scan_type}:{time_str}"


def cache_status() -> dict:
    with _lock:
        return {
            "students": len(_students_by_adm),
            "cards": len(_students_by_uid),
            "age_sec": int(time.time() - _cache_loaded_at) if _cache_loaded_at else None,
            "attendance_rows": len(_attendance_today),
            "last_error": _last_refresh_error or None,
        }
