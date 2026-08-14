# ERP vs NFC — do not mix sheets

| System | Telegram bot | Google Sheet | Purpose |
|--------|--------------|--------------|---------|
| **ERP** (app / website / this QR) | **@mmmjhschoolbot** | **MMMJHS Telegram / ERP sheet** | School ERP portal |
| **NFC attendance** | **@Vipinbellbot** | **NFC attendance sheet** | Gate taps only |

The Android ERP app reads **only** `ERP_APPS_SCRIPT_URL` (MMMJHS Telegram sheet).
It does **not** read or write the NFC attendance sheet.

## Domain / website
- Purchased: **https://mmmjhschool.com**
- Website hosted on **Vercel** (point domain DNS to Vercel)
- ERP bot **@mmmjhschoolbot** is working and updates the MMMJHS Telegram sheet
- **Do not touch @Vipinbellbot / NFC sheet**

## Render / API env for ERP only (never change NFC bot vars)
```
ERP_BOT_TOKEN=<token for @mmmjhschoolbot>
ERP_BOT_USERNAME=mmmjhschoolbot
ERP_APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec   # MMMJHS Telegram sheet
PUBLIC_BASE_URL=https://mmmjhschool.com
```

NFC (leave alone):
```
BOT_TOKEN / NFC_BOT_TOKEN → @Vipinbellbot
APPS_SCRIPT_URL / NFC_APPS_SCRIPT_URL → NFC attendance sheet
```

## APK install
1. Download `MMM-School-ERP.apk`
2. Install on Android (allow unknown apps)
3. Open → login with admission numbers from the **MMMJHS Telegram sheet**
