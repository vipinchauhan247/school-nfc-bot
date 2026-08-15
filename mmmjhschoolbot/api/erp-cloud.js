/**
 * ERP cloud API — snapshot sync (compat) + native students/fees in Supabase.
 * Telegram bot, GAS fee sync, and NFC attendance are unchanged.
 *
 * Phase 2: dual-writes erp_payments / erp_fee_sessions on every cloud push.
 * School website on mmmjhschool.com can sync without pasting a secret
 * (Origin/Referer allow-list). Random internet still needs ERP_CLOUD_SECRET.
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

function trustedSiteOrigins() {
  const fromEnv = getEnv('ERP_CLOUD_SITE_ORIGINS');
  const list = fromEnv
    ? fromEnv.split(',').map(s => s.trim()).filter(Boolean)
    : ['https://www.mmmjhschool.com', 'https://mmmjhschool.com'];
  return list;
}

function requestSiteOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (origin) return origin.replace(/\/$/, '');
  const referer = String(req.headers.referer || '').trim();
  if (!referer) return '';
  try {
    const url = new URL(referer);
    return `${url.protocol}//${url.host}`;
  } catch (err) {
    return '';
  }
}

function isTrustedSiteRequest(req) {
  const flag = getEnv('ERP_CLOUD_TRUST_SITE_ORIGIN').toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return false;
  const origin = requestSiteOrigin(req);
  if (!origin) return false;
  return trustedSiteOrigins().some(allowed => origin === allowed.replace(/\/$/, ''));
}

function authorize(req) {
  if (isTrustedSiteRequest(req)) return true;
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

function fallbackReceiptNo(admissionNo, payment) {
  return [
    admissionNo,
    payment?.date || payment?.paidOn || '',
    payment?.amount || '',
    payment?.month || '',
    payment?.mode || payment?.paymentMode || ''
  ].join('|');
}

function extractFeeDataFromStudents(schoolId, students, cancelledReceipts) {
  const payments = [];
  const sessions = [];
  const cancelled = new Set(
    (cancelledReceipts || []).map(item => String(typeof item === 'string' ? item : item?.receiptNo || '').trim()).filter(Boolean)
  );

  for (const student of students || []) {
    const admission_no = normalizeAdmission(student.admissionNo || student.AdmissionNo);
    if (!admission_no) continue;
    const feeRecords = { ...(student.feeRecords && typeof student.feeRecords === 'object' ? student.feeRecords : {}) };
    const sessionNames = new Set(Object.keys(feeRecords));
    if (student.currentFeeInfo && typeof student.currentFeeInfo === 'object') {
      sessionNames.add(String(student.currentFeeInfo.session || student.currentSession || 'current'));
      if (!feeRecords[student.currentFeeInfo.session || student.currentSession || 'current']) {
        feeRecords[student.currentFeeInfo.session || student.currentSession || 'current'] = student.currentFeeInfo;
      }
    }

    sessionNames.forEach((session_name) => {
      const fee = feeRecords[session_name];
      if (!fee || typeof fee !== 'object') return;
      sessions.push({
        school_id: schoolId,
        admission_no,
        session_name: String(session_name || 'current'),
        monthly_tuition: Number(fee.monthlyTuition || 0) || null,
        due_months: Array.isArray(fee.dueMonths) ? fee.dueMonths : [],
        paid_months: Array.isArray(fee.paidMonths) ? fee.paidMonths : [],
        wallet_balance: Number(fee.walletBalance || 0) || null,
        payload: fee,
        updated_at: new Date().toISOString()
      });
      (fee.payments || []).forEach((p) => {
        if (!p || typeof p !== 'object') return;
        const receipt_no = String(p.receiptNo || fallbackReceiptNo(admission_no, p)).trim();
        if (!receipt_no) return;
        payments.push({
          school_id: schoolId,
          admission_no,
          receipt_no,
          session_name: String(session_name || 'current'),
          amount: Number(p.amount || 0) || 0,
          paid_on: String(p.date || p.paidOn || ''),
          month: String(p.month || ''),
          mode: String(p.mode || p.paymentMode || ''),
          cancelled: cancelled.has(receipt_no),
          payload: p,
          updated_at: new Date().toISOString()
        });
      });
    });
  }

  cancelled.forEach((receipt_no) => {
    if (payments.some(p => p.receipt_no === receipt_no)) return;
    payments.push({
      school_id: schoolId,
      admission_no: '',
      receipt_no,
      session_name: '',
      amount: 0,
      paid_on: '',
      month: '',
      mode: '',
      cancelled: true,
      payload: { receiptNo: receipt_no },
      updated_at: new Date().toISOString()
    });
  });

  return { payments, sessions };
}

async function upsertChunked(table, conflict, rows) {
  if (!rows.length) return { upserted: 0 };
  const chunkSize = 200;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await supabaseRequest(
      'POST',
      `${table}?on_conflict=${conflict}`,
      chunk,
      'resolution=merge-duplicates,return=minimal'
    );
    upserted += chunk.length;
  }
  return { upserted };
}

async function upsertFeesFromPayload(schoolId, payload) {
  const { payments, sessions } = extractFeeDataFromStudents(
    schoolId,
    payload?.students || [],
    payload?.cancelledReceipts || []
  );
  const pay = await upsertChunked('erp_payments', 'school_id,receipt_no', payments);
  const sess = await upsertChunked('erp_fee_sessions', 'school_id,admission_no,session_name', sessions);
  return { payments: pay.upserted, sessions: sess.upserted };
}

async function listNativePayments(schoolId) {
  const sid = encodeURIComponent(schoolId || schoolIdDefault());
  const rows = await supabaseRequest(
    'GET',
    `erp_payments?school_id=eq.${sid}&select=admission_no,receipt_no,session_name,amount,paid_on,month,mode,cancelled,payload,updated_at&order=paid_on.asc&limit=20000`
  );
  return Array.isArray(rows) ? rows : [];
}

function applyNativePaymentsToPayload(payload, payments) {
  if (!payload || !Array.isArray(payload.students) || !Array.isArray(payments) || !payments.length) {
    return payload;
  }
  const byAdmission = new Map();
  payload.students.forEach((student) => {
    const key = normalizeAdmission(student.admissionNo || student.AdmissionNo).toLowerCase();
    if (key) byAdmission.set(key, student);
  });

  const cancelled = Array.isArray(payload.cancelledReceipts) ? payload.cancelledReceipts.slice() : [];
  const cancelledSet = new Set(
    cancelled.map(item => String(typeof item === 'string' ? item : item?.receiptNo || '').trim().toLowerCase()).filter(Boolean)
  );

  payments.forEach((row) => {
    const receiptNo = String(row.receipt_no || '').trim();
    if (!receiptNo) return;
    if (row.cancelled) {
      if (!cancelledSet.has(receiptNo.toLowerCase())) {
        cancelled.push({ receiptNo, cancelledAt: row.updated_at });
        cancelledSet.add(receiptNo.toLowerCase());
      }
      return;
    }
    const student = byAdmission.get(String(row.admission_no || '').trim().toLowerCase());
    if (!student) return;
    if (!student.feeRecords || typeof student.feeRecords !== 'object') student.feeRecords = {};
    const sessionName = String(row.session_name || 'current');
    if (!student.feeRecords[sessionName] || typeof student.feeRecords[sessionName] !== 'object') {
      student.feeRecords[sessionName] = { payments: [], paidMonths: [], dueMonths: [] };
    }
    const fee = student.feeRecords[sessionName];
    if (!Array.isArray(fee.payments)) fee.payments = [];
    const nativePay = (row.payload && typeof row.payload === 'object')
      ? { ...row.payload }
      : {
        receiptNo,
        amount: Number(row.amount || 0),
        date: row.paid_on,
        month: row.month,
        mode: row.mode
      };
    nativePay.receiptNo = nativePay.receiptNo || receiptNo;
    nativePay.amount = Number(nativePay.amount || row.amount || 0);
    const exists = fee.payments.some(p => String(p?.receiptNo || '').trim().toLowerCase() === receiptNo.toLowerCase());
    if (!exists) fee.payments.push(nativePay);
  });

  payload.cancelledReceipts = cancelled;
  return payload;
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
    `erp_students?school_id=eq.${sid}&select=admission_no,name,current_class,current_section,parent_name,parent_phone,nfc_uid,school_bot_chat_id,telegram_user_name,status,payload,updated_at&order=admission_no.asc&limit=5000`
  );
  return Array.isArray(rows) ? rows : [];
}

async function listNativeFeeSessions(schoolId) {
  const sid = encodeURIComponent(schoolId || schoolIdDefault());
  const rows = await supabaseRequest(
    'GET',
    `erp_fee_sessions?school_id=eq.${sid}&select=admission_no,session_name,monthly_tuition,due_months,paid_months,wallet_balance,payload,updated_at&order=admission_no.asc&limit=10000`
  );
  return Array.isArray(rows) ? rows : [];
}

function studentFromNativeRow(row) {
  const fromPayload = row?.payload && typeof row.payload === 'object' ? { ...row.payload } : {};
  const admissionNo = normalizeAdmission(row?.admission_no || fromPayload.admissionNo || fromPayload.AdmissionNo);
  if (!admissionNo) return null;
  const chatId = String(fromPayload.telegramChatId || fromPayload.schoolBotChatId || row.school_bot_chat_id || '').trim();
  const username = String(fromPayload.telegramUserName || row.telegram_user_name || '').trim();
  const student = {
    ...fromPayload,
    admissionNo,
    name: String(fromPayload.name || row.name || '').trim(),
    currentClass: String(fromPayload.currentClass || fromPayload.class || row.current_class || '').trim(),
    currentSection: String(fromPayload.currentSection || fromPayload.section || row.current_section || '').trim(),
    parentName: String(fromPayload.parentName || row.parent_name || '').trim(),
    parentPhone: String(fromPayload.parentPhone || fromPayload.phone || row.parent_phone || '').trim(),
    phone: String(fromPayload.phone || fromPayload.parentPhone || row.parent_phone || '').trim(),
    nfcUid: String(fromPayload.nfcUid || fromPayload.cardUid || row.nfc_uid || '').trim(),
    cardUid: String(fromPayload.cardUid || fromPayload.nfcUid || row.nfc_uid || '').trim(),
    status: String(fromPayload.status || row.status || '').trim(),
    feeRecords: (fromPayload.feeRecords && typeof fromPayload.feeRecords === 'object') ? fromPayload.feeRecords : {}
  };
  if (chatId) {
    student.telegramChatId = chatId;
    student.schoolBotChatId = chatId;
    student.SchoolBotChatId = chatId;
  }
  if (username) {
    student.telegramUserName = username;
    student.TelegramUserName = username;
  }
  return student;
}

function applyNativeFeeSessionsToPayload(payload, sessions) {
  if (!payload || !Array.isArray(payload.students) || !Array.isArray(sessions) || !sessions.length) {
    return payload;
  }
  const byAdmission = new Map();
  payload.students.forEach((student) => {
    const key = normalizeAdmission(student.admissionNo || student.AdmissionNo).toLowerCase();
    if (key) byAdmission.set(key, student);
  });
  sessions.forEach((row) => {
    const student = byAdmission.get(String(row.admission_no || '').trim().toLowerCase());
    if (!student) return;
    if (!student.feeRecords || typeof student.feeRecords !== 'object') student.feeRecords = {};
    const sessionName = String(row.session_name || 'current');
    const fromPayload = row.payload && typeof row.payload === 'object' ? row.payload : {};
    const prev = student.feeRecords[sessionName] && typeof student.feeRecords[sessionName] === 'object'
      ? student.feeRecords[sessionName]
      : {};
    student.feeRecords[sessionName] = {
      ...fromPayload,
      ...prev,
      session: sessionName,
      monthlyTuition: Number(prev.monthlyTuition || fromPayload.monthlyTuition || row.monthly_tuition || 0),
      dueMonths: Array.isArray(prev.dueMonths) ? prev.dueMonths
        : (Array.isArray(fromPayload.dueMonths) ? fromPayload.dueMonths
          : (Array.isArray(row.due_months) ? row.due_months : [])),
      paidMonths: Array.isArray(prev.paidMonths) ? prev.paidMonths
        : (Array.isArray(fromPayload.paidMonths) ? fromPayload.paidMonths
          : (Array.isArray(row.paid_months) ? row.paid_months : [])),
      walletBalance: Math.max(
        Number(prev.walletBalance || 0),
        Number(fromPayload.walletBalance || 0),
        Number(row.wallet_balance || 0)
      ),
      payments: Array.isArray(prev.payments) ? prev.payments
        : (Array.isArray(fromPayload.payments) ? fromPayload.payments : [])
    };
  });
  return payload;
}

async function rebuildPayloadFromNative(schoolId, basePayload) {
  const nativeRows = await listNativeStudents(schoolId);
  const students = [];
  nativeRows.forEach((row) => {
    const student = studentFromNativeRow(row);
    if (student) students.push(student);
  });
  if (!students.length) {
    return {
      ok: false,
      studentCount: 0,
      payload: null,
      message: 'Native erp_students table is empty; cannot rebuild snapshot.'
    };
  }

  let payload = {
    version: (basePayload && basePayload.version) || '2.1',
    savedAt: new Date().toISOString(),
    activeSession: (basePayload && basePayload.activeSession) || '2026-27',
    classes: (basePayload && basePayload.classes) || [],
    students,
    classFeeMaster: (basePayload && basePayload.classFeeMaster) || {},
    feeScheduleRules: (basePayload && basePayload.feeScheduleRules) || {},
    weightageRules: (basePayload && basePayload.weightageRules) || {},
    userPermissions: (basePayload && basePayload.userPermissions) || {},
    signatures: (basePayload && basePayload.signatures) || {},
    sessions: (basePayload && basePayload.sessions) || {},
    teachers: (basePayload && basePayload.teachers) || [],
    subjects: (basePayload && basePayload.subjects) || {},
    staffUsers: (basePayload && basePayload.staffUsers) || [],
    examSubjectConfigs: (basePayload && basePayload.examSubjectConfigs) || {},
    schoolProfile: (basePayload && basePayload.schoolProfile) || {},
    periodSettings: (basePayload && basePayload.periodSettings) || {},
    telegramLogs: (basePayload && basePayload.telegramLogs) || [],
    cancelledReceipts: (basePayload && basePayload.cancelledReceipts) || [],
    printSettings: (basePayload && basePayload.printSettings) || {},
    rebuiltFromNative: true
  };

  try {
    const sessions = await listNativeFeeSessions(schoolId);
    payload = applyNativeFeeSessionsToPayload(payload, sessions);
  } catch (err) {
    console.error('[ERP-CLOUD] fee session rebuild overlay failed:', err.message);
  }
  try {
    const payments = await listNativePayments(schoolId);
    payload = applyNativePaymentsToPayload(payload, payments);
  } catch (err) {
    console.error('[ERP-CLOUD] payment rebuild overlay failed:', err.message);
  }

  return { ok: true, studentCount: students.length, payload };
}

function snapshotStudentCount(snapshot) {
  const students = snapshot?.payload?.students;
  return Array.isArray(students) ? students.length : 0;
}

async function clearNativeRoster(schoolId) {
  const sid = encodeURIComponent(schoolId || schoolIdDefault());
  const results = {};
  try {
    await supabaseRequest('DELETE', `erp_payments?school_id=eq.${sid}`, undefined, 'return=minimal');
    results.payments = true;
  } catch (err) {
    console.error('[ERP-CLOUD] clear payments failed:', err.message);
    results.payments = err.message;
  }
  try {
    await supabaseRequest('DELETE', `erp_fee_sessions?school_id=eq.${sid}`, undefined, 'return=minimal');
    results.feeSessions = true;
  } catch (err) {
    console.error('[ERP-CLOUD] clear fee sessions failed:', err.message);
    results.feeSessions = err.message;
  }
  try {
    await supabaseRequest('DELETE', `erp_students?school_id=eq.${sid}`, undefined, 'return=minimal');
    results.students = true;
  } catch (err) {
    console.error('[ERP-CLOUD] clear students failed:', err.message);
    results.students = err.message;
  }
  return results;
}

async function ensureSnapshotHasStudents(schoolId) {
  const snapshot = await readSnapshot(schoolId);
  const count = snapshotStudentCount(snapshot);
  if (count > 0) {
    return { snapshot, rebuilt: false, studentCount: count };
  }

  const rebuilt = await rebuildPayloadFromNative(schoolId, snapshot?.payload || {});
  if (!rebuilt.ok || !rebuilt.payload) {
    return {
      snapshot: snapshot || null,
      rebuilt: false,
      studentCount: 0,
      error: rebuilt.message || 'Native rebuild failed.'
    };
  }

  const written = await writeSnapshot(schoolId, rebuilt.payload, 'native-rebuild');
  const saved = written?.snapshot || {
    school_id: schoolId,
    payload: rebuilt.payload,
    saved_at: rebuilt.payload.savedAt,
    saved_by: 'native-rebuild',
    version: rebuilt.payload.version
  };
  if (!saved.payload) saved.payload = rebuilt.payload;
  return {
    snapshot: saved,
    rebuilt: true,
    studentCount: rebuilt.studentCount
  };
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
    console.error('[ERP-CLOUD] native student dual-write failed:', err.message);
  }

  let fees = { payments: 0, sessions: 0 };
  try {
    fees = await upsertFeesFromPayload(schoolId, payload);
  } catch (err) {
    console.error('[ERP-CLOUD] native fee dual-write failed:', err.message);
  }

  const saved = Array.isArray(data) ? data[0] : data;
  return { snapshot: saved, fees };
}

function cloudConfigBody(req) {
  const configured = isConfigured();
  const schoolId = schoolIdDefault();
  const siteTrusted = !!(req && isTrustedSiteRequest(req));
  const requiresSecret = !!cloudSecret() && !siteTrusted;
  const cloudSync = {
    configured,
    schoolId,
    requiresSecret,
    native: configured,
    siteTrusted,
    feesNative: configured
  };
  return {
    ok: true,
    configured,
    schoolId,
    requiresSecret,
    native: configured,
    siteTrusted,
    feesNative: configured,
    cloudSync
  };
}

async function handleCloudConfig(req, res) {
  return json(res, 200, cloudConfigBody(req));
}

async function route(req, res, action) {
  const act = String(action || req.query?.action || '').trim();
  if (act === 'cloudConfig') {
    await handleCloudConfig(req, res);
    return true;
  }
  if (['cloudPull', 'cloudPush', 'nativeStudents', 'nativeMigrate', 'nativePayments', 'rebuildSnapshot', 'wipeRoster'].includes(act)) {
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

    if (req.method === 'GET' && action === 'nativePayments') {
      const payments = await listNativePayments(schoolId);
      return json(res, 200, {
        ok: true,
        configured: true,
        native: true,
        schoolId,
        count: payments.length,
        payments
      });
    }

    if ((req.method === 'POST' || req.method === 'GET') && action === 'nativeMigrate') {
      const snapshot = await readSnapshot(schoolId);
      const students = snapshot?.payload?.students || [];
      const studentResult = await upsertStudentsFromPayload(schoolId, students);
      let feeResult = { payments: 0, sessions: 0 };
      try {
        feeResult = await upsertFeesFromPayload(schoolId, snapshot?.payload || {});
      } catch (err) {
        console.error('[ERP-CLOUD] fee migrate failed:', err.message);
      }
      return json(res, 200, {
        ok: true,
        schoolId,
        snapshotStudents: students.length,
        nativeUpserted: studentResult.upserted,
        nativePayments: feeResult.payments,
        nativeFeeSessions: feeResult.sessions
      });
    }

    if ((req.method === 'POST' || req.method === 'GET') && action === 'wipeRoster') {
      const emptyPayload = {
        version: '2.1',
        savedAt: new Date().toISOString(),
        students: [],
        cancelledReceipts: [],
        intentionalEmpty: true
      };
      const existing = await readSnapshot(schoolId);
      const base = existing?.payload && typeof existing.payload === 'object' ? existing.payload : {};
      // Keep staffUsers + teachers — wiping students must not delete school logins
      const payload = {
        ...base,
        ...emptyPayload,
        students: [],
        cancelledReceipts: [],
        intentionalEmpty: true,
        staffUsers: Array.isArray(base.staffUsers) ? base.staffUsers : [],
        teachers: Array.isArray(base.teachers) ? base.teachers : []
      };
      const cleared = await clearNativeRoster(schoolId);
      const written = await writeSnapshot(schoolId, payload, 'wipe-roster');
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        wiped: true,
        studentCount: 0,
        staffCount: (payload.staffUsers || []).length,
        cleared,
        savedAt: written?.snapshot?.saved_at || payload.savedAt
      });
    }

    if ((req.method === 'POST' || req.method === 'GET') && action === 'rebuildSnapshot') {
      const ensured = await ensureSnapshotHasStudents(schoolId);
      if (!ensured.studentCount) {
        return json(res, 200, {
          ok: false,
          configured: true,
          schoolId,
          error: ensured.error || 'No students in snapshot or native tables.',
          studentCount: 0
        });
      }
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        rebuilt: !!ensured.rebuilt,
        studentCount: ensured.studentCount,
        snapshot: ensured.snapshot,
        native: true,
        feesNative: true
      });
    }

    if (req.method === 'GET') {
      // Do NOT auto-rebuild deleted/empty rosters from native leftovers.
      // Empty snapshot is a valid fresh-start state. Use rebuildSnapshot only if asked.
      let snapshot = await readSnapshot(schoolId);
      if (snapshot && snapshot.payload && snapshotStudentCount(snapshot) > 0) {
        try {
          const payments = await listNativePayments(schoolId);
          snapshot.payload = applyNativePaymentsToPayload(snapshot.payload, payments);
        } catch (err) {
          console.error('[ERP-CLOUD] native payment overlay failed:', err.message);
        }
      }
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        snapshot: snapshot || null,
        studentCount: snapshotStudentCount(snapshot),
        native: true,
        feesNative: true
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
      // Intentional empty = fresh start: clear native leftovers so old 824 cannot return
      let wipedNative = null;
      if (payload.students.length === 0) {
        wipedNative = await clearNativeRoster(schoolId);
        payload.intentionalEmpty = true;
      }
      const savedBy = String(body.savedBy || '').trim();
      const written = await writeSnapshot(schoolId, payload, savedBy);
      const snapshot = written?.snapshot || written;
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        savedAt: snapshot?.saved_at || payload.savedAt,
        studentCount: payload.students.length,
        wipedNative,
        native: true,
        nativePayments: written?.fees?.payments || 0,
        nativeFeeSessions: written?.fees?.sessions || 0
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
