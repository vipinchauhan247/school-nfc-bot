# MMM School ERP — Android APK + live Sheet sync

## Why QR / Sign disappeared
The earlier mobile ERP branch used a **separate empty SQLite DB** (demo students 2211–2215) and the APK was pointed at **`http://127.0.0.1:8080`**.

Your real data (**677 students**) lives on **Google Sheets** via the live server:
`https://school-nfc-bot.onrender.com`

So the app could not see your uploaded data, Telegram QR/sign-in on the site looked wrong on that branch, and the phone APK could not sync.

**This branch restores:**
- NFC gate + Telegram webhook + Google Sheet (source of truth)
- Website **Telegram QR + Sign / Register** panel again
- Mobile API reading the **same Sheet**
- APK default API URL → `https://school-nfc-bot.onrender.com`

> After merge, **redeploy on Render** so `/api/mobile/*` exists in production. Until then the APK login will fail with 404.

## How to run / install the APK

### On Android phone
1. Copy **`MMM-School-ERP.apk`** to the phone (WhatsApp / Drive / USB / agent artifact download).
2. Open **Files** or **Chrome** → tap the APK.
3. If blocked: **Settings → Apps → Special access → Install unknown apps** → allow for Files/Chrome.
4. Tap **Install** → **Open**.
5. Choose Student / Parent / Staff.
6. Enter a **real admission number from your Sheet** (not 2211 demo).
7. Staff password = Render env `ADMIN_PASSWORD` (default `admin123` if unset).

### Parent Telegram (QR sign-in)
1. Open `https://school-nfc-bot.onrender.com`
2. Scan the **Telegram QR**
3. Send `/register <Admission No>`

## Sync model
```
Google Sheet (uploaded students)
        │
        ▼
Render server (NFC + Telegram + /api/mobile)
        │
   ┌────┴────┐
 Website   Android APK
```
App and website auto-refresh about every 12 seconds after deploy.
