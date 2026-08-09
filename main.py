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
# ===========================================================================
# PASTE THIS CODE AT THE BOTTOM OF main.py (BEFORE "if __name__" line)
# ===========================================================================

# ============== TELEGRAM WEBHOOK (instant replies 24/7) ==============

def _escape_html(text):
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def _looks_like_uid(value):
    raw = str(value or "").strip().replace(" ","").replace(":","").replace("-","")
    if not raw: return False
    if raw.isdigit() and len(raw) <= 6: return False
    return len(raw) >= 8 and all(c in "0123456789ABCDEFabcdef" for c in raw)

def _find_student(admission_no):
    data = bot.apps_script_get({"action": "get_all_uids"})
    if not isinstance(data, list): return None
    key = str(admission_no).strip().lower()
    for s in data:
        if str(s.get("admissionNo","")).strip().lower() == key:
            return s
    return None

@app.route("/bot_webhook", methods=["POST"])
def telegram_webhook():
    try:
        update = request.get_json(force=True)
        if not update: return "OK", 200
        msg = update.get("message")
        if not msg or not msg.get("text"): return "OK", 200

        chat_id = msg["chat"]["id"]
        text = msg["text"].strip()
        parts = text.split()
        cmd = parts[0].lower().lstrip("/").split("@")[0]
        args = parts[1:]

        if cmd == "start" and not args:
            bot.send_telegram_message(chat_id,
                f"🏫 <b>{SCHOOL_NAME}</b>\n\n"
                "<b>Parents / Students:</b>\n"
                "<code>/register &lt;Admission No&gt;</code>\n"
                "Example: <code>/register 1658</code>\n\n"
                "<b>Check Status:</b>\n"
                "<code>/status &lt;Admission No&gt;</code>\n\n"
                "<b>Admin — Link NFC Card:</b>\n"
                "<code>/link &lt;Card UID&gt; &lt;Admission No&gt;</code>")

        elif cmd == "register" or (cmd == "start" and args):
            adm = args[0] if args else ""
            if not adm:
                bot.send_telegram_message(chat_id, "⚠️ <b>Usage</b>\n<code>/register 1658</code>")
                return "OK", 200
            if _looks_like_uid(adm):
                bot.send_telegram_message(chat_id, "⚠️ That looks like a Card UID.\nUse <code>/register &lt;Admission No&gt;</code>")
                return "OK", 200
            student = _find_student(adm)
            if not student:
                bot.send_telegram_message(chat_id, f"❌ Admission <code>{_escape_html(adm)}</code> not found.")
                return "OK", 200
            ok = bot.save_chat_id_to_sheet(adm, chat_id)
            db.update_student_chat_id(adm, str(chat_id))
            name = _escape_html(student.get("name",""))
            bot.send_telegram_message(chat_id,
                f"✅ <b>Registration Successful!</b>\n\n"
                f"Linked to: <b>{name}</b>\n\n"
                "You will receive NFC gate attendance alerts on this chat.")

        elif cmd == "link" and len(args) >= 2:
            uid, adm = args[0], args[1]
            if not _looks_like_uid(uid):
                bot.send_telegram_message(chat_id, f"⚠️ <code>{_escape_html(uid)}</code> is not a valid NFC UID.")
                return "OK", 200
            ok = bot.link_card_on_sheet(adm, uid)
            if ok:
                bot.send_telegram_message(chat_id,
                    f"✅ <b>NFC Card Linked!</b>\n\n"
                    f"<b>Admission:</b> <code>{_escape_html(adm)}</code>\n"
                    f"<b>Card UID:</b> <code>{_escape_html(uid.upper())}</code>")
            else:
                bot.send_telegram_message(chat_id, f"❌ Card link failed for <code>{_escape_html(adm)}</code>.")

        elif cmd == "status":
            adm = args[0] if args else ""
            if not adm:
                bot.send_telegram_message(chat_id, "📊 <b>Usage</b>\n<code>/status 1658</code>")
                return "OK", 200
            student = _find_student(adm)
            if not student:
                bot.send_telegram_message(chat_id, f"❌ Admission <code>{_escape_html(adm)}</code> not found.")
                return "OK", 200
            has_card = "✅ Linked" if student.get("nfcUid","") else "❌ Not linked"
            has_chat = "✅ Registered" if student.get("telegramChatId","") else "❌ Not registered"
            bot.send_telegram_message(chat_id,
                f"📊 <b>Student Status</b>\n\n"
                f"<b>Name:</b> {_escape_html(student.get('name','N/A'))}\n"
                f"<b>Admission:</b> <code>{_escape_html(adm)}</code>\n"
                f"<b>NFC Card:</b> {has_card}\n"
                f"<b>Telegram:</b> {has_chat}")

        elif cmd == "link":
            bot.send_telegram_message(chat_id,
                "⚠️ <b>Usage</b>\n<code>/link &lt;Card UID&gt; &lt;Admission No&gt;</code>")

        else:
            bot.send_telegram_message(chat_id,
                "Commands:\n"
                "👨‍👩‍👧 <code>/register &lt;Admission No&gt;</code>\n"
                "📊 <code>/status &lt;Admission No&gt;</code>\n"
                "🔗 <code>/link &lt;Card UID&gt; &lt;Admission No&gt;</code>")

    except Exception as e:
        print(f"[WEBHOOK ERROR] {e}")
    return "OK", 200


@app.route("/set_webhook_url")
def set_webhook_url():
    """Visit this URL once after deploy to connect Telegram."""
    from config import BOT_TOKEN
    webhook_url = f"https://{request.host}/bot_webhook"
    resp = requests.get(f"https://api.telegram.org/bot{BOT_TOKEN}/setWebhook?url={webhook_url}")
    data = resp.json()
    if data.get("ok"):
        return f"✅ Webhook set to: {webhook_url}", 200
    return f"❌ Failed: {resp.text}", 500


if __name__ == "__main__":
    db.init_db()
    start_bot_thread()
    start_keep_alive()
    print(f"[APP] Starting {SCHOOL_NAME} Attendance System on port {PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
