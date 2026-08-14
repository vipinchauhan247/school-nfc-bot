# ERP vs NFC — do not mix sheets

| System | Telegram bot | Google Sheet | Purpose |
|--------|--------------|--------------|---------|
| **ERP** (app / website / this QR) | **@mmmjhschoolbot** | **MMMJHS Telegram / ERP sheet** | School ERP portal |
| **NFC attendance** | **@Vipinbellbot** | **NFC attendance sheet** | Gate taps only |

The Android ERP app reads **only** `ERP_APPS_SCRIPT_URL` (MMMJHS Telegram sheet).
It does **not** read or write the NFC attendance sheet.

## Domain
Purchased: **https://mmmjhschool.com**

Point DNS to your Render service (Custom Domain), then set:
```
PUBLIC_BASE_URL=https://mmmjhschool.com
```

## Render env you must set for ERP
```
ERP_BOT_TOKEN=<token for @mmmjhschoolbot>
ERP_BOT_USERNAME=mmmjhschoolbot
ERP_APPS_SCRIPT_URL=https://script.google.com/macros/s/XXXX/exec   # MMMJHS Telegram sheet script
PUBLIC_BASE_URL=https://mmmjhschool.com
```

NFC can keep:
```
NFC_BOT_TOKEN / BOT_TOKEN=<@Vipinbellbot>
NFC_APPS_SCRIPT_URL / APPS_SCRIPT_URL=<NFC attendance script>
```

## APK install
1. Download `MMM-School-ERP.apk`
2. Install on Android (allow unknown apps)
3. Open → login with admission numbers from the **MMMJHS Telegram sheet**
