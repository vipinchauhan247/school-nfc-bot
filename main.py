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
from config import SCHOOL_NAME, PORT, BOT_TOKEN, APPS_SCRIPT_URL, public_base_url

app = Flask(__name__)
RELEASE_VERSION = "school-header-single-alert-20260904"


def _public_base_url() -> str:
    configured = public_base_url()
    if configured:
        return configured
    try:
        return request.url_root.rstrip("/")
    except Exception:
        return ""


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
                "release": RELEASE_VERSION,
                "botConfigured": bool(BOT_TOKEN),
                "appsScriptConfigured": bool(APPS_SCRIPT_URL),
                "cache": cache,
            }
        )
    return (
        f"OK - @Vipinbellbot active on Render | "
        f"release={RELEASE_VERSION} "
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
    refresh_ok = False
    if not cache.get("cards"):
        refresh_ok = nfc_gate.refresh_student_cache(force=True)
        cache = nfc_gate.cache_status()
    else:
        threading.Thread(
            target=nfc_gate.refresh_student_cache, kwargs={"force": True}, daemon=True
        ).start()
        refresh_ok = True

    cards = cache.get("cards") or 0
    if cards:
        message = "NFC cache loaded"
    elif not APPS_SCRIPT_URL:
        message = "Cache empty — add APPS_SCRIPT_URL in Vercel Environment Variables"
    elif not refresh_ok:
        message = "Cache refresh failed — see cache.last_error"
    else:
        message = "Cache still empty after refresh — check Apps Script get_all_uids"

    webhook = {"ok": False, "url": ""}
    base = _public_base_url()
    if BOT_TOKEN and base:
        try:
            webhook = {
                "ok": bot.register_webhook(base),
                "url": base.rstrip("/") + "/bot_webhook",
            }
        except Exception as e:
            webhook = {"ok": False, "url": "", "error": str(e)}
            print(f"[WARM] webhook register error: {e}")

    return jsonify(
        {
            "ok": cards > 0,
            "message": message,
            "botConfigured": bool(BOT_TOKEN),
            "appsScriptConfigured": bool(APPS_SCRIPT_URL),
            "cacheRefreshOk": refresh_ok,
            "cache": cache,
            "webhook": webhook,
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
    try:
        text = nfc_gate.process_nfc_tap(uid)
    except Exception as e:
        print(f"[NFC] process error uid={uid}: {e}")
        text = "ERROR"
    print(f"[NFC] uid={uid} -> {text}")
    return Response(text.strip(), status=200, mimetype="text/plain")


@app.route("/nfc_bg", methods=["GET", "POST"])
def nfc_background():
    """
    Separate Vercel invocation for Sheet write + parent Telegram.
    /nfc returns first so the OLED stays fast; this route finishes the work.
    """
    payload = request.get_json(silent=True) or {}
    kind = (
        request.args.get("kind")
        or payload.get("kind")
        or "sync"
    )
    uid = (
        request.args.get("uid")
        or payload.get("uid")
        or ""
    )
    extra = payload.get("extra") if isinstance(payload.get("extra"), dict) else {}
    if request.args.get("admission"):
        extra = dict(extra)
        extra.setdefault("admission", request.args.get("admission"))
        extra.setdefault("day", request.args.get("day") or "")
        extra.setdefault("scan_type", request.args.get("scan_type") or "IN")
    result = nfc_gate.run_nfc_background(str(kind), str(uid), extra)
    return jsonify({"ok": result == "ok", "result": result}), 200


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
    base = _public_base_url()
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
    # Render: warm cache on boot. Vercel: use /warm (UptimeRobot) — avoid race on import.
    if not os.environ.get("VERCEL"):
        threading.Thread(target=warm_nfc_cache, daemon=True).start()
