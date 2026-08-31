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

## Reference code (use this to rebuild fast NFC)

**Full live files in repo (always use these, do not rewrite from memory):**

| File | Path |
|------|------|
| Fast gate logic | `nfc_gate.py` |
| Flask routes | `main.py` |
| Telegram + Sheet API | `bot.py` |
| Config / env | `config.py` |
| Vercel deploy | `vercel.json` |
| ESP firmware | `firmware/ESP8266_Attendance_Vercel_OTA/ESP8266_Attendance_Vercel_OTA.ino` |

**Rule:** `/nfc` must **never** call `apps_script_get()` and wait before returning text to the ESP.  
Sheet + Telegram = **after** reply (thread on Render; see Vercel notes below).

---

### 1. `nfc_gate.py` — in-memory cache (globals)

```python
IST = ZoneInfo("Asia/Kolkata")
CACHE_TTL_SEC = 120          # refresh roster from Sheet every 2 min (background)
IN_CUTOFF_HOUR = 11          # before 11:00 IST = IN, else OUT

_students_by_uid: Dict[str, dict] = {}   # NFC UID -> student row
_students_by_adm: Dict[str, dict] = {}   # admission -> student row
_attendance_today: Dict[str, dict] = {}  # admission -> {date, in, out}
_cache_loaded_at = 0.0
_cache_loading = False

def _normalize_uid(raw: str) -> str:
    return str(raw or "").replace(" ", "").replace(":", "").replace("-", "").upper()

def _safe_name(name: str) -> str:
    # No colons — ESP parses SUCCESS:Name:IN:HH:mm:ss
    clean = "".join(ch for ch in str(name or "Student") if 32 <= ord(ch) <= 126 and ch != ":")
    return (clean.strip() or "Student")[:40]
```

---

### 2. `nfc_gate.py` — load cache (only on `/warm`, boot, or background — **not** on every tap)

```python
def refresh_student_cache(force: bool = False) -> bool:
    if not bot.APPS_SCRIPT_URL:
        return False
    with _lock:
        if not force and _students_by_uid and (time.time() - _cache_loaded_at) < CACHE_TTL_SEC:
            return True
        if _cache_loading and not force:
            return bool(_students_by_uid)
        _cache_loading = True
    try:
        rows = bot.get_all_students()  # Apps Script action=get_all_uids
        by_uid, by_adm = {}, {}
        for row in rows or []:
            adm = bot.normalize_admission(row.get("admissionNo", ""))
            if not adm:
                continue
            student = {
                "admissionNo": adm,
                "name": str(row.get("name") or "").strip() or f"Student {adm}",
                "nfcUid": _normalize_uid(row.get("nfcUid", "")),
                ...
            }
            by_adm[adm.lower()] = student
            if student["nfcUid"]:
                by_uid[student["nfcUid"]] = student
        with _lock:
            if by_adm:  # never wipe good cache on failed fetch
                _students_by_uid = by_uid
                _students_by_adm = by_adm
                _cache_loaded_at = time.time()
        refresh_attendance_from_sheet()  # action=today_attendance
        return bool(by_adm)
    finally:
        with _lock:
            _cache_loading = False
```

---

### 3. `nfc_gate.py` — **`process_nfc_tap`** (this is what makes 1–2 s taps)

```python
def process_nfc_tap(raw_uid: str) -> str:
  uid = _normalize_uid(raw_uid)
  if not uid:
      return "INVALID CARD"

  _schedule_cache_refresh(force=False)  # background only, never blocks tap

  with _lock:
      student = _students_by_uid.get(uid)
      cache_empty = not _students_by_uid

  if cache_empty:
      _schedule_cache_refresh(force=True)
      return "ERROR"   # ESP: tap again after /warm

  if not student:
      # Vercel: Telegram MUST run before HTTP response ends
      if _is_vercel():
          try:
              _telegram_admin_new_card(uid)
          except Exception as e:
              print(f"[NFC] new-card telegram error: {e}")
          threading.Thread(target=_background_admin_new_card_sheet, args=(uid,), daemon=True).start()
      else:
          threading.Thread(target=_background_admin_new_card, args=(uid,), daemon=True).start()
      return "INVALID CARD"

  now = _now_ist()
  day = now.strftime("%Y-%m-%d")
  time_str = now.strftime("%H:%M:%S")
  scan_type = "IN" if now.hour < IN_CUTOFF_HOUR else "OUT"
  name = _safe_name(student.get("name") or "Student")
  admission = bot.normalize_admission(student.get("admissionNo", ""))

  bucket = _attendance_bucket(admission, day)
  with _lock:
      existing = bucket.get("in") if scan_type == "IN" else bucket.get("out")

  if existing:
      threading.Thread(target=_reconcile_duplicate, args=(uid, admission, day, scan_type), daemon=True).start()
      return f"DUPLICATE:{name}:{existing}"

  _mark_local(admission, day, scan_type, time_str)
  threading.Thread(target=_background_sheet_sync, args=(uid,), daemon=True).start()
  return f"SUCCESS:{name}:{scan_type}:{time_str}"   # OLED gets this in ~1s
```

---

