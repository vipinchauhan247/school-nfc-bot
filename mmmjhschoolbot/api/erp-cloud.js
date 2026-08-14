/**
 * Phase 1 ERP cloud API — stores full SchoolData snapshot in Supabase.
 * Telegram bot, GAS fee sync, and NFC attendance are unchanged; ERP pushes here on save.
 *
 * Safe cloud-native add-on: also dual-writes erp_students rows (chat ID + username).
 * Does not replace snapshot sync.
 */

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ERP-Cloud-Secret');
  res.end(JSON.stringify(body));
}

function empty(res) {
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ERP-Cloud-Secret');
  res.end();
}

function getEnv(name) {
  return String(process.env[name] || '').trim();
}

function cloudSecret() {
  return getEnv('ERP_CLOUD_SECRET');
}

function schoolIdDefault() {
  return getEnv('ERP_CLOUD_SCHOOL_ID') || 'mmm-jhs';
}

function supabaseConfig() {
  const url = getEnv('SUPABASE_URL');
  const key = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

function isConfigured() {
  return !!supabaseConfig();
}

function authorize(req) {
  const expected = cloudSecret();
  if (!expected) return true;
  const provided = String(req.headers['x-erp-cloud-secret'] || req.query.secret || '').trim();
  return provided === expected;
}

async function supabaseRequest(method, path, body, prefer) {
  const cfg = supabaseConfig();
  if (!cfg) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set on Render.');

  const init = {
    method,
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Prefer: prefer || 'return=representation'
    }
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const response = await fetch(`${cfg.url}/rest/v1/${path}`, init);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    throw new Error(`Supabase returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    const msg = data?.message || data?.error || data?.hint || text.slice(0, 200);
    throw new Error(msg || `Supabase HTTP ${response.status}`);
  }
  return data;
}

function normalizeAdmission(value) {
  let s = String(value || '').trim();
  if (s.endsWith('.0') && /^\d+$/.test(s.slice(0, -2))) s = s.slice(0, -2);
  return s;
}

function nativeRowFromStudent(row, schoolId) {
  if (!row || typeof row !== 'object') return null;
  const admissionNo = normalizeAdmission(row.admissionNo || row.AdmissionNo);
  if (!admissionNo) return null;
  return {
    school_id: schoolId || schoolIdDefault(),
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
    status: String(row.status || row.Status || '').trim() || null,
    payload: row,
    updated_at: new Date().toISOString()
  };
}

async function upsertStudentsFromPayload(schoolId, students) {
  const rows = [];
  for (const s of students || []) {
    const row = nativeRowFromStudent(s, schoolId);
    if (row) rows.push(row);
  }
  if (!rows.length) return { upserted: 0 };
  const chunkSize = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await supabaseRequest(
      'POST',
      'erp_students?on_conflict=school_id,admission_no',
      chunk,
      'resolution=merge-duplicates,return=minimal'
    );
    upserted += chunk.length;
  }
  return { upserted };
}

async function upsertStudentLink({ admissionNo, chatId, username, student }) {
  if (!isConfigured()) return { ok: false, skipped: true };
  const admission_no = normalizeAdmission(admissionNo);
  if (!admission_no) throw new Error('admissionNo required');
  const schoolId = schoolIdDefault();
  const base = nativeRowFromStudent(student || { admissionNo: admission_no }, schoolId) || {
    school_id: schoolId,
    admission_no,
    name: '',
    payload: {}
  };
  base.school_bot_chat_id = String(chatId || '').trim();
  base.telegram_user_name = String(username || '').trim();
  base.status = 'Linked';
  base.updated_at = new Date().toISOString();
  await supabaseRequest(
    'POST',
    'erp_students?on_conflict=school_id,admission_no',
    [base],
    'resolution=merge-duplicates,return=representation'
  );
  return { ok: true, admission_no, school_bot_chat_id: base.school_bot_chat_id };
}

async function listNativeStudents(schoolId) {
  const sid = encodeURIComponent(schoolId || schoolIdDefault());
  const rows = await supabaseRequest(
    'GET',
    `erp_students?school_id=eq.${sid}&select=admission_no,name,current_class,current_section,parent_name,parent_phone,nfc_uid,school_bot_chat_id,telegram_user_name,status,updated_at&order=admission_no.asc`
  );
  return Array.isArray(rows) ? rows : [];
}

async function readSnapshot(schoolId) {
  const rows = await supabaseRequest(
    'GET',
    `erp_snapshots?school_id=eq.${encodeURIComponent(schoolId)}&select=school_id,payload,saved_at,saved_by,version&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function writeSnapshot(schoolId, payload, savedBy) {
  const row = {
    school_id: schoolId,
    payload,
    saved_at: payload?.savedAt || new Date().toISOString(),
    saved_by: savedBy || '',
    version: payload?.version || '2.0'
  };
  const cfg = supabaseConfig();
  const response = await fetch(`${cfg.url}/rest/v1/erp_snapshots`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation'
    },
    body: JSON.stringify(row)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (err) {
    throw new Error(`Supabase upsert failed: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `Supabase HTTP ${response.status}`);
  }

  try {
    await upsertStudentsFromPayload(schoolId, payload.students || []);
  } catch (err) {
    console.error('[ERP-CLOUD] native dual-write failed:', err.message);
  }

  return Array.isArray(data) ? data[0] : data;
}

function cloudConfigBody() {
  const configured = isConfigured();
  const schoolId = schoolIdDefault();
  const requiresSecret = !!cloudSecret();
  const cloudSync = { configured, schoolId, requiresSecret, native: configured };
  return {
    ok: true,
    configured,
    schoolId,
    requiresSecret,
    native: configured,
    cloudSync
  };
}

async function handleCloudConfig(req, res) {
  return json(res, 200, cloudConfigBody());
}

async function route(req, res, action) {
  const act = String(action || req.query?.action || '').trim();
  if (act === 'cloudConfig') {
    await handleCloudConfig(req, res);
    return true;
  }
  if (['cloudPull', 'cloudPush', 'nativeStudents', 'nativeMigrate'].includes(act)) {
    await erpCloudHandler(req, res);
    return true;
  }
  return false;
}

async function erpCloudHandler(req, res) {
  try {
    if (req.method === 'OPTIONS') return empty(res);

    const action = String(req.query.action || '').trim();
    if (req.method === 'GET' && action === 'cloudConfig') {
      return handleCloudConfig(req, res);
    }

    if (!supabaseConfig()) {
      return json(res, 200, {
        ok: false,
        configured: false,
        error: 'Cloud database is not configured on the server yet. ERP will use local storage only.'
      });
    }

    if (!authorize(req)) {
      return json(res, 403, { ok: false, error: 'Invalid cloud sync secret.' });
    }

    const schoolId = String(req.query.schoolId || req.body?.schoolId || schoolIdDefault()).trim() || schoolIdDefault();

    if (req.method === 'GET' && action === 'nativeStudents') {
      const students = await listNativeStudents(schoolId);
      return json(res, 200, { ok: true, configured: true, native: true, schoolId, count: students.length, students });
    }

    if (req.method === 'POST' && action === 'nativeMigrate') {
      const snapshot = await readSnapshot(schoolId);
      const students = snapshot?.payload?.students || [];
      const result = await upsertStudentsFromPayload(schoolId, students);
      return json(res, 200, {
        ok: true,
        schoolId,
        snapshotStudents: students.length,
        nativeUpserted: result.upserted
      });
    }

    if (req.method === 'GET') {
      const snapshot = await readSnapshot(schoolId);
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        snapshot: snapshot || null,
        native: true
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const payload = body.payload;
      if (!payload || typeof payload !== 'object') {
        return json(res, 400, { ok: false, error: 'POST body must include payload object.' });
      }
      if (!Array.isArray(payload.students)) {
        return json(res, 400, { ok: false, error: 'payload.students array is required.' });
      }
      const savedBy = String(body.savedBy || '').trim();
      const snapshot = await writeSnapshot(schoolId, payload, savedBy);
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        savedAt: snapshot?.saved_at || payload.savedAt,
        studentCount: payload.students.length,
        native: true
      });
    }

    return json(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error('[ERP-CLOUD]', error);
    return json(res, 500, { ok: false, error: error.message });
  }
}

erpCloudHandler.upsertStudentLink = upsertStudentLink;
erpCloudHandler.isConfigured = isConfigured;
erpCloudHandler.listNativeStudents = listNativeStudents;
erpCloudHandler.route = route;
erpCloudHandler.handleCloudConfig = handleCloudConfig;
erpCloudHandler.cloudConfigBody = cloudConfigBody;

module.exports = erpCloudHandler;
