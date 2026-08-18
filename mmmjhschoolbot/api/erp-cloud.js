/**
 * ERP cloud API — snapshot sync (compat) + native students/fees in Supabase.
 * Telegram bot, GAS fee sync, and NFC attendance are unchanged.
 *
 * Phase 2: dual-writes erp_payments / erp_fee_sessions on every cloud push.
 * School website on mmmjhschool.com can sync without pasting a secret
 * (Origin/Referer allow-list). Random internet still needs ERP_CLOUD_SECRET.
 * Does not replace snapshot sync.
 */

const crypto = require('crypto');

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ERP-Cloud-Secret,X-ERP-Session');
  res.end(JSON.stringify(body));
}

function empty(res) {
  res.statusCode = 204;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ERP-Cloud-Secret,X-ERP-Session');
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

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function hashPassword(password, salt, iterations) {
  const rounds = Math.max(120000, Number(iterations || 210000));
  return crypto.pbkdf2Sync(String(password || ''), String(salt || ''), rounds, 32, 'sha256').toString('hex');
}

function requestIpHash(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const remote = forwarded || String(req.socket?.remoteAddress || '').trim();
  if (!remote) return '';
  const key = getEnv('ERP_AUDIT_HASH_KEY') || cloudSecret() || 'mmm-jhs-audit';
  return crypto.createHmac('sha256', key).update(remote).digest('hex');
}

function requestUserAgent(req) {
  return String(req.headers['user-agent'] || '').trim().slice(0, 500);
}

function isTcAdministrator(user) {
  const role = String(user?.role || '').toLowerCase();
  return role.includes('super admin') || role === 'admin' || user?.canIssueTC === true;
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

async function readSnapshotStaffUser(schoolId, usernameOrId) {
  const snapshot = await readSnapshot(schoolId);
  const staff = Array.isArray(snapshot?.payload?.staffUsers) ? snapshot.payload.staffUsers : [];
  const key = normalizeUsername(usernameOrId);
  return staff.find(user => (
    normalizeUsername(user?.username) === key ||
    normalizeUsername(user?.id) === key
  )) || null;
}

async function readStaffCredential(schoolId, usernameOrId) {
  const key = normalizeUsername(usernameOrId);
  const rows = await supabaseRequest(
    'GET',
    `erp_staff_credentials?school_id=eq.${encodeURIComponent(schoolId)}&or=(username_lower.eq.${encodeURIComponent(key)},user_id.eq.${encodeURIComponent(String(usernameOrId || '').trim())})&select=*&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function saveStaffCredential(schoolId, user, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 210000;
  const userId = String(user.id || user.username || '').trim();
  const usernameLower = normalizeUsername(user.username || user.id);
  const row = {
    school_id: schoolId,
    user_id: userId,
    username_lower: usernameLower,
    user_name: String(user.name || '').trim(),
    role: String(user.role || '').trim(),
    password_salt: salt,
    password_hash: hashPassword(password, salt, iterations),
    password_iterations: iterations,
    active: user.active !== false && String(user.status || '').toLowerCase() !== 'inactive',
    updated_at: new Date().toISOString()
  };
  // Roster rebuilds can change user_id while username stays the same — clear stale row.
  try {
    const stale = await supabaseRequest(
      'GET',
      `erp_staff_credentials?school_id=eq.${encodeURIComponent(schoolId)}&username_lower=eq.${encodeURIComponent(usernameLower)}&select=id,user_id&limit=1`
    );
    const prev = Array.isArray(stale) && stale.length ? stale[0] : null;
    if (prev && String(prev.user_id || '') !== userId) {
      await supabaseRequest(
        'DELETE',
        `erp_staff_credentials?id=eq.${encodeURIComponent(prev.id)}`,
        undefined,
        'return=minimal'
      );
    }
  } catch (err) {
    console.error('[ERP-AUTH] stale credential cleanup failed:', err.message);
  }
  const rows = await supabaseRequest(
    'POST',
    'erp_staff_credentials?on_conflict=school_id,user_id',
    row,
    'resolution=merge-duplicates,return=representation'
  );
  return Array.isArray(rows) ? rows[0] : rows;
}

function publicStaffUser(user) {
  if (!user) return null;
  const copy = { ...user };
  delete copy.password;
  delete copy.passwordHash;
  delete copy.password_hash;
  return copy;
}

function snapshotForBrowser(snapshot) {
  if (!snapshot || !snapshot.payload || typeof snapshot.payload !== 'object') return snapshot;
  const safe = {
    ...snapshot,
    payload: { ...snapshot.payload }
  };
  if (Array.isArray(snapshot.payload.staffUsers)) {
    safe.payload.staffUsers = snapshot.payload.staffUsers.map(publicStaffUser);
  }
  return safe;
}

async function preserveSnapshotStaffPasswords(schoolId, payload) {
  if (!payload || !Array.isArray(payload.staffUsers)) return payload;
  const existing = await readSnapshot(schoolId);
  const existingStaff = Array.isArray(existing?.payload?.staffUsers) ? existing.payload.staffUsers : [];
  const byKey = new Map();
  existingStaff.forEach(user => {
    const keys = [normalizeUsername(user?.id), normalizeUsername(user?.username)].filter(Boolean);
    keys.forEach(key => byKey.set(key, user));
  });
  const next = { ...payload };
  next.staffUsers = payload.staffUsers.map(user => {
    const previous = byKey.get(normalizeUsername(user?.id)) || byKey.get(normalizeUsername(user?.username));
    let merged = user;
    if (!user?.password && previous?.password) {
      merged = { ...merged, password: previous.password };
    }
    if (!previous) return merged;
    const localChat = String(merged.telegramChatId || '').trim();
    const remoteChat = String(previous.telegramChatId || '').trim();
    // Never blank a Telegram self-link just because a stale ERP tab pushed without it.
    if (!localChat && remoteChat) {
      merged = {
        ...merged,
        telegramChatId: remoteChat,
        telegramUserName: merged.telegramUserName || previous.telegramUserName || '',
        telegramLinkSource: previous.telegramLinkSource || merged.telegramLinkSource || '',
        telegramLinkedAt: previous.telegramLinkedAt || merged.telegramLinkedAt || ''
      };
    } else if (localChat && remoteChat && localChat !== remoteChat) {
      const localAt = Date.parse(merged.telegramLinkedAt || '') || 0;
      const remoteAt = Date.parse(previous.telegramLinkedAt || '') || 0;
      if (remoteAt > localAt) {
        merged = {
          ...merged,
          telegramChatId: remoteChat,
          telegramUserName: previous.telegramUserName || '',
          telegramLinkSource: previous.telegramLinkSource || '',
          telegramLinkedAt: previous.telegramLinkedAt || ''
        };
      }
    } else if (localChat && remoteChat && localChat === remoteChat) {
      merged = {
        ...merged,
        telegramUserName: merged.telegramUserName || previous.telegramUserName || '',
        telegramLinkSource: merged.telegramLinkSource || previous.telegramLinkSource || '',
        telegramLinkedAt: merged.telegramLinkedAt || previous.telegramLinkedAt || ''
      };
    }
    return merged;
  });
  return next;
}

async function authenticateStaffPassword(schoolId, usernameOrId, password) {
  const username = String(usernameOrId || '').trim();
  const suppliedPassword = String(password || '');
  if (!username || !suppliedPassword) return null;

  const snapshotUser = await readSnapshotStaffUser(schoolId, username);
  if (!snapshotUser) return null;
  if (snapshotUser.active === false || String(snapshotUser.status || '').toLowerCase() === 'inactive') return null;

  let credential = await readStaffCredential(schoolId, snapshotUser.username || snapshotUser.id);
  if (credential) {
    if (credential.active === false) return null;
    const actual = hashPassword(suppliedPassword, credential.password_salt, credential.password_iterations);
    return safeEqual(actual, credential.password_hash) ? publicStaffUser(snapshotUser) : null;
  }

  // One-time migration from the existing cloud snapshot. Once a credential row
  // exists, the legacy snapshot password is never accepted again.
  if (snapshotUser.password && safeEqual(snapshotUser.password, suppliedPassword)) {
    credential = await saveStaffCredential(schoolId, snapshotUser, suppliedPassword);
    return credential ? publicStaffUser(snapshotUser) : null;
  }
  return null;
}

async function writeAuditLog(entry) {
  try {
    await supabaseRequest('POST', 'erp_audit_logs', entry, 'return=minimal');
  } catch (error) {
    console.error('[ERP-AUDIT]', error.message);
  }
}

async function createLoginSession(req, schoolId, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const rows = await supabaseRequest('POST', 'erp_login_sessions', {
    school_id: schoolId,
    user_id: String(user.id || user.username || ''),
    username: String(user.username || user.id || ''),
    user_name: String(user.name || ''),
    role: String(user.role || ''),
    token_hash: tokenHash,
    status: 'active',
    ip_hash: requestIpHash(req),
    user_agent: requestUserAgent(req)
  }, 'return=representation');
  const session = Array.isArray(rows) ? rows[0] : rows;
  return { token, session };
}

async function sessionFromToken(token, options) {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const rows = await supabaseRequest(
    'GET',
    `erp_login_sessions?token_hash=eq.${encodeURIComponent(tokenHash)}&status=eq.active&select=*&limit=1`
  );
  const session = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!session) return null;
  const maxHours = Math.max(1, Number(getEnv('ERP_SESSION_HOURS') || 12));
  const ageMs = Date.now() - new Date(session.logged_in_at).getTime();
  if (!Number.isFinite(ageMs) || ageMs > maxHours * 60 * 60 * 1000) {
    await supabaseRequest(
      'PATCH',
      `erp_login_sessions?id=eq.${encodeURIComponent(session.id)}`,
      { status: 'expired', logged_out_at: new Date().toISOString() },
      'return=minimal'
    );
    return null;
  }
  if (options?.touch !== false) {
    await supabaseRequest(
      'PATCH',
      `erp_login_sessions?id=eq.${encodeURIComponent(session.id)}`,
      { last_seen_at: new Date().toISOString() },
      'return=minimal'
    );
  }
  return session;
}

function requestSessionToken(req) {
  return String(req.headers['x-erp-session'] || req.body?.sessionToken || req.query?.sessionToken || '').trim();
}

async function requireErpSession(req, res) {
  const session = await sessionFromToken(requestSessionToken(req));
  if (!session) {
    json(res, 401, { ok: false, error: 'Your ERP session has expired. Please log in again.' });
    return null;
  }
  return session;
}

async function handleAuthLogin(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  if (!isTrustedSiteRequest(req)) return json(res, 403, { ok: false, error: 'Login is allowed only from the official ERP website.' });
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = await authenticateStaffPassword(schoolId, username, password);
  if (!user) {
    await writeAuditLog({
      school_id: schoolId,
      action: 'LOGIN_FAILED',
      entity_type: 'staff_session',
      entity_id: normalizeUsername(username),
      metadata: { username: normalizeUsername(username), ipHash: requestIpHash(req), userAgent: requestUserAgent(req) }
    });
    return json(res, 401, { ok: false, error: 'Incorrect username or password.' });
  }
  const created = await createLoginSession(req, schoolId, user);
  await writeAuditLog({
    school_id: schoolId,
    actor_user_id: String(user.id || user.username || ''),
    actor_username: String(user.username || user.id || ''),
    actor_name: String(user.name || ''),
    actor_role: String(user.role || ''),
    login_session_id: created.session.id,
    action: 'LOGIN_SUCCESS',
    entity_type: 'staff_session',
    entity_id: created.session.id,
    metadata: { loggedInAt: created.session.logged_in_at }
  });
  return json(res, 200, {
    ok: true,
    sessionToken: created.token,
    session: {
      id: created.session.id,
      loggedInAt: created.session.logged_in_at,
      expiresInHours: Math.max(1, Number(getEnv('ERP_SESSION_HOURS') || 12))
    },
    user
  });
}

async function handleAuthLogout(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const session = await requireErpSession(req, res);
  if (!session) return;
  const loggedOutAt = new Date().toISOString();
  await supabaseRequest(
    'PATCH',
    `erp_login_sessions?id=eq.${encodeURIComponent(session.id)}`,
    { status: 'logged_out', logged_out_at: loggedOutAt, last_seen_at: loggedOutAt },
    'return=minimal'
  );
  await writeAuditLog({
    school_id: schoolId,
    actor_user_id: session.user_id,
    actor_username: session.username,
    actor_name: session.user_name,
    actor_role: session.role,
    login_session_id: session.id,
    action: 'LOGOUT',
    entity_type: 'staff_session',
    entity_id: session.id,
    metadata: { loggedOutAt }
  });
  return json(res, 200, { ok: true, loggedOutAt });
}

async function handleAuthSession(req, res) {
  const session = await requireErpSession(req, res);
  if (!session) return;
  return json(res, 200, {
    ok: true,
    session: {
      id: session.id,
      userId: session.user_id,
      username: session.username,
      userName: session.user_name,
      role: session.role,
      loggedInAt: session.logged_in_at,
      lastSeenAt: session.last_seen_at
    }
  });
}

async function handleAuthChangePassword(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const session = await requireErpSession(req, res);
  if (!session) return;
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 8) return json(res, 400, { ok: false, error: 'New password must be at least 8 characters.' });
  const user = await authenticateStaffPassword(schoolId, session.username, currentPassword);
  if (!user) return json(res, 403, { ok: false, error: 'Current password is incorrect.' });
  await saveStaffCredential(schoolId, user, newPassword);
  await writeAuditLog({
    school_id: schoolId,
    actor_user_id: session.user_id,
    actor_username: session.username,
    actor_name: session.user_name,
    actor_role: session.role,
    login_session_id: session.id,
    action: 'PASSWORD_CHANGED',
    entity_type: 'staff_user',
    entity_id: session.user_id,
    metadata: {}
  });
  return json(res, 200, { ok: true });
}

/** Super Admin / Principal resets another staff login password into erp_staff_credentials. */
async function handleAuthAdminResetPassword(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const session = await requireErpSession(req, res);
  if (!session) return;
  const role = String(session.role || '').toLowerCase();
  if (!(role.includes('super admin') || role.includes('principal') || role === 'admin')) {
    return json(res, 403, { ok: false, error: 'Only Super Admin / Principal can reset staff passwords.' });
  }
  const targetKey = String(req.body?.userId || req.body?.username || '').trim();
  const newPassword = String(req.body?.newPassword || '');
  if (!targetKey) return json(res, 400, { ok: false, error: 'Target staff user is required.' });
  if (newPassword.length < 8) return json(res, 400, { ok: false, error: 'New password must be at least 8 characters.' });

  const target = await readSnapshotStaffUser(schoolId, targetKey);
  if (!target) return json(res, 404, { ok: false, error: 'Staff user not found in cloud roster.' });

  await saveStaffCredential(schoolId, target, newPassword);

  // Keep snapshot password in sync for one-time migration / admin visibility before pull-strip.
  try {
    const snapshot = await readSnapshot(schoolId);
    const payload = snapshot?.payload && typeof snapshot.payload === 'object' ? { ...snapshot.payload } : { version: '2.1', students: [] };
    const staff = Array.isArray(payload.staffUsers) ? payload.staffUsers.slice() : [];
    const idx = staff.findIndex(user =>
      normalizeUsername(user?.id) === normalizeUsername(target.id) ||
      normalizeUsername(user?.username) === normalizeUsername(target.username)
    );
    if (idx >= 0) {
      staff[idx] = { ...staff[idx], password: newPassword };
      payload.staffUsers = staff;
      payload.savedAt = new Date().toISOString();
      await writeSnapshot(schoolId, payload, `password-reset:${session.username}`);
    }
  } catch (error) {
    console.error('[ERP-AUTH] snapshot password mirror failed:', error.message);
  }

  await writeAuditLog({
    school_id: schoolId,
    actor_user_id: session.user_id,
    actor_username: session.username,
    actor_name: session.user_name,
    actor_role: session.role,
    login_session_id: session.id,
    action: 'PASSWORD_ADMIN_RESET',
    entity_type: 'staff_user',
    entity_id: String(target.id || target.username || ''),
    metadata: { targetUsername: String(target.username || '') }
  });

  return json(res, 200, {
    ok: true,
    userId: target.id,
    username: target.username,
    name: target.name
  });
}

async function handleAuthAudit(req, res, schoolId) {
  const session = await requireErpSession(req, res);
  if (!session) return;
  if (!isTcAdministrator(session)) return json(res, 403, { ok: false, error: 'Administrator access required.' });
  const rows = await supabaseRequest(
    'GET',
    `erp_login_sessions?school_id=eq.${encodeURIComponent(schoolId)}&select=id,user_id,username,user_name,role,logged_in_at,last_seen_at,logged_out_at,status,user_agent&order=logged_in_at.desc&limit=500`
  );
  return json(res, 200, { ok: true, sessions: Array.isArray(rows) ? rows : [] });
}

function certificatePublicView(row) {
  if (!row) return null;
  const student = row.student_snapshot || {};
  return {
    certificateNo: row.certificate_no,
    status: String(row.status || '').toUpperCase(),
    issuedAt: row.issued_at,
    academicSession: row.academic_session,
    student: {
      name: student.name || '',
      admissionNo: row.admission_no,
      class: student.currentClass || student.class || student.lastClass || '',
      section: student.currentSection || student.section || student.lastSection || ''
    },
    school: {
      name: student.schoolName || 'Madan Mohan Malviya Junior High School',
      address: student.schoolAddress || 'Sector 53, Noida'
    },
    revokedAt: row.revoked_at || null,
    revocationReason: row.status === 'revoked' ? (row.revocation_reason || '') : ''
  };
}

async function handleTcVerify(req, res) {
  const token = String(req.query?.token || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return json(res, 400, { ok: false, valid: false, error: 'Invalid verification code.' });
  }
  const rows = await supabaseRequest(
    'GET',
    `erp_tc_certificates?verification_token=eq.${encodeURIComponent(token)}&select=certificate_no,admission_no,academic_session,student_snapshot,issued_at,status,revoked_at,revocation_reason&limit=1`
  );
  const row = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!row) return json(res, 404, { ok: false, valid: false, error: 'Certificate not found.' });
  return json(res, 200, { ok: true, valid: row.status === 'valid', certificate: certificatePublicView(row) });
}

async function handleTcIssue(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const session = await requireErpSession(req, res);
  if (!session) return;
  if (!isTcAdministrator(session)) return json(res, 403, { ok: false, error: 'Super Admin access is required to issue a TC.' });

  const adminPassword = String(req.body?.adminPassword || '');
  const admin = await authenticateStaffPassword(schoolId, session.username, adminPassword);
  if (!admin || !isTcAdministrator(admin)) {
    await writeAuditLog({
      school_id: schoolId,
      actor_user_id: session.user_id,
      actor_username: session.username,
      actor_name: session.user_name,
      actor_role: session.role,
      login_session_id: session.id,
      action: 'TC_ISSUE_DENIED',
      entity_type: 'student',
      entity_id: String(req.body?.admissionNo || ''),
      metadata: { reason: 'Administrator password verification failed.' }
    });
    return json(res, 403, { ok: false, error: 'Administrator password is incorrect.' });
  }

  const admissionNo = normalizeAdmission(req.body?.admissionNo);
  const snapshot = await readSnapshot(schoolId);
  const students = Array.isArray(snapshot?.payload?.students) ? snapshot.payload.students : [];
  const student = students.find(item => normalizeAdmission(item?.admissionNo || item?.AdmissionNo) === admissionNo);
  if (!student) return json(res, 404, { ok: false, error: 'Student not found in the cloud roster.' });

  const studentId = String(student.id || student.studentId || admissionNo);
  const academicSession = String(req.body?.academicSession || snapshot?.payload?.activeSession || '').trim();
  const certificateNo = String(req.body?.certificateNo || `TC-${academicSession}-${admissionNo}`).trim();
  const profile = snapshot?.payload?.schoolProfile || {};
  const officialSnapshot = {
    id: studentId,
    admissionNo,
    name: student.name || '',
    parentName: student.parentName || '',
    motherName: student.motherName || '',
    dob: student.dob || '',
    gender: student.gender || '',
    address: student.address || '',
    currentClass: student.currentClass || student.class || '',
    currentSection: student.currentSection || student.section || '',
    academicSession,
    schoolName: profile.name || 'Madan Mohan Malviya Junior High School',
    schoolAddress: profile.address || 'Sector 53, Noida'
  };
  const rpcRows = await supabaseRequest('POST', 'rpc/erp_issue_tc', {
    p_school_id: schoolId,
    p_student_id: studentId,
    p_admission_no: admissionNo,
    p_certificate_no: certificateNo,
    p_academic_session: academicSession,
    p_student_snapshot: officialSnapshot,
    p_issued_by_user_id: session.user_id,
    p_issued_by_username: session.username,
    p_issued_by_name: session.user_name,
    p_login_session_id: session.id,
    p_left_reason: String(req.body?.leftReason || "Parent's desire / Transfer to another school").trim()
  });
  const certificate = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
  return json(res, 200, {
    ok: true,
    certificate,
    verificationUrl: `https://www.mmmjhschool.com/verify-tc.html?token=${encodeURIComponent(certificate.verification_token)}`
  });
}

async function handleTcGet(req, res, schoolId) {
  const session = await requireErpSession(req, res);
  if (!session) return;
  const admissionNo = normalizeAdmission(req.query?.admissionNo || req.body?.admissionNo);
  const certificateNo = String(req.query?.certificateNo || req.body?.certificateNo || '').trim();
  let filter = `school_id=eq.${encodeURIComponent(schoolId)}`;
  if (certificateNo) filter += `&certificate_no=eq.${encodeURIComponent(certificateNo)}`;
  else if (admissionNo) filter += `&admission_no=eq.${encodeURIComponent(admissionNo)}`;
  else return json(res, 400, { ok: false, error: 'Admission or certificate number is required.' });
  const rows = await supabaseRequest(
    'GET',
    `erp_tc_certificates?${filter}&select=*&order=issued_at.desc&limit=1`
  );
  const certificate = Array.isArray(rows) && rows.length ? rows[0] : null;
  return json(res, 200, {
    ok: true,
    certificate,
    verificationUrl: certificate ? `https://www.mmmjhschool.com/verify-tc.html?token=${encodeURIComponent(certificate.verification_token)}` : ''
  });
}

async function handleTcList(req, res, schoolId) {
  const session = await requireErpSession(req, res);
  if (!session) return;
  const certificates = await listTcCertificatesInternal(schoolId);
  return json(res, 200, { ok: true, certificates });
}

async function listTcCertificatesInternal(schoolId) {
  const rows = await supabaseRequest(
    'GET',
    `erp_tc_certificates?school_id=eq.${encodeURIComponent(schoolId)}&select=id,student_id,admission_no,certificate_no,academic_session,student_snapshot,issued_at,issued_by_name,status,revoked_at&order=issued_at.desc&limit=2000`
  );
  return Array.isArray(rows) ? rows : [];
}

/** Merge permanent TC register back into roster — restores left/inactive students after a bad rebuild. */
function applyTcCertificatesToPayload(payload, certificates) {
  if (!payload || !Array.isArray(payload.students) || !Array.isArray(certificates) || !certificates.length) {
    return { payload, restored: 0, markedLeft: 0 };
  }

  const byAdmission = new Map();
  payload.students.forEach((student) => {
    const key = normalizeAdmission(student?.admissionNo || student?.AdmissionNo);
    if (key) byAdmission.set(key, student);
  });

  let restored = 0;
  let markedLeft = 0;
  certificates.forEach((cert) => {
    const adm = normalizeAdmission(cert?.admission_no);
    if (!adm) return;
    const snap = cert.student_snapshot && typeof cert.student_snapshot === 'object' ? cert.student_snapshot : {};
    let student = byAdmission.get(adm);
    if (!student) {
      student = {
        ...snap,
        admissionNo: adm,
        name: String(snap.name || '').trim() || `Student ${adm}`,
        currentClass: snap.currentClass || snap.class || '',
        currentSection: snap.currentSection || snap.section || '',
        parentName: snap.parentName || '',
        status: 'Left',
        feeRecords: snap.feeRecords && typeof snap.feeRecords === 'object' ? snap.feeRecords : {}
      };
      payload.students.push(student);
      byAdmission.set(adm, student);
      restored += 1;
    }

    const wasActive = String(student.status || '').toLowerCase() === 'active'
      || !['left', 'inactive', 'withdrawn', 'transferred'].includes(String(student.status || '').toLowerCase());
    student.status = 'Left';
    student.tcCertificateNo = cert.certificate_no || student.tcCertificateNo || '';
    student.tcNo = cert.certificate_no || student.tcNo || '';
    student.leftAt = student.leftAt || cert.issued_at || new Date().toISOString();
    student.leftReason = student.leftReason || 'Transfer certificate issued';
    if (snap.name && !student.name) student.name = snap.name;
    if (snap.parentName && !student.parentName) student.parentName = snap.parentName;
    if (wasActive) markedLeft += 1;
  });

  return { payload, restored, markedLeft };
}

async function handleRecoverFromTcRegister(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const session = await requireErpSession(req, res);
  if (!session) return;
  if (!isTcAdministrator(session)) {
    return json(res, 403, { ok: false, error: 'Super Admin / Principal access is required.' });
  }

  const snapshot = await readSnapshot(schoolId);
  if (!snapshot?.payload || !Array.isArray(snapshot.payload.students)) {
    return json(res, 404, { ok: false, error: 'School cloud roster not found.' });
  }

  const certificates = await listTcCertificatesInternal(schoolId);
  const merged = applyTcCertificatesToPayload({ ...snapshot.payload, students: snapshot.payload.students.slice() }, certificates);
  if (!certificates.length) {
    return json(res, 200, { ok: true, configured: true, tcCount: 0, restored: 0, markedLeft: 0, message: 'No issued TCs in cloud register.' });
  }

  merged.payload.savedAt = new Date().toISOString();
  const written = await writeSnapshot(schoolId, merged.payload, `recover-tc:${session.username}`);
  return json(res, 200, {
    ok: true,
    configured: true,
    schoolId,
    tcCount: certificates.length,
    restored: merged.restored,
    markedLeft: merged.markedLeft,
    studentCount: merged.payload.students.length,
    savedAt: written?.snapshot?.saved_at || merged.payload.savedAt
  });
}

async function handleTcRevoke(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const session = await requireErpSession(req, res);
  if (!session) return;
  if (!isTcAdministrator(session)) return json(res, 403, { ok: false, error: 'Super Admin access is required.' });
  const admin = await authenticateStaffPassword(schoolId, session.username, String(req.body?.adminPassword || ''));
  if (!admin || !isTcAdministrator(admin)) return json(res, 403, { ok: false, error: 'Administrator password is incorrect.' });
  const certificateId = String(req.body?.certificateId || '').trim();
  const reason = String(req.body?.reason || '').trim();
  if (!certificateId || !reason) return json(res, 400, { ok: false, error: 'Certificate and revocation reason are required.' });
  const result = await supabaseRequest('POST', 'rpc/erp_revoke_tc', {
    p_school_id: schoolId,
    p_certificate_id: certificateId,
    p_revoked_by_user_id: session.user_id,
    p_revoked_by_username: session.username,
    p_revoked_by_name: session.user_name,
    p_login_session_id: session.id,
    p_reason: reason
  });
  return json(res, 200, { ok: true, certificate: Array.isArray(result) ? result[0] : result });
}

function normalizeAdmission(value) {
  let s = String(value || '').trim();
  if (s.endsWith('.0') && /^\d+$/.test(s.slice(0, -2))) s = s.slice(0, -2);
  return s;
}

function normalizeSubjectsPayloadServer(subjects) {
  if (Array.isArray(subjects)) return subjects.filter((s) => s && typeof s === 'object');
  if (subjects && typeof subjects === 'object') {
    return Object.values(subjects).filter((s) => s && typeof s === 'object' && (s.code || s.name || s.id));
  }
  return [];
}

function normalizePeriodSettingsPayloadServer(periodSettings) {
  if (Array.isArray(periodSettings) && periodSettings.length) {
    return periodSettings.filter((p) => p && typeof p === 'object');
  }
  if (periodSettings && typeof periodSettings === 'object') {
    const vals = Object.values(periodSettings).filter((p) => p && typeof p === 'object' && (p.name || p.periodNo));
    if (vals.length) return vals;
  }
  return [];
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

/**
 * Staff self-link for @mmmjhschoolbot:
 * verify ERP username+password, then store telegramChatId on staffUsers in cloud snapshot.
 * Teachers are NOT on the Students Google Sheet.
 */
async function upsertStaffTelegramLink({ username, password, chatId, telegramUserName, unlink }) {
  if (!isConfigured()) return { ok: false, error: 'Cloud ERP is not configured on the bot server.' };
  const schoolId = schoolIdDefault();
  const user = await authenticateStaffPassword(schoolId, username, password);
  if (!user) {
    return { ok: false, error: 'Invalid staff username or password. Use your ERP login (User Management).' };
  }

  const snapshot = await readSnapshot(schoolId);
  if (!snapshot || !snapshot.payload || typeof snapshot.payload !== 'object') {
    return { ok: false, error: 'School cloud snapshot not found. Ask office to open ERP once so staff users sync to cloud.' };
  }

  const payload = { ...snapshot.payload };
  const staff = Array.isArray(payload.staffUsers) ? payload.staffUsers.map((u) => ({ ...u })) : [];
  const key = normalizeUsername(user.username || user.id);
  const idx = staff.findIndex((u) =>
    normalizeUsername(u?.username) === key || normalizeUsername(u?.id) === key
  );
  if (idx < 0) {
    return { ok: false, error: 'Staff user not found in cloud snapshot.' };
  }

  const cleanChat = String(chatId || '').trim();
  if (!unlink && !/^-?\d{7,15}$/.test(cleanChat)) {
    return { ok: false, error: 'Invalid Telegram chat ID.' };
  }

  // One Telegram chat → one staff login (clear from others)
  if (!unlink && cleanChat) {
    staff.forEach((u, i) => {
      if (i === idx) return;
      if (String(u.telegramChatId || '').trim() === cleanChat) {
        u.telegramChatId = '';
        u.telegramUserName = '';
      }
    });
  }

  if (unlink) {
    staff[idx].telegramChatId = '';
    staff[idx].telegramUserName = '';
    staff[idx].telegramLinkSource = '';
    staff[idx].telegramLinkedAt = '';
  } else {
    staff[idx].telegramChatId = cleanChat;
    staff[idx].telegramUserName = String(telegramUserName || '').trim();
    staff[idx].telegramLinkSource = 'Telegram /stafflink';
    staff[idx].telegramLinkedAt = new Date().toISOString();
  }

  payload.staffUsers = staff;
  payload.savedAt = new Date().toISOString();
  await writeSnapshot(schoolId, payload, `telegram-staff-link:${staff[idx].username || staff[idx].id}`);

  return {
    ok: true,
    unlinked: !!unlink,
    staff: publicStaffUser(staff[idx])
  };
}

async function findStaffByTelegramChatId(chatId) {
  if (!isConfigured()) return null;
  const cleanChat = String(chatId || '').trim();
  if (!cleanChat) return null;
  const snapshot = await readSnapshot(schoolIdDefault());
  const staff = Array.isArray(snapshot?.payload?.staffUsers) ? snapshot.payload.staffUsers : [];
  const hit = staff.find((u) => String(u.telegramChatId || '').trim() === cleanChat);
  return hit ? publicStaffUser(hit) : null;
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
    teachers: Array.isArray(basePayload?.teachers) ? basePayload.teachers : [],
    subjects: normalizeSubjectsPayloadServer(basePayload?.subjects),
    staffUsers: Array.isArray(basePayload?.staffUsers) ? basePayload.staffUsers : [],
    examSubjectConfigs: (basePayload && basePayload.examSubjectConfigs) || {},
    schoolProfile: (basePayload && basePayload.schoolProfile) || {},
    periodSettings: normalizePeriodSettingsPayloadServer(basePayload?.periodSettings),
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

  // Never rebuild from native if staff/teachers exist — native table is students-only
  // and a rebuild would wipe staff logins, Telegram links, and left-student history.
  const basePayload = snapshot?.payload || {};
  const hasStaffMeta = (Array.isArray(basePayload.staffUsers) && basePayload.staffUsers.length > 0)
    || (Array.isArray(basePayload.teachers) && basePayload.teachers.length > 0);
  if (hasStaffMeta) {
    return {
      snapshot: snapshot || null,
      rebuilt: false,
      studentCount: 0,
      error: 'Snapshot is empty but staff/teachers metadata exists — refusing native rebuild. Contact admin or restore from Supabase backup.'
    };
  }

  const rebuilt = await rebuildPayloadFromNative(schoolId, basePayload);
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

/**
 * Change probe for polling. Selects only the timestamp, so both the API response
 * and the Supabase read stay a few bytes instead of the whole roster.
 */
async function readSnapshotVersion(schoolId) {
  const rows = await supabaseRequest(
    'GET',
    `erp_snapshots?school_id=eq.${encodeURIComponent(schoolId)}&select=saved_at,version&limit=1`
  );
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function syncStaffCredentialsFromPayload(schoolId, payload) {
  const staff = Array.isArray(payload?.staffUsers) ? payload.staffUsers : [];
  for (const user of staff) {
    const plain = String(user?.password || '').trim();
    if (plain.length < 8) continue;
    try {
      await saveStaffCredential(schoolId, user, plain);
    } catch (err) {
      console.error('[ERP-AUTH] credential sync failed:', user?.username || user?.id, err.message);
    }
  }
}

async function writeSnapshot(schoolId, payload, savedBy) {
  payload = await preserveSnapshotStaffPasswords(schoolId, payload);
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
  try {
    await syncStaffCredentialsFromPayload(schoolId, payload);
  } catch (err) {
    console.error('[ERP-AUTH] bulk credential sync failed:', err.message);
  }
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

function studentPhotoStorageBucket() {
  return getEnv('ERP_STUDENT_PHOTO_BUCKET') || 'student-photos';
}

function decodeDataUrlImage(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) return null;
  let ext = 'jpg';
  if (mime.includes('png')) ext = 'png';
  else if (mime.includes('webp')) ext = 'webp';
  return { buffer, mime, ext };
}

function studentPhotoStorageObjectPath(schoolId, admissionNo, ext) {
  return `${schoolId}/${normalizeAdmission(admissionNo)}.${ext || 'jpg'}`;
}

function studentPhotoPublicUrl(schoolId, admissionNo, ext) {
  const cfg = supabaseConfig();
  const bucket = studentPhotoStorageBucket();
  const objectPath = studentPhotoStorageObjectPath(schoolId, admissionNo, ext);
  return `${cfg.url}/storage/v1/object/public/${bucket}/${objectPath}`;
}

async function uploadStudentPhotoBufferToStorage(schoolId, admissionNo, buffer, mime) {
  const cfg = supabaseConfig();
  if (!cfg) throw new Error('Supabase is not configured on the server.');
  if (!buffer || !buffer.length) throw new Error(`Empty image for admission ${admissionNo}.`);
  const normalizedMime = String(mime || 'image/jpeg').toLowerCase();
  let ext = 'jpg';
  if (normalizedMime.includes('png')) ext = 'png';
  else if (normalizedMime.includes('webp')) ext = 'webp';
  const bucket = studentPhotoStorageBucket();
  const objectPath = studentPhotoStorageObjectPath(schoolId, admissionNo, ext);
  const response = await fetch(`${cfg.url}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': normalizedMime || 'image/jpeg',
      'x-upsert': 'true'
    },
    body: buffer
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text.slice(0, 240);
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.error || message;
    } catch (err) {}
    if (/bucket/i.test(message)) {
      throw new Error(`Supabase Storage bucket "${bucket}" is missing. Create a public bucket with that exact name (see SUPABASE_PHOTO_STORAGE.md).`);
    }
    throw new Error(`Photo upload failed for ${admissionNo}: ${message}`);
  }
  return studentPhotoPublicUrl(schoolId, admissionNo, ext);
}

async function uploadStudentPhotoToStorage(schoolId, admissionNo, dataUrl) {
  const decoded = decodeDataUrlImage(dataUrl);
  if (!decoded) throw new Error(`Invalid image data for admission ${admissionNo}.`);
  return uploadStudentPhotoBufferToStorage(schoolId, admissionNo, decoded.buffer, decoded.mime);
}

async function downloadRemoteStudentPhoto(url, cookie) {
  const cleanUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(cleanUrl)) throw new Error('Invalid photo URL.');
  const headers = {
    'User-Agent': 'MMM-ERP-PhotoImport/1.0',
    Accept: 'image/*,*/*'
  };
  const sessionCookie = String(cookie || '').trim();
  if (sessionCookie) headers.Cookie = sessionCookie;
  const response = await fetch(cleanUrl, { headers, redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Empty image file.');
  if (buffer.length > 2 * 1024 * 1024) throw new Error('Image too large (max 2 MB).');
  const mime = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^image\//i.test(mime)) throw new Error(`Not an image (${mime || 'unknown type'}).`);
  return { buffer, mime };
}

/**
 * Option C — upload JPEG/PNG to Supabase Storage, store public URL in cloud snapshot.
 * Small JSON requests; images live outside the roster payload.
 */
async function handlePhotoStorageUpload(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const photos = req.body?.photos;
  if (!Array.isArray(photos) || !photos.length) {
    return json(res, 400, { ok: false, error: 'POST body must include photos array.' });
  }
  if (photos.length > 15) {
    return json(res, 400, { ok: false, error: 'Maximum 15 photos per request (server limit). Update js/cloudSync.js — it sends smaller automatic batches.' });
  }

  const snapshot = await readSnapshot(schoolId);
  if (!snapshot?.payload || !Array.isArray(snapshot.payload.students) || !snapshot.payload.students.length) {
    return json(res, 404, { ok: false, error: 'School cloud roster not found.' });
  }

  const byAdmission = new Map();
  snapshot.payload.students.forEach((student) => {
    const key = normalizeAdmission(student?.admissionNo || student?.AdmissionNo);
    if (key) byAdmission.set(key, student);
  });

  const uploaded = [];
  for (const row of photos) {
    if (!row || typeof row !== 'object') continue;
    const key = normalizeAdmission(row.admissionNo || row.AdmissionNo);
    if (!key) continue;
    const student = byAdmission.get(key);
    if (!student) continue;
    const dataUrl = String(row.photo || row.photoDataUrl || '').trim();
    if (!dataUrl.startsWith('data:image')) continue;
    const publicUrl = await uploadStudentPhotoToStorage(schoolId, key, dataUrl);
    student.photo = publicUrl;
    student.photoDataUrl = publicUrl;
    uploaded.push({ admissionNo: key, photoUrl: publicUrl });
  }

  if (!uploaded.length) {
    return json(res, 400, { ok: false, error: 'No matching students or valid photo data in this batch.' });
  }

  const payload = {
    ...snapshot.payload,
    savedAt: new Date().toISOString()
  };
  const savedBy = String(req.body?.savedBy || 'bulk-photo-storage').trim();
  const written = await writeSnapshot(schoolId, payload, savedBy);
  const savedAt = written?.snapshot?.saved_at || payload.savedAt;

  return json(res, 200, {
    ok: true,
    configured: true,
    schoolId,
    storage: true,
    patched: uploaded.length,
    uploaded,
    savedAt,
    studentCount: payload.students.length
  });
}

/**
 * Import student photos from external URLs (old ERP /uploads/ links).
 * Server downloads each image and stores it in Supabase Storage.
 */
async function handlePhotoImportFromUrls(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) {
    return json(res, 400, { ok: false, error: 'POST body must include items array with admissionNo and url.' });
  }
  if (items.length > 15) {
    return json(res, 400, { ok: false, error: 'Maximum 15 URLs per request. The app imports in automatic batches — update js/cloudSync.js if you see this.' });
  }

  const snapshot = await readSnapshot(schoolId);
  if (!snapshot?.payload || !Array.isArray(snapshot.payload.students) || !snapshot.payload.students.length) {
    return json(res, 404, { ok: false, error: 'School cloud roster not found.' });
  }

  const byAdmission = new Map();
  snapshot.payload.students.forEach((student) => {
    const key = normalizeAdmission(student?.admissionNo || student?.AdmissionNo);
    if (key) byAdmission.set(key, student);
  });

  const cookie = String(req.body?.cookie || '').trim();
  const uploaded = [];
  const failed = [];

  for (const row of items) {
    if (!row || typeof row !== 'object') continue;
    const key = normalizeAdmission(row.admissionNo || row.AdmissionNo);
    const sourceUrl = String(row.url || row.photoUrl || row.photo || '').trim();
    if (!key || !sourceUrl) continue;
    const student = byAdmission.get(key);
    if (!student) {
      failed.push({ admissionNo: key, error: 'Student not found in cloud roster.' });
      continue;
    }
    try {
      const downloaded = await downloadRemoteStudentPhoto(sourceUrl, cookie);
      const publicUrl = await uploadStudentPhotoBufferToStorage(schoolId, key, downloaded.buffer, downloaded.mime);
      student.photo = publicUrl;
      student.photoDataUrl = publicUrl;
      uploaded.push({ admissionNo: key, photoUrl: publicUrl, sourceUrl });
    } catch (err) {
      failed.push({ admissionNo: key, error: err.message || String(err), sourceUrl });
    }
  }

  if (!uploaded.length) {
    return json(res, 400, {
      ok: false,
      error: failed.length
        ? `No photos imported. First error: ${failed[0].error}`
        : 'No matching students or valid photo URLs in this batch.',
      failed
    });
  }

  const payload = {
    ...snapshot.payload,
    savedAt: new Date().toISOString()
  };
  const savedBy = String(req.body?.savedBy || 'old-erp-photo-import').trim();
  const written = await writeSnapshot(schoolId, payload, savedBy);
  const savedAt = written?.snapshot?.saved_at || payload.savedAt;

  return json(res, 200, {
    ok: true,
    configured: true,
    schoolId,
    storage: true,
    imported: uploaded.length,
    patched: uploaded.length,
    uploaded,
    failed,
    savedAt,
    studentCount: payload.students.length
  });
}

/** Patch student passport photos in small batches (avoids Vercel 4.5MB body limit on full roster push). */
async function handlePhotoPatch(req, res, schoolId) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
  const photos = req.body?.photos;
  if (!Array.isArray(photos) || !photos.length) {
    return json(res, 400, { ok: false, error: 'POST body must include photos array.' });
  }
  if (photos.length > 15) {
    return json(res, 400, { ok: false, error: 'Maximum 15 photos per request (server limit). Update js/cloudSync.js — it sends smaller automatic batches.' });
  }

  const snapshot = await readSnapshot(schoolId);
  if (!snapshot?.payload || !Array.isArray(snapshot.payload.students) || !snapshot.payload.students.length) {
    return json(res, 404, { ok: false, error: 'School cloud roster not found.' });
  }

  const byAdmission = new Map();
  snapshot.payload.students.forEach((student) => {
    const key = normalizeAdmission(student?.admissionNo || student?.AdmissionNo);
    if (key) byAdmission.set(key, student);
  });

  let patched = 0;
  const touchedStudents = [];
  photos.forEach((row) => {
    if (!row || typeof row !== 'object') return;
    const key = normalizeAdmission(row.admissionNo || row.AdmissionNo);
    if (!key) return;
    const student = byAdmission.get(key);
    if (!student) return;
    const photo = String(row.photo || row.photoDataUrl || '').trim();
    const isAssetPhoto = photo.startsWith('assets/students/') && /\.(jpe?g|png|webp)$/i.test(photo);
    if (!photo.startsWith('data:image') && !isAssetPhoto) return;
    student.photo = photo;
    student.photoDataUrl = photo;
    touchedStudents.push(student);
    patched += 1;
  });

  if (!patched) {
    return json(res, 400, { ok: false, error: 'No matching students or valid photo data in this batch.' });
  }

  const payload = {
    ...snapshot.payload,
    savedAt: new Date().toISOString()
  };
  const savedBy = String(req.body?.savedBy || 'bulk-photo-upload').trim();
  const written = await writeSnapshot(schoolId, payload, savedBy);
  const savedAt = written?.snapshot?.saved_at || payload.savedAt;

  return json(res, 200, {
    ok: true,
    configured: true,
    schoolId,
    patched,
    savedAt,
    studentCount: payload.students.length
  });
}

async function route(req, res, action) {
  const act = String(action || req.query?.action || '').trim();
  if (act === 'cloudConfig') {
    await handleCloudConfig(req, res);
    return true;
  }
  if ([
    'cloudPull', 'cloudVersion', 'health', 'cloudPush', 'photoPatch', 'photoStorageUpload', 'photoImportFromUrls', 'nativeStudents', 'nativeMigrate', 'nativePayments',
    'rebuildSnapshot', 'wipeRoster', 'recoverFromTcRegister', 'authLogin', 'authLogout', 'authSession', 'authChangePassword',
    'authAdminResetPassword', 'authAudit', 'tcIssue', 'tcGet', 'tcList', 'tcVerify', 'tcRevoke'
  ].includes(act)) {
    await erpCloudHandler(req, res);
    return true;
  }
  return false;
}

async function erpCloudHandler(req, res) {
  try {
    // Vercel serverless: ensure query/body are parsed when invoked directly as /api/erp-cloud
    if (!req.query || typeof req.query !== 'object') req.query = {};
    if (!req.query.action && req.url) {
      try {
        const parsed = new URL(String(req.url), 'http://localhost');
        parsed.searchParams.forEach((value, key) => { req.query[key] = value; });
      } catch (e) {}
    }
    if (typeof req.body === 'string' && req.body.trim()) {
      try { req.body = JSON.parse(req.body); } catch (e) { req.body = {}; }
    }
    if (!req.body || typeof req.body !== 'object') req.body = {};

    if (req.method === 'OPTIONS') return empty(res);

    const action = String(req.query.action || '').trim();
    if (req.method === 'GET' && action === 'cloudConfig') {
      return handleCloudConfig(req, res);
    }

    // Uptime pings land here: no database read, no roster, a few bytes.
    if (action === 'health') {
      return json(res, 200, { ok: true, service: 'erp-cloud' });
    }

    if (!supabaseConfig()) {
      return json(res, 200, {
        ok: false,
        configured: false,
        error: 'Cloud database is not configured on the server yet. ERP will use local storage only.'
      });
    }

    const schoolId = String(req.query.schoolId || req.body?.schoolId || schoolIdDefault()).trim() || schoolIdDefault();

    // These actions have their own authentication rules. Public verification is
    // token-scoped; login is restricted to the official site; all others require
    // a valid short-lived ERP session.
    if (action === 'tcVerify' && req.method === 'GET') return handleTcVerify(req, res);
    if (action === 'authLogin') return handleAuthLogin(req, res, schoolId);
    if (action === 'authLogout') return handleAuthLogout(req, res, schoolId);
    if (action === 'authSession') return handleAuthSession(req, res);
    if (action === 'authChangePassword') return handleAuthChangePassword(req, res, schoolId);
    if (action === 'authAdminResetPassword') return handleAuthAdminResetPassword(req, res, schoolId);
    if (action === 'authAudit') return handleAuthAudit(req, res, schoolId);
    if (action === 'tcIssue') return handleTcIssue(req, res, schoolId);
    if (action === 'tcGet') return handleTcGet(req, res, schoolId);
    if (action === 'tcList') return handleTcList(req, res, schoolId);
    if (action === 'tcRevoke') return handleTcRevoke(req, res, schoolId);

    if (!authorize(req)) {
      return json(res, 403, { ok: false, error: 'Invalid cloud sync secret.' });
    }

    // Poll target: tells the browser whether the roster changed without sending it.
    if (req.method === 'GET' && action === 'cloudVersion') {
      const row = await readSnapshotVersion(schoolId);
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        savedAt: row?.saved_at || '',
        version: row?.version || ''
      });
    }

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
        snapshot: snapshotForBrowser(ensured.snapshot),
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
        try {
          const certificates = await listTcCertificatesInternal(schoolId);
          const tcMerged = applyTcCertificatesToPayload(snapshot.payload, certificates);
          snapshot.payload = tcMerged.payload;
        } catch (err) {
          console.error('[ERP-CLOUD] TC register overlay failed:', err.message);
        }
      }
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        snapshot: snapshotForBrowser(snapshot) || null,
        studentCount: snapshotStudentCount(snapshot),
        native: true,
        feesNative: true
      });
    }

    if (req.method === 'POST' && action === 'recoverFromTcRegister') {
      return handleRecoverFromTcRegister(req, res, schoolId);
    }

    if (req.method === 'POST' && action === 'photoPatch') {
      return handlePhotoPatch(req, res, schoolId);
    }

    if (req.method === 'POST' && action === 'photoStorageUpload') {
      return handlePhotoStorageUpload(req, res, schoolId);
    }

    if (req.method === 'POST' && action === 'photoImportFromUrls') {
      return handlePhotoImportFromUrls(req, res, schoolId);
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
erpCloudHandler.upsertStaffTelegramLink = upsertStaffTelegramLink;
erpCloudHandler.findStaffByTelegramChatId = findStaffByTelegramChatId;
erpCloudHandler.isConfigured = isConfigured;
erpCloudHandler.listNativeStudents = listNativeStudents;
erpCloudHandler.route = route;
erpCloudHandler.handleCloudConfig = handleCloudConfig;
erpCloudHandler.cloudConfigBody = cloudConfigBody;

module.exports = erpCloudHandler;
