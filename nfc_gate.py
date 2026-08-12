"""
Fast NFC gate for ESP8266.
Reply from in-memory cache first; sync Google Sheet + Telegram in background.
OLED response format stays identical to Apps Script:
  SUCCESS:Name:IN:HH:mm:ss | SUCCESS:Name:OUT:HH:mm:ss
  DUPLICATE:Name:HH:mm:ss
  INVALID CARD
"""

from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Any, Dict, Optional
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


def _now_ist() -> datetime:
    return datetime.now(IST)


def _normalize_uid(raw: str) -> str:
    return str(raw or "").replace(" ", "").replace(":", "").replace("-", "").upper()


def _safe_name(name: str) -> str:
    """OLED-safe ASCII; keep readable."""
    clean = "".join(ch for ch in str(name or "Student") if 32 <= ord(ch) <= 126).strip()
    return (clean or "Student")[:40]


def refresh_student_cache(force: bool = False) -> bool:
    global _cache_loaded_at, _cache_loading, _students_by_uid, _students_by_adm
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
            _students_by_uid = by_uid
            _students_by_adm = by_adm
            _cache_loaded_at = time.time()
        print(f"[NFC] cache refreshed: {len(by_adm)} students, {len(by_uid)} cards")
        return True
    except Exception as e:
        print(f"[NFC] cache refresh error: {e}")
        return False
    finally:
        with _lock:
            _cache_loading = False


def invalidate_student_cache() -> None:
    global _cache_loaded_at
    with _lock:
        _cache_loaded_at = 0.0


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


def _background_sheet_sync(uid: str) -> None:
    """Let Apps Script write Attendance + send Telegram (source of truth)."""
    try:
        result = bot.apps_script_get({"uid": uid}, timeout=45)
        print(f"[NFC] background sheet sync {uid} -> {result}")
    except Exception as e:
        print(f"[NFC] background sync error: {e}")


def _background_admin_new_card(uid: str) -> None:
    try:
        bot.send_telegram_message(
            bot.ADMIN_CHAT_ID,
            "🆕 <b>New Unregistered NFC Card Scanned!</b>\n\n"
            f"<b>Card UID:</b> <code>{bot.escape_html(uid)}</code>\n\n"
            "To link this card to a student, reply:\n"
            f"👉 <code>/link {bot.escape_html(uid)} &lt;Admission No&gt;</code>",
        )
        # Also let Apps Script record/alert if desired
        bot.apps_script_get({"uid": uid}, timeout=45)
    except Exception as e:
        print(f"[NFC] new-card notify error: {e}")


def process_nfc_tap(raw_uid: str) -> str:
    """
    Fast path for ESP OLED. Always returns plain text (no JSON).
    """
    uid = _normalize_uid(raw_uid)
    if not uid:
        return "INVALID CARD"

    refresh_student_cache(force=False)

    with _lock:
        student = _students_by_uid.get(uid)

    if not student:
        # One forced refresh in case card was linked recently
        refresh_student_cache(force=True)
        with _lock:
            student = _students_by_uid.get(uid)

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
        }
