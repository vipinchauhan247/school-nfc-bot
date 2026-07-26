import os
import sys
import time
import json
import threading
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

sys.stdout.reconfigure(encoding='utf-8')

# =========================================================================
# CONFIGURATION
# =========================================================================
SCHOOL_NAME = "Madan Mohan Malviya Junior High School"
BOT_TOKEN = "8990505731:AAHjAD0Mhc83BuuqKqaRkpFJBHdGVL9OC34"
SPREADSHEET_ID = "1tUTF6GSKXCGEXW8iMibG83InjoQK8SF_RWbFlJ1FxHQ"
TELEGRAM_API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}/"
APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyE5iWnZO4YxhHQt9I0VP31ArQaflndxL2G9Tr43rJUHVWPyn0geiMZJo9D_EfdC6CGnw/exec"

PORT = int(os.environ.get("PORT", 8080))

class HealthCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"Madan Mohan Malviya Junior High School Attendance Bot Active")

    def log_message(self, format, *args):
        return

def run_health_server():
    server = HTTPServer(("0.0.0.0", PORT), HealthCheckHandler)
    print(f"[HEALTH SERVER] Active on port {PORT}")
    server.serve_forever()

def send_telegram_msg(chat_id, text):
    url = TELEGRAM_API_BASE + "sendMessage"
    payload = {
        "chat_id": str(chat_id),
        "text": text,
        "parse_mode": "HTML"
    }
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
    try:
        urllib.request.urlopen(req)
        return True
    except Exception as e:
        print(f"send_telegram_msg error: {e}")
        return False

def handle_update(update):
    if "message" not in update or "text" not in update["message"]:
        return

    msg = update["message"]
    chat_id = msg["chat"]["id"]
    text = msg["text"].strip()
    first_name = msg.get("from", {}).get("first_name", "Parent")

    print(f"[RECEIVED COMMAND] '{text}' from Chat ID: {chat_id} (Parent: {first_name})")

    text_lower = text.lower()

    if text_lower in ["/start", "start"]:
        reply = (f"👋 <b>Welcome {first_name}!</b>\n\n"
                 f"Welcome to the official Attendance Portal for <b>{SCHOOL_NAME}</b>.\n\n"
                 f"To link your Telegram account for real-time attendance alerts, please type:\n"
                 f"👉 <code>/register &lt;Admission Number&gt;</code>\n\n"
                 f"<i>Example:</i> <code>/register 1234</code>")
        send_telegram_msg(chat_id, reply)

    elif text_lower in ["/help", "help"]:
        reply = (f"ℹ️ <b>{SCHOOL_NAME} - Help Guide</b>\n\n"
                 f"• <code>/start</code> - Welcome info\n"
                 f"• <code>/help</code> - Command list\n"
                 f"• <code>/register &lt;Admission Number&gt;</code> - Register parent account")
        send_telegram_msg(chat_id, reply)

    elif text_lower.startswith("/register") or text_lower.startswith("register"):
        parts = text.split()
        if len(parts) < 2:
            reply = "⚠️ <b>Missing Admission Number!</b>\n\n<b>Usage:</b> <code>/register &lt;Admission Number&gt;</code>\n<i>Example:</i> <code>/register 1234</code>"
            send_telegram_msg(chat_id, reply)
        else:
            admission_no = parts[1].strip()
            reply = f"✅ <b>Registration Successful!</b>\n\nLinked to Admission Number: <b>{admission_no}</b>\n\nDear <b>{first_name}</b>, you will now receive real-time attendance alerts for <b>{SCHOOL_NAME}</b>."
            send_telegram_msg(chat_id, reply)

            try:
                payload = {"update_id": update["update_id"], "message": msg}
                req = urllib.request.Request(APPS_SCRIPT_URL, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
                urllib.request.urlopen(req)
                print(f"  -> Synced Admission {admission_no} to Google Sheet")
            except Exception as e:
                print(f"  -> Sheet sync notice: {e}")
    else:
        reply = f"Unrecognized command. Type <code>/help</code> or <code>/register &lt;Admission Number&gt;</code> to register with <b>{SCHOOL_NAME}</b>."
        send_telegram_msg(chat_id, reply)

def start_bot():
    print("=========================================================================")
    print(f"  LAUNCHING 24/7 CLOUD BOT FOR: {SCHOOL_NAME}")
    print("=========================================================================")

    try:
        urllib.request.urlopen(TELEGRAM_API_BASE + "deleteWebhook")
        print("Webhook Status: Disabled successfully.")
    except Exception as e:
        print(f"Webhook reset notice: {e}")

    offset = 0
    while True:
        try:
            url = TELEGRAM_API_BASE + f"getUpdates?offset={offset}&timeout=5"
            req = urllib.request.Request(url)
            data = json.loads(req.read().decode('utf-8'))

            if data.get("ok") and data.get("result"):
                for update in data["result"]:
                    offset = update["update_id"] + 1
                    handle_update(update)
        except Exception as err:
            time.sleep(1)

if __name__ == "__main__":
    # Start Telegram Polling Engine in background thread
    t = threading.Thread(target=start_bot, daemon=True)
    t.start()

    # Run Health Server on Main Thread (Required for Render health checks!)
    run_health_server()
