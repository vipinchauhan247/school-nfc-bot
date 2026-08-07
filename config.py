import os

SCHOOL_NAME = os.environ.get("SCHOOL_NAME", "Madan Mohan Malviya Junior High School")
BOT_TOKEN = os.environ.get("BOT_TOKEN", "")
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}" if BOT_TOKEN else ""
APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL", "")
PORT = int(os.environ.get("PORT", 8080))
DATABASE_PATH = os.environ.get("DATABASE_PATH", "school.db")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
