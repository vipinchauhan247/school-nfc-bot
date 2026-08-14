"""
MMM School service:

1) NFC attendance  — @Vipinbellbot + NFC attendance Google Sheet (nfc_gate / bot)
2) ERP mobile/web  — @mmmjhschoolbot + MMMJHS Telegram / ERP Google Sheet (erp_sheet)

These two stacks must stay separate.
"""

import os
import threading
import time
import urllib.parse
import urllib.request
from functools import wraps

from flask import (
    Flask,
    Response,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from flask_cors import CORS

import bot
import database as db
import erp_sheet
import nfc_gate
from config import (
    ADMIN_PASSWORD,
    ERP_APPS_SCRIPT_URL,
    ERP_BOT_TOKEN,
    ERP_BOT_USERNAME,
    ERP_TELEGRAM_API,
    NFC_BOT_TOKEN,
    NFC_BOT_USERNAME,
    PORT,
    SCHOOL_NAME,
)

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "school-attendance-secret-key-change-me")
CORS(app, resources={r"/api/*": {"origins": "*"}})


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("admin_login"))
        return f(*args, **kwargs)

    return decorated


# ---------------------------------------------------------------------------
# Public homepage — ERP QR (@mmmjhschoolbot), NFC noted separately
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    erp_stats = erp_sheet.school_stats() if erp_sheet.configured() else {"total": 0, "present": 0, "absent": 0}
    bot_link = f"https://t.me/{ERP_BOT_USERNAME}"
    qr_url = (
        "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data="
        + urllib.parse.quote(bot_link, safe="")
    )
    return render_template(
        "index.html",
        school_name=SCHOOL_NAME,
        stats=erp_stats,
        bot_link=bot_link,
        bot_username=ERP_BOT_USERNAME,
        nfc_bot_username=NFC_BOT_USERNAME,
        qr_url=qr_url,
        erp_configured=erp_sheet.configured(),
        today_records=[],
        history=[],
    )


@app.route("/health")
def health():
    cache = nfc_gate.cache_status()
    erp_ok = "yes" if erp_sheet.configured() else "missing_ERP_APPS_SCRIPT_URL"
    return (
        f"OK | NFC @{NFC_BOT_USERNAME} students={cache.get('students')} cards={cache.get('cards')} | "
        f"ERP @{ERP_BOT_USERNAME} sheet={erp_ok}",
        200,
    )


# ---------------------------------------------------------------------------
# NFC attendance — @Vipinbellbot + NFC sheet only
# ---------------------------------------------------------------------------


@app.route("/warm")
def warm():
    threading.Thread(
        target=nfc_gate.refresh_student_cache, kwargs={"force": True}, daemon=True
    ).start()
    return jsonify({"ok": True, "message": "Warming NFC cache", "cache": nfc_gate.cache_status()})


@app.route("/nfc", methods=["GET", "POST"])
def nfc_tap():
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
def telegram_webhook_nfc():
    """Webhook for @Vipinbellbot (NFC attendance)."""
    if not NFC_BOT_TOKEN:
        return "NFC_BOT_TOKEN missing", 503
    try:
        update = request.get_json(force=True, silent=True)
        if not update:
            return "EMPTY", 400
        bot.handle_telegram_update(update)
        return "OK", 200
    except Exception as e:
        print(f"[NFC-WEBHOOK] error: {e}")
        return "ERROR", 500


@app.route("/erp_bot_webhook", methods=["POST"])
def telegram_webhook_erp():
    """Webhook for @mmmjhschoolbot (ERP). Does not touch NFC sheet."""
    if not ERP_BOT_TOKEN:
        return "ERP_BOT_TOKEN missing", 503
    try:
        update = request.get_json(force=True, silent=True)
        if not update:
            return "EMPTY", 400
        _handle_erp_telegram(update)
        return "OK", 200
    except Exception as e:
        print(f"[ERP-WEBHOOK] error: {e}")
        return "ERROR", 500


@app.route("/setup")
def setup():
    base = os.environ.get("RENDER_EXTERNAL_URL", request.url_root.rstrip("/"))
    results = {}
    if NFC_BOT_TOKEN:
        results["nfc"] = bot.register_webhook(base)  # sets /bot_webhook on NFC token
    else:
        results["nfc"] = "NFC_BOT_TOKEN missing"
    if ERP_BOT_TOKEN and ERP_TELEGRAM_API:
        try:
            url = base.rstrip("/") + "/erp_bot_webhook"
            resp = __import__("requests").get(
                f"{ERP_TELEGRAM_API}/setWebhook",
                params={"url": url, "drop_pending_updates": False},
                timeout=15,
            )
            results["erp"] = resp.json()
        except Exception as e:
            results["erp"] = str(e)
    else:
        results["erp"] = "ERP_BOT_TOKEN missing"
    return jsonify(results)


def _erp_send(chat_id, text):
    if not ERP_TELEGRAM_API:
        return
    try:
        __import__("requests").post(
            f"{ERP_TELEGRAM_API}/sendMessage",
            json={"chat_id": chat_id, "text": text, "parse_mode": "HTML"},
            timeout=15,
        )
    except Exception as e:
        print(f"[ERP-BOT] send error: {e}")


