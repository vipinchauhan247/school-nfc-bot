import os
import threading
import urllib.request
import time
from functools import wraps
from flask import Flask, render_template, request, jsonify, redirect, url_for, session
from flask_cors import CORS

import database as db
import bot
from config import SCHOOL_NAME, PORT, ADMIN_PASSWORD

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


# ============================================================================
# MOBILE API
# ============================================================================

@app.route("/api/mobile/school")
def mobile_school_info():
    stats = db.get_attendance_stats()
    return jsonify({
        "school_name": SCHOOL_NAME,
        "stats": stats,
    })


@app.route("/api/mobile/parent/login", methods=["POST"])
def mobile_parent_login():
    data = request.get_json(silent=True) or {}
    admission_no = (data.get("admission_no") or "").strip()
    if not admission_no:
        return jsonify({"success": False, "message": "Admission number required"}), 400

    student, record = db.get_student_today_status(admission_no)
    if not student:
        return jsonify({"success": False, "message": "Student not found"}), 404

    return jsonify({
        "success": True,
        "student": db.row_to_dict(student),
        "today": {
            "present": record is not None,
            "time_in": record["time_in"] if record else None,
        },
    })


@app.route("/api/mobile/parent/<admission_no>/status")
def mobile_parent_status(admission_no):
    student, record = db.get_student_today_status(admission_no)
    if not student:
        return jsonify({"success": False, "message": "Student not found"}), 404

    history = db.get_student_attendance_history(admission_no, 30)
    summary = db.get_student_attendance_summary(admission_no, 30)
    notices = db.get_notices("parents")
    homework = db.get_homework(student["class_name"])
    return jsonify({
        "success": True,
        "student": db.row_to_dict(student),
        "today": {
            "present": record is not None,
            "time_in": record["time_in"] if record else None,
        },
        "history": [db.row_to_dict(h) for h in history],
        "summary": summary,
        "notices": [db.row_to_dict(n) for n in notices],
        "homework": [db.row_to_dict(h) for h in homework],
    })


@app.route("/api/mobile/student/login", methods=["POST"])
def mobile_student_login():
    data = request.get_json(silent=True) or {}
    admission_no = (data.get("admission_no") or "").strip()
    if not admission_no:
        return jsonify({"success": False, "message": "Admission number required"}), 400

    student, record = db.get_student_today_status(admission_no)
    if not student:
        return jsonify({"success": False, "message": "Student not found"}), 404

    return jsonify({
        "success": True,
        "student": db.row_to_dict(student),
        "today": {
            "present": record is not None,
            "time_in": record["time_in"] if record else None,
        },
    })


@app.route("/api/mobile/student/<admission_no>/dashboard")
def mobile_student_dashboard(admission_no):
    student, record = db.get_student_today_status(admission_no)
    if not student:
        return jsonify({"success": False, "message": "Student not found"}), 404

    history = db.get_student_attendance_history(admission_no, 30)
    summary = db.get_student_attendance_summary(admission_no, 30)
    notices = db.get_notices("students")
    homework = db.get_homework(student["class_name"])
    return jsonify({
        "success": True,
        "student": db.row_to_dict(student),
        "today": {
            "present": record is not None,
            "time_in": record["time_in"] if record else None,
        },
        "history": [db.row_to_dict(h) for h in history],
        "summary": summary,
        "notices": [db.row_to_dict(n) for n in notices],
        "homework": [db.row_to_dict(h) for h in homework],
    })


@app.route("/api/mobile/notices")
def mobile_notices():
    audience = request.args.get("audience", "all")
    notices = db.get_notices(audience)
    return jsonify({"success": True, "notices": [db.row_to_dict(n) for n in notices]})


@app.route("/api/mobile/homework")
def mobile_homework():
    class_name = request.args.get("class_name", "")
    if not class_name:
        return jsonify({"success": False, "message": "class_name required"}), 400
    homework = db.get_homework(class_name)
    return jsonify({"success": True, "homework": [db.row_to_dict(h) for h in homework]})


@app.route("/api/mobile/admin/login", methods=["POST"])
def mobile_admin_login():
    data = request.get_json(silent=True) or {}
    if data.get("password") == ADMIN_PASSWORD:
        return jsonify({"success": True, "message": "Login successful"})
    return jsonify({"success": False, "message": "Invalid password"}), 401


@app.route("/api/mobile/admin/dashboard")
def mobile_admin_dashboard():
    students = [db.row_to_dict(s) for s in db.get_all_students()]
    stats = db.get_attendance_stats()
    today = [db.row_to_dict(r) for r in db.get_today_attendance()]
    return jsonify({
        "success": True,
        "stats": stats,
        "students": students,
        "today_attendance": today,
    })


@app.route("/api/mobile/admin/mark/<int:student_id>", methods=["POST"])
def mobile_admin_mark(student_id):
    success, message, student = db.mark_attendance(student_id)
    if success and student:
        bot.notify_parent_attendance(student)
    return jsonify({
        "success": success,
        "message": message,
        "student": db.row_to_dict(student) if student else None,
    })


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
