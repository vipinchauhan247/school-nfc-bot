# NFC Fast Response (1–2 seconds) — Architecture & Fixes

Reference for **@Vipinbellbot** / `school-nfc-bot.vercel.app` and ESP8266 NFC boxes.

---

## Goal

OLED on the NFC box should show **SUCCESS / DUPLICATE / NEW CARD** in about **1–2 seconds** after tap.  
Google Sheet write and parent Telegram alerts happen **after** the OLED reply, not during it.

---

## How fast response works (core design)

This is the same model that worked on **Render** with `nfc_gate.py`. It was restored on **Vercel** using Flask `main.py` + `nfc_gate.py`.

### ESP8266 (dumb client)

- Read UID from PN532 only.
- Send: `GET https://school-nfc-bot.vercel.app/nfc?uid=XXXXXXXX`
- Show plain-text reply on OLED.
- **Do not** store student list or UIDs on the ESP (only short debounce / offline queue in advanced firmware).

### Server (smart cache)

File: `nfc_gate.py`

1. **In-memory maps** (loaded from Google Sheet via Apps Script):
   - `students_by_uid` — NFC UID → student
   - `students_by_adm` — admission → student
   - `attendance_today` — today’s IN/OUT per admission (for DUPLICATE)

2. **On each `/nfc` tap** (fast path, no Sheet wait):
   - Lookup UID in RAM.
   - Decide IN vs OUT (before 11:00 IST = IN, else OUT).
   - Return immediately:
     - `SUCCESS:Name:IN:HH:mm:ss`
     - `SUCCESS:Name:OUT:HH:mm:ss`
     - `DUPLICATE:Name:HH:mm:ss`
     - `INVALID CARD`
     - `ERROR` (cache empty — tap again after `/warm`)

3. **After reply** (background on Render; special rules on Vercel — see below):
   - Apps Script `?uid=...` → writes Attendance sheet + parent Telegram.
   - New unregistered card → admin Telegram alert.

### Why this is ~1–2 seconds

| Step | Time |
|------|------|
| ESP Wi‑Fi + HTTPS | ~0.5–1.5 s |
| Server RAM lookup | ~0.05–0.2 s |
| **Total perceived** | **~1–2 s** |

### What makes it slow (10–20 seconds)

Calling **Google Apps Script on every tap** and waiting for Sheet + Telegram **before** answering the ESP.  
The broken Vercel deploy did exactly that.

---

## Vercel vs Render (important)

| | Render (old) | Vercel (current) |
|--|--------------|------------------|
| Process | Always-on | Serverless (cold start possible) |
| In-memory cache | One process, shared | Per instance; lost on cold start |
| Background threads | Work after response | **Killed when HTTP response ends** |
| Keep warm | Built-in keep-alive | **UptimeRobot on `/warm`** every 5 min |

### Vercel deployment layout

- **Entry:** `main.py` (Flask) via `vercel.json` + `@vercel/python`
- **Not** separate Node `api/nfc.js` (that build failed on Vercel).
- **Telegram webhook:** same Flask app, route `/bot_webhook`

### `/warm` endpoint

- Reloads student + attendance cache from Apps Script.
- If cache empty on Vercel: loads **synchronously** (serverless cannot rely on background threads).
- First `/warm` after idle may take **~5–30 s** (loads all students).
- **UptimeRobot must hit `/warm`**, not only `/health`.

```
https://school-nfc-bot.vercel.app/warm
Interval: every 5 minutes
```

Good `/warm` response:

```json
{
  "ok": true,
  "message": "NFC cache loaded",
  "cache": { "students": 678, "cards": 146, "age_sec": 120 }
}
```

---

## Environment variables (Vercel)

| Variable | Purpose |
|----------|---------|
| `BOT_TOKEN` | @Vipinbellbot |
| `APPS_SCRIPT_URL` | Google Apps Script `/exec` |
| `ADMIN_CHAT_ID` | New-card alerts (default `1722022492`) |
| `SCHOOL_NAME` | Optional |

Open once after deploy: `https://school-nfc-bot.vercel.app/setup`

---

## ESP8266 firmware

### Simple gate (repo)

`firmware/mmm_jhs_nfc_gate/mmm_jhs_nfc_gate.ino`

### Full school box (OTA, battery, sleep, offline queue)

`firmware/ESP8266_Attendance_Vercel_OTA/ESP8266_Attendance_Vercel_OTA.ino`

```cpp
const char* ATTENDANCE_SERVER_URL = "https://school-nfc-bot.vercel.app/nfc";
```