def _handle_erp_telegram(update):
    msg = (update or {}).get("message") or {}
    chat_id = (msg.get("chat") or {}).get("id")
    text = (msg.get("text") or "").strip()
    if not chat_id or not text:
        return
    low = text.lower()
    if low.startswith("/start") or low.startswith("/help"):
        _erp_send(
            chat_id,
            f"🏫 <b>{SCHOOL_NAME} ERP</b>\n"
            f"Bot: @{ERP_BOT_USERNAME}\n\n"
            "This bot uses the <b>MMMJHS Telegram / ERP sheet</b> "
            "(not the NFC attendance sheet).\n\n"
            "Commands:\n"
            "• <code>/register &lt;Admission No&gt;</code>\n"
            "• <code>/status &lt;Admission No&gt;</code>",
        )
        return
    if low.startswith("/register"):
        parts = text.split()
        if len(parts) < 2:
            _erp_send(chat_id, "Usage: <code>/register &lt;Admission No&gt;</code>")
            return
        student = erp_sheet.find_student(parts[1])
        if not student:
            _erp_send(
                chat_id,
                f"❌ Admission <code>{parts[1]}</code> not found on MMMJHS ERP sheet.",
            )
            return
        _erp_send(
            chat_id,
            f"✅ Found <b>{student['name']}</b> ({student['class_name']})\n"
            f"Admission: <code>{student['admission_no']}</code>\n\n"
            f"<i>ERP sheet: MMMJHS Telegram — bot @{ERP_BOT_USERNAME}</i>",
        )
        return
    if low.startswith("/status"):
        parts = text.split()
        if len(parts) < 2:
            _erp_send(chat_id, "Usage: <code>/status &lt;Admission No&gt;</code>")
            return
        student = erp_sheet.find_student(parts[1])
        if not student:
            _erp_send(chat_id, "❌ Not found on MMMJHS ERP sheet.")
            return
        _erp_send(
            chat_id,
            f"👤 <b>{student['name']}</b>\n"
            f"Class: {student['class_name']}\n"
            f"Admission: <code>{student['admission_no']}</code>",
        )
        return
    _erp_send(chat_id, "Try /help")


# ---------------------------------------------------------------------------
# Web admin — ERP sheet students (@mmmjhschoolbot data)
# ---------------------------------------------------------------------------


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    if request.method == "POST":
        if request.form.get("password") == ADMIN_PASSWORD:
            session["admin"] = True
            return redirect(url_for("admin_dashboard"))
        error = "Invalid password"
    return render_template("admin_login.html", school_name=SCHOOL_NAME, error=error)


@app.route("/admin/logout")
def admin_logout():
    session.pop("admin", None)
    return redirect(url_for("index"))


@app.route("/admin")
@login_required
def admin_dashboard():
    students = erp_sheet.get_all_students()
    stats = erp_sheet.school_stats()
    class_counts = {}
    for s in students:
        class_counts[s["class_name"] or "—"] = class_counts.get(s["class_name"] or "—", 0) + 1
    class_counts_rows = [{"class_name": k, "count": v} for k, v in sorted(class_counts.items())]
    return render_template(
        "admin.html",
        school_name=SCHOOL_NAME,
        students=students,
        stats=stats,
        class_counts=class_counts_rows,
    )


@app.route("/admin/students/add", methods=["POST"])
@login_required
def add_student():
    return jsonify(
        {
            "success": False,
            "message": "Add students on the MMMJHS Telegram / ERP Google Sheet (not the NFC attendance sheet).",
        }
    ), 400


@app.route("/admin/students/<int:student_id>/mark", methods=["POST"])
@login_required
def manual_mark(student_id):
    return jsonify(
        {
            "success": False,
            "message": "Attendance marking for NFC stays on the NFC gate / @Vipinbellbot sheet. ERP app does not write the NFC sheet.",
        }
    ), 400


@app.route("/admin/students/<admission_no>/link-card", methods=["POST"])
@login_required
def link_card(admission_no):
    return jsonify(
        {
            "success": False,
            "message": "NFC card linking belongs to the NFC attendance sheet (@Vipinbellbot), not the ERP sheet.",
        }
    ), 400


# ---------------------------------------------------------------------------
# MOBILE ERP API — MMMJHS Telegram sheet only
# ---------------------------------------------------------------------------


@app.route("/api/mobile/school")
def mobile_school_info():
    if not erp_sheet.configured():
        return jsonify(
            {
                "school_name": SCHOOL_NAME,
                "stats": {"total": 0, "present": 0, "absent": 0},
                "bot": f"@{ERP_BOT_USERNAME}",
                "source": "mmmjhs_telegram_sheet",
                "warning": "Set ERP_APPS_SCRIPT_URL to the MMMJHS Telegram / ERP sheet Apps Script (not NFC).",
            }
        )
    return jsonify(
        {
            "school_name": SCHOOL_NAME,
            "stats": erp_sheet.school_stats(),
            "bot": f"@{ERP_BOT_USERNAME}",
            "source": "mmmjhs_telegram_sheet",
        }
    )


