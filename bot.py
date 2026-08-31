"""
@Vipinbellbot — instant reply + Google Sheet (via Apps Script).
Used by Render webhook at POST /bot_webhook (24/7, no PC).
"""

import re
import os
import time
import requests
from config import TELEGRAM_API, SCHOOL_NAME, BOT_TOKEN

try:
    from config import APPS_SCRIPT_URL, ADMIN_CHAT_ID
except ImportError:
    APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL", "").strip()
    ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "1722022492").strip()


def send_telegram_message(chat_id, text, parse_mode="HTML"):
    if not TELEGRAM_API:
        print("[BOT] BOT_TOKEN missing — cannot send message")
        return None
    try:
        resp = requests.post(
            f"{TELEGRAM_API}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": parse_mode},
            timeout=15,
        )
        data = resp.json()
        if not data.get("ok"):
            print(f"[BOT] sendMessage failed for {chat_id}: {data}")
        return data
    except Exception as e:
        print(f"[BOT] sendMessage error: {e}")
        return None


def apps_script_get(params, timeout=25):
    if not APPS_SCRIPT_URL:
        print("[BOT] APPS_SCRIPT_URL missing — set it in Render Environment")
        return None
    try:
        resp = requests.get(APPS_SCRIPT_URL, params=params, timeout=timeout, allow_redirects=True)
        try:
            return resp.json()
        except Exception:
            return {"raw": (resp.text or "").strip(), "ok": resp.ok}
    except Exception as e:
        print(f"[BOT] Apps Script error: {e}")
        return None