Copy `private_config.example.h` → `private_config.h` (Wi‑Fi + OTA password).

### Auto sleep (3:30 PM – 7:30 AM IST)

Not “3.30 seconds” — **3:30 PM** school close.

```cpp
#define DISABLE_AUTO_SLEEP true   // testing: awake 24/7
#define DISABLE_AUTO_SLEEP false  // school: deep sleep overnight
```

### Server response format (must match)

Firmware validates strict plain text:

| Response | Meaning |
|----------|---------|
| `SUCCESS:Name:IN:16:30:45` | Marked IN |
| `SUCCESS:Name:OUT:16:30:45` | Marked OUT |
| `DUPLICATE:Name:16:30:45` | Already scanned |
| `INVALID CARD` | UID not registered |
| `ERROR` | Server cache loading — tap again |

**Names must not contain `:`** on server (`nfc_gate._safe_name` strips colons).  
Firmware parses SUCCESS using `:IN:` / `:OUT:` markers (handles odd names better).

---

## Problems found and fixes (changelog)

### 1. Slow taps on Vercel (10–20 s)

- **Cause:** Vercel called Apps Script on every `/nfc` tap; no RAM cache.
- **Fix:** Restored `nfc_gate.py` fast path on Vercel (PR #31, Flask `main.py`).

### 2. UptimeRobot didn’t help

- **Cause:** Old `/warm` didn’t reload cache; `/health` only checked config.
- **Fix:** `/warm` reloads cache; point UptimeRobot at `/warm` every 5 min.

### 3. Vercel build failed (~3 s Error)

- **Cause:** Mixed Node `api/*.js` + Python `bot_webhook.py`.
- **Fix:** Single Flask `main.py` deploy via `vercel.json` builds/routes.

### 4. Cache always empty (`cards: 0`)

- **Cause:** Background threads on Vercel don’t finish; boot thread raced with `/warm`.
- **Fix:** Sync cache load on `/warm` when empty; skip boot warm on Vercel; `force` refresh doesn’t block on `_cache_loading`.

### 5. New card — fast beep but no Telegram

- **Cause:** Admin alert ran in daemon thread; Vercel killed it after HTTP response.
- **Fix:** On Vercel, send admin Telegram **synchronously** before returning `INVALID CARD` (`nfc_gate.py`).

### 6. OLED “SERVER ERROR / Invalid response”

- **Cause:** Student names with `:` broke `SUCCESS:Name:IN:time` parsing; `ERROR` not accepted by firmware.
- **Fix:** Strip `:` from names on server; firmware parses `:IN:`/`OUT:`; show **SERVER BUSY** on `ERROR`.

### 7. Box sleeps immediately on power-on after 3:30 PM

- **Cause:** `checkOvernightSchedule()` in firmware (by design).
- **Fix:** `DISABLE_AUTO_SLEEP true` for testing; `false` for school gates.

---

## Daily operations checklist

1. **UptimeRobot:** `/warm` every 5 min.
2. **Morning:** Open `/warm` — confirm `cards` > 0 before gates open.
3. **New deploy:** Vercel Deployments → Ready on `main`.
4. **Link new card:** Telegram `/link UID AdmissionNo` on @Vipinbellbot.
5. **Do not** UptimeRobot `/nfc` (fake taps).

---

## Key files

| File | Role |
|------|------|
| `nfc_gate.py` | RAM cache, `/nfc` logic, background Sheet sync |
| `main.py` | Flask routes: `/nfc`, `/warm`, `/health`, `/bot_webhook`, `/setup` |
| `bot.py` | Telegram + Apps Script helpers |
| `vercel.json` | Vercel Python Flask routing |
| `firmware/ESP8266_Attendance_Vercel_OTA/` | Production ESP firmware |

---

## Testing

```bash
# Cache status
curl -s https://school-nfc-bot.vercel.app/warm

# Simulated tap (should be <1s when warm)
curl -s "https://school-nfc-bot.vercel.app/nfc?uid=TEST123"
```

Registered card should return `SUCCESS:...` in ~1–2 s on the box when cache is warm.

---

## If taps are slow again

1. Check `/warm` — `cards` should be > 0.
2. Check Vercel deployment is latest `main` (not old “no warm cache” message).
3. Cold start — first tap after long idle may be ~2–3 s; UptimeRobot mitigates this.
4. ESP Serial Monitor — look for `[HTTP] Server Response:` line.

---

*Last updated: August 2026 — MMM JHS NFC gate on Vercel.*
