import os

SCHOOL_NAME = os.environ.get("SCHOOL_NAME", "Madan Mohan Malviya Junior High School")

# ---------------------------------------------------------------------------
# NFC attendance stack — @Vipinbellbot + NFC attendance Google Sheet
# LOCKED: do not change unless the user explicitly asks.
# ---------------------------------------------------------------------------
NFC_BOT_TOKEN = os.environ.get("NFC_BOT_TOKEN", os.environ.get("BOT_TOKEN", "")).strip()
NFC_TELEGRAM_API = f"https://api.telegram.org/bot{NFC_BOT_TOKEN}" if NFC_BOT_TOKEN else ""
NFC_BOT_USERNAME = os.environ.get("NFC_BOT_USERNAME", "Vipinbellbot").lstrip("@")
# Apps Script bound to the NFC attendance spreadsheet
NFC_APPS_SCRIPT_URL = os.environ.get(
    "NFC_APPS_SCRIPT_URL", os.environ.get("APPS_SCRIPT_URL", "")
).strip()
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "1722022492").strip()

# Back-compat aliases used by existing nfc_gate / bot modules (NFC only)
BOT_TOKEN = NFC_BOT_TOKEN
TELEGRAM_API = NFC_TELEGRAM_API
APPS_SCRIPT_URL = NFC_APPS_SCRIPT_URL

# ---------------------------------------------------------------------------
# ERP stack — @mmmjhschoolbot + MMMJHS Telegram / ERP Google Sheet
# Website: Vercel (mmmjhschool.com). Bot confirmed working.
# ---------------------------------------------------------------------------
ERP_BOT_TOKEN = os.environ.get("ERP_BOT_TOKEN", "").strip()
ERP_TELEGRAM_API = f"https://api.telegram.org/bot{ERP_BOT_TOKEN}" if ERP_BOT_TOKEN else ""
ERP_BOT_USERNAME = os.environ.get("ERP_BOT_USERNAME", "mmmjhschoolbot").lstrip("@")
# Apps Script bound to the MMMJHS Telegram / ERP spreadsheet (NOT the NFC sheet)
ERP_APPS_SCRIPT_URL = os.environ.get("ERP_APPS_SCRIPT_URL", "").strip()

PORT = int(os.environ.get("PORT", 8080))
DATABASE_PATH = os.environ.get("DATABASE_PATH", "school.db")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

# Public ERP website on Vercel
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://mmmjhschool.com").rstrip("/")
VERCEL_URL = os.environ.get("VERCEL_URL", "").strip()

# Default public Telegram bot for ERP UI / QR
TELEGRAM_BOT_USERNAME = ERP_BOT_USERNAME
