"""
@Vipinbellbot — Render poller (instant reply + Google Sheet sync).

Rules:
- ERP must NOT poll this bot.
- Telegram webhook must be EMPTY (Render owns getUpdates).
- Env on Render:
    BOT_TOKEN=<Vipinbell token>
    APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
"""

import time
import requests
import database as db
from config import TELEGRAM_API, SCHOOL_NAME, APPS_SCRIPT_URL


def send_telegram_message(chat_id, text, parse_mode="HTML"):
    if not TELEGRAM_API:
        print("[BOT] No BOT_TOKEN configured, skipping message")
        return None
    url = f"{TELEGRAM_API}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    try:
        resp = requests.post(url, json=payload, timeout=8)
        return resp.json()
    except Exception as e:
        print(f"[ERROR] Failed to send Telegram message: {e}")
        return None


def apps_script_get(params, timeout=20):
    """Call Apps Script doGet (sheet save / card link)."""
    if not APPS_SCRIPT_URL:
        return None
    try:
        resp = requests.get(APPS_SCRIPT_URL, params=params, timeout=timeout)
        # Follow redirects; try parse JSON if possible
        text = (resp.text or "").strip()
        try:
            return resp.json()
        except Exception:
            return {"raw": text, "ok": resp.ok}
    except Exception as e:
        print(f"[ERROR] Apps Script GET failed: {e}")
        return None


def save_chat_id_to_sheet(admission_no, chat_id):
    """Instant sheet upload for parent Chat ID (column F)."""
    result = apps_script_get(
        {
            "action": "save_chat_id",
            "admission": str(admission_no).strip(),
            "chatId": str(chat_id).strip(),
        }
    )
    print(f"[SHEET] save_chat_id {admission_no} -> {result}")
    if not result:
        return False
    if isinstance(result, dict) and result.get("ok") is True:
        return True
    # Some deployments return plain text
    raw = str(result.get("raw", result)).upper()
    return "TRUE" in raw or '"OK":TRUE' in raw.replace(" ", "")


def link_card_on_sheet(admission_no, uid):
    result = apps_script_get(
        {
            "action": "register_card",
            "admission": str(admission_no).strip(),
            "uid": str(uid).strip(),
        }
    )
    print(f"[SHEET] register_card {admission_no} {uid} -> {result}")
    text = str(result)
    if isinstance(result, dict) and result.get("raw") is not None:
        text = str(result.get("raw"))
    return "SUCCESS" in text.upper() or "REGISTERED" in text.upper()


def notify_parent_attendance(student):
    if not student["telegram_chat_id"]:
        return
    msg = (
        f"✅ <b>Attendance Confirmed!</b>\n\n"
        f"👤 Student: {student['name']}\n"
        f"🔢 Admission No: {student['admission_no']}\n"
        f"📚 Class: {student['class_name']}\n"
        f"🕐 Time: {time.strftime('%I:%M %p')}\n"
        f"📅 Date: {time.strftime('%d %b %Y')}\n\n"
        f"Your child has arrived at {SCHOOL_NAME}."
    )
    send_telegram_message(student["telegram_chat_id"], msg)


