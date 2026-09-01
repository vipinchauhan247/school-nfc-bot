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

import os
import threading
import time
from datetime import datetime
from typing import Dict, Optional, Tuple
from zoneinfo import ZoneInfo

import requests

import bot
from config import public_base_url

IST = ZoneInfo("Asia/Kolkata")
CACHE_TTL_SEC = 120
IN_CUTOFF_HOUR = 11  # before 11:00 = IN, else OUT
# Start the follow-up lambda, then stop waiting for its body (Apps Script is slow).
FOLLOWUP_CONNECT_TIMEOUT = 1.0
FOLLOWUP_READ_TIMEOUT = 0.05


def _is_vercel() -> bool:
    return bool(os.environ.get("VERCEL"))

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
    """OLED-safe ASCII; no colons (ESP parses SUCCESS:Name:IN:time)."""
    clean = "".join(
        ch for ch in str(name or "Student")
        if 32 <= ord(ch) <= 126 and ch != ":"
    ).strip()
    return (clean or "Student")[:40]


def _row_to_student(row: dict, uid_fallback: str = "") -> Optional[dict]:
    if not isinstance(row, dict):
        return None
    adm = bot.normalize_admission(row.get("admissionNo") or row.get("admission") or "")
    uid = _normalize_uid(row.get("nfcUid") or uid_fallback)
    if not adm and not uid:
        return None
    if not adm:
        adm = uid or "unknown"
    return {
        "admissionNo": adm,
        "name": str(row.get("name") or "").strip() or f"Student {adm}",
        "className": str(row.get("className") or "").strip(),
        "nfcUid": uid,
        "telegramChatId": bot.normalize_chat_id(row.get("telegramChatId", "")),
    }


def _remember_student(student: dict) -> None:
    if not student:
        return
    adm = bot.normalize_admission(student.get("admissionNo", "")).lower()
    uid = _normalize_uid(student.get("nfcUid", ""))
    with _lock:
        if adm:
            _students_by_adm[adm] = student
        if uid:
            _students_by_uid[uid] = student


def _student_from_peek(peek, uid: str):
    """
    Returns:
      ("found", student) | ("missing", None) | ("error", None)
    """
    if not isinstance(peek, dict):
        return ("error", None)
    if peek.get("found") is False:
        return ("missing", None)
    row = peek.get("student") if isinstance(peek.get("student"), dict) else None
    student = _row_to_student(row, uid_fallback=uid) if row else None
    if not student and (peek.get("admissionNo") or peek.get("name") or peek.get("nfcUid")):
        student = _row_to_student(peek, uid_fallback=uid)
    if student:
        if not student.get("nfcUid"):
            student["nfcUid"] = uid
        return ("found", student)
    if peek.get("found") is True:
        return (
            "found",
            {
                "admissionNo": bot.normalize_admission(
                    peek.get("admissionNo") or peek.get("admission") or uid
                )
                or uid,
                "name": str(peek.get("name") or "Student").strip() or "Student",
                "className": str(peek.get("className") or "").strip(),
                "nfcUid": uid,
                "telegramChatId": bot.normalize_chat_id(peek.get("telegramChatId", "")),
            },
        )
    return ("error", None)


def _apply_peek_attendance(peek, admission: str) -> None:
    if not isinstance(peek, dict) or not admission:
        return
    att = peek.get("attendance") if isinstance(peek.get("attendance"), dict) else {}
    day = str(
        (att.get("date") if att else None)
        or peek.get("date")
        or _now_ist().strftime("%Y-%m-%d")
    )
    in_time = str((att.get("inTime") or att.get("in") or "")).strip()
    out_time = str((att.get("outTime") or att.get("out") or "")).strip()
    if not in_time and not out_time:
        return
    key = bot.normalize_admission(admission).lower()
    with _lock:
        _attendance_today[key] = {"date": day, "in": in_time, "out": out_time}


def _resolve_student(uid: str) -> Tuple[str, Optional[dict]]:
    """
    Cache-first student lookup. If this Vercel instance has no roster yet,
    peek this UID from Apps Script instead of returning ERROR.
    Returns ("found"|"missing"|"unknown", student_or_none).
    """
    with _lock:
        student = _students_by_uid.get(uid)
        cache_has_cards = bool(_students_by_uid)

    if student:
        return ("found", student)
    if cache_has_cards:
        return ("missing", None)

    peek = bot.apps_script_get({"action": "peek_uid", "uid": uid}, timeout=6)
    status, peeked = _student_from_peek(peek, uid)
    if status == "found" and peeked:
        _remember_student(peeked)
        _apply_peek_attendance(peek, peeked.get("admissionNo", ""))
        return ("found", peeked)
    if status == "missing":
        return ("missing", None)

    # Peek failed — load the full roster once (same as /warm).
    refresh_student_cache(force=True)
    with _lock:
        student = _students_by_uid.get(uid)
        cache_has_cards = bool(_students_by_uid)
    if student:
        return ("found", student)
    if cache_has_cards:
        return ("missing", None)
    return ("unknown", None)


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
        if _cache_loading and not force:
            return bool(_students_by_uid)
        _cache_loading = True

    try:
        rows = bot.get_all_students()
        by_uid: Dict[str, dict] = {}
        by_adm: Dict[str, dict] = {}
        for row in rows or []:
            student = _row_to_student(row)
            if not student:
                continue
            by_adm[student["admissionNo"].lower()] = student
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
        return bool(by_adm)
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


