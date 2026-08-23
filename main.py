"""
MMM School NFC Bot — Render 24/7 (@Vipinbellbot only).

Telegram: POST /bot_webhook
NFC box:  GET  /nfc?uid=XXXX   (fast OLED reply; Sheet/Telegram in background)
"""

import os
import threading
import time
import urllib.request

from flask import Flask, request, Response, jsonify

import bot
import nfc_gate
from config import SCHOOL_NAME, PORT, BOT_TOKEN

app = Flask(__name__)


@app.route("/")
def index():
    return (
        "<h1>MMM School NFC Bot</h1>"
        "<p>@Vipinbellbot — 24/7 on Render</p>"
        "<ul>"
        "<li><a href='/health'>/health</a> — status check</li>"
        "<li><a href='/warm'>/warm</a> — wake server + reload card cache (use before 8 AM / 2 PM)</li>"
        "<li><a href='/setup'>/setup</a> — connect Telegram webhook (open once after deploy)</li>"
        "<li><code>/nfc?uid=CARDUID</code> — fast NFC gate for ESP8266</li>"
        "</ul>",
        200,
    )


@app.route("/health")
def health():
    cache = nfc_gate.cache_status()
    return (
        f"OK - @Vipinbellbot active on Render | "
        f"students={cache.get('students')} cards={cache.get('cards')} "
        f"cache_age_sec={cache.get('age_sec')} "
        f"attendance_rows={cache.get('attendance_rows')}",
        200,
    )


@app.route("/warm")
def warm():
    """
    Call this before school gate / recess (or via UptimeRobot every 5 min).
    Wakes Render and reloads student cache so first taps stay fast.
    """
    threading.Thread(target=nfc_gate.refresh_student_cache, kwargs={"force": True}, daemon=True).start()
    cache = nfc_gate.cache_status()
    return jsonify(
        {
            "ok": True,
            "message": "Warming NFC cache in background",
            "cache": cache,
        }
    )


@app.route("/nfc", methods=["GET", "POST"])
def nfc_tap():
    """ESP8266 calls this instead of Google Apps Script for fast OLED response."""
    body = request.get_json(silent=True) or {}
    uid = (
        request.args.get("uid")
        or request.args.get("UID")
        or body.get("uid")
        or ""
    )
    if not uid and request.form:
        uid = request.form.get("uid", "")
    battery = (
        request.args.get("battery")
        or request.form.get("battery")
        or body.get("battery")
        or ""
    )
    text = nfc_gate.process_nfc_tap(uid)
    if battery != "":
        print(f"[NFC] uid={uid} battery={battery} -> {text}")
    else:
        print(f"[NFC] uid={uid} -> {text}")
    return Response(text, status=200, mimetype="text/plain")


@app.route("/bot_webhook", methods=["POST"])
def telegram_webhook():
    if not BOT_TOKEN:
        print("[WEBHOOK] BOT_TOKEN missing in Render Environment")
        return "BOT_TOKEN missing", 503
    try:
        update = request.get_json(force=True, silent=True)
        if not update:
            return "EMPTY", 400
        bot.handle_telegram_update(update)
        return "OK", 200
    except Exception as e:
        print(f"[WEBHOOK] error: {e}")
        return "ERROR", 500


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
    """Ping /health every 2.5 min so Render free tier stays warm."""
    base = os.environ.get("RENDER_EXTERNAL_URL", "")
    if not base:
        return
    time.sleep(15)
    url = base.rstrip("/") + "/health"
    print(f"[KEEP-ALIVE] {url}")
    while True:
        try:
            time.sleep(150)
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


def warm_nfc_cache():
    time.sleep(5)
    try:
        nfc_gate.refresh_student_cache(force=True)
    except Exception as e:
        print(f"[NFC] warm cache error: {e}")


if __name__ == "__main__":
    print(f"[APP] {SCHOOL_NAME} — Render bot starting on port {PORT}")
    if os.environ.get("RENDER_EXTERNAL_URL"):
        threading.Thread(target=keep_alive, daemon=True).start()
        threading.Thread(target=auto_setup_webhook, daemon=True).start()
        threading.Thread(target=warm_nfc_cache, daemon=True).start()
    app.run(host="0.0.0.0", port=PORT, debug=False)
else:
    # Gunicorn / Render import path
    threading.Thread(target=warm_nfc_cache, daemon=True).start()
