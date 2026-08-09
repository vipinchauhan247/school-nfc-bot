"""
@Vipinbellbot — instant reply + Google Sheet (via Apps Script).
Used by Render webhook at POST /bot_webhook (24/7, no PC).
"""

import time
import requests
from config import TELEGRAM_API, SCHOOL_NAME, APPS_SCRIPT_URL, BOT_TOKEN


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
        print("[BOT] APPS_SCRIPT_URL missing")
        return None
    try:
        resp = requests.get(APPS_SCRIPT_URL, params=params, timeout=timeout)
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


def find_student_on_sheet(admission_no):
    adm = normalize_admission(admission_no).lower()
    if not adm:
        return None
    data = apps_script_get({"action": "get_all_uids"})
    if not isinstance(data, list):
        return None
    for row in data:
        if normalize_admission(row.get("admissionNo", "")).lower() == adm:
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
                f"❌ Admission <code>{escape_html(arg1)}</code> not found on school sheet.",
            )
            return

        ok = save_chat_id_to_sheet(arg1, chat_id)
        name = escape_html(student.get("name") or "Student")
        if ok:
            send_telegram_message(
                chat_id,
                f"✅ <b>Registration Successful!</b>\n\n"
                f"Linked to: <b>{name}</b>\n"
                f"Admission: <code>{escape_html(arg1)}</code>\n\n"
                f"You will receive NFC gate attendance alerts on this chat.",
            )
        else:
            send_telegram_message(
                chat_id,
                f"⚠️ Found {name} but sheet save failed. Try again in 10 seconds.",
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
            send_telegram_message(chat_id, f"❌ Admission <code>{escape_html(arg1)}</code> not found.")
            return
        has_card = "✅" if student.get("nfcUid") else "❌"
        has_chat = "✅" if student.get("telegramChatId") else "❌"
        send_telegram_message(
            chat_id,
            f"📊 <b>Student Status</b>\n\n"
            f"Name: {escape_html(student.get('name', 'N/A'))}\n"
            f"Admission: <code>{escape_html(arg1)}</code>\n"
            f"NFC Card: {has_card}\n"
            f"Telegram: {has_chat}",
        )
        return

    send_telegram_message(
        chat_id,
        "Commands:\n"
        "<code>/register &lt;Admission No&gt;</code>\n"
        "<code>/link &lt;UID&gt; &lt;Admission No&gt;</code>\n"
        "<code>/status &lt;Admission No&gt;</code>",
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
