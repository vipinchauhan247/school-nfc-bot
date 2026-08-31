"""
MMM School NFC Bot — Render 24/7 or Vercel (@Vipinbellbot only).

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


def _public_base_url() -> str:
    vercel = os.environ.get("VERCEL_URL", "").strip()
    if vercel:
        return f"https://{vercel}"
    render = os.environ.get("RENDER_EXTERNAL_URL", "").strip()
    if render:
        return render.rstrip("/")
    return request.url_root.rstrip("/")


@app.route("/")
def index():
    platform = "Vercel" if os.environ.get("VERCEL") else "Render"
    return (
        "<h1>MMM School NFC Bot</h1>"
        f"<p>@Vipinbellbot — fast NFC on {platform}</p>"
        "<ul>"
        "<li><a href='/health'>/health</a> — status check</li>"
        "<li><a href='/warm'>/warm</a> — reload card cache (UptimeRobot every 5 min)</li>"
        "<li><a href='/setup'>/setup</a> — connect Telegram webhook (open once after deploy)</li>"
        "<li><code>/nfc?uid=CARDUID</code> — fast NFC gate for ESP8266</li>"
        "</ul>",
        200,
    )


@app.route("/health")
def health():
    cache = nfc_gate.cache_status()
    if os.environ.get("VERCEL"):
        return jsonify(
            {
                "ok": True,
                "platform": "vercel",
                "service": "@Vipinbellbot NFC webhook",
                "cache": cache,
            }
        )
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
    Call before school gate / recess (or via UptimeRobot every 5 min).
    Reloads student cache so first taps stay fast.
    On Vercel, background threads may not finish — load sync when cache is empty.
    """
    cache = nfc_gate.cache_status()
    if not cache.get("cards"):
        nfc_gate.refresh_student_cache(force=True)
        cache = nfc_gate.cache_status()
    else:
        threading.Thread(
            target=nfc_gate.refresh_student_cache, kwargs={"force": True}, daemon=True
        ).start()
    return jsonify(
        {
            "ok": True,
            "message": "Warming NFC cache in background",
            "cache": cache,
            "platform": "vercel" if os.environ.get("VERCEL") else "render",
        }
    )


@app.route("/nfc", methods=["GET", "POST"])
def nfc_tap():
    """ESP8266 calls this instead of Google Apps Script for fast OLED response."""
    uid = (
        request.args.get("uid")
        or request.args.get("UID")
        or (request.get_json(silent=True) or {}).get("uid")
        or ""
    )
    if not uid and request.form:
        uid = request.form.get("uid", "")
    text = nfc_gate.process_nfc_tap(uid)
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
    """Open once after deploy to register Telegram webhook."""
    base = _public_base_url()
    if not BOT_TOKEN:
        return "Set BOT_TOKEN in Environment first.", 500
    ok = bot.register_webhook(base)
    if ok:
        return f"Webhook OK: {base}/bot_webhook", 200
    return "Webhook failed — check deployment logs.", 500


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
    # Gunicorn / Render / Vercel import path — warm cache on cold start
    threading.Thread(target=warm_nfc_cache, daemon=True).start()
