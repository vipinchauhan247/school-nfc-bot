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

            CREATE TABLE IF NOT EXISTS notices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                audience TEXT DEFAULT 'all',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS homework (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                class_name TEXT NOT NULL,
                subject TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                due_date TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
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

        notice_count = conn.execute("SELECT COUNT(*) FROM notices").fetchone()[0]
        if notice_count == 0:
            notices = [
                ("School Reopens Monday", "School will reopen on Monday after the holiday. All students must arrive by 8:00 AM.", "all"),
                ("Parent-Teacher Meeting", "PTM for Class 5-7 on Saturday, 10 AM. Parents are requested to attend.", "parents"),
                ("Science Fair Registration", "Register for the annual science fair by Friday. See your class teacher for details.", "students"),
                ("Annual Sports Day", "Sports Day is on 15th August. Students should wear house colour uniforms.", "all"),
            ]
            conn.executemany(
                "INSERT INTO notices (title, body, audience) VALUES (?, ?, ?)",
                notices,
            )

        hw_count = conn.execute("SELECT COUNT(*) FROM homework").fetchone()[0]
        if hw_count == 0:
            homework = [
                ("Class 5", "Mathematics", "Chapter 5 Exercises", "Complete exercises 5.1 to 5.5 from textbook", "2026-08-10"),
                ("Class 5", "Hindi", "कविता याद करें", "Learn the poem 'बसंत पंचमी' and write meaning of difficult words", "2026-08-09"),
                ("Class 5", "Science", "Plant Diagram", "Draw and label parts of a flowering plant", "2026-08-11"),
                ("Class 6", "English", "Essay Writing", "Write 200 words on 'My Favourite Festival'", "2026-08-10"),
                ("Class 6", "Mathematics", "Fractions Worksheet", "Solve the worksheet given in class", "2026-08-09"),
                ("Class 7", "Science", "Lab Report", "Write lab report on 'Acids and Bases' experiment", "2026-08-12"),
            ]
            conn.executemany(
                "INSERT INTO homework (class_name, subject, title, description, due_date) VALUES (?, ?, ?, ?, ?)",
                homework,
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


def get_student_attendance_history(admission_no, days=30):
    with get_db() as conn:
        return conn.execute("""
            SELECT a.date, a.time_in, a.status
            FROM attendance a
            JOIN students s ON s.id = a.student_id
            WHERE s.admission_no = ?
            ORDER BY a.date DESC
            LIMIT ?
        """, (admission_no, days)).fetchall()


def get_student_today_status(admission_no):
    today = date.today().isoformat()
    with get_db() as conn:
        student = conn.execute(
            "SELECT * FROM students WHERE admission_no = ?", (admission_no,)
        ).fetchone()
        if not student:
            return None, None
        record = conn.execute(
            "SELECT time_in, status FROM attendance WHERE student_id = ? AND date = ?",
            (student["id"], today),
        ).fetchone()
        return student, record


def row_to_dict(row):
    if row is None:
        return None
    return dict(row)


def get_notices(audience="all"):
    with get_db() as conn:
        return conn.execute("""
            SELECT * FROM notices
            WHERE audience IN ('all', ?)
            ORDER BY created_at DESC
            LIMIT 20
        """, (audience,)).fetchall()


def get_homework(class_name):
    with get_db() as conn:
        return conn.execute("""
            SELECT * FROM homework
            WHERE class_name = ?
            ORDER BY due_date ASC
            LIMIT 20
        """, (class_name,)).fetchall()


def get_student_attendance_summary(admission_no, days=30):
    with get_db() as conn:
        student = conn.execute(
            "SELECT id FROM students WHERE admission_no = ?", (admission_no,)
        ).fetchone()
        if not student:
            return None
        present = conn.execute("""
            SELECT COUNT(*) FROM attendance
            WHERE student_id = ? AND date >= date('now', ?)
        """, (student["id"], f"-{days} days")).fetchone()[0]
        return {"present_days": present, "period_days": days, "percentage": round((present / days) * 100, 1) if days else 0}