@app.route("/api/mobile/parent/login", methods=["POST"])
@app.route("/api/mobile/student/login", methods=["POST"])
def mobile_login():
    data = request.get_json(silent=True) or {}
    admission_no = erp_sheet.normalize_admission(data.get("admission_no") or "")
    if not admission_no:
        return jsonify({"success": False, "message": "Admission number required"}), 400
    if not erp_sheet.configured():
        return jsonify(
            {
                "success": False,
                "message": "ERP sheet not configured. Set ERP_APPS_SCRIPT_URL (MMMJHS Telegram sheet).",
            }
        ), 503
    student = erp_sheet.find_student(admission_no)
    if not student:
        return jsonify(
            {"success": False, "message": "Student not found on MMMJHS ERP sheet"}
        ), 404
    return jsonify(
        {
            "success": True,
            "student": student,
            "today": {"present": False, "time_in": None},
            "source": "mmmjhs_telegram_sheet",
            "bot": f"@{ERP_BOT_USERNAME}",
        }
    )


def _erp_dashboard(admission_no: str, audience: str):
    student = erp_sheet.find_student(admission_no)
    if not student:
        return None
    notices = [db.row_to_dict(n) for n in db.get_notices(audience)]
    homework = [db.row_to_dict(h) for h in db.get_homework(student["class_name"])]
    return {
        "success": True,
        "student": student,
        "today": {"present": False, "time_in": None},
        "history": [],
        "summary": {"present_days": 0, "period_days": 30, "percentage": 0},
        "notices": notices,
        "homework": homework,
        "source": "mmmjhs_telegram_sheet",
        "bot": f"@{ERP_BOT_USERNAME}",
    }


@app.route("/api/mobile/parent/<admission_no>/status")
def mobile_parent_status(admission_no):
    payload = _erp_dashboard(admission_no, "parents")
    if not payload:
        return jsonify({"success": False, "message": "Student not found on MMMJHS ERP sheet"}), 404
    return jsonify(payload)


@app.route("/api/mobile/student/<admission_no>/dashboard")
def mobile_student_dashboard(admission_no):
    payload = _erp_dashboard(admission_no, "students")
    if not payload:
        return jsonify({"success": False, "message": "Student not found on MMMJHS ERP sheet"}), 404
    return jsonify(payload)


@app.route("/api/mobile/admin/login", methods=["POST"])
def mobile_admin_login():
    data = request.get_json(silent=True) or {}
    if data.get("password") == ADMIN_PASSWORD:
        return jsonify({"success": True, "message": "Login successful"})
    return jsonify({"success": False, "message": "Invalid password"}), 401


@app.route("/api/mobile/admin/dashboard")
def mobile_admin_dashboard():
    students = erp_sheet.get_all_students()
    return jsonify(
        {
            "success": True,
            "stats": erp_sheet.school_stats(),
            "students": students,
            "today_attendance": [],
            "source": "mmmjhs_telegram_sheet",
            "bot": f"@{ERP_BOT_USERNAME}",
        }
    )


@app.route("/api/mobile/admin/mark/<int:student_id>", methods=["POST"])
def mobile_admin_mark(student_id):
    return jsonify(
        {
            "success": False,
            "message": "ERP app does not mark the NFC attendance sheet. Use NFC gate / @Vipinbellbot for gate attendance.",
        }
    ), 400


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


def keep_alive():
    base = os.environ.get("RENDER_EXTERNAL_URL", "")
    if not base:
        return
    time.sleep(15)
    url = base.rstrip("/") + "/health"
    while True:
        try:
            time.sleep(150)
            req = urllib.request.Request(url, headers={"User-Agent": "MMM-KeepAlive/1.0"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"[KEEP-ALIVE] {resp.status}")
        except Exception as e:
            print(f"[KEEP-ALIVE] {e}")


def warm_nfc_cache():
    time.sleep(2)
    try:
        nfc_gate.refresh_student_cache(force=True)
    except Exception as e:
        print(f"[NFC] warm cache error: {e}")


def boot():
    try:
        db.init_db()
    except Exception as e:
        print(f"[DB] optional init: {e}")
    print(
        f"[BOOT] NFC=@{NFC_BOT_USERNAME} sheet=NFC_APPS_SCRIPT_URL | "
        f"ERP=@{ERP_BOT_USERNAME} sheet=ERP_APPS_SCRIPT_URL "
        f"({'set' if ERP_APPS_SCRIPT_URL else 'MISSING'})"
    )
    threading.Thread(target=warm_nfc_cache, daemon=True).start()
    if os.environ.get("RENDER_EXTERNAL_URL"):
        threading.Thread(target=keep_alive, daemon=True).start()


boot()

if __name__ == "__main__":
    print(f"[APP] {SCHOOL_NAME} — NFC + ERP separated")
    app.run(host="0.0.0.0", port=PORT, debug=False)
