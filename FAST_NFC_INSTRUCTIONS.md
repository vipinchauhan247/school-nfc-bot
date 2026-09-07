# Fast NFC response (1–2 seconds) — instructions for Codex / deploy

**Bot:** @Vipinbellbot only  
**Host:** `https://school-nfc-bot.vercel.app`  
**Do not touch:** @mmmjhschoolbot / ERP / `mmmjhschoolbot/`

OLED on the ESP8266 box must show SUCCESS / DUPLICATE / NEW CARD in **about 1–2 seconds**.  
Google Sheet write and parent Telegram happen **after** that reply, never during it.

Longer architecture notes: [`NFC_FAST_RESPONSE_GUIDE.md`](NFC_FAST_RESPONSE_GUIDE.md)

---

## Golden rule

**`GET /nfc?uid=...` must never wait on Google Apps Script or Telegram before returning plain text to the ESP.**

If `/nfc` calls Apps Script (or `peek_uid`, or `sendMessage`) and waits, taps become **5–15 seconds**. That is the bug. Do not “fix” speed by putting the student list on the ESP8266.

---

## Who stores what

| Place | RAM | Job |
|--------|-----|-----|
| **ESP8266** (~80 KB, ~15–30 KB free after Wi‑Fi + HTTPS + OLED) | UID just read + short offline queue only | Read card → `GET /nfc?uid=` → show OLED |
| **Vercel Flask** (`nfc_gate.py`) | All 146+ card UIDs and names | Instant lookup, then reply |

ESP8266 **cannot** hold 678 students. Do not download `get_all_uids` onto the box.

---

## Required server design

Deploy **Flask** `main.py` with `nfc_gate.py` via `vercel.json` (`@vercel/python`).

**Not allowed:** Node `api/nfc.js` (or any handler) that does `fetch(APPS_SCRIPT_URL + "?uid=" + uid)` on every tap.

### Files (use these, do not rewrite from memory)

| File | Role |
|------|------|
| `nfc_gate.py` | In-memory UID cache + tap logic |
| `main.py` | Routes: `/nfc`, `/warm`, `/health`, `/bot_webhook`, `/nfc_bg`, `/setup` |
| `bot.py` | Telegram + Apps Script helpers |
| `config.py` | Env + production URL `school-nfc-bot.vercel.app` |
| `vercel.json` | Route all traffic to `main.py` |
| `requirements.txt` | `flask`, `requests` |

### `/nfc` fast path (OLED)

1. Load UID from query (`uid` or `UID`).
2. Look up UID in **RAM** (`_students_by_uid`).
3. Return **immediately** (HTTP 200, `text/plain`, no JSON):

| Response | Meaning |
|----------|---------|
| `SUCCESS:Name:IN:HH:mm:ss` | Marked IN (before 11:00 IST) |
| `SUCCESS:Name:OUT:HH:mm:ss` | Marked OUT (11:00 IST or later) |
| `DUPLICATE:Name:HH:mm:ss` | Already scanned this IN or OUT |
| `INVALID CARD` | UID not on Students sheet |
| `ERROR` | Cache empty — tap again after `/warm` |

Strip `:` from names (`nfc_gate._safe_name`). Do not return JSON to the ESP.

4. **After** the reply is decided: Sheet + parent Telegram.
   - Vercel: start a **separate** request to `POST /nfc_bg` (do **not** wait for Apps Script to finish).
   - Never `apps_script_get({"uid": uid})` inside `/nfc` before `return`.

### `/warm` (keep RAM full)

UptimeRobot must hit this **every 5 minutes**:

```
https://school-nfc-bot.vercel.app/warm
```

Not `/health`. Not `/nfc`.

Good `/warm` (cache loaded):

```json
{
  "ok": true,
  "message": "NFC cache loaded",
  "cache": { "students": 678, "cards": 146 }
}
```

**Broken** `/warm` (slow 5–10 s taps — reject this deploy):

```json
{"ok": true, "message": "Serverless endpoint ready; no keep-alive or warm cache is required."}
```

If cache is empty, `/warm` must load `get_all_uids` **synchronously** (Vercel kills background threads). First `/warm` after idle may take 5–30 s; that is OK. Taps must stay fast.

Also from `/warm`: register Telegram webhook to  
`https://school-nfc-bot.vercel.app/bot_webhook`  
never a per-deploy `VERCEL_URL` like `school-nfc-bot-xxxxx.vercel.app`.

### Env (Vercel)

- `BOT_TOKEN`
- `APPS_SCRIPT_URL`
- `ADMIN_CHAT_ID` (optional)
- `SCHOOL_NAME` (optional)

---

## Timing (when cache is warm)

| Step | Time |
|------|------|
| ESP Wi‑Fi + HTTPS | ~0.5–1.5 s |
| Server RAM lookup | ~0.05–0.2 s |
| **OLED total** | **~1–2 s** |

---

## What NOT to do (causes 5–15 s)

```python
# BAD — blocks the box on every tap
def nfc_tap():
    result = bot.apps_script_get({"uid": uid}, timeout=45)
    return result
```

```javascript
// BAD — no RAM cache
export default async function handler(req, res) {
  const r = await fetch(APPS_SCRIPT_URL + "?uid=" + uid);
  res.end(await r.text());
}
```

Also slow / forbidden on the `/nfc` request:

- `peek_uid` / `get_all_uids` before returning to the ESP
- `sendMessage` to admin/parent before returning SUCCESS / INVALID CARD
- Waiting for `POST /nfc_bg` body (Apps Script is slow)
- Putting the roster on ESP8266 RAM
- UptimeRobot on `/nfc` (fake taps)

Empty cache: return `ERROR` quickly. Do not peek Google on that same tap. `/warm` fills RAM.

---

## After every deploy — verify

```bash
# 1. Cache must be loaded (must NOT say "no warm cache is required")
curl -s https://school-nfc-bot.vercel.app/warm

# 2. Unregistered UID must return INVALID CARD in under 1s when warm
curl -s -w "\n%{time_total}s\n" "https://school-nfc-bot.vercel.app/nfc?uid=TEST123DEAD"

# 3. Telegram
# Message @Vipinbellbot /start — must reply
```

UptimeRobot: **Up**, URL `/warm`, interval **5 minutes**.

ESP firmware URL (do not change unless the host changes):

```
https://school-nfc-bot.vercel.app/nfc
```

Firmware: `firmware/mmm_jhs_nfc_gate/` or `firmware/ESP8266_Attendance_Vercel_OTA/`

---

## Checklist before merging any NFC change

- [ ] `vercel.json` still routes `/(.*)` → `main.py` (Flask), not Node `api/nfc.js`
- [ ] `/nfc` does not call Apps Script / Telegram before returning text
- [ ] `/warm` returns `cache.cards > 0` and message **NFC cache loaded**
- [ ] Webhook URL is `https://school-nfc-bot.vercel.app/bot_webhook`
- [ ] Timed `/nfc?uid=TEST...` is **&lt; 1 s** after `/warm`
- [ ] @mmmjhschoolbot / ERP files unchanged
