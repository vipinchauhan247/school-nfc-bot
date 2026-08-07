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
        resp = requests.post(url, json=payload, timeout=5)
        return resp.json()
    except Exception as e:
        print(f"[ERROR] Failed to send Telegram message: {e}")
        return None


def notify_parent_attendance(student):
    if not student["telegram_chat_id"]:
        return
    msg = (
        f"✅ <b>Attendance Confirmed!</b>\n\n"
        f"👤 <b>Student:</b> {student['name']}\n"
        f"🔢 <b>Admission No:</b> {student['admission_no']}\n"
        f"📚 <b>Class:</b> {student['class_name']}\n"
        f"🕐 <b>Time:</b> {time.strftime('%I:%M %p')}\n"
        f"📅 <b>Date:</b> {time.strftime('%d %b %Y')}\n\n"
        f"<i>Your child has arrived at {SCHOOL_NAME}.</i>"
    )
    send_telegram_message(student["telegram_chat_id"], msg)


def handle_update(update):
    if "message" not in update:
        return

    msg = update["message"]
    chat_id = msg.get("chat", {}).get("id")
    text = msg.get("text", "").strip()
    from_user = msg.get("from", {})
    user_first_name = from_user.get("first_name", "Parent")

    if not text or not chat_id:
        return

    print(f"[MESSAGE] From {user_first_name} ({chat_id}): {text}")

    if text.startswith("/start") or text == "/help":
        welcome_msg = (
            f"🏫 <b>Welcome to {SCHOOL_NAME}!</b>\n\n"
            f"👋 Hello <b>{user_first_name}</b>!\n"
            f"This is the official Student Attendance Notification System.\n\n"
            f"📌 <b>Available Commands:</b>\n"
            f"• <code>/register &lt;Admission No&gt;</code> — Link your phone for alerts\n"
            f"• <code>/status &lt;Admission No&gt;</code> — Check today's attendance\n"
            f"• <code>/help</code> — Show this message\n\n"
            f"<i>Example:</i> <code>/register 2211</code>"
        )
        send_telegram_message(chat_id, welcome_msg)

    elif text.startswith("/register") or text.lower().startswith("register"):
        parts = text.split()
        if len(parts) < 2:
            send_telegram_message(
                chat_id,
                "⚠️ <b>Please include your child's Admission Number!</b>\n\n"
                "<i>Usage:</i> <code>/register &lt;Admission No&gt;</code>\n"
                "<i>Example:</i> <code>/register 2211</code>",
            )
            return

        admission_no = parts[1]
        student = db.get_student_by_admission(admission_no)

        if APPS_SCRIPT_URL and not student:
            try:
                requests.post(APPS_SCRIPT_URL, json=update, timeout=10)
                return
            except Exception as e:
                print(f"[ERROR] Apps Script forward failed: {e}")

        if not student:
            send_telegram_message(
                chat_id,
                f"❌ <b>Admission number {admission_no} not found.</b>\n\n"
                "Please check the number and try again, or contact the school office.",
            )
            return

        db.link_telegram(admission_no, chat_id)
        send_telegram_message(
            chat_id,
            f"✅ <b>Registration Successful!</b>\n\n"
            f"👤 <b>Student:</b> {student['name']}\n"
            f"📚 <b>Class:</b> {student['class_name']}\n"
            f"🔢 <b>Admission No:</b> {student['admission_no']}\n\n"
            f"You will now receive instant notifications when your child arrives at school.",
        )

    elif text.startswith("/status"):
        parts = text.split()
        if len(parts) < 2:
            send_telegram_message(chat_id, "⚠️ Usage: <code>/status &lt;Admission No&gt;</code>")
            return

        student = db.get_student_by_admission(parts[1])
        if not student:
            send_telegram_message(chat_id, f"❌ Student with admission no <b>{parts[1]}</b> not found.")
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
                f"✅ <b>{student['name']}</b> is <b>PRESENT</b> today.\n"
                f"🕐 Arrival time: <b>{record['time_in']}</b>",
            )
        else:
            send_telegram_message(
                chat_id,
                f"⏳ <b>{student['name']}</b> has not checked in yet today.",
            )

    elif text.startswith("/link") or text.lower().startswith("link"):
        if APPS_SCRIPT_URL:
            try:
                requests.post(APPS_SCRIPT_URL, json=update, timeout=10)
                return
            except Exception as e:
                print(f"[ERROR] Apps Script forward failed: {e}")
                send_telegram_message(chat_id, "⚠️ Server error while linking card.")


def start_polling():
    if not TELEGRAM_API:
        print("[BOT] No BOT_TOKEN set — Telegram bot disabled")
        return

    offset = 0
    print("[BOT] Telegram Polling Engine Started!")

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
                print(f"[BOT-WARNING] Telegram API response not OK: {data}")
                time.sleep(3)
        except Exception as e:
            print(f"[BOT-ERROR] Polling exception: {e}")
            time.sleep(3)