def escape_html(text):
    return (
        str(text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def normalize_admission(value):
    s = str(value or "").strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def admissions_match(a, b):
    return normalize_admission(a).lower() == normalize_admission(b).lower()


def is_admin_chat(chat_id):
    return ADMIN_CHAT_ID and str(chat_id).strip() == ADMIN_CHAT_ID


def format_student_label(student, include_admission=True):
    name = escape_html((student or {}).get("name") or "Student")
    adm = normalize_admission((student or {}).get("admissionNo", ""))
    cls = escape_html((student or {}).get("className") or "")
    label = f"<b>{name}</b>"
    if cls:
        label += f" (Class {cls})"
    if include_admission and adm:
        label += f"\nAdmission: <code>{escape_html(adm)}</code>"
    return label


def get_all_students():
    data = apps_script_get({"action": "get_all_uids"}, timeout=45)
    return data if isinstance(data, list) else []


def find_student_on_sheet(admission_no):
    """Prefer single-row Apps Script lookup (fast/reliable). Fallback to full list."""
    adm = normalize_admission(admission_no)
    if not adm:
        return None

    result = apps_script_get(
        {"action": "find_student", "admission": adm},
        timeout=30,
    )
    if isinstance(result, dict) and result.get("ok") and isinstance(result.get("student"), dict):
        student = result["student"]
        student["admissionNo"] = normalize_admission(student.get("admissionNo") or adm)
        student["telegramChatId"] = normalize_chat_id(student.get("telegramChatId", ""))
        student["nfcUid"] = str(student.get("nfcUid") or "").replace(" ", "").replace(":", "").replace("-", "").upper()
        return student

    # Fallback: full sheet dump (older Apps Script without find_student)
    data = get_all_students()
    if not data:
        print(f"[SHEET] find_student failed for {adm}; get_all_uids empty/unavailable: {result}")
        return None
    needle = adm.lower()
    for row in data:
        if normalize_admission(row.get("admissionNo", "")).lower() == needle:
            return row
    return None


def find_student_by_chat_id(chat_id):
    """First linked student (legacy). Prefer find_all_students_by_chat_id."""
    matches = find_all_students_by_chat_id(chat_id)
    return matches[0] if matches else None


def normalize_chat_id(value):
    s = str(value or "").strip()
    if s.endswith(".0") and s[:-2].isdigit():
        s = s[:-2]
    return s


def get_linked_students_from_sheet(chat_id):
    cid = normalize_chat_id(chat_id)
    result = apps_script_get({"action": "whoami", "chatId": cid}, timeout=30)
    if isinstance(result, dict) and result.get("ok"):
        return result.get("students") or []
    return find_all_students_by_chat_id(chat_id)


def find_all_students_by_chat_id(chat_id):
    cid = normalize_chat_id(chat_id)
    if not cid:
        return []
    # Prefer whoami (small payload)
    result = apps_script_get({"action": "whoami", "chatId": cid}, timeout=30)
    if isinstance(result, dict) and result.get("ok"):
        return result.get("students") or []
    linked = []
    for row in get_all_students():
        if normalize_chat_id(row.get("telegramChatId", "")) == cid:
            linked.append(row)
    return linked


def _bump_nfc_cache():
    try:
        import nfc_gate
        nfc_gate.invalidate_student_cache()
    except Exception:
        pass
    # Vercel serverless: Node NFC cache is separate from Python webhook memory.
    base = (
        os.environ.get("PUBLIC_BASE_URL", "").strip()
        or os.environ.get("VERCEL_URL", "").strip()
    )
    if base and not base.startswith("http"):
        base = f"https://{base}"
    if base:
        try:
            requests.get(base.rstrip("/") + "/warm", timeout=8)
        except Exception as e:
            print(f"[NFC] warm ping after cache bump: {e}")


def chat_linked_to_admission(chat_id, admission_no):
    if is_admin_chat(chat_id):
        return True
    for row in find_all_students_by_chat_id(chat_id):
        if admissions_match(row.get("admissionNo"), admission_no):
            return True
    return False


def format_linked_students_list(students):
    if not students:
        return ""
    lines = []
    for s in students:
        lines.append("• " + format_student_label(s, include_admission=True))
    return "\n".join(lines)


def save_chat_id_to_sheet(admission_no, chat_id):
    result = apps_script_get(
        {
            "action": "save_chat_id",
            "admission": normalize_admission(admission_no),
            "chatId": str(chat_id).strip(),
        },
        timeout=30,
    )
    print(f"[SHEET] save_chat_id {admission_no} -> {result}")
    if not result:
        return False
    if isinstance(result, dict):
        if result.get("ok") is True:
            _bump_nfc_cache()
            return True
        if result.get("error") == "admission_linked_to_other_chat":
            return "blocked_other_parent"
    raw = str(result.get("raw", result) if isinstance(result, dict) else result).upper()
    ok = "TRUE" in raw or '"OK":TRUE' in raw.replace(" ", "")
    if ok:
        _bump_nfc_cache()
    return ok


def link_card_on_sheet(admission_no, uid):
    clean_uid = str(uid or "").replace(" ", "").replace(":", "").replace("-", "").upper()
    result = apps_script_get(
        {
            "action": "register_card",
            "admission": normalize_admission(admission_no),
            "uid": clean_uid,
        },
        timeout=30,
    )
    print(f"[SHEET] register_card {admission_no} {clean_uid} -> {result}")
    text = str(result.get("raw", result) if isinstance(result, dict) else result)
    ok = "SUCCESS" in text.upper() or "REGISTERED" in text.upper()
    if ok:
        _bump_nfc_cache()
    return ok

def get_attendance_from_sheet(admission_no, chat_id, date_str=""):
    params = {
        "action": "get_attendance",
        "admission": normalize_admission(admission_no),
        "chatId": str(chat_id).strip(),
    }
    if date_str:
        params["date"] = date_str
    result = apps_script_get(params)
    print(f"[SHEET] get_attendance {admission_no} -> {result}")
    if not isinstance(result, dict):
        return {"error": "fetch_failed"}
    if not result.get("ok"):
        return {"error": result.get("error") or "unknown"}
    return result.get("attendance") or {"error": "not_found"}


def looks_like_date(value):
    s = str(value or "").strip()
    if not s:
        return False
    if re.match(r"^\d{4}-\d{1,2}-\d{1,2}$", s):
        return True
    if re.match(r"^\d{1,2}[/-]\d{1,2}[/-]\d{4}$", s):
        return True
    return False


def parse_attendance_args(parts, chat_id):
    """Return (admission_no, date_str). Blank date_str = today."""
    arg1 = parts[1].strip() if len(parts) > 1 else ""
    arg2 = parts[2].strip() if len(parts) > 2 else ""

    if not arg1:
        linked = get_linked_students_from_sheet(chat_id)
        if len(linked) == 1:
            return (linked[0].get("admissionNo", ""), "")
        return ("", "")

    if arg2:
        if looks_like_date(arg2):
            return (arg1, arg2)
        if looks_like_date(arg1):
            return (arg2, arg1)
        return (arg1, arg2)

    if looks_like_date(arg1):
        linked = get_linked_students_from_sheet(chat_id)
        if len(linked) == 1:
            return (linked[0].get("admissionNo", ""), arg1)
        return ("", arg1)

    return (arg1, "")


def send_attendance_reply(chat_id, admission_no, record):
    if record.get("error") == "invalid_date":
        send_telegram_message(
            chat_id,
            "⚠️ Invalid date.\n\n"
            "Use: <code>/attendance 1725 09-08-2026</code>\n"
            "Or: <code>/attendance 1725 2026-08-09</code>",
        )
        return

    date_label = escape_html(record.get("date") or "today")
    adm = escape_html(record.get("admissionNo") or admission_no or "")
    name = escape_html(record.get("name") or "Student")

    if not record.get("found", True):
        send_telegram_message(
            chat_id,
            f"📭 <b>No attendance on {date_label}</b>\n\n"
            f"<b>{name}</b>\n"
            f"Admission: <code>{adm}</code>\n\n"
            "No IN/OUT record found on the Attendance sheet for this date.",
        )
        return

    in_time = record.get("inTime") or "—"
    out_time = record.get("outTime") or "—"
    send_telegram_message(
        chat_id,
        f"🕐 <b>Attendance — {date_label}</b>\n\n"
        f"<b>{name}</b>\n"
        f"Admission: <code>{adm}</code>\n\n"
        f"IN: <b>{escape_html(in_time)}</b>\n"
        f"OUT: <b>{escape_html(out_time)}</b>",
    )


def looks_like_nfc_uid(value):
    raw = str(value or "").strip().replace(" ", "").replace(":", "").replace("-", "")
    if not raw:
        return False
    if raw.isdigit() and len(raw) <= 6:
        return False
    return len(raw) >= 8 and all(c in "0123456789ABCDEFabcdef" for c in raw)


def handle_telegram_update(update):
    if not update or "message" not in update:
        return

    msg = update["message"]
    chat_id = msg.get("chat", {}).get("id")
    text = (msg.get("text") or "").strip()
    first_name = (msg.get("from") or {}).get("first_name", "Parent")

    if not chat_id or not text:
        return

    print(f"[BOT] {chat_id}: {text}")
    parts = text.split()
    cmd = parts[0].lower().lstrip("/").split("@")[0]
    arg1 = parts[1].strip() if len(parts) > 1 else ""
    arg2 = parts[2].strip() if len(parts) > 2 else ""

    if cmd in ("start", "help") and not arg1:
        send_telegram_message(
            chat_id,
            f"🏫 <b>{escape_html(SCHOOL_NAME)}</b>\n\n"
            f"Hello {escape_html(first_name)}!\n\n"
            f"<b>Parents — link for attendance alerts:</b>\n"
            f"<code>/register &lt;Admission No&gt;</code>\n"
            f"Example: <code>/register 1658</code>\n"
            f"<i>Two or more children? Register each admission on this same chat.</i>\n\n"
            f"<b>To check status of registration:</b>\n"
            f"<code>/status &lt;Admission No&gt;</code>\n"
            f"Example: <code>/status 1658</code>\n\n"
            f"<b>Today's IN / OUT time:</b>\n"
            f"<code>/attendance</code> — your linked child, today\n"
            f"<code>/attendance &lt;Admission No&gt;</code> — today\n"
            f"<code>/attendance &lt;Admission No&gt; &lt;Date&gt;</code> — past day\n"
            f"Date: <code>09-08-2026</code> or <code>2026-08-09</code>\n\n"
            f"<b>Check which child is linked to this chat:</b>\n"
            f"<code>/whoami</code>\n\n"
            f"<b>Admin — link new NFC card:</b>\n"
            f"<code>/link &lt;Card UID&gt; &lt;Admission No&gt;</code>\n"
            f"Example: <code>/link D7FE3B63 1658</code>",
        )
        return

    if cmd == "register" or (cmd == "start" and arg1):
        if not arg1:
            send_telegram_message(
                chat_id,
                "⚠️ Usage: <code>/register 1658</code>",
            )
            return
        if looks_like_nfc_uid(arg1):
            send_telegram_message(
                chat_id,
                "⚠️ That looks like a Card UID.\nUse <code>/register &lt;Admission No&gt;</code>",
            )
            return

        student = find_student_on_sheet(arg1)

        if not student:
            send_telegram_message(
                chat_id,
                f"❌ Admission <code>{escape_html(arg1)}</code> not found.\n\n"
                f"Check the number on the student's ID card / diary and try again.",
            )
            return

        existing_chat = normalize_chat_id(student.get("telegramChatId", ""))
        my_chat = normalize_chat_id(chat_id)

        if not is_admin_chat(chat_id):
            if existing_chat and existing_chat != my_chat:
                send_telegram_message(
                    chat_id,
                    f"⚠️ Admission <code>{escape_html(arg1)}</code> is already linked to another parent.\n\n"
                    f"Student: {format_student_label(student, include_admission=False)}\n\n"
                    "Contact school admin if you need help.",
                )
                return

        already_mine = existing_chat == my_chat and bool(existing_chat)

        ok = save_chat_id_to_sheet(arg1, chat_id)
        if ok == "blocked_other_parent":
            send_telegram_message(
                chat_id,
                f"⚠️ Admission <code>{escape_html(arg1)}</code> is already linked to another parent.\n\n"
                f"Student: {format_student_label(student, include_admission=False)}\n\n"
                "Contact school admin if you need help.",
            )
            return
        if ok is True:
            others = [
                s for s in find_all_students_by_chat_id(chat_id)
                if not admissions_match(s.get("admissionNo"), arg1)
            ]
            extra = ""
            if others:
                extra = (
                    "\n\n<b>Also linked on this chat:</b>\n"
                    + format_linked_students_list(others)
                )
            if already_mine:
                title = "✅ <b>Already linked</b>"
            else:
                title = "✅ <b>Registration Successful!</b>"
            send_telegram_message(
                chat_id,
                title + "\n\n"
                "Please verify this is YOUR child:\n"
                + format_student_label(student)
                + "\n\n"
                "You will receive NFC gate IN/OUT alerts for this child on this chat.\n"
                "<i>Another child? Send</i> <code>/register &lt;Admission No&gt;</code>"
                + extra,
            )
            return

        if not APPS_SCRIPT_URL:
            send_telegram_message(
                chat_id,
                "⚠️ Server misconfigured: APPS_SCRIPT_URL not set on Render. Contact school admin.",
            )
            return

        send_telegram_message(
            chat_id,
            f"⚠️ Found {escape_html(student.get('name', 'student'))} but sheet save failed. Try again in 10 seconds.",
        )
        return

    if cmd == "myid":
        send_telegram_message(
            chat_id,
            f"🆔 <b>Your Telegram Chat ID</b>\n\n<code>{escape_html(chat_id)}</code>\n\n"
            "Share this only with school admin if needed.",
        )
        return

    if cmd == "whoami":
        linked = get_linked_students_from_sheet(chat_id)
        if not linked:
            send_telegram_message(
                chat_id,
                "ℹ️ This Telegram chat is <b>not linked</b> yet.\n\n"
                "Use: <code>/register &lt;Admission No&gt;</code>\n"
                "Example: <code>/register 1725</code>\n\n"
                "<i>Register each child separately on this same chat.</i>",
            )
            return
        if len(linked) == 1:
            send_telegram_message(
                chat_id,
                "👤 <b>Your linked student</b>\n\n" + format_student_label(linked[0]),
            )
            return
        send_telegram_message(
            chat_id,
            f"👤 <b>Your linked students ({len(linked)})</b>\n\n"
            + format_linked_students_list(linked),
        )
        return

    if cmd == "link":
        if arg1 and arg2 and looks_like_nfc_uid(arg1):
            ok = link_card_on_sheet(arg2, arg1)
            if ok:
                send_telegram_message(
                    chat_id,
                    f"✅ <b>NFC Card Linked!</b>\n\n"
                    f"Admission: <code>{escape_html(arg2)}</code>\n"
                    f"Card UID: <code>{escape_html(arg1.upper())}</code>",
                )
            else:
                send_telegram_message(
                    chat_id,
                    f"❌ Card link failed for admission <code>{escape_html(arg2)}</code>.",
                )
            return
        send_telegram_message(
            chat_id,
            "⚠️ Usage: <code>/link &lt;Card UID&gt; &lt;Admission No&gt;</code>",
        )
        return

    if cmd == "status":
        if not arg1:
            send_telegram_message(chat_id, "⚠️ Usage: <code>/status 1658</code>")
            return
        student = find_student_on_sheet(arg1)
        if not student:
            send_telegram_message(
                chat_id,
                f"❌ Admission <code>{escape_html(arg1)}</code> not found on Google Sheet.\n\n"
                "Check the admission number and try again.",
            )
            return
        has_card = "✅" if student.get("nfcUid") else "❌"
        has_chat = "✅" if student.get("telegramChatId") else "❌"
        mismatch = ""
        if not is_admin_chat(chat_id) and student.get("telegramChatId"):
            if str(student.get("telegramChatId", "")).strip() == str(chat_id).strip():
                pass  # this admission is linked to caller
            elif not chat_linked_to_admission(chat_id, arg1):
                linked = find_all_students_by_chat_id(chat_id)
                if linked:
                    mismatch = (
                        "\n\n⚠️ <b>Note:</b> YOUR chat is linked to:\n"
                        + format_linked_students_list(linked)
                        + f"\n\nThis status is for admission <code>{escape_html(arg1)}</code>."
                    )
        send_telegram_message(
            chat_id,
            f"📊 <b>Student Status</b>\n\n"
            + format_student_label(student)
            + f"\nNFC Card: {has_card}\n"
            f"Telegram: {has_chat}"
            + mismatch,
        )
        return

    if cmd == "attendance" or cmd == "today":
        admission_no, date_str = parse_attendance_args(parts, chat_id)

        if not admission_no:
            linked = get_linked_students_from_sheet(chat_id)
            if len(linked) > 1:
                date_hint = ""
                if date_str:
                    date_hint = f" on <code>{escape_html(date_str)}</code>"
                send_telegram_message(
                    chat_id,
                    "⚠️ <b>Which child?</b> You have "
                    f"<b>{len(linked)}</b> children on this chat:\n\n"
                    + format_linked_students_list(linked)
                    + f"\n\nUse:\n<code>/attendance &lt;Admission No&gt;{date_hint}</code>",
                )
                return
            send_telegram_message(
                chat_id,
                "⚠️ <b>Usage</b>\n\n"
                "<code>/attendance</code> — today (one child linked)\n"
                "<code>/attendance 1725</code> — today\n"
                "<code>/attendance 1725 09-08-2026</code> — past day",
            )
            return

        if not APPS_SCRIPT_URL:
            send_telegram_message(
                chat_id,
                "⚠️ Server misconfigured: APPS_SCRIPT_URL not set on Render.",
            )
            return

        record = get_attendance_from_sheet(admission_no, chat_id, date_str)
        if record.get("error") == "not_authorized":
            linked = find_all_students_by_chat_id(chat_id)
            if linked:
                send_telegram_message(
                    chat_id,
                    "🔒 <b>Not linked to this admission</b>\n\n"
                    "YOUR chat is linked to:\n"
                    + format_linked_students_list(linked)
                    + "\n\nYou asked: <code>"
                    + escape_html(admission_no)
                    + "</code>\n\n"
                    "Use <code>/register "
                    + escape_html(admission_no)
                    + "</code> to add this child.",
                )
            else:
                send_telegram_message(
                    chat_id,
                    "🔒 Register first: <code>/register &lt;Admission No&gt;</code>\n"
                    "Then use <code>/attendance</code> with the <b>same</b> number.",
                )
            return

        if record.get("error") == "invalid_date":
            send_attendance_reply(chat_id, admission_no, record)
            return

        if record.get("error"):
            send_telegram_message(
                chat_id,
                f"❌ Could not load attendance for <code>{escape_html(admission_no)}</code>. Try again.",
            )
            return

        send_attendance_reply(chat_id, admission_no, record)
        return

    send_telegram_message(
        chat_id,
        "Commands:\n"
        "<code>/register &lt;Admission No&gt;</code>\n"
        "<code>/whoami</code>\n"
        "<code>/status &lt;Admission No&gt;</code>\n"
        "<code>/attendance</code> or <code>/attendance &lt;Adm&gt; [Date]</code>\n"
        "<code>/link &lt;UID&gt; &lt;Admission No&gt;</code>",
    )


def register_webhook(public_base_url):
    """Point Telegram to this Render service (instant push, no polling)."""
    if not BOT_TOKEN or not public_base_url:
        print("[BOT] Skip webhook — BOT_TOKEN or RENDER URL missing")
        return False
    webhook_url = public_base_url.rstrip("/") + "/bot_webhook"
    try:
        # Clear old webhook first
        resp = requests.get(
            f"{TELEGRAM_API}/setWebhook",
            params={"url": webhook_url, "drop_pending_updates": False},
            timeout=15,
        )
        data = resp.json()
        print(f"[BOT] setWebhook -> {webhook_url} => {data}")
        return bool(data.get("ok"))
    except Exception as e:
        print(f"[BOT] setWebhook error: {e}")
        return False
