import os

SCHOOL_NAME = os.environ.get("SCHOOL_NAME", "Madan Mohan Malviya Junior High School")

# @Vipinbellbot ONLY — set in Render Environment (never commit real token)
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}" if BOT_TOKEN else ""

# Google Apps Script Web App /exec — sheet save + student lookup
APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL", "").strip()
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "1722022492").strip()

PORT = int(os.environ.get("PORT", 8080))
