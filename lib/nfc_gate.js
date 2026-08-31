/**
 * Fast NFC gate for ESP8266 on Vercel serverless.
 * Reply from in-memory cache first; sync Google Sheet + Telegram in background.
 */

const { appsScriptGet } = require('./apps_script');
const { ADMIN_CHAT_ID } = require('./config');

const CACHE_TTL_SEC = 120;
const IN_CUTOFF_HOUR = 11;

let studentsByUid = {};
let studentsByAdm = {};
let attendanceToday = {};
let cacheLoadedAt = 0;
let cacheLoading = false;

function nowIST() {
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
  );
}

function normalizeUid(raw) {
  return String(raw || '')
    .replace(/[\s:-]/g, '')
    .toUpperCase();
}

function normalizeAdmission(value) {
  let s = String(value || '').trim();
  if (s.endsWith('.0') && /^\d+$/.test(s.slice(0, -2))) {
    s = s.slice(0, -2);
  }
  return s;
}

function normalizeChatId(value) {
  let s = String(value || '').trim();
  if (s.endsWith('.0') && /^\d+$/.test(s.slice(0, -2))) {
    s = s.slice(0, -2);
  }
  return s;
}

function safeName(name) {
  const clean = String(name || 'Student')
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126)
    .join('')
    .trim();
  return (clean || 'Student').slice(0, 40);
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cacheStatus() {
  return {
    students: Object.keys(studentsByAdm).length,
    cards: Object.keys(studentsByUid).length,
    age_sec: cacheLoadedAt
      ? Math.floor((Date.now() - cacheLoadedAt) / 1000)
      : null,
    attendance_rows: Object.keys(attendanceToday).length,
  };
}

function applyTodayAttendanceMap(payload) {
  if (!payload || typeof payload !== 'object' || !payload.ok) return;
  const day = String(payload.date || formatDay(nowIST()));
  const rawMap = payload.attendance || {};
  if (typeof rawMap !== 'object') return;

  const rebuilt = {};
  for (const [admKey, row] of Object.entries(rawMap)) {
    if (!row || typeof row !== 'object') continue;
    const adm = normalizeAdmission(row.admissionNo || admKey).toLowerCase();
    if (!adm) continue;
    rebuilt[adm] = {
      date: day,
      in: String(row.in || '').trim(),
      out: String(row.out || '').trim(),
    };
  }

  for (const key of Object.keys(attendanceToday)) {
    const row = attendanceToday[key] || {};
    if (row.date === day && !rebuilt[key]) {
      delete attendanceToday[key];
    }
  }
  for (const [key, row] of Object.entries(rebuilt)) {
    attendanceToday[key] = row;
  }
  console.log(
    `[NFC] attendance reconciled from sheet: ${Object.keys(rebuilt).length} rows for ${day}`
  );
}

async function refreshAttendanceFromSheet() {
  try {
    const payload = await appsScriptGet({ action: 'today_attendance' }, 45000);
    if (payload && typeof payload === 'object') {
      applyTodayAttendanceMap(payload);
      return true;
    }
  } catch (err) {
    console.error('[NFC] attendance refresh error:', err);
  }
  return false;
}

async function getAllStudents() {
  const data = await appsScriptGet({ action: 'get_all_uids' }, 45000);
  return Array.isArray(data) ? data : [];
}

async function refreshStudentCache(force = false) {
  const now = Date.now();
  if (
    !force &&
    Object.keys(studentsByUid).length &&
    now - cacheLoadedAt < CACHE_TTL_SEC * 1000
  ) {
    return true;
  }
  if (cacheLoading) {
    return Object.keys(studentsByUid).length > 0;
  }
  cacheLoading = true;

  try {
    const rows = await getAllStudents();
    const byUid = {};
    const byAdm = {};
    for (const row of rows || []) {
      if (!row || typeof row !== 'object') continue;
      const adm = normalizeAdmission(row.admissionNo);
      if (!adm) continue;
      const student = {
        admissionNo: adm,
        name: String(row.name || '').trim() || `Student ${adm}`,
        className: String(row.className || '').trim(),
        nfcUid: normalizeUid(row.nfcUid),
        telegramChatId: normalizeChatId(row.telegramChatId),
      };
      byAdm[adm.toLowerCase()] = student;
      if (student.nfcUid) {
        byUid[student.nfcUid] = student;
      }
    }
    if (Object.keys(byAdm).length) {
      studentsByUid = byUid;
      studentsByAdm = byAdm;
      cacheLoadedAt = Date.now();
    }
    console.log(
      `[NFC] cache refreshed: ${Object.keys(byAdm).length} students, ${Object.keys(byUid).length} cards`
    );
    await refreshAttendanceFromSheet();
    return true;
  } catch (err) {
    console.error('[NFC] cache refresh error:', err);
    return false;
  } finally {
    cacheLoading = false;
  }
}

function scheduleCacheRefresh(force = false) {
  const age = cacheLoadedAt ? (Date.now() - cacheLoadedAt) / 1000 : 99999;
  if (cacheLoading) return null;
  if (!force && Object.keys(studentsByUid).length && age < CACHE_TTL_SEC) {
    return null;
  }
  return () => refreshStudentCache(force);
}

