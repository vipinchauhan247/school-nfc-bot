import sqlite3
from datetime import datetime, date
from contextlib import contextmanager
from config import DATABASE_PATH


@contextmanager
def get_db():
    conn = sqlite3.connect(DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS students (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                admission_no TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                class_name TEXT NOT NULL,
                parent_name TEXT,
                parent_phone TEXT,
                nfc_card_id TEXT UNIQUE,
                telegram_chat_id TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS attendance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                date TEXT NOT NULL,
                time_in TEXT NOT NULL,
                status TEXT DEFAULT 'present',
                FOREIGN KEY (student_id) REFERENCES students(id),
                UNIQUE(student_id, date)
            );

            CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
            CREATE INDEX IF NOT EXISTS idx_students_admission ON students(admission_no);
            CREATE INDEX IF NOT EXISTS idx_students_nfc ON students(nfc_card_id);
        """)

        count = conn.execute("SELECT COUNT(*) FROM students").fetchone()[0]
        if count == 0:
            sample = [
                ("2211", "Rahul Sharma", "Class 5", "Mr. Sharma", "9876543210"),
                ("2212", "Priya Singh", "Class 6", "Mrs. Singh", "9876543211"),
                ("2213", "Amit Kumar", "Class 5", "Mr. Kumar", "9876543212"),
                ("2214", "Sneha Patel", "Class 7", "Mrs. Patel", "9876543213"),
                ("2215", "Vikram Yadav", "Class 6", "Mr. Yadav", "9876543214"),
            ]
            conn.executemany(
                "INSERT INTO students (admission_no, name, class_name, parent_name, parent_phone) VALUES (?, ?, ?, ?, ?)",
                sample,
            )


def get_all_students():
    with get_db() as conn:
        return conn.execute(
            "SELECT * FROM students ORDER BY class_name, name"
        ).fetchall()


def get_student_by_admission(admission_no):
    with get_db() as conn:
        return conn.execute(
            "SELECT * FROM students WHERE admission_no = ?", (admission_no,)
        ).fetchone()


def get_student_by_nfc(nfc_card_id):
    with get_db() as conn:
        return conn.execute(
            "SELECT * FROM students WHERE nfc_card_id = ?", (nfc_card_id,)
        ).fetchone()


def get_student_by_id(student_id):
    with get_db() as conn:
        return conn.execute(
            "SELECT * FROM students WHERE id = ?", (student_id,)
        ).fetchone()


def add_student(admission_no, name, class_name, parent_name="", parent_phone=""):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO students (admission_no, name, class_name, parent_name, parent_phone) VALUES (?, ?, ?, ?, ?)",
            (admission_no, name, class_name, parent_name, parent_phone),
        )


def link_telegram(admission_no, chat_id):
    with get_db() as conn:
        result = conn.execute(
            "UPDATE students SET telegram_chat_id = ? WHERE admission_no = ?",
            (str(chat_id), admission_no),
        )
        return result.rowcount > 0


def upsert_telegram_registration(admission_no, chat_id, name=None, class_name=None):
    """Link chat ID locally; create a minimal row if student only exists on Google Sheet."""
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM students WHERE admission_no = ?", (admission_no,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE students SET telegram_chat_id = ? WHERE admission_no = ?",
                (str(chat_id), admission_no),
            )
            return
        conn.execute(
            "INSERT INTO students (admission_no, name, class_name, telegram_chat_id) VALUES (?, ?, ?, ?)",
            (
                admission_no,
                name or f"Student {admission_no}",
                class_name or "—",
                str(chat_id),
            ),
        )


def link_nfc_card(admission_no, nfc_card_id):
    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM students WHERE nfc_card_id = ? AND admission_no != ?",
            (nfc_card_id, admission_no),
        ).fetchone()
        if existing:
            return False, "Card already linked to another student"
        result = conn.execute(
            "UPDATE students SET nfc_card_id = ? WHERE admission_no = ?",
            (nfc_card_id, admission_no),
        )
        if result.rowcount == 0:
            return False, "Student not found"
        return True, "Card linked successfully"


def mark_attendance(student_id):
    today = date.today().isoformat()
    now = datetime.now().strftime("%H:%M:%S")

    with get_db() as conn:
        existing = conn.execute(
            "SELECT id FROM attendance WHERE student_id = ? AND date = ?",
            (student_id, today),
        ).fetchone()
        if existing:
            return False, "Already marked present today", None

        conn.execute(
            "INSERT INTO attendance (student_id, date, time_in) VALUES (?, ?, ?)",
            (student_id, today, now),
        )
        student = conn.execute(
            "SELECT * FROM students WHERE id = ?", (student_id,)
        ).fetchone()
        return True, "Attendance marked", student


def get_today_attendance():
    today = date.today().isoformat()
    with get_db() as conn:
        return conn.execute("""
            SELECT s.*, a.time_in, a.status
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            WHERE a.date = ?
            ORDER BY a.time_in
        """, (today,)).fetchall()


def get_attendance_stats():
    today = date.today().isoformat()
    with get_db() as conn:
        total = conn.execute("SELECT COUNT(*) FROM students").fetchone()[0]
        present = conn.execute(
            "SELECT COUNT(*) FROM attendance WHERE date = ?", (today,)
        ).fetchone()[0]
        return {"total": total, "present": present, "absent": total - present}


def get_attendance_history(days=7):
    with get_db() as conn:
        return conn.execute("""
            SELECT a.date, COUNT(*) as count
            FROM attendance a
            GROUP BY a.date
            ORDER BY a.date DESC
            LIMIT ?
        """, (days,)).fetchall()


def get_students_by_class():
    with get_db() as conn:
        return conn.execute("""
            SELECT class_name, COUNT(*) as count
            FROM students
            GROUP BY class_name
            ORDER BY class_name
        """).fetchall()
