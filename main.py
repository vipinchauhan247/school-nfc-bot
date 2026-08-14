"""
MMM School — production NFC/Telegram/Sheets + mobile ERP API.

Keeps Google Sheet as source of truth (uploaded student data).
Mobile app + website read the same Sheet via Apps Script / NFC cache.
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
import nfc_gate
from config import ADMIN_PASSWORD, BOT_TOKEN, PORT, SCHOOL_NAME

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "school-attendance-secret-key-change-me")
CORS(app, resources={r"/api/*": {"origins": "*"}})

TELEGRAM_BOT_USERNAME = os.environ.get("TELEGRAM_BOT_USERNAME", "Vipinbellbot").lstrip("@")


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("admin_login"))
        return f(*args, **kwargs)

    return decorated


def _sheet_student_to_api(row):
    if not row:
        return None
    adm = bot.normalize_admission(row.get("admissionNo") or row.get("admission_no") or "")
    return {
        "id": abs(hash(adm)) % (10**9),
        "admission_no": adm,
        "name": str(row.get("name") or "").strip() or f"Student {adm}",
        "class_name": str(row.get("className") or row.get("class_name") or "").strip(),
        "parent_name": str(row.get("parentName") or row.get("parent_name") or "").strip(),
        "parent_phone": str(row.get("parentPhone") or row.get("parent_phone") or "").strip(),
        "nfc_uid": str(row.get("nfcUid") or row.get("nfc_uid") or "").strip(),
        "telegram_chat_id": bot.normalize_chat_id(
            row.get("telegramChatId") or row.get("telegram_chat_id") or ""
        ),
    }


def _today_bucket_for(admission_no: str) -> dict:
    day = nfc_gate._now_ist().strftime("%Y-%m-%d")
    key = bot.normalize_admission(admission_no).lower()
    with nfc_gate._lock:
        row = nfc_gate._attendance_today.get(key) or {}
        if row.get("date") != day:
            return {"present": False, "time_in": None, "time_out": None, "date": day}
        return {
            "present": bool(row.get("in") or row.get("out")),
            "time_in": row.get("in") or None,
            "time_out": row.get("out") or None,
            "date": day,
        }


def _school_stats_from_cache() -> dict:
    status = nfc_gate.cache_status()
    total = status.get("students") or 0
    present = status.get("attendance_rows") or 0
    if total and present > total:
        present = total
    return {"total": total, "present": present, "absent": max(total - present, 0)}


# ---------------------------------------------------------------------------
# Public / production NFC + Telegram
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    stats = _school_stats_from_cache()
    bot_link = f"https://t.me/{TELEGRAM_BOT_USERNAME}"
    qr_url = (
        "https://api.qrserver.com/v1/create-qr-code/?size=220x220&data="
        + urllib.parse.quote(bot_link, safe="")
    )
    return render_template(
        "index.html",
        school_name=SCHOOL_NAME,
        stats=stats,
        bot_link=bot_link,
        bot_username=TELEGRAM_BOT_USERNAME,
        qr_url=qr_url,
        today_records=[],
        history=[],
    )


@app.route("/health")
def health():
    cache = nfc_gate.cache_status()
    return (
        f"OK - @{TELEGRAM_BOT_USERNAME} active | "
        f"students={cache.get('students')} cards={cache.get('cards')} "
        f"cache_age_sec={cache.get('age_sec')} "
        f"attendance_rows={cache.get('attendance_rows')}",
        200,
    )


@app.route("/warm")
def warm():
    threading.Thread(
        target=nfc_gate.refresh_student_cache, kwargs={"force": True}, daemon=True
    ).start()
    return jsonify(
        {
            "ok": True,
            "message": "Warming NFC cache in background",
            "cache": nfc_gate.cache_status(),
        }
    )


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
def telegram_webhook():
    if not BOT_TOKEN:
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
    base = os.environ.get("RENDER_EXTERNAL_URL", request.url_root.rstrip("/"))
    if not BOT_TOKEN:
        return "Set BOT_TOKEN in Render Environment first.", 500
    ok = bot.register_webhook(base)
    if ok:
        return f"Webhook OK: {base}/bot_webhook", 200
    return "Webhook failed — check Render logs.", 500


# ---------------------------------------------------------------------------
# Web admin (optional local SQLite helpers + Sheet-aware student list)
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
    # Prefer live Sheet cache so uploaded data appears
    with nfc_gate._lock:
        sheet_students = list(nfc_gate._students_by_adm.values())
    students = [_sheet_student_to_api(s) for s in sheet_students]
    students = [s for s in students if s]
    students.sort(key=lambda s: (s["class_name"], s["name"]))
    stats = _school_stats_from_cache()
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
            "message": "Add students on the Google Sheet (source of truth). App/website sync from the Sheet.",
        }
    ), 400


@app.route("/admin/students/<int:student_id>/mark", methods=["POST"])
@login_required
def manual_mark(student_id):
    with nfc_gate._lock:
        sheet_students = list(nfc_gate._students_by_adm.values())
    target = None
    for row in sheet_students:
        api = _sheet_student_to_api(row)
        if api and api["id"] == student_id:
            target = api
            break
    if not target:
        return jsonify({"success": False, "message": "Student not found"}), 404
    uid = (target.get("nfc_uid") or "").strip()
    if not uid:
        return jsonify({"success": False, "message": "Link NFC card first"}), 400
    text = nfc_gate.process_nfc_tap(uid)
    return jsonify({"success": text.startswith("SUCCESS"), "message": text})


@app.route("/admin/students/<admission_no>/link-card", methods=["POST"])
@login_required
def link_card(admission_no):
    data = request.get_json(silent=True) or {}
    nfc_id = (data.get("nfc_card_id") or "").strip()
    if not nfc_id:
        return jsonify({"success": False, "message": "NFC card ID required"}), 400
    ok = bot.link_card_on_sheet(admission_no, nfc_id)
    return jsonify(
        {
            "success": bool(ok),
            "message": "Card linked on Google Sheet" if ok else "Link failed — check Sheet / Apps Script",
        }
    )


# ---------------------------------------------------------------------------
# MOBILE API — same Sheet data as NFC / Telegram
# ---------------------------------------------------------------------------


@app.route("/api/mobile/school")
def mobile_school_info():
    nfc_gate._schedule_cache_refresh(force=False)
    return jsonify(
        {
            "school_name": SCHOOL_NAME,
            "stats": _school_stats_from_cache(),
            "bot": f"@{TELEGRAM_BOT_USERNAME}",
            "source": "google_sheet",
        }
    )


@app.route("/api/mobile/parent/login", methods=["POST"])
@app.route("/api/mobile/student/login", methods=["POST"])
def mobile_login():
    data = request.get_json(silent=True) or {}
    admission_no = bot.normalize_admission(data.get("admission_no") or "")
    if not admission_no:
        return jsonify({"success": False, "message": "Admission number required"}), 400

    student_row = bot.find_student_on_sheet(admission_no)
    student = _sheet_student_to_api(student_row)
    if not student:
        return jsonify({"success": False, "message": "Student not found on school sheet"}), 404

    today = _today_bucket_for(admission_no)
    return jsonify({"success": True, "student": student, "today": today})


def _dashboard_payload(admission_no: str, audience: str):
    student_row = bot.find_student_on_sheet(admission_no)
    student = _sheet_student_to_api(student_row)
    if not student:
        return None

    today = _today_bucket_for(admission_no)
    # History from sheet when possible
    history = []
    try:
        att = bot.get_attendance_from_sheet(admission_no, "0", "")
        if isinstance(att, dict) and not att.get("error"):
            if att.get("found", True) and (att.get("inTime") or att.get("outTime")):
                history.append(
                    {
                        "date": att.get("date") or today.get("date"),
                        "time_in": att.get("inTime") or "",
                        "status": "present",
                    }
                )
    except Exception as e:
        print(f"[MOBILE] attendance history: {e}")

    if today.get("present") and not history:
        history.append(
            {
                "date": today.get("date"),
                "time_in": today.get("time_in") or "",
                "status": "present",
            }
        )

    present_days = 1 if today.get("present") else 0
    summary = {
        "present_days": present_days,
        "period_days": 30,
        "percentage": round((present_days / 30) * 100, 1),
    }

    notices = [db.row_to_dict(n) for n in db.get_notices(audience)]
    homework = [db.row_to_dict(h) for h in db.get_homework(student["class_name"])]
    return {
        "success": True,
        "student": student,
        "today": today,
        "history": history,
        "summary": summary,
        "notices": notices,
        "homework": homework,
        "source": "google_sheet",
    }


@app.route("/api/mobile/parent/<admission_no>/status")
def mobile_parent_status(admission_no):
    payload = _dashboard_payload(admission_no, "parents")
    if not payload:
        return jsonify({"success": False, "message": "Student not found"}), 404
    return jsonify(payload)


@app.route("/api/mobile/student/<admission_no>/dashboard")
def mobile_student_dashboard(admission_no):
    payload = _dashboard_payload(admission_no, "students")
    if not payload:
        return jsonify({"success": False, "message": "Student not found"}), 404
    return jsonify(payload)


@app.route("/api/mobile/admin/login", methods=["POST"])
def mobile_admin_login():
    data = request.get_json(silent=True) or {}
    if data.get("password") == ADMIN_PASSWORD:
        return jsonify({"success": True, "message": "Login successful"})
    return jsonify({"success": False, "message": "Invalid password"}), 401


@app.route("/api/mobile/admin/dashboard")
def mobile_admin_dashboard():
    nfc_gate._schedule_cache_refresh(force=False)
    with nfc_gate._lock:
        sheet_students = list(nfc_gate._students_by_adm.values())
        attendance = dict(nfc_gate._attendance_today)
    students = [_sheet_student_to_api(s) for s in sheet_students]
    students = [s for s in students if s]
    students.sort(key=lambda s: (s["class_name"], s["name"]))
    day = nfc_gate._now_ist().strftime("%Y-%m-%d")
    today_attendance = []
    for s in students:
        row = attendance.get(s["admission_no"].lower()) or {}
        if row.get("date") == day and (row.get("in") or row.get("out")):
            today_attendance.append({**s, "time_in": row.get("in") or row.get("out") or ""})
    return jsonify(
        {
            "success": True,
            "stats": _school_stats_from_cache(),
            "students": students,
            "today_attendance": today_attendance,
            "source": "google_sheet",
        }
    )


@app.route("/api/mobile/admin/mark/<int:student_id>", methods=["POST"])
def mobile_admin_mark(student_id):
    # Resolve student from sheet cache by synthetic id
    with nfc_gate._lock:
        sheet_students = list(nfc_gate._students_by_adm.values())
    target = None
    for row in sheet_students:
        api = _sheet_student_to_api(row)
        if api and api["id"] == student_id:
            target = api
            break
    if not target:
        return jsonify({"success": False, "message": "Student not found"}), 404
    uid = (target.get("nfc_uid") or "").strip()
    if not uid:
        return jsonify(
            {
                "success": False,
                "message": "No NFC card linked. Link card first, then mark via gate or /link.",
            }
        ), 400
    text = nfc_gate.process_nfc_tap(uid)
    ok = text.startswith("SUCCESS")
    return jsonify({"success": ok, "message": text, "student": target})


# ---------------------------------------------------------------------------
# Keep-alive / startup
# ---------------------------------------------------------------------------


def keep_alive():
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
    time.sleep(2)
    try:
        nfc_gate.refresh_student_cache(force=True)
    except Exception as e:
        print(f"[NFC] warm cache error: {e}")


def boot():
    try:
        db.init_db()  # notices/homework extras only
    except Exception as e:
        print(f"[DB] init optional: {e}")
    threading.Thread(target=warm_nfc_cache, daemon=True).start()
    if os.environ.get("RENDER_EXTERNAL_URL"):
        threading.Thread(target=keep_alive, daemon=True).start()
        threading.Thread(target=auto_setup_webhook, daemon=True).start()


boot()

if __name__ == "__main__":
    print(f"[APP] {SCHOOL_NAME} — Sheets + Mobile ERP on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
