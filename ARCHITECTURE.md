# Architecture lock

## Do not touch (unless user explicitly asks)
- **@Vipinbellbot**
- NFC attendance Google Sheet
- `bot.py` / `nfc_gate.py` NFC webhook (`/bot_webhook`, `/nfc`)
- `NFC_BOT_TOKEN` / `APPS_SCRIPT_URL` / `NFC_APPS_SCRIPT_URL`

## ERP (safe to change)
- **@mmmjhschoolbot** — confirmed working + updates MMMJHS Telegram sheet
- `ERP_BOT_TOKEN` / `ERP_APPS_SCRIPT_URL`
- Mobile app / ERP web UI
- Domain **mmmjhschool.com** (website on **Vercel**)

## Hosting
| Piece | Where |
|-------|--------|
| School website | **Vercel** → `mmmjhschool.com` (DNS TBD) |
| ERP Telegram bot | Separate from NFC; sheet = MMMJHS Telegram |
| NFC gate + @Vipinbellbot | Render (existing) — leave alone |