### 4. `nfc_gate.py` — background Sheet + parent Telegram (after SUCCESS)

```python
def _background_sheet_sync(uid: str) -> None:
    # Apps Script ?uid=... writes Attendance row + sends parent Telegram
    result = bot.apps_script_get({"uid": uid}, timeout=45)
    refresh_attendance_from_sheet()
```

On **Vercel**, this thread may not finish after the response. Registered taps still show SUCCESS fast;  
Sheet/Telegram may lag until instance stays alive briefly. **Do not** move this before `return SUCCESS`  
or taps become 10–20 s again.

---

### 5. `bot.py` — Apps Script helpers (used by cache, not by fast tap path)

```python
def apps_script_get(params, timeout=25):
    if not APPS_SCRIPT_URL:
        return None
    resp = requests.get(APPS_SCRIPT_URL, params=params, timeout=timeout, allow_redirects=True)
    try:
        return resp.json()
    except Exception:
        return {"raw": (resp.text or "").strip(), "ok": resp.ok}

def get_all_students():
    data = apps_script_get({"action": "get_all_uids"}, timeout=45)
    return data if isinstance(data, list) else []
```

**Apps Script must support:**

| Param | Purpose |
|-------|---------|
| `action=get_all_uids` | Load Students sheet → cache |
| `action=today_attendance` | Today's IN/OUT for DUPLICATE memory |
| `uid=XXXX` | Record tap + parent Telegram |
| `action=peek_uid` | Reconcile DUPLICATE after sheet delete |

---

### 6. `main.py` — Flask routes

```python
@app.route("/nfc", methods=["GET", "POST"])
def nfc_tap():
    uid = request.args.get("uid") or request.args.get("UID") or ""
    try:
        text = nfc_gate.process_nfc_tap(uid)
    except Exception as e:
        print(f"[NFC] process error uid={uid}: {e}")
        text = "ERROR"
    return Response(text.strip(), status=200, mimetype="text/plain")  # NOT json

@app.route("/warm")
def warm():
    cache = nfc_gate.cache_status()
    if not cache.get("cards"):
        # Vercel: must load sync when empty (threads don't survive)
        nfc_gate.refresh_student_cache(force=True)
        cache = nfc_gate.cache_status()
    else:
        threading.Thread(target=nfc_gate.refresh_student_cache, kwargs={"force": True}, daemon=True).start()
    return jsonify({"ok": cache.get("cards", 0) > 0, "cache": cache, ...})
```

---

### 7. `vercel.json` — deploy Flask + `nfc_gate.py` (do not use mixed Node `api/nfc.js`)

```json
{
  "version": 2,
  "builds": [
    {
      "src": "main.py",
      "use": "@vercel/python",
      "config": { "maxLambdaSize": "15mb", "maxDuration": 60 }
    }
  ],
  "routes": [{ "src": "/(.*)", "dest": "main.py" }]
}
```

`requirements.txt` must include: `flask`, `requests`

---

### 8. ESP8266 — URL and response parsing

```cpp
const char* ATTENDANCE_SERVER_URL = "https://school-nfc-bot.vercel.app/nfc";
// Request: ATTENDANCE_SERVER_URL + "?uid=" + uidStr

bool parseSuccessResponse(const String& response, String& studentName, String& typeStr, String& timeStr) {
  if (!response.startsWith("SUCCESS:")) return false;
  int inPos = response.indexOf(":IN:");
  int outPos = response.indexOf(":OUT:");
  // Parse using :IN: or :OUT: markers (names may contain other characters)
  ...
}

bool isValidatedServerResponse(const String& response) {
  if (response == "INVALID CARD" || response == "ERROR") return true;
  ...
}
```

---

### 9. Rebuild checklist (new server / new host)

1. Copy `nfc_gate.py`, `main.py`, `bot.py`, `config.py`, `vercel.json`, `requirements.txt`.
2. Set env: `BOT_TOKEN`, `APPS_SCRIPT_URL`, `ADMIN_CHAT_ID`.
3. Deploy Flask — **never** replace `/nfc` with direct Apps Script proxy.
4. Point UptimeRobot at `/warm` every 5 min.
5. Confirm `/warm` shows `cards` > 0.
6. Test: `curl "https://YOUR_HOST/nfc?uid=TEST"` → `INVALID CARD` in &lt;1 s when warm.
7. Flash ESP with `ATTENDANCE_SERVER_URL` pointing to `YOUR_HOST/nfc`.

---

### 10. What NOT to do (causes 10–20 s taps)

```python
# BAD — blocks ESP on every tap
def nfc_tap():
    result = bot.apps_script_get({"uid": uid}, timeout=45)
    return result["raw"]

# BAD — no cache
def nfc_tap():
    student = bot.find_student_by_uid_slow(uid)  # hits Sheet every time
```

```javascript
// BAD — Vercel Node without persistent cache
export default async function handler(req, res) {
  const r = await fetch(APPS_SCRIPT_URL + "?uid=" + uid);  // 5–15 s every tap
  res.end(await r.text());
}
```

---

*Last updated: August 2026 — MMM JHS NFC gate on Vercel.*