function invalidateStudentCache() {
  cacheLoadedAt = 0;
  const bg = scheduleCacheRefresh(true);
  return bg;
}

function formatDay(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTime(dt) {
  const h = String(dt.getHours()).padStart(2, '0');
  const m = String(dt.getMinutes()).padStart(2, '0');
  const s = String(dt.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function attendanceBucket(admission, day) {
  const key = admission.toLowerCase();
  const row = attendanceToday[key];
  if (!row || row.date !== day) {
    attendanceToday[key] = { date: day, in: '', out: '' };
  }
  return attendanceToday[key];
}

function markLocal(admission, day, scanType, timeStr) {
  const row = attendanceBucket(admission, day);
  if (scanType === 'IN') row.in = timeStr;
  else row.out = timeStr;
}

function clearLocalScan(admission, day, scanType) {
  const row = attendanceBucket(admission, day);
  if (scanType === 'IN') row.in = '';
  else row.out = '';
}

async function backgroundSheetSync(uid) {
  try {
    const result = await appsScriptGet({ uid }, 45000);
    console.log(`[NFC] background sheet sync ${uid} ->`, result);
    await refreshAttendanceFromSheet();
  } catch (err) {
    console.error('[NFC] background sync error:', err);
  }
}

async function reconcileDuplicate(uid, admission, day, scanType) {
  try {
    const peek = await appsScriptGet({ action: 'peek_uid', uid }, 30000);
    if (!peek || typeof peek !== 'object' || !peek.ok) {
      await refreshAttendanceFromSheet();
      return;
    }
    if (!peek.found) {
      delete studentsByUid[normalizeUid(uid)];
      console.log(`[NFC] peek: UID ${uid} no longer on Students`);
      return;
    }
    const att = peek.attendance || {};
    const sheetVal =
      (scanType === 'IN' ? att.inTime : att.outTime) || '';
    if (!String(sheetVal).trim()) {
      clearLocalScan(admission, day, scanType);
      console.log(
        `[NFC] cleared local ${scanType} for ${admission} (deleted on sheet)`
      );
    } else {
      markLocal(admission, day, scanType, String(sheetVal).trim());
    }
  } catch (err) {
    console.error('[NFC] reconcile error:', err);
  }
}

async function sendTelegramMessage(chatId, text) {
  const { TELEGRAM_API } = require('./config');
  if (!TELEGRAM_API) return null;
  try {
    const resp = await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
    return await resp.json();
  } catch (err) {
    console.error('[BOT] sendMessage error:', err);
    return null;
  }
}

async function backgroundAdminNewCard(uid) {
  try {
    await refreshStudentCache(true);
    if (studentsByUid[normalizeUid(uid)]) {
      console.log(`[NFC] UID ${uid} appeared after refresh — skip admin alert`);
      return;
    }
    await sendTelegramMessage(
      ADMIN_CHAT_ID,
      '🆕 <b>New Unregistered NFC Card Scanned!</b>\n\n' +
        `<b>Card UID:</b> <code>${escapeHtml(uid)}</code>\n\n` +
        'To link this card to a student, reply:\n' +
        `👉 <code>/link ${escapeHtml(uid)} &lt;Admission No&gt;</code>`
    );
    await appsScriptGet({ uid }, 45000);
  } catch (err) {
    console.error('[NFC] new-card notify error:', err);
  }
}

/**
 * Fast path for ESP OLED. Returns plain text and optional background tasks.
 */
function processNfcTap(rawUid) {
  const backgrounds = [];
  const uid = normalizeUid(rawUid);
  if (!uid) {
    return { text: 'INVALID CARD', backgrounds };
  }

  const refreshBg = scheduleCacheRefresh(false);
  if (refreshBg) backgrounds.push(refreshBg);

  const student = studentsByUid[uid];
  const cacheEmpty = !Object.keys(studentsByUid).length;

  if (cacheEmpty) {
    const forceBg = scheduleCacheRefresh(true);
    if (forceBg) backgrounds.push(forceBg);
    return { text: 'ERROR', backgrounds };
  }

  if (!student) {
    backgrounds.push(() => backgroundAdminNewCard(uid));
    return { text: 'INVALID CARD', backgrounds };
  }

  const now = nowIST();
  const day = formatDay(now);
  const timeStr = formatTime(now);
  const scanType = now.getHours() < IN_CUTOFF_HOUR ? 'IN' : 'OUT';
  const name = safeName(student.name);
  const admission = normalizeAdmission(student.admissionNo);

  const bucket = attendanceBucket(admission, day);
  const existing =
    scanType === 'IN' ? bucket.in : bucket.out;

  if (existing) {
    backgrounds.push(() =>
      reconcileDuplicate(uid, admission, day, scanType)
    );
    return { text: `DUPLICATE:${name}:${existing}`, backgrounds };
  }

  markLocal(admission, day, scanType, timeStr);
  backgrounds.push(() => backgroundSheetSync(uid));
  return { text: `SUCCESS:${name}:${scanType}:${timeStr}`, backgrounds };
}

module.exports = {
  processNfcTap,
  refreshStudentCache,
  invalidateStudentCache,
  cacheStatus,
  scheduleCacheRefresh,
};