def _telegram_admin_new_card(uid: str) -> None:
    bot.send_telegram_message(
        bot.ADMIN_CHAT_ID,
        "🆕 <b>New Unregistered NFC Card Scanned!</b>\n\n"
        f"<b>Card UID:</b> <code>{bot.escape_html(uid)}</code>\n\n"
        "To link this card to a student, reply:\n"
        f"👉 <code>/link {bot.escape_html(uid)} &lt;Admission No&gt;</code>",
    )


def _background_admin_new_card(uid: str) -> None:
    try:
        _telegram_admin_new_card(uid)
        bot.apps_script_get({"uid": uid}, timeout=45)
        if not _is_vercel():
            threading.Thread(
                target=refresh_student_cache, kwargs={"force": True}, daemon=True
            ).start()
    except Exception as e:
        print(f"[NFC] new-card notify error: {e}")


def _background_admin_new_card_sheet(uid: str) -> None:
    """Apps Script log for new card (after Telegram already sent)."""
    try:
        bot.apps_script_get({"uid": uid}, timeout=45)
    except Exception as e:
        print(f"[NFC] new-card sheet log error: {e}")


def run_nfc_background(kind: str, uid: str, extra: Optional[dict] = None) -> str:
    """Sheet + Telegram work that must finish after the OLED reply."""
    uid = _normalize_uid(uid)
    extra = extra or {}
    try:
        if kind == "sync":
            _background_sheet_sync(uid)
            return "ok"
        if kind == "new_card":
            _background_admin_new_card(uid)
            return "ok"
        if kind == "new_card_sheet":
            _background_admin_new_card_sheet(uid)
            return "ok"
        if kind == "reconcile":
            _reconcile_duplicate(
                uid,
                extra.get("admission") or "",
                extra.get("day") or _now_ist().strftime("%Y-%m-%d"),
                extra.get("scan_type") or "IN",
            )
            return "ok"
        print(f"[NFC] unknown background kind={kind}")
        return "unknown"
    except Exception as e:
        print(f"[NFC] background kind={kind} uid={uid} error: {e}")
        return "error"


def _invoke_followup(kind: str, uid: str, extra: Optional[dict] = None) -> None:
    """
    Start a NEW Vercel invocation so Apps Script/Telegram survive after /nfc returns.
    Connect, then drop the body — the child keeps running independently.
    """
    base = public_base_url()
    if not base:
        print("[NFC] followup skipped — no public base URL")
        return
    url = base.rstrip("/") + "/nfc_bg"
    payload = {"kind": kind, "uid": uid, "extra": extra or {}}
    try:
        requests.post(
            url,
            json=payload,
            timeout=(FOLLOWUP_CONNECT_TIMEOUT, FOLLOWUP_READ_TIMEOUT),
            headers={"User-Agent": "MMM-NFC-Followup/1.0"},
        )
    except requests.Timeout:
        # Child accepted the request; we do not wait for Apps Script.
        pass
    except Exception as e:
        print(f"[NFC] followup invoke error: {e}")


def _after_response(kind: str, uid: str, extra: Optional[dict] = None) -> None:
    if _is_vercel():
        _invoke_followup(kind, uid, extra)
        return
    threading.Thread(
        target=run_nfc_background, args=(kind, uid, extra), daemon=True
    ).start()


def process_nfc_tap(raw_uid: str) -> str:
    """
    Fast path for ESP OLED. Always returns plain text (no JSON).
    Must not block on Google Apps Script when the card cache is already warm.
    """
    uid = _normalize_uid(raw_uid)
    if not uid:
        return "INVALID CARD"

    _schedule_cache_refresh(force=False)

    status, student = _resolve_student(uid)
    if status == "unknown":
        return "ERROR"
    if status != "found" or not student:
        if _is_vercel():
            try:
                _telegram_admin_new_card(uid)
            except Exception as e:
                print(f"[NFC] new-card telegram error: {e}")
            _after_response("new_card_sheet", uid)
        else:
            _after_response("new_card", uid)
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
        _after_response(
            "reconcile",
            uid,
            {"admission": admission, "day": day, "scan_type": scan_type},
        )
        return f"DUPLICATE:{name}:{existing}"

    _mark_local(admission, day, scan_type, time_str)
    _after_response("sync", uid)
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
