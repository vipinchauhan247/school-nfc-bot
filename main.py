"""
MMM School NFC Bot — Render 24/7 (@Vipinbellbot only).

Telegram sends updates to POST /bot_webhook (instant, no PC polling).
"""

import os
import threading
import time
import urllib.request

from flask import Flask, request

import bot
from config import SCHOOL_NAME, PORT, BOT_TOKEN

app = Flask(__name__)


@app.route("/health")
def health():
    return "OK - @Vipinbellbot active on Render", 200


@app.route("/bot_webhook", methods=["POST"])
def telegram_webhook():
    try:
        update = request.get_json(force=True, silent=True)
        if update:
            bot.handle_telegram_update(update)
    except Exception as e:
        print(f"[WEBHOOK] error: {e}")
    return "OK", 200


@app.route("/setup")
def setup():
    """Open once after deploy: https://school-nfc-bot.onrender.com/setup"""
    base = os.environ.get("RENDER_EXTERNAL_URL", request.url_root.rstrip("/"))
    if not BOT_TOKEN:
        return "Set BOT_TOKEN in Render Environment first.", 500
    ok = bot.register_webhook(base)
    if ok:
        return f"Webhook OK: {base}/bot_webhook", 200
    return "Webhook failed — check Render logs.", 500


def keep_alive():
    """Ping /health every 4 min so Render free tier stays warm."""
    base = os.environ.get("RENDER_EXTERNAL_URL", "")
    if not base:
        return
    time.sleep(20)
    url = base.rstrip("/") + "/health"
    print(f"[KEEP-ALIVE] {url}")
    while True:
        try:
            time.sleep(240)
            req = urllib.request.Request(url, headers={"User-Agent": "MMM-KeepAlive/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"[KEEP-ALIVE] status {resp.status}")
        except Exception as e:
            print(f"[KEEP-ALIVE] {e}")


def auto_setup_webhook():
    time.sleep(3)
    base = os.environ.get("RENDER_EXTERNAL_URL", "")
    if base and BOT_TOKEN:
        bot.register_webhook(base)


if __name__ == "__main__":
    print(f"[APP] {SCHOOL_NAME} — Render bot starting on port {PORT}")
    if os.environ.get("RENDER_EXTERNAL_URL"):
        threading.Thread(target=keep_alive, daemon=True).start()
        threading.Thread(target=auto_setup_webhook, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT, debug=False)
