import os
import time
import requests
import urllib.request
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

# ============================================================================
# CONFIGURATION
# ============================================================================

BOT_TOKEN = "8990505731:AAHjAD0Mhc83BuuqKqaRkpFJBHdGVL9OC34"
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyE5iWnZO4YxhHQt9I0VP31ArQaflndxL2G9Tr43rJUHVWPyn0geiMZJo9D_EfdC6CGnw/exec"
SCHOOL_NAME = "Madan Mohan Malviya Junior High School"

PORT = int(os.environ.get("PORT", 8080))

# ============================================================================
# DUMMY DOCKER HEALTH CHECK SERVER
# ============================================================================

class HealthCheckHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"OK - School NFC Attendance Bot Engine Active")

    def log_message(self, format, *args):
        return

def run_dummy_server():
    server_address = ("", PORT)
    httpd = HTTPServer(server_address, HealthCheckHandler)
    print(f"[HEALTH-CHECK] HTTP Server listening on port {PORT}...")
    httpd.serve_forever()

def self_ping_keep_alive():
    time.sleep(15)
    render_url = os.environ.get("RENDER_EXTERNAL_URL", f"http://127.0.0.1:{PORT}")
    print(f"[KEEP-ALIVE] Initialized self-ping targeting {render_url}")
    
    while True:
        try:
            time.sleep(240) # Ping every 4 minutes to prevent Render free-tier sleep
            req = urllib.request.Request(render_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req) as resp:
                print(f"[KEEP-ALIVE] Ping sent successfully. Response code: {resp.status}")
        except Exception as e:
            print(f"[KEEP-ALIVE] Ping warning: {e}")

# ============================================================================
# TELEGRAM BOT ENGINE
# ============================================================================

def send_telegram_message(chat_id, text, parse_mode="HTML"):
    url = f"{TELEGRAM_API}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": parse_mode
    }
    try:
        resp = requests.post(url, json=payload, timeout=5)
        return resp.json()
    except Exception as e:
        print(f"[ERROR] Failed to send Telegram message: {e}")
        return None

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
            f"📌 <b>How to Register Your Phone:</b>\n"
            f"To receive instant attendance alerts when your child arrives at school, please send:\n\n"
            f"👉 <code>/register &lt;Admission No&gt;</code>\n\n"
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
                "<i>Example:</i> <code>/register 2211</code>"
            )
        else:
            # Forward registration command to Apps Script for single verified message
            try:
                print(f"[REGISTRATION] Forwarding update for admission '{parts[1]}' to Apps Script...")
                requests.post(APPS_SCRIPT_URL, json=update, timeout=10)
            except Exception as e:
                print(f"[ERROR] Failed to forward registration to Apps Script: {e}")
                send_telegram_message(chat_id, "⚠️ Server error. Please try again in a few moments.")

    elif text.startswith("/link") or text.lower().startswith("link"):
        # Forward card linking command to Apps Script
        try:
            print(f"[CARD LINKING] Forwarding /link command to Apps Script...")
            requests.post(APPS_SCRIPT_URL, json=update, timeout=10)
        except Exception as e:
            print(f"[ERROR] Failed to forward link command to Apps Script: {e}")
            send_telegram_message(chat_id, "⚠️ Server error while linking card.")

def start_polling():
    offset = 0
    print("[BOT] Telegram Polling Engine Started Successfully!")
    
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
            print(f"[BOT-ERROR] Exception in polling loop: {e}")
            time.sleep(3)

# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

if __name__ == "__main__":
    t_server = threading.Thread(target=run_dummy_server, daemon=True)
    t_server.start()

    t_ping = threading.Thread(target=self_ping_keep_alive, daemon=True)
    t_ping.start()

    start_polling()