def handle_update(update):
    if "message" not in update:
        return

    msg = update["message"]
    chat_id = msg.get("chat", {}).get("id")
    text = (msg.get("text") or "").strip()
    from_user = msg.get("from", {})
    user_first_name = from_user.get("first_name", "Parent")

    if not text or not chat_id:
        return

    print(f"[MESSAGE] From {user_first_name} ({chat_id}): {text}")

    if text.startswith("/start") or text == "/help":
        send_telegram_message(
            chat_id,
            f"🏫 Welcome to {SCHOOL_NAME}!\n\n"
            f"👋 Hello {user_first_name}!\n"
            f"Official Student Attendance Notification System.\n\n"
            f"📌 Commands:\n"
            f"• /register &lt;Admission No&gt; — link phone for alerts\n"
            f"• /status &lt;Admission No&gt; — today's attendance\n"
            f"• /help — this message\n\n"
            f"Example: /register 2211",
        )
        return

    if text.startswith("/register") or text.lower().startswith("register"):
        parts = text.split()
        if len(parts) < 2:
            send_telegram_message(
                chat_id,
                "⚠️ Please include Admission Number!\n\n"
                "Usage: /register &lt;Admission No&gt;\n"
                "Example: /register 2211",
            )
            return

        admission_no = parts[1].strip()
        student = db.get_student_by_admission(admission_no)

        # Instant sheet write (Google Sheet Students column F)
        sheet_ok = save_chat_id_to_sheet(admission_no, chat_id)

        if student:
            db.link_telegram(admission_no, chat_id)
            send_telegram_message(
                chat_id,
                f"✅ <b>Registration Successful!</b>\n\n"
                f"👤 Student: {student['name']}\n"
                f"📚 Class: {student['class_name']}\n"
                f"🔢 Admission No: {student['admission_no']}\n"
                f"📄 Sheet: {'saved' if sheet_ok else 'check sheet / Apps Script'}\n\n"
                f"You will receive attendance alerts on this chat.",
            )
            return

        # Not in Render SQLite — sheet is source of truth for school register
        if sheet_ok:
            send_telegram_message(
                chat_id,
                f"✅ <b>Registration Successful!</b>\n\n"
                f"🔢 Admission No: <code>{admission_no}</code>\n"
                f"Chat ID saved to school Google Sheet.\n\n"
                f"You will receive NFC gate attendance alerts on this chat.",
            )
        else:
            send_telegram_message(
                chat_id,
                f"❌ Admission number <code>{admission_no}</code> was not found "
                f"in the school register, or sheet save failed.\n\n"
                f"Check the number on the ID card / fee receipt, then try again.",
            )
        return

    if text.startswith("/status"):
        parts = text.split()
        if len(parts) < 2:
            send_telegram_message(chat_id, "⚠️ Usage: /status &lt;Admission No&gt;")
            return

        student = db.get_student_by_admission(parts[1])
        if not student:
            send_telegram_message(chat_id, f"❌ Student {parts[1]} not found on Render app DB.")
            return

        from datetime import date

        today = date.today().isoformat()
        with db.get_db() as conn:
            record = conn.execute(
                "SELECT time_in FROM attendance WHERE student_id = ? AND date = ?",
                (student["id"], today),
            ).fetchone()

        if record:
            send_telegram_message(
                chat_id,
                f"✅ {student['name']} is PRESENT today.\n🕐 Arrival: {record['time_in']}",
            )
        else:
            send_telegram_message(chat_id, f"⏳ {student['name']} has not checked in yet today.")
        return

    if text.startswith("/link") or text.lower().startswith("link"):
        parts = text.split()
        if len(parts) < 3:
            send_telegram_message(
                chat_id,
                "⚠️ Usage: /link &lt;Card UID&gt; &lt;Admission No&gt;\n"
                "Example: /link D7FE3B63 1658",
            )
            return

        uid = parts[1].strip()
        admission_no = parts[2].strip()
        ok = link_card_on_sheet(admission_no, uid)
        if ok:
            # Best-effort local DB too
            try:
                db.link_nfc_card(admission_no, uid.replace(":", "").replace("-", "").upper())
            except Exception:
                pass
            send_telegram_message(
                chat_id,
                f"✅ <b>NFC Card Linked!</b>\n\n"
                f"Admission: <code>{admission_no}</code>\n"
                f"Card UID: <code>{uid}</code>\n"
                f"Saved to Google Sheet.",
            )
        else:
            send_telegram_message(
                chat_id,
                f"❌ Card link failed for admission <code>{admission_no}</code>.\n"
                f"Check admission exists on the Students sheet.",
            )
        return


def start_polling():
    if not TELEGRAM_API:
        print("[BOT] No BOT_TOKEN set — Telegram bot disabled")
        return

    # Ensure webhook is clear so polling works
    try:
        requests.get(f"{TELEGRAM_API}/deleteWebhook", timeout=15)
        print("[BOT] Webhook cleared for Render polling")
    except Exception as e:
        print(f"[BOT] deleteWebhook warning: {e}")

    offset = 0
    print("[BOT] Telegram Polling Engine Started (instant replies)!")

    while True:
        try:
            url = f"{TELEGRAM_API}/getUpdates?offset={offset}&timeout=20"
            resp = requests.get(url, timeout=25)
            data = resp.json()

            if data.get("ok"):
                for update in data.get("result", []):
                    offset = update["update_id"] + 1
                    handle_update(update)
            else:
                desc = str(data)
                print(f"[BOT-WARNING] {data}")
                if "Conflict" in desc or "webhook" in desc.lower():
                    print("[BOT] Conflict — another webhook/poller is active. Clear webhook.")
                    try:
                        requests.get(f"{TELEGRAM_API}/deleteWebhook", timeout=15)
                    except Exception:
                        pass
                    time.sleep(10)
                else:
                    time.sleep(3)
        except Exception as e:
            print(f"[BOT-ERROR] {e}")
            time.sleep(3)
