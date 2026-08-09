"""
@Vipinbellbot — instant reply + Google Sheet (via Apps Script).
Used by Render webhook at POST /bot_webhook (24/7, no PC).
"""

import re
import time
import requests
from config import TELEGRAM_API, SCHOOL_NAME, APPS_SCRIPT_URL, BOT_TOKEN, ADMIN_CHAT_ID


def send_telegram_message(chat_id, text, parse_mode="HTML"):
    if not TELEGRAM_API:
        print("[BOT] BOT_TOKEN missing — cannot send message")
        return None
    try:
        resp = requests.post(
            f"{TELEGRAM_API}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": parse_mode},
            timeout=10,
        )
        return resp.json()
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
    data = apps_script_get({"action": "get_all_uids"})
    return data if isinstance(data, list) else []


def find_student_on_sheet(admission_no):
    adm = normalize_admission(admission_no).lower()
    if not adm:
        return None
    data = get_all_students()
    if not data:
        return None
    for row in data:
        if normalize_admission(row.get("admissionNo", "")).lower() == adm:
            return row
    return None


def find_student_by_chat_id(chat_id):
    cid = str(chat_id or "").strip()
    if not cid:
        return None
    for row in get_all_students():
        if str(row.get("telegramChatId", "")).strip() == cid:
            return row
    return None


def save_chat_id_to_sheet(admission_no, chat_id):
    result = apps_script_get(
        {
            "action": "save_chat_id",
            "admission": normalize_admission(admission_no),
            "chatId": str(chat_id).strip(),
        }
    )
    print(f"[SHEET] save_chat_id {admission_no} -> {result}")
    if not result:
        return False
    if isinstance(result, dict) and result.get("ok") is True:
        return True
    raw = str(result.get("raw", result)).upper()
    return "TRUE" in raw or '"OK":TRUE' in raw.replace(" ", "")


def link_card_on_sheet(admission_no, uid):
    clean_uid = str(uid or "").replace(" ", "").replace(":", "").replace("-", "").upper()
    result = apps_script_get(
        {
            "action": "register_card",
            "admission": normalize_admission(admission_no),
            "uid": clean_uid,
        }
    )
    print(f"[SHEET] register_card {admission_no} {clean_uid} -> {result}")
    text = str(result.get("raw", result) if isinstance(result, dict) else result)
    return "SUCCESS" in text.upper() or "REGISTERED" in text.upper()


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
        linked = find_student_by_chat_id(chat_id)
        return ((linked or {}).get("admissionNo", ""), "")

    if arg2:
        if looks_like_date(arg2):
            return (arg1, arg2)
        if looks_like_date(arg1):
            return (arg2, arg1)
        return (arg1, arg2)

    if looks_like_date(arg1):
        linked = find_student_by_chat_id(chat_id)
        return ((linked or {}).get("admissionNo", ""), arg1)

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
            f"Example: <code>/register 1658</code>\n\n"
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

        if not is_admin_chat(chat_id):
            linked_here = find_student_by_chat_id(chat_id)
            if linked_here and not admissions_match(linked_here.get("admissionNo"), arg1):
                send_telegram_message(
                    chat_id,
                    "⚠️ <b>This Telegram is already linked to another student</b>\n\n"
                    + format_student_label(linked_here)
                    + "\n\nYou tried: <code>"
                    + escape_html(arg1)
                    + "</code>\n\n"
                    "If the admission number is wrong, contact school admin to fix the link.",
                )
                return

            existing_chat = str(student.get("telegramChatId", "")).strip()
            if existing_chat and existing_chat != str(chat_id).strip():
                send_telegram_message(
                    chat_id,
                    f"⚠️ Admission <code>{escape_html(arg1)}</code> is already linked to another parent.\n\n"
                    f"Student: {format_student_label(student, include_admission=False)}\n\n"
                    "If you typed the wrong admission number, use the correct one from the ID card.\n"
                    "Contact school admin if you need help.",
                )
                return

        # Sheet is source of truth (no Render/SQLite database)
        ok = save_chat_id_to_sheet(arg1, chat_id)
        if ok:
            send_telegram_message(
                chat_id,
                "✅ <b>Registration Successful!</b>\n\n"
                "Please verify this is YOUR child:\n"
                + format_student_label(student)
                + "\n\n"
                "Chat ID saved to <b>Google Sheet</b>.\n"
                "You will receive NFC gate attendance alerts on this chat.\n\n"
                "Wrong name? Send <code>/whoami</code> and contact school admin immediately.",
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

    if cmd == "whoami":
        linked = find_student_by_chat_id(chat_id)
        if not linked:
            send_telegram_message(
                chat_id,
                "ℹ️ This Telegram chat is <b>not linked</b> yet.\n\n"
                "Use: <code>/register &lt;Admission No&gt;</code>\n"
                "Example: <code>/register 1725</code>",
            )
            return
        send_telegram_message(
            chat_id,
            "👤 <b>Your linked student</b>\n\n" + format_student_label(linked),
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
                f"❌ Admission <code>{escape_html(arg1)}</code> not found on "
                f"<b>Google Sheet</b> (not a Render database).",
            )
            return
        has_card = "✅" if student.get("nfcUid") else "❌"
        has_chat = "✅" if student.get("telegramChatId") else "❌"
        linked_here = find_student_by_chat_id(chat_id)
        mismatch = ""
        if linked_here and not admissions_match(linked_here.get("admissionNo"), arg1):
            mismatch = (
                "\n\n⚠️ <b>Note:</b> YOUR chat is linked to "
                + format_student_label(linked_here, include_admission=True)
                + "\nYou asked about a <b>different</b> admission number."
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
            send_telegram_message(
                chat_id,
                "⚠️ <b>Usage</b>\n\n"
                "<code>/attendance</code> — today (after <code>/register</code>)\n"
                "<code>/attendance 1725</code> — today\n"
                "<code>/attendance 1725 09-08-2026</code> — that day\n"
                "<code>/attendance 09-08-2026</code> — your child, that day",
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
            linked = find_student_by_chat_id(chat_id)
            if linked:
                send_telegram_message(
                    chat_id,
                    "🔒 <b>Admission number does not match your link</b>\n\n"
                    "YOUR chat is linked to:\n"
                    + format_student_label(linked)
                    + "\n\nYou asked about: <code>"
                    + escape_html(admission_no)
                    + "</code>\n\n"
                    "Check the admission number on the student's ID card.\n"
                    "Send <code>/whoami</code> to see your linked student.",
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
        requests.get(f"{TELEGRAM_API}/deleteWebhook", params={"drop_pending_updates": True}, timeout=15)
        resp = requests.get(
            f"{TELEGRAM_API}/setWebhook",
            params={"url": webhook_url, "drop_pending_updates": True},
            timeout=15,
        )
        data = resp.json()
        print(f"[BOT] setWebhook -> {webhook_url} => {data}")
        return bool(data.get("ok"))
    except Exception as e:
        print(f"[BOT] setWebhook error: {e}")
        return False
