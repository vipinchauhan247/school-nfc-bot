import os
import threading
import urllib.request
import time
from functools import wraps
from flask import Flask, render_template, request, jsonify, redirect, url_for, session

import database as db
import bot
from config import SCHOOL_NAME, PORT, ADMIN_PASSWORD

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "school-attendance-secret-key-change-me")


def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin"):
            return redirect(url_for("admin_login"))
        return f(*args, **kwargs)
    return decorated


@app.route("/")
def index():
    stats = db.get_attendance_stats()
    today_records = db.get_today_attendance()
    history = db.get_attendance_history(7)
    return render_template(
        "index.html",
        school_name=SCHOOL_NAME,
        stats=stats,
        today_records=today_records,
        history=history,
    )


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
    students = db.get_all_students()
    stats = db.get_attendance_stats()
    class_counts = db.get_students_by_class()
    return render_template(
        "admin.html",
        school_name=SCHOOL_NAME,
        students=students,
        stats=stats,
        class_counts=class_counts,
    )


@app.route("/admin/students/add", methods=["POST"])
@login_required
def add_student():
    try:
        db.add_student(
            request.form["admission_no"],
            request.form["name"],
            request.form["class_name"],
            request.form.get("parent_name", ""),
            request.form.get("parent_phone", ""),
        )
        return jsonify({"success": True, "message": "Student added successfully"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 400


@app.route("/admin/students/<int:student_id>/mark", methods=["POST"])
@login_required
def manual_mark(student_id):
    success, message, student = db.mark_attendance(student_id)
    if success and student:
        bot.notify_parent_attendance(student)
    return jsonify({"success": success, "message": message})


@app.route("/admin/students/<admission_no>/link-card", methods=["POST"])
@login_required
def link_card(admission_no):
    data = request.get_json()
    nfc_id = data.get("nfc_card_id", "").strip()
    if not nfc_id:
        return jsonify({"success": False, "message": "NFC card ID required"}), 400
    success, message = db.link_nfc_card(admission_no, nfc_id)
    return jsonify({"success": success, "message": message})


@app.route("/api/nfc-scan", methods=["POST"])
def nfc_scan():
    data = request.get_json(silent=True) or {}
    card_id = data.get("card_id") or data.get("nfc_card_id") or request.form.get("card_id")
    if not card_id:
        return jsonify({"success": False, "message": "card_id required"}), 400

    student = db.get_student_by_nfc(card_id)
    if not student:
        return jsonify({"success": False, "message": "Card not registered"}), 404

    success, message, updated_student = db.mark_attendance(student["id"])
    if success and updated_student:
        bot.notify_parent_attendance(updated_student)
        return jsonify({
            "success": True,
            "message": message,
            "student": {
                "name": updated_student["name"],
                "admission_no": updated_student["admission_no"],
                "class_name": updated_student["class_name"],
            },
        })
    return jsonify({"success": False, "message": message})


@app.route("/health")
def health():
    return "OK - School Attendance System Active", 200


def self_ping_keep_alive():
    time.sleep(15)
    render_url = os.environ.get("RENDER_EXTERNAL_URL", f"http://127.0.0.1:{PORT}")
    print(f"[KEEP-ALIVE] Self-ping targeting {render_url}")
    while True:
        try:
            time.sleep(240)
            req = urllib.request.Request(
                f"{render_url}/health",
                headers={"User-Agent": "Mozilla/5.0"},
            )
            with urllib.request.urlopen(req) as resp:
                print(f"[KEEP-ALIVE] Ping OK — status {resp.status}")
        except Exception as e:
            print(f"[KEEP-ALIVE] Ping warning: {e}")


def start_bot_thread():
    t = threading.Thread(target=bot.start_polling, daemon=True)
    t.start()


def start_keep_alive():
    if os.environ.get("RENDER_EXTERNAL_URL"):
        t = threading.Thread(target=self_ping_keep_alive, daemon=True)
        t.start()


if __name__ == "__main__":
    db.init_db()
    start_bot_thread()
    start_keep_alive()
    print(f"[APP] Starting {SCHOOL_NAME} Attendance System on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
