/**
 * ERP Cloud layer — snapshot (compat) + native student rows (cloud-native).
 *
 * Env (Render — already used by live cloud sync):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (or SUPABASE_SERVICE_KEY)
 *   ERP_CLOUD_SECRET
 *   ERP_CLOUD_SCHOOL_ID=mmm-jhs
 *
 * Does NOT touch @Vipinbellbot / NFC.
 */
const https = require('https');
const { URL } = require('url');

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function schoolIdDefault() {
  return env('ERP_CLOUD_SCHOOL_ID', 'mmm-jhs') || 'mmm-jhs';
}

function cloudSecret() {
  return env('ERP_CLOUD_SECRET');
}

function supabaseUrl() {
  return env('SUPABASE_URL').replace(/\/$/, '');
}

function supabaseKey() {
  return env('SUPABASE_SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_KEY') || env('SUPABASE_KEY');
}

function isConfigured() {
  return !!(supabaseUrl() && supabaseKey());
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-ERP-Cloud-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function readSecret(req) {
  const q = req.query || {};
  const header = req.headers['x-erp-cloud-secret'] || req.headers['X-ERP-Cloud-Secret'];
  return String(header || q.secret || '').trim();
}

function requireSecret(req, res) {
  const expected = cloudSecret();
  if (!expected) return true;
  if (readSecret(req) !== expected) {
    json(res, 200, { ok: false, error: 'Invalid cloud sync secret.' });
    return false;
  }
  return true;
}

function supabaseRequest(method, pathWithQuery, body, prefer) {
  const base = supabaseUrl();
  const key = supabaseKey();
  if (!base || !key) return Promise.reject(new Error('Supabase is not configured on Render.'));

  const url = new URL(pathWithQuery.startsWith('http') ? pathWithQuery : `${base}${pathWithQuery}`);
  const payload = body == null ? null : Buffer.from(JSON.stringify(body));

  const options = {
    method,
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer:
        prefer ||
        (method === 'POST' || method === 'PATCH'
          ? 'return=representation'
          : 'return=minimal')
    }
  };
  if (payload) options.headers['Content-Length'] = payload.length;

  return new Promise((resolve, reject) => {
    const req = https.request(options, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        const status = resp.statusCode || 0;
        if (status >= 200 && status < 300) {
          if (!data) return resolve(null);
          try {
            resolve(JSON.parse(data));
          } catch (_) {
            resolve(data);
          }
          return;
        }
        reject(new Error(`Supabase ${status}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizeAdmission(value) {
  let s = String(value || '').trim();
  if (s.endsWith('.0') && s.slice(0, -2).match(/^\d+$/)) s = s.slice(0, -2);
  return s;
}

function studentFromPayloadRow(row) {
  if (!row || typeof row !== 'object') return null;
  const admissionNo = normalizeAdmission(row.admissionNo || row.AdmissionNo);
  if (!admissionNo) return null;
  return {
    school_id: schoolIdDefault(),
    admission_no: admissionNo,
    name: String(row.name || row.StudentName || '').trim(),
    current_class: String(row.currentClass || row.Class || '').trim(),
    current_section: String(row.currentSection || row.Section || '').trim(),
    parent_name: String(row.parentName || row.ParentName || '').trim(),
    parent_phone: String(row.parentPhone || row.ParentPhone || '').trim(),
    nfc_uid: String(row.nfcUid || row.NfcUid || row.cardUid || '').trim(),
    school_bot_chat_id: String(
      row.schoolTelegramChatId || row.schoolBotChatId || row.SchoolBotChatId || row.telegramChatId || ''
    ).trim(),
    telegram_user_name: String(row.telegramUserName || row.TelegramUserName || '').trim(),
    status: String(row.Status || row.status || '').trim() || null,
    payload: row,
    updated_at: new Date().toISOString()
  };
}

async function getSnapshot(schoolId) {
  const sid = encodeURIComponent(schoolId || schoolIdDefault());
  const tables = [
    env('ERP_SNAPSHOT_TABLE', 'erp_snapshots'),
    'erp_snapshots',
    'school_snapshots',
    'mmm_erp_snapshots'
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  let lastErr;
  for (const table of tables) {
    try {
      const rows = await supabaseRequest(
        'GET',
        `/rest/v1/${table}?school_id=eq.${sid}&select=*&order=saved_at.desc&limit=1`
      );
      if (Array.isArray(rows)) {
        // Remember working table for later writes
        process.env.ERP_SNAPSHOT_TABLE = table;
        return rows[0] || null;
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No erp snapshot table found. Run sql/erp_cloud_native.sql or set ERP_SNAPSHOT_TABLE.');
}

async function saveSnapshot({ schoolId, payload, savedBy }) {
  const sid = schoolId || schoolIdDefault();
  const students = Array.isArray(payload?.students) ? payload.students : [];
  const savedAt = new Date().toISOString();
  const row = {
    school_id: sid,
    payload,
    saved_at: savedAt,
    saved_by: savedBy || 'ERP',
    version: String(payload?.version || '2.1')
  };

  // Upsert one row per school_id
  const table = env('ERP_SNAPSHOT_TABLE', 'erp_snapshots');
  try {
    await supabaseRequest(
      'POST',
      `/rest/v1/${table}?on_conflict=school_id`,
      [row],
      'resolution=merge-duplicates,return=representation'
    );
  } catch (_) {
    await supabaseRequest('DELETE', `/rest/v1/${table}?school_id=eq.${encodeURIComponent(sid)}`);
    await supabaseRequest('POST', `/rest/v1/${table}`, [row]);
  }

  // Dual-write native student rows (cloud-native core)
  try {
    await upsertStudentsFromPayload(sid, students);
  } catch (err) {
    console.error('[erp-cloud] native dual-write failed:', err.message);
  }

  return {
    ok: true,
    configured: true,
    schoolId: sid,
    savedAt,
    studentCount: students.length,
    native: true
  };
}

async function upsertStudentsFromPayload(schoolId, students) {
  const rows = [];
  for (const s of students || []) {
    const row = studentFromPayloadRow(s);
    if (!row) continue;
    row.school_id = schoolId;
    rows.push(row);
  }
  if (!rows.length) return { upserted: 0 };

  // Chunk to avoid huge payloads
  const chunkSize = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await supabaseRequest(
      'POST',
      '/rest/v1/erp_students?on_conflict=school_id,admission_no',
      chunk,
      'resolution=merge-duplicates,return=minimal'
    );
    upserted += chunk.length;
  }
  return { upserted };
}

async function upsertStudentLink({ admissionNo, chatId, username, student }) {
  const admission_no = normalizeAdmission(admissionNo);
  if (!admission_no) throw new Error('admissionNo required');
  const school_id = schoolIdDefault();
  const base = studentFromPayloadRow(student || { admissionNo: admission_no }) || {
    school_id,
    admission_no,
    name: '',
    current_class: '',
    current_section: '',
    parent_name: '',
    parent_phone: '',
    nfc_uid: '',
    payload: {}
  };
  base.school_id = school_id;
  base.admission_no = admission_no;
  base.school_bot_chat_id = String(chatId || '').trim();
  base.telegram_user_name = String(username || '').trim();
  base.status = 'Linked';
  base.updated_at = new Date().toISOString();
  if (student && typeof student === 'object') base.payload = { ...(base.payload || {}), ...student };

  await supabaseRequest(
    'POST',
    '/rest/v1/erp_students?on_conflict=school_id,admission_no',
    [base],
    'resolution=merge-duplicates,return=representation'
  );
  return { ok: true, admission_no, school_bot_chat_id: base.school_bot_chat_id };
}

async function listNativeStudents(schoolId) {
  const sid = encodeURIComponent(schoolId || schoolIdDefault());
  const rows = await supabaseRequest(
    'GET',
    `/rest/v1/erp_students?school_id=eq.${sid}&select=admission_no,name,current_class,current_section,parent_name,parent_phone,nfc_uid,school_bot_chat_id,telegram_user_name,status,updated_at&order=admission_no.asc`
  );
  return Array.isArray(rows) ? rows : [];
}

async function handleCloudConfig(req, res) {
  return json(res, 200, {
    ok: true,
    gasUrl: env('GOOGLE_SCRIPT_URL') || null,
    cloudSync: {
      configured: isConfigured(),
      schoolId: schoolIdDefault(),
      requiresSecret: !!cloudSecret(),
      native: true,
      mode: 'snapshot+native'
    }
  });
}

async function handleCloudPull(req, res) {
  if (!requireSecret(req, res)) return;
  if (!isConfigured()) {
    return json(res, 200, { ok: false, configured: false, error: 'Supabase not configured.' });
  }
  const schoolId = String(req.query.schoolId || schoolIdDefault()).trim();
  const snapshot = await getSnapshot(schoolId);
  return json(res, 200, {
    ok: true,
    configured: true,
    schoolId,
    snapshot,
    native: true
  });
}

async function handleCloudPush(req, res) {
  if (!requireSecret(req, res)) return;
  if (!isConfigured()) {
    return json(res, 200, { ok: false, configured: false, error: 'Supabase not configured.' });
  }
  const body = req.body || {};
  const schoolId = String(body.schoolId || req.query.schoolId || schoolIdDefault()).trim();
  const payload = body.payload;
  if (!payload || typeof payload !== 'object') {
    return json(res, 200, { ok: false, error: 'payload required' });
  }
  const result = await saveSnapshot({
    schoolId,
    payload,
    savedBy: body.savedBy || 'ERP'
  });
  return json(res, 200, result);
}

async function handleNativeStudents(req, res) {
  if (!requireSecret(req, res)) return;
  if (!isConfigured()) {
    return json(res, 200, { ok: false, configured: false, error: 'Supabase not configured.' });
  }
  const schoolId = String(req.query.schoolId || schoolIdDefault()).trim();
  const students = await listNativeStudents(schoolId);
  return json(res, 200, {
    ok: true,
    configured: true,
    native: true,
    schoolId,
    count: students.length,
    students
  });
}

async function handleNativeMigrate(req, res) {
  if (!requireSecret(req, res)) return;
  if (!isConfigured()) {
    return json(res, 200, { ok: false, configured: false, error: 'Supabase not configured.' });
  }
  const schoolId = String((req.body && req.body.schoolId) || req.query.schoolId || schoolIdDefault()).trim();
  const snapshot = await getSnapshot(schoolId);
  const students = snapshot?.payload?.students || [];
  const result = await upsertStudentsFromPayload(schoolId, students);
  return json(res, 200, {
    ok: true,
    schoolId,
    snapshotStudents: students.length,
    nativeUpserted: result.upserted,
    message: 'Snapshot students dual-written into erp_students (cloud-native core).'
  });
}

async function route(req, res, action) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-ERP-Cloud-Secret',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  try {
    if (action === 'cloudConfig') return handleCloudConfig(req, res);
    if (action === 'cloudPull') return handleCloudPull(req, res);
    if (action === 'cloudPush') return handleCloudPush(req, res);
    if (action === 'nativeStudents') return handleNativeStudents(req, res);
    if (action === 'nativeMigrate') return handleNativeMigrate(req, res);
    return false;
  } catch (error) {
    console.error('[erp-cloud]', error);
    return json(res, 200, { ok: false, error: error.message });
  }
}

module.exports = {
  isConfigured,
  schoolIdDefault,
  route,
  upsertStudentLink,
  listNativeStudents,
  handleCloudConfig
};
