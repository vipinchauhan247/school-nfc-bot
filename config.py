import os

SCHOOL_NAME = os.environ.get("SCHOOL_NAME", "Madan Mohan Malviya Junior High School")

# @Vipinbellbot ONLY — set in Render Environment (never commit real token)
BOT_TOKEN = os.environ.get("BOT_TOKEN", "").strip()
TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}" if BOT_TOKEN else ""

# Google Apps Script Web App /exec — sheet save + student lookup
APPS_SCRIPT_URL = os.environ.get("APPS_SCRIPT_URL", "").strip()
ADMIN_CHAT_ID = os.environ.get("ADMIN_CHAT_ID", "1722022492").strip()

PORT = int(os.environ.get("PORT", 8080))

# Production hostname for Telegram webhook + Vercel follow-up jobs.
# Do not use VERCEL_URL — that is a per-deployment host that breaks the bot.
PRODUCTION_HOST = "school-nfc-bot.vercel.app"


def _with_https(value: str) -> str:
    raw = (value or "").strip().rstrip("/")
    if not raw:
        return ""
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    return f"https://{raw}"


def public_base_url() -> str:
    """Stable public origin for webhook registration and /nfc_bg follow-ups."""
    explicit = _with_https(os.environ.get("PUBLIC_BASE_URL", ""))
    if explicit:
        return explicit
    prod = _with_https(os.environ.get("VERCEL_PROJECT_PRODUCTION_URL", ""))
    if prod:
        return prod
    if os.environ.get("VERCEL"):
        return f"https://{PRODUCTION_HOST}"
    render = _with_https(os.environ.get("RENDER_EXTERNAL_URL", ""))
    if render:
        return render
    vercel = _with_https(os.environ.get("VERCEL_URL", ""))
    if vercel:
        return vercel
    return ""
