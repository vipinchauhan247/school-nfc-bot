import os
import sys
import time
import json
import threading
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

sys.stdout.reconfigure(encoding='utf-8')

BOT_TOKEN = "8990505731:AAHjAD0Mhc83BuuqKqaRkpFJBHdGVL9OC34"
SPREADSHEET_ID = "1tUTF6GSKXCGEXW8iMibG83InjoQK8SF_RWbFlJ1FxHQ"
TELEGRAM_API_BASE = f"https://api.telegram.org/bot{BOT_TOKEN}/"
APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyE5iWnZO4YxhHQt9I0VP31ArQaflndxL2G9Tr43rJUHVWPyn0geiMZJo9D_EfdC6CGnw/exec"

PORT = int(os.environ.get("PORT", 8080))

# 1. Simple HTTP Health Check Server for 24/7 Cloud Hosting
class HealthCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"School NFC Attendance Bot - 24/7 Cloud Service Active")

    def log_message(self, format, *args):
        return  # Suppress HTTP access logs

def run_health_server():
    server = HTTPServer(("0.0.0.0", PORT), HealthCheckHandler)
    print(f"[HEALTH SERVER] Listening on port {PORT}")
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

    print(f"[RECEIVED COMMAND] '{text}' from Chat ID: {chat_id}")

    text_lower = text.lower()

    if text_lower in ["/start", "start"]:
        reply = f"👋 <b>Welcome {first_name}!</b>\n\nWelcome to the <b>School NFC Attendance Bot</b>.\n\nTo register, type:\n👉 <code>/register &lt;Admission Number&gt;</code>\n\n<i>Example:</i> <code>/register 1234</code>"
        send_telegram_msg(chat_id, reply)

    elif text_lower in ["/help", "help"]:
        reply = "ℹ️ <b>School NFC Attendance Bot - Help Guide</b>\n\n• <code>/start</code> - Start bot\n• <code>/help</code> - Command guide\n• <code>/register &lt;Admission Number&gt;</code> - Register parent"
        send_telegram_msg(chat_id, reply)

    elif text_lower.startswith("/register") or text_lower.startswith("register"):
        parts = text.split()
        if len(parts) < 2:
            reply = "⚠️ <b>Missing Admission Number!</b>\n\n<b>Usage:</b> <code>/register &lt;Admission Number&gt;</code>\n<i>Example:</i> <code>/register 1234</code>"
            send_telegram_msg(chat_id, reply)
        else:
            admission_no = parts[1].strip()
            reply = f"✅ <b>Registration Successful!</b>\n\nLinked to Admission Number: <b>{admission_no}</b>"
            send_telegram_msg(chat_id, reply)

            try:
                payload = {"update_id": update["update_id"], "message": msg}
                req = urllib.request.Request(APPS_SCRIPT_URL, data=json.dumps(payload).encode('utf-8'), headers={'Content-Type': 'application/json'})
                urllib.request.urlopen(req)
                print(f"  -> Synced Admission {admission_no} to Google Sheet")
            except Exception as e:
                print(f"  -> Sheet sync notice: {e}")
    else:
        reply = "Unrecognized command. Type <code>/help</code> or <code>/register &lt;Admission Number&gt;</code> to register."
        send_telegram_msg(chat_id, reply)

def start_bot():
    print("=========================================================================")
    print("  LAUNCHING 24/7 CLOUD POLLING BOT ENGINE")
    print("=========================================================================")

    try:
        urllib.request.urlopen(TELEGRAM_API_BASE + "deleteWebhook?drop_pending_updates=true")
        print("Webhook Status: Disabled successfully.")
    except Exception as e:
        print(f"Webhook reset notice: {e}")

    offset = 0
    while True:
        try:
            url = TELEGRAM_API_BASE + f"getUpdates?offset={offset}&timeout=5"
            req = urllib.request.urlopen(url)
            data = json.loads(req.read().decode('utf-8'))

            if data.get("ok") and data.get("result"):
                for update in data["result"]:
                    offset = update["update_id"] + 1
                    handle_update(update)
        except Exception as err:
            time.sleep(1)

if __name__ == "__main__":
    # Start Health Check Server Thread
    t = threading.Thread(target=run_health_server, daemon=True)
    t.start()

    # Start Main Telegram Polling Engine
    start_bot()
