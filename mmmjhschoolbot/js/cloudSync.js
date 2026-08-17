/**
 * Shared ERP cloud sync (Supabase via Render /api/erp-cloud).
 *
 * When window.ERP_CLOUD_ONLY is true (default for MMM JHS):
 *   - Cloud snapshot is the only roster source of truth
 *   - Pull REPLACES memory (no merge with stale localStorage students)
 *   - Push uploads this device's in-memory data (already cloud-based + local edits)
 *   - One-time migrate: if cloud empty but browser still has old local data, upload once
 *
 * Hybrid mode (ERP_CLOUD_ONLY false): fee receipts still MERGED by receiptNo so a
 * stale PC localStorage (₹0) cannot wipe a phone ledger (₹1900).
 */
(function () {
  const LS_SCHOOL_ID = 'MMM_ERP_CLOUD_SCHOOL_ID';
  const LS_SECRET = 'MMM_ERP_CLOUD_SECRET';
  const LS_LAST_PULL = 'MMM_ERP_CLOUD_LAST_PULL_AT';
  const LS_LAST_CLOUD_AT = 'MMM_ERP_CLOUD_LAST_CLOUD_AT';
  const LS_MIGRATED_FLAG = 'MMM_ERP_CLOUD_ONLY_MIGRATED';

  let cloudPushTimer = null;
  let cloudPollTimer = null;
  let cloudSyncInFlight = false;

  // Live-sync tuning. The poll itself only fetches a timestamp, so a short
  // interval stays cheap; the roster is downloaded only when it changed.
  const CLOUD_POLL_MS = 15000;
  const FALLBACK_PULL_EVERY_TICKS = 6; // ~90s, used only if the server has no probe
  let versionProbeSupported = true;
  let fallbackPollTicks = 0;

  function isCloudOnly() {
    // Default ON for MMM JHS. Set window.ERP_CLOUD_ONLY = false only to re-enable hybrid.
    return window.ERP_CLOUD_ONLY !== false;
  }

  function getCloudSchoolId() {
    return String(localStorage.getItem(LS_SCHOOL_ID) || window.ERP_CLOUD_SCHOOL_ID || 'mmm-jhs').trim() || 'mmm-jhs';
  }

  function getCloudSecret() {
    return String(localStorage.getItem(LS_SECRET) || window.ERP_CLOUD_SECRET || '').trim();
  }

  function setCloudCredentials(schoolId, secret) {
    if (schoolId) localStorage.setItem(LS_SCHOOL_ID, String(schoolId).trim());
    if (secret !== undefined) localStorage.setItem(LS_SECRET, String(secret || '').trim());
  }

  function isLiveSchoolWebsiteHost() {
    const h = String(window.location.hostname || '').replace(/^www\./, '').toLowerCase();
    return h === 'mmmjhschool.com'
      || h.endsWith('.vercel.app')
      || h === 'madanmohanmalviyaschool.com'
      || h.includes('mmmjhschool');
  }

  function getErpCloudApiBase() {
    if (typeof getMmmjhsBotApiBase === 'function') return getMmmjhsBotApiBase();
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      const port = String(window.MMMJHS_BOT_LOCAL_PORT || '8085').trim();
      return `${window.location.protocol}//${host}:${port}/api/mmmjhs-bot`;
    }
    if (isLiveSchoolWebsiteHost()) return '/api/mmmjhs-bot';
    return 'https://mmmjhschoolbot.onrender.com/api/mmmjhs-bot';
  }

  function withCloudSecret(url) {
    const secret = getCloudSecret();
    if (!secret) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}secret=${encodeURIComponent(secret)}`;
  }

  function cloudPullUrl() {
    const schoolId = getCloudSchoolId();
    return withCloudSecret(`${getErpCloudApiBase()}?action=cloudPull&schoolId=${encodeURIComponent(schoolId)}`);
  }

  function cloudPushUrl() {
    return withCloudSecret(`${getErpCloudApiBase()}?action=cloudPush`);
  }

  function cloudPhotoPatchUrl() {
    return withCloudSecret(`${getErpCloudApiBase()}?action=photoPatch`);
  }

  function cloudPhotoStorageUrl() {
    return withCloudSecret(`${getErpCloudApiBase()}?action=photoStorageUpload`);
  }

  function cloudPhotoImportUrl() {
    return withCloudSecret(`${getErpCloudApiBase()}?action=photoImportFromUrls`);
  }

  function cloudHeaders() {
    const headers = { Accept: 'application/json' };
    const secret = getCloudSecret();
    if (secret) headers['X-ERP-Cloud-Secret'] = secret;
    return headers;
  }

  async function fetchWithRetry(url, options, retries) {
    const max = retries == null ? 2 : retries;
    let lastErr;
    for (let attempt = 0; attempt <= max; attempt++) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutMs = 20000;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const opts = Object.assign({}, options || {});
        if (controller) opts.signal = controller.signal;
        return await fetch(url, opts);
      } catch (err) {
        lastErr = err && err.name === 'AbortError'
          ? new Error('Cloud request timed out. Check internet and refresh — live site should use Vercel /api, not Render.')
          : err;
        if (attempt < max) await new Promise((resolve) => setTimeout(resolve, 2500));
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function fetchCloudConfig() {
    try {
      const res = await fetchWithRetry(`${getErpCloudApiBase()}?action=cloudConfig`, { cache: 'no-store' });
      const data = await parseCloudResponse(res);
      if (data.cloudSync) return data.cloudSync;
      if (typeof data.configured === 'boolean') {
        return {
          configured: data.configured,
          schoolId: data.schoolId,
          requiresSecret: data.requiresSecret,
          native: data.native,
          siteTrusted: data.siteTrusted,
          feesNative: data.feesNative,
          error: data.error
        };
      }
      if (data.service) {
        return {
          configured: false,
          error: 'Render bot needs update. Push api/mmmjhs-bot.js + api/erp-cloud.js to GitHub and redeploy Render.'
        };
      }
      return { configured: false };
    } catch (err) {
      return { configured: false, error: err.message };
    }
  }

  async function parseCloudResponse(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      if (res.status === 404) {
        throw new Error('Cloud API not found (404). Deploy api/mmmjhs-bot.js + api/erp-cloud.js on Vercel and hard-refresh the site.');
      }
      throw new Error(`Cloud fetch failed (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }
  }

  function hasSyncedFromCloud() {
    return !!localStorage.getItem(LS_LAST_CLOUD_AT);
  }

  function admissionKey(student) {
    return String(student?.admissionNo || student?.AdmissionNo || '').trim().toLowerCase();
  }

  function paymentKey(payment) {
    if (!payment) return '';
    const receipt = String(payment.receiptNo || '').trim().toLowerCase();
    if (receipt) return `r:${receipt}`;
    return `f:${payment.date || ''}|${payment.amount || ''}|${payment.month || ''}|${payment.mode || ''}`;
  }

  function cancelledReceiptKey(item) {
    const receipt = String(typeof item === 'string' ? item : item?.receiptNo || '').trim().toLowerCase();
    return receipt ? `r:${receipt}` : '';
  }

  function mergeCancelledReceipts(a, b) {
    const map = new Map();
    [...(a || []), ...(b || [])].forEach((item) => {
      const key = cancelledReceiptKey(item);
      if (!key) return;
      const marker = typeof item === 'string' ? { receiptNo: item } : item;
      const previous = map.get(key);
      const previousAt = Date.parse(previous?.cancelledAt || '') || 0;
      const nextAt = Date.parse(marker?.cancelledAt || '') || 0;
      if (!previous || nextAt >= previousAt) map.set(key, { ...(previous || {}), ...marker });
    });
    return Array.from(map.values());
  }

  function removeCancelledPayments(students, cancelledReceipts) {
    const cancelledKeys = new Set((cancelledReceipts || []).map(cancelledReceiptKey).filter(Boolean));
    if (!cancelledKeys.size) return;
    const scrub = fee => {
      if (!fee || !Array.isArray(fee.payments)) return;
      fee.payments = fee.payments.filter(payment => !cancelledKeys.has(paymentKey(payment)));
    };
    (students || []).forEach(student => {
      Object.values(student?.feeRecords || {}).forEach(scrub);
      scrub(student?.currentFeeInfo);
    });
  }

  function mergeStringLists(a, b) {
    const out = [];
    const seen = new Set();
    [...(a || []), ...(b || [])].forEach((item) => {
      const key = String(item || '').trim();
      if (!key) return;
      const norm = key.toLowerCase();
      if (seen.has(norm)) return;
      seen.add(norm);
      out.push(key);
    });
    return out;
  }

  function mergePayments(a, b) {
    const map = new Map();
    [...(a || []), ...(b || [])].forEach((payment) => {
      const key = paymentKey(payment);
      if (!key) return;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, payment);
        return;
      }
      const prevAmt = Number(prev.amount || 0);
      const nextAmt = Number(payment.amount || 0);
      map.set(key, nextAmt >= prevAmt ? { ...prev, ...payment } : { ...payment, ...prev });
    });
    return Array.from(map.values());
  }

  function mergeFeeSession(localFee, remoteFee) {
    const L = localFee && typeof localFee === 'object' ? localFee : {};
    const R = remoteFee && typeof remoteFee === 'object' ? remoteFee : {};
    const payments = mergePayments(L.payments, R.payments);
    const paidMonths = mergeStringLists(L.paidMonths, R.paidMonths);
    const dueFromBoth = mergeStringLists(L.dueMonths, R.dueMonths);
    const paidSet = new Set(paidMonths.map((m) => String(m).toLowerCase()));
    const dueMonths = dueFromBoth.filter((m) => !paidSet.has(String(m).toLowerCase()));
    return {
      ...R,
      ...L,
      monthlyTuition: Number(L.monthlyTuition || R.monthlyTuition || 0) || L.monthlyTuition || R.monthlyTuition,
      payments,
      paidMonths,
      dueMonths,
      walletBalance: Math.max(Number(L.walletBalance || 0), Number(R.walletBalance || 0))
    };
  }

  function mergeFeeRecords(localFr, remoteFr) {
    const sessions = new Set([
      ...Object.keys(localFr && typeof localFr === 'object' ? localFr : {}),
      ...Object.keys(remoteFr && typeof remoteFr === 'object' ? remoteFr : {})
    ]);
    const out = {};
    sessions.forEach((sess) => {
      out[sess] = mergeFeeSession(
        localFr && localFr[sess],
        remoteFr && remoteFr[sess]
      );
    });
    return out;
  }

  function preferText(a, b) {
    const left = String(a == null ? '' : a).trim();
    const right = String(b == null ? '' : b).trim();
    if (left && right) {
      if (/^(parent|n\/?a|null|undefined|-)$/i.test(left) && right) return b;
      return a;
    }
    return left ? a : b;
  }

  function resolveStudentName(localStudent, remoteStudent) {
    const L = String(localStudent?.name || '').trim();
    const R = String(remoteStudent?.name || '').trim();
    if (!L) return R;
    if (!R) return L;
    if (L.toLowerCase() === R.toLowerCase()) return L;

    // Never keep a permanent per-device name fork for the same admission
    if (typeof scoreStudentAsCanonical === 'function') {
      const localScore = scoreStudentAsCanonical(localStudent);
      const remoteScore = scoreStudentAsCanonical(remoteStudent);
      if (remoteScore > localScore) return R;
      if (localScore > remoteScore) return L;
    }

    const localStats = countPayments({ students: [localStudent] });
    const remoteStats = countPayments({ students: [remoteStudent] });
    if (remoteStats.total > localStats.total) return R;
    if (localStats.total > remoteStats.total) return L;

    // Shared cloud wins when still tied so PC/phone converge
    return R;
  }

  function isRealStudentPhoto(value) {
    const photo = String(value || '').trim();
    if (photo.startsWith('assets/students/') && /\.(jpe?g|png|webp)$/i.test(photo)) return true;
    if (/supabase\.co\/storage\/v1\/object\/public\//i.test(photo)) return true;
    if (!photo.startsWith('data:image')) return false;
    if (/unsplash|placeholder|dicebear|gravatar/i.test(photo)) return false;
    return photo.length > 120;
  }

  function preferStudentPhoto(localValue, remoteValue) {
    const localPhoto = String(localValue || '').trim();
    const remotePhoto = String(remoteValue || '').trim();
    const localReal = isRealStudentPhoto(localPhoto);
    const remoteReal = isRealStudentPhoto(remotePhoto);
    if (localReal && !remoteReal) return localPhoto;
    if (remoteReal && !localReal) return remotePhoto;
    if (localReal && remoteReal) return localPhoto.length >= remotePhoto.length ? localPhoto : remotePhoto;
    return localPhoto || remotePhoto;
  }

  function mergeStudent(localStudent, remoteStudent) {
    const L = localStudent || {};
    const R = remoteStudent || {};
    const base = { ...R, ...L };
    const photo = preferStudentPhoto(L.photo || L.photoDataUrl, R.photo || R.photoDataUrl);
    return {
      ...base,
      name: resolveStudentName(L, R),
      parentName: preferText(L.parentName, R.parentName),
      phone: preferText(L.phone, R.phone),
      cardUid: preferText(L.cardUid || L.nfcUid, R.cardUid || R.nfcUid) || L.cardUid || R.cardUid,
      nfcUid: preferText(L.nfcUid, R.nfcUid) || L.nfcUid || R.nfcUid,
      telegramChatId: preferText(L.telegramChatId, R.telegramChatId) || L.telegramChatId || R.telegramChatId,
      photo,
      photoDataUrl: photo,
      feeRecords: mergeFeeRecords(L.feeRecords, R.feeRecords),
      currentFeeInfo: mergeFeeSession(L.currentFeeInfo, R.currentFeeInfo)
    };
  }

  function countPayments(payload) {
    let n = 0;
    let total = 0;
    (payload?.students || []).forEach((student) => {
      const fr = student?.feeRecords;
      if (!fr || typeof fr !== 'object') return;
      Object.values(fr).forEach((sess) => {
        (sess?.payments || []).forEach((p) => {
          n += 1;
          total += Number(p?.amount || 0);
        });
      });
    });
    return { count: n, total };
  }

  function mergeSchoolPayloads(localPayload, remotePayload, options) {
    const local = localPayload && typeof localPayload === 'object' ? localPayload : {};
    const remote = remotePayload && typeof remotePayload === 'object' ? remotePayload : {};
    const remoteStudentsAuthoritative = !!(options && options.remoteStudentsAuthoritative);
    const localStudentsAuthoritative = !!(options && options.localStudentsAuthoritative);
    const byAdmission = new Map();

    // Student membership must not be an addition-only union. That old behavior
    // resurrected deleted/renumbered rows from stale PCs and inflated the roster.
    // Pull: cloud membership wins. Push: this device's membership wins. For the
    // admissions kept by that authority, merge both copies so receipts and fees
    // are still protected from stale-device overwrites.
    const baseStudents = localStudentsAuthoritative ? (local.students || []) : (remote.students || []);
    const detailStudents = localStudentsAuthoritative ? (remote.students || []) : (local.students || []);

    baseStudents.forEach((student) => {
      const key = admissionKey(student);
      if (!key) return;
      byAdmission.set(key, student);
    });

    detailStudents.forEach((student) => {
      const key = admissionKey(student);
      if (!key) return;
      if (byAdmission.has(key)) {
        const localStudent = (local.students || []).find((item) => admissionKey(item) === key) || student;
        const remoteStudent = (remote.students || []).find((item) => admissionKey(item) === key) || student;
        byAdmission.set(key, mergeStudent(localStudent, remoteStudent));
      } else if (!remoteStudentsAuthoritative && !localStudentsAuthoritative) {
        byAdmission.set(key, student);
      }
    });

    const localAt = Date.parse(local.savedAt || '') || 0;
    const remoteAt = Date.parse(remote.savedAt || '') || 0;
    const newerMeta = remoteAt >= localAt ? remote : local;
    const olderMeta = remoteAt >= localAt ? local : remote;

    const cancelledReceipts = mergeCancelledReceipts(local.cancelledReceipts, remote.cancelledReceipts);
    const students = Array.from(byAdmission.values());
    removeCancelledPayments(students, cancelledReceipts);

    // Staff logins + teachers: same membership rule as students.
    // Prefer-non-empty + savedAt resurrected deleted users from stale PCs and
    // could wipe custom staff when an empty/newer side won incorrectly.
    let staffUsers;
    let teachers;
    if (localStudentsAuthoritative) {
      staffUsers = Array.isArray(local.staffUsers) ? local.staffUsers : (remote.staffUsers || []);
      teachers = Array.isArray(local.teachers) ? local.teachers : (remote.teachers || []);
    } else if (remoteStudentsAuthoritative) {
      staffUsers = Array.isArray(remote.staffUsers) ? remote.staffUsers : (local.staffUsers || []);
      teachers = Array.isArray(remote.teachers) ? remote.teachers : (local.teachers || []);
    } else {
      staffUsers = Array.isArray(newerMeta.staffUsers) ? newerMeta.staffUsers
        : (Array.isArray(olderMeta.staffUsers) ? olderMeta.staffUsers : []);
      teachers = Array.isArray(newerMeta.teachers) ? newerMeta.teachers
        : (Array.isArray(olderMeta.teachers) ? olderMeta.teachers : []);
    }

    return {
      ...olderMeta,
      ...newerMeta,
      version: newerMeta.version || olderMeta.version || '2.0',
      savedAt: new Date().toISOString(),
      students,
      cancelledReceipts,
      classes: (newerMeta.classes && newerMeta.classes.length) ? newerMeta.classes : (olderMeta.classes || []),
      staffUsers,
      schoolProfile: newerMeta.schoolProfile || olderMeta.schoolProfile,
      signatures: newerMeta.signatures || olderMeta.signatures,
      teachers,
      subjects: newerMeta.subjects || olderMeta.subjects,
      sessions: newerMeta.sessions || olderMeta.sessions,
      classFeeMaster: newerMeta.classFeeMaster || olderMeta.classFeeMaster,
      feeScheduleRules: newerMeta.feeScheduleRules || olderMeta.feeScheduleRules,
      examSubjectConfigs: newerMeta.examSubjectConfigs || olderMeta.examSubjectConfigs,
      periodSettings: newerMeta.periodSettings || olderMeta.periodSettings,
      activeSession: newerMeta.activeSession || olderMeta.activeSession
    };
  }

  function payloadsDifferOnFees(a, b) {
    const left = countPayments(a);
    const right = countPayments(b);
    return left.count !== right.count || left.total !== right.total
      || (a?.students || []).length !== (b?.students || []).length;
  }

  async function applyNativeStudentLinks(options) {
    const schoolId = getCloudSchoolId();
    const url = withCloudSecret(`${getErpCloudApiBase()}?action=nativeStudents&schoolId=${encodeURIComponent(schoolId)}`);
    const res = await fetchWithRetry(url, { headers: cloudHeaders(), cache: 'no-store' });
    const data = await parseCloudResponse(res);
    if (!data.ok || !Array.isArray(data.students) || !data.students.length) {
      return { ok: true, applied: 0 };
    }
    if (typeof buildSchoolDataStoragePayload !== 'function' || typeof applySchoolDataStoragePayload !== 'function') {
      return { ok: false, error: 'ERP storage helpers missing.' };
    }

    const payload = buildSchoolDataStoragePayload();
    const byAdmission = new Map((payload.students || []).map((student) => [admissionKey(student), student]));
    let applied = 0;

    data.students.forEach((row) => {
      const key = String(row.admission_no || '').trim().toLowerCase();
      if (!key) return;
      const student = byAdmission.get(key);
      if (!student) return;
      const chatId = String(row.school_bot_chat_id || '').trim();
      const username = String(row.telegram_user_name || '').trim();
      if (chatId) {
        if (student.telegramChatId !== chatId || student.schoolBotChatId !== chatId) applied += 1;
        student.telegramChatId = chatId;
        student.schoolBotChatId = chatId;
        student.SchoolBotChatId = chatId;
      }
      if (username) {
        student.telegramUserName = username;
        student.TelegramUserName = username;
      }
      if (row.status) student.status = row.status;
    });

    if (applied) {
      applySchoolDataStoragePayload(payload);
      if (typeof saveSchoolDataToStorage === 'function') saveSchoolDataToStorage({ skipCloudPush: true });
    }
    return { ok: true, applied, count: data.students.length };
  }

  function cloudVersionUrl() {
    const schoolId = getCloudSchoolId();
    return withCloudSecret(`${getErpCloudApiBase()}?action=cloudVersion&schoolId=${encodeURIComponent(schoolId)}`);
  }

  /**
   * Ask the server for just the snapshot timestamp (~80 bytes) instead of
   * re-downloading the whole roster on every poll.
   * Returns true when a full pull is actually needed.
   */
  async function cloudSnapshotChanged() {
    try {
      const res = await fetchWithRetry(cloudVersionUrl(), { headers: cloudHeaders(), cache: 'no-store' });
      const data = await parseCloudResponse(res);
      if (!data || !data.ok || !data.savedAt) {
        // Older server without the probe — fall back to slow full polling.
        versionProbeSupported = false;
        return false;
      }
      versionProbeSupported = true;
      const known = String(localStorage.getItem(LS_LAST_CLOUD_AT) || '');
      return String(data.savedAt) !== known;
    } catch (err) {
      versionProbeSupported = false;
      return false;
    }
  }

  async function fetchCloudSnapshotRaw() {
    const res = await fetchWithRetry(cloudPullUrl(), { headers: cloudHeaders(), cache: 'no-store' });
    const data = await parseCloudResponse(res);
    if (!data.ok) throw new Error(data.error || 'Cloud pull failed.');
    if (!data.configured) return { ok: false, configured: false, error: data.error };
    return data;
  }

  async function fetchCloudSnapshot() {
    // Use boot prefetch when available (starts as soon as cloudSync.js loads)
    if (window._erpCloudPrefetchPromise && !window._erpCloudPrefetchConsumed) {
      window._erpCloudPrefetchConsumed = true;
      try {
        const prefetched = await window._erpCloudPrefetchPromise;
        window._erpCloudPrefetchPromise = null;
        if (prefetched) return prefetched;
      } catch (err) {
        window._erpCloudPrefetchPromise = null;
        console.warn('Cloud prefetch missed, fetching again:', err);
      }
    }
    return fetchCloudSnapshotRaw();
  }

  function peekDormantLocalSchoolPayload() {
    if (typeof window.peekLocalSchoolDataForCloudMigration === 'function') {
      return window.peekLocalSchoolDataForCloudMigration();
    }
    try {
      const raw = localStorage.getItem('MMM_SchoolData_v6');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.students) && parsed.students.length) return parsed;
    } catch (e) {}
    return null;
  }

  async function migrateLocalRosterToCloudOnce() {
    if (localStorage.getItem(LS_MIGRATED_FLAG) === '1') {
      return { ok: false, skipped: true, reason: 'already-migrated' };
    }
    const dormant = peekDormantLocalSchoolPayload();
    if (!dormant || !Array.isArray(dormant.students) || !dormant.students.length) {
      return { ok: false, skipped: true, reason: 'no-local' };
    }
    if (typeof applySchoolDataStoragePayload !== 'function') {
      return { ok: false, error: 'ERP storage helpers missing.' };
    }
    const applied = applySchoolDataStoragePayload(dormant);
    if (!applied) return { ok: false, error: 'Could not load local roster for migration.' };
    const pushed = await pushSchoolDataToCloud({ skipMergePull: true, payload: dormant });
    localStorage.setItem(LS_MIGRATED_FLAG, '1');
    if (typeof window.clearLocalSchoolDataAuthorityStores === 'function') {
      window.clearLocalSchoolDataAuthorityStores();
    }
    return {
      ok: true,
      migrated: true,
      studentCount: pushed.studentCount || dormant.students.length,
      savedAt: pushed.savedAt
    };
  }

  function cloudWipeUrl() {
    const schoolId = getCloudSchoolId();
    return withCloudSecret(`${getErpCloudApiBase()}?action=wipeRoster&schoolId=${encodeURIComponent(schoolId)}`);
  }

  async function wipeCloudRoster() {
    const res = await fetchWithRetry(cloudWipeUrl(), {
      method: 'POST',
      headers: { ...cloudHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ schoolId: getCloudSchoolId() })
    });
    const data = await parseCloudResponse(res);
    if (!data.ok) throw new Error(data.error || 'Cloud wipe failed.');
    return data;
  }

  async function applyEmptyCloudRoster(cloudPayload, snapshot, options) {
    const src = cloudPayload && typeof cloudPayload === 'object' ? cloudPayload : {};
    const payload = {
      ...src,
      students: [],
      savedAt: src.savedAt || (snapshot && snapshot.saved_at) || new Date().toISOString()
    };

    // Empty student roster must NEVER invent empty staff/teachers.
    // Missing arrays → keep what is already in memory (or last display cache).
    // That bug wiped real logins when students were cleared / snapshot missing.
    const memStaff = (typeof SchoolData !== 'undefined' && Array.isArray(SchoolData.staffUsers))
      ? SchoolData.staffUsers
      : null;
    const memTeachers = (typeof SchoolData !== 'undefined' && Array.isArray(SchoolData.teachers))
      ? SchoolData.teachers
      : null;
    if (Array.isArray(src.staffUsers)) {
      payload.staffUsers = src.staffUsers;
    } else if (memStaff && memStaff.length) {
      payload.staffUsers = memStaff;
    } else {
      delete payload.staffUsers;
    }
    if (Array.isArray(src.teachers)) {
      payload.teachers = src.teachers;
    } else if (memTeachers && memTeachers.length) {
      payload.teachers = memTeachers;
    } else {
      delete payload.teachers;
    }

    const applied = applySchoolDataStoragePayload(payload, { allowEmpty: true });
    if (!applied) {
      SchoolData.students = [];
      if (Array.isArray(payload.staffUsers)) SchoolData.staffUsers = payload.staffUsers;
      if (Array.isArray(payload.teachers)) SchoolData.teachers = payload.teachers;
    }
    if (typeof window.clearLocalSchoolDataAuthorityStores === 'function') {
      window.clearLocalSchoolDataAuthorityStores();
    }
    if (typeof window.saveCloudDisplayCache === 'function') {
      try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
    }
    window._erpCloudBootReady = true;
    window._erpCloudPushDisabled = false;
    window._erpCloudMemoryDirty = false;
    window._erpCloudLastPullError = '';
    if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
    refreshUiAfterCloudApply(options);
    return {
      ok: true,
      configured: true,
      applied: true,
      empty: true,
      studentCount: 0,
      staffCount: (SchoolData.staffUsers || []).length,
      message: 'Cloud roster is empty — ready for a fresh student upload.'
    };
  }

  async function pullSchoolDataFromCloud(options) {
    const force = !!(options && options.force);
    if (cloudSyncInFlight) return { ok: false, skipped: true };
    if (typeof buildSchoolDataStoragePayload !== 'function' || typeof applySchoolDataStoragePayload !== 'function') {
      return { ok: false, error: 'ERP storage helpers missing.' };
    }

    cloudSyncInFlight = true;
    try {
      const data = await fetchCloudSnapshot();
      if (!data.configured) return data;

      const snapshot = data.snapshot;
      const cloudPayload = snapshot && snapshot.payload;
      const snapshotCount = Array.isArray(cloudPayload?.students) ? cloudPayload.students.length : 0;

      // Empty roster is valid (user deleted students / fresh start). Never error, never auto-restore.
      if (snapshot && cloudPayload && snapshotCount === 0) {
        return await applyEmptyCloudRoster(cloudPayload, snapshot, options);
      }

      if (!snapshot || !cloudPayload) {
        // No snapshot row yet — also a valid empty start for cloud-only
        if (isCloudOnly()) {
          return await applyEmptyCloudRoster({ students: [], version: '2.1' }, null, options);
        }
        window._erpCloudBootReady = true;
        window._erpCloudPushDisabled = false;
        return { ok: true, configured: true, empty: true, message: 'No cloud snapshot yet. Upload students when ready.' };
      }

      const localPayload = buildSchoolDataStoragePayload();
      const cloudOnly = isCloudOnly();
      const memoryDirty = !!window._erpCloudMemoryDirty;

      // Cloud-only: replace memory with cloud. Do not union stale local students.
      // Exception: if the user already edited while a display-cache was showing,
      // keep this device's membership/edits and soft-merge fees from cloud.
      let merged;
      if (cloudOnly && memoryDirty) {
        merged = mergeSchoolPayloads(localPayload, cloudPayload, { localStudentsAuthoritative: true });
      } else if (cloudOnly) {
        merged = {
          ...cloudPayload,
          cancelledReceipts: mergeCancelledReceipts(localPayload.cancelledReceipts, cloudPayload.cancelledReceipts),
          savedAt: cloudPayload.savedAt || snapshot.saved_at || new Date().toISOString()
        };
        removeCancelledPayments(merged.students, merged.cancelledReceipts);
      } else {
        merged = mergeSchoolPayloads(localPayload, cloudPayload, { remoteStudentsAuthoritative: true });
      }

      const localFees = countPayments(localPayload);
      const cloudFees = countPayments(cloudPayload);
      const mergedFees = countPayments(merged);
      const localAt = Date.parse(localPayload.savedAt || '') || 0;
      const cloudAt = Date.parse(snapshot.saved_at || cloudPayload.savedAt || '') || 0;
      const lastKnownCloudAt = Date.parse(localStorage.getItem(LS_LAST_CLOUD_AT) || '') || 0;
      const neverSyncedThisDevice = !hasSyncedFromCloud();
      const cloudUpdatedSinceLastPull = cloudAt > lastKnownCloudAt;
      const cloudHasMoreFees = cloudFees.count > localFees.count || cloudFees.total > localFees.total;
      const localMissingFees = localFees.count === 0 && cloudFees.count > 0;
      const memoryEmpty = !(localPayload.students || []).length;

      const shouldApply = force
        || cloudOnly
        || memoryEmpty
        || neverSyncedThisDevice
        || cloudUpdatedSinceLastPull
        || cloudAt > localAt
        || cloudHasMoreFees
        || localMissingFees
        || payloadsDifferOnFees(localPayload, merged);

      if (!shouldApply) {
        return {
          ok: true,
          configured: true,
          skipped: true,
          localAt,
          cloudAt,
          localFees,
          cloudFees
        };
      }

      const applied = applySchoolDataStoragePayload(merged, {
        allowEmpty: !!(merged.students && merged.students.length === 0)
      });
      if (!applied) throw new Error('Cloud snapshot could not be applied.');
      if (typeof repairCrossDeviceStudentIdentityDrift === 'function') {
        repairCrossDeviceStudentIdentityDrift();
      }

      const cloudStamp = snapshot.saved_at || cloudPayload.savedAt || new Date().toISOString();
      localStorage.setItem(LS_LAST_PULL, cloudStamp);
      localStorage.setItem(LS_LAST_CLOUD_AT, cloudStamp);
      if (cloudOnly && typeof window.clearLocalSchoolDataAuthorityStores === 'function') {
        window.clearLocalSchoolDataAuthorityStores();
      }
      if (typeof window.saveCloudDisplayCache === 'function') {
        try { window.saveCloudDisplayCache(merged); } catch (e) { console.warn('display cache', e); }
      }
      window._erpCloudBootReady = true;
      window._erpCloudPushDisabled = false;
      window._erpCloudMemoryDirty = false;
      window._erpCloudLastPullError = '';
      if (typeof saveSchoolDataToStorage === 'function') saveSchoolDataToStorage({ skipCloudPush: true });

      // Hybrid only: push merged fees back. Cloud-only never re-uploads local-only ghosts.
      if (!cloudOnly && (payloadsDifferOnFees(merged, cloudPayload) || mergedFees.count > cloudFees.count)) {
        try {
          await pushSchoolDataToCloud({ skipMergePull: true, payload: merged });
        } catch (err) {
          console.warn('Cloud merge push failed:', err);
        }
      } else if (cloudOnly && memoryDirty) {
        try {
          await pushSchoolDataToCloud({ skipMergePull: true, payload: merged });
        } catch (err) {
          console.warn('Cloud dirty-boot push failed:', err);
        }
      }

      // Overlay Chat IDs after first paint — do not block UI on this second request
      setTimeout(() => {
        applyNativeStudentLinks({ silent: true }).catch((e) => console.warn('native links', e));
      }, 0);

      if (typeof window.setCloudLoadingOverlay === 'function') {
        window.setCloudLoadingOverlay(false);
      }

      refreshUiAfterCloudApply(options);
      return {
        ok: true,
        configured: true,
        applied: true,
        cloudOnly,
        studentCount: (merged.students || []).length,
        savedAt: cloudStamp,
        localFees,
        cloudFees,
        mergedFees
      };
    } finally {
      cloudSyncInFlight = false;
    }
  }

  async function pushSchoolDataToCloud(options) {
    if (typeof buildSchoolDataStoragePayload !== 'function') return { ok: false, error: 'ERP storage helpers missing.' };
    const schoolId = getCloudSchoolId();
    let payload = (options && options.payload) || buildSchoolDataStoragePayload();
    const cloudOnly = isCloudOnly();

    // Empty upload is allowed (fresh start). Server clears native leftovers.
    if (!Array.isArray(payload.students)) payload.students = [];

    // Hybrid: merge with current cloud so ₹0 PC cannot wipe ₹1900 phone.
    // Cloud-only: still soft-merge fees for admissions this device already has, so two
    // open PCs do not clobber each other — but never resurrect students from cloud
    // that this device deleted (localStudentsAuthoritative).
    if (!(options && options.skipMergePull) && payload.students.length > 0) {
      try {
        const remote = await fetchCloudSnapshot();
        if (remote.configured && remote.snapshot && remote.snapshot.payload) {
          const remoteCount = Array.isArray(remote.snapshot.payload.students)
            ? remote.snapshot.payload.students.length
            : 0;
          if (remoteCount > 0) {
            payload = mergeSchoolPayloads(payload, remote.snapshot.payload, { localStudentsAuthoritative: true });
            if (typeof applySchoolDataStoragePayload === 'function') {
              applySchoolDataStoragePayload(payload);
              if (typeof saveSchoolDataToStorage === 'function') {
                saveSchoolDataToStorage({ skipCloudPush: true });
              }
            }
          }
        }
      } catch (err) {
        console.warn('Cloud pre-push merge skipped:', err);
      }
    }
    const savedBy = (typeof getCurrentActiveUser === 'function' && getCurrentActiveUser()?.name) || 'ERP';
    const res = await fetchWithRetry(cloudPushUrl(), {
      method: 'POST',
      headers: { ...cloudHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ schoolId, payload, savedBy })
    });
    const data = await parseCloudResponse(res);
    if (!data.ok) throw new Error(data.error || 'Cloud push failed.');
    const stamp = data.savedAt || payload.savedAt || new Date().toISOString();
    localStorage.setItem(LS_LAST_CLOUD_AT, stamp);
    localStorage.setItem(LS_LAST_PULL, stamp);
    window._erpCloudLastPushAt = stamp;
    window._erpCloudLastPushCount = data.studentCount || (payload.students || []).length;
    window._erpCloudLastPushError = '';
    if (cloudOnly && typeof window.clearLocalSchoolDataAuthorityStores === 'function') {
      window.clearLocalSchoolDataAuthorityStores();
    }
    return data;
  }

  function scheduleCloudPush(delayMs) {
    if (window._erpCloudPushDisabled) return;
    // Cloud-only: never upload until the first cloud pull finished (prevents empty wipe)
    if (isCloudOnly() && !window._erpCloudBootReady) return;
    // Allow first upload even before a successful pull (fixes phone→PC fee mismatch)
    if (!getCloudSecret() && !(window._erpCloudServerConfig && window._erpCloudServerConfig.configured)) return;
    clearTimeout(cloudPushTimer);
    const wait = delayMs == null ? 600 : delayMs;
    cloudPushTimer = setTimeout(async () => {
      try {
        await pushSchoolDataToCloud();
        window._erpCloudLastPushError = '';
        window._erpCloudSyncState = 'live';
        if (typeof window.saveCloudDisplayCache === 'function' && typeof buildSchoolDataStoragePayload === 'function') {
          try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
        }
      } catch (err) {
        window._erpCloudLastPushError = err.message;
        window._erpCloudSyncState = 'error';
        console.warn('Cloud push failed:', err);
      }
    }, wait);
  }

  function cancelScheduledCloudPush() {
    clearTimeout(cloudPushTimer);
    cloudPushTimer = null;
  }

  /** Staff create/delete: cancel debounced merge-push, upload exact memory list, refresh cache. */
  async function pushStaffAuthorityToCloud() {
    cancelScheduledCloudPush();
    window._erpCloudMemoryDirty = true;
    const data = await pushSchoolDataToCloud({ skipMergePull: true });
    window._erpCloudMemoryDirty = false;
    if (typeof window.saveCloudDisplayCache === 'function' && typeof buildSchoolDataStoragePayload === 'function') {
      try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
    }
    return data;
  }

  async function pushStudentPhotoBatchToCloud(photos) {
    const schoolId = getCloudSchoolId();
    const savedBy = (typeof getCurrentActiveUser === 'function' && getCurrentActiveUser()?.name) || 'Bulk photo upload';
    const res = await fetchWithRetry(cloudPhotoPatchUrl(), {
      method: 'POST',
      headers: { ...cloudHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ schoolId, photos, savedBy })
    });
    const data = await parseCloudResponse(res);
    if (!data.ok) throw new Error(data.error || 'Photo cloud save failed.');
    if (!Number(data.patched) || !String(data.savedAt || '').trim()) {
      throw new Error('Photo API is not deployed on the server yet (got a fake OK). Use assets folder upload or redeploy api/erp-cloud.js.');
    }
    return data;
  }

  async function pushStudentPhotoStorageBatchToCloud(photos) {
    const schoolId = getCloudSchoolId();
    const savedBy = (typeof getCurrentActiveUser === 'function' && getCurrentActiveUser()?.name) || 'Bulk photo upload';
    const res = await fetchWithRetry(cloudPhotoStorageUrl(), {
      method: 'POST',
      headers: { ...cloudHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ schoolId, photos, savedBy })
    });
    const data = await parseCloudResponse(res);
    if (!data.ok) throw new Error(data.error || 'Photo storage upload failed.');
    if (!Number(data.patched) || !String(data.savedAt || '').trim() || !data.storage) {
      throw new Error('Photo storage API is not deployed yet. Create the Supabase bucket and redeploy api/erp-cloud.js.');
    }
    return data;
  }

  async function pushPhotoImportFromUrlsBatch(items, cookie) {
    const schoolId = getCloudSchoolId();
    const savedBy = (typeof getCurrentActiveUser === 'function' && getCurrentActiveUser()?.name) || 'Old ERP photo import';
    const res = await fetchWithRetry(cloudPhotoImportUrl(), {
      method: 'POST',
      headers: { ...cloudHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ schoolId, items, cookie: cookie || '', savedBy })
    });
    const data = await parseCloudResponse(res);
    if (!data.ok) throw new Error(data.error || 'Photo import failed.');
    if (!Number(data.imported || data.patched) || !String(data.savedAt || '').trim()) {
      throw new Error('Photo import API is not deployed yet. Redeploy api/erp-cloud.js on Vercel.');
    }
    return data;
  }

  /** Import photos from old ERP URLs (CSV manifest) into Supabase Storage. */
  async function pushBulkPhotoImportFromUrls(importRows, cookie) {
    const rows = Array.isArray(importRows) ? importRows.filter(row => row?.admissionNo && row?.url) : [];
    if (!rows.length) throw new Error('No photo URLs to import.');

    cancelScheduledCloudPush();
    window._erpCloudMemoryDirty = true;
    window._erpCloudSyncState = 'syncing';

    const BATCH_SIZE = 20;
    let imported = 0;
    let savedAt = '';
    const allUploaded = [];
    const allFailed = [];

    try {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE).map(row => ({
          admissionNo: row.admissionNo,
          url: row.url
        }));
        const result = await pushPhotoImportFromUrlsBatch(batch, cookie);
        const uploaded = Array.isArray(result.uploaded) ? result.uploaded : [];
        uploaded.forEach((item) => {
          const key = String(item.admissionNo || '').trim().toLowerCase();
          const student = typeof findStudentByAdmissionNo === 'function'
            ? findStudentByAdmissionNo(item.admissionNo)
            : (SchoolData.students || []).find(s => String(s.admissionNo || '').trim().toLowerCase() === key);
          if (student && item.photoUrl) {
            student.photo = item.photoUrl;
            student.photoDataUrl = item.photoUrl;
          }
        });
        allUploaded.push(...uploaded);
        if (Array.isArray(result.failed)) allFailed.push(...result.failed);
        imported += Number(result.imported || result.patched || uploaded.length);
        savedAt = result.savedAt || savedAt;
      }

      if (typeof saveSchoolDataToStorage === 'function') {
        saveSchoolDataToStorage({ skipCloudPush: true });
      }
      if (savedAt) {
        localStorage.setItem(LS_LAST_CLOUD_AT, savedAt);
        localStorage.setItem(LS_LAST_PULL, savedAt);
        window._erpCloudLastPushAt = savedAt;
      }
      window._erpCloudLastPushCount = imported;
      window._erpCloudLastPushError = '';
      window._erpCloudSyncState = 'live';

      if (typeof window.saveCloudDisplayCache === 'function' && typeof buildSchoolDataStoragePayload === 'function') {
        try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
      }

      return { ok: true, imported, savedAt, uploaded: allUploaded, failed: allFailed, storage: true };
    } catch (err) {
      window._erpCloudLastPushError = err.message;
      window._erpCloudSyncState = 'error';
      throw err;
    } finally {
      window._erpCloudMemoryDirty = false;
    }
  }

  /** Option C — upload images to Supabase Storage; cloud roster stores public URLs only. */
  async function pushBulkStudentPhotosToSupabaseStorage(photoRows) {
    const rows = Array.isArray(photoRows) ? photoRows.filter(row => row?.student && row?.dataUrl) : [];
    if (!rows.length) throw new Error('No photos to save.');

    cancelScheduledCloudPush();
    window._erpCloudMemoryDirty = true;
    window._erpCloudSyncState = 'syncing';

    const BATCH_SIZE = 25;
    let patched = 0;
    let savedAt = '';

    try {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE).map(row => ({
          admissionNo: row.student.admissionNo || row.student.AdmissionNo,
          photo: row.dataUrl,
          photoDataUrl: row.dataUrl
        }));
        const result = await pushStudentPhotoStorageBatchToCloud(batch);
        const uploaded = Array.isArray(result.uploaded) ? result.uploaded : [];
        uploaded.forEach((item) => {
          const key = String(item.admissionNo || '').trim().toLowerCase();
          const row = rows.find(r => String(r.student?.admissionNo || '').trim().toLowerCase() === key);
          if (!row || !item.photoUrl) return;
          row.student.photo = item.photoUrl;
          row.student.photoDataUrl = item.photoUrl;
        });
        patched += Number(result.patched || uploaded.length);
        savedAt = result.savedAt || savedAt;
      }

      if (typeof saveSchoolDataToStorage === 'function') {
        saveSchoolDataToStorage({ skipCloudPush: true });
      }
      if (savedAt) {
        localStorage.setItem(LS_LAST_CLOUD_AT, savedAt);
        localStorage.setItem(LS_LAST_PULL, savedAt);
        window._erpCloudLastPushAt = savedAt;
      }
      window._erpCloudLastPushCount = patched;
      window._erpCloudLastPushError = '';
      window._erpCloudSyncState = 'live';

      if (typeof window.saveCloudDisplayCache === 'function' && typeof buildSchoolDataStoragePayload === 'function') {
        try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
      }

      return { ok: true, patched, savedAt, storage: true };
    } catch (err) {
      window._erpCloudLastPushError = err.message;
      window._erpCloudSyncState = 'error';
      throw err;
    } finally {
      window._erpCloudMemoryDirty = false;
    }
  }

  /** Save bulk-uploaded photos in small batches so refresh keeps them. */
  async function pushBulkStudentPhotosToCloud(photoRows) {
    const rows = Array.isArray(photoRows) ? photoRows.filter(row => row?.student && row?.dataUrl) : [];
    if (!rows.length) throw new Error('No photos to save.');

    cancelScheduledCloudPush();
    window._erpCloudMemoryDirty = true;
    window._erpCloudSyncState = 'syncing';

    const BATCH_SIZE = 25;
    let patched = 0;
    let savedAt = '';

    try {
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE).map(row => ({
          admissionNo: row.student.admissionNo || row.student.AdmissionNo,
          photo: row.dataUrl,
          photoDataUrl: row.dataUrl
        }));
        try {
          const result = await pushStudentPhotoBatchToCloud(batch);
          batch.forEach((item) => {
            const key = String(item.admissionNo || '').trim().toLowerCase();
            const row = rows.find(r => String(r.student?.admissionNo || '').trim().toLowerCase() === key);
            if (row) {
              row.student.photo = item.photo;
              row.student.photoDataUrl = item.photo;
            }
          });
          patched += Number(result.patched || batch.length);
          savedAt = result.savedAt || savedAt;
        } catch (batchErr) {
          const msg = String(batchErr.message || batchErr);
          const patchUnavailable = /404|not found|unknown|Method not allowed/i.test(msg);
          if (patchUnavailable && typeof pushStaffAuthorityToCloud === 'function') {
            const fallback = await pushStaffAuthorityToCloud();
            patched = rows.length;
            savedAt = fallback?.savedAt || savedAt;
            break;
          }
          throw batchErr;
        }
      }

      if (savedAt) {
        localStorage.setItem(LS_LAST_CLOUD_AT, savedAt);
        localStorage.setItem(LS_LAST_PULL, savedAt);
        window._erpCloudLastPushAt = savedAt;
      }
      window._erpCloudLastPushCount = patched;
      window._erpCloudLastPushError = '';
      window._erpCloudSyncState = 'live';

      if (typeof window.saveCloudDisplayCache === 'function' && typeof buildSchoolDataStoragePayload === 'function') {
        try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
      }

      return { ok: true, patched, savedAt };
    } catch (err) {
      window._erpCloudLastPushError = err.message;
      window._erpCloudSyncState = 'error';
      throw err;
    } finally {
      window._erpCloudMemoryDirty = false;
    }
  }

  function flushCloudPushNow() {
    scheduleCloudPush(0);
  }

  function refreshUiAfterCloudApply(options) {
    if (typeof handleRouting !== 'function') return;
    if (!options?.silent) {
      handleRouting();
      return;
    }
    // Silent live sync: still refresh fee/receipt/users screens so staff Telegram links appear
    const hash = String(window.location.hash || '').toLowerCase();
    if (/receipt|fee|dashboard|student|backup|users/.test(hash)) {
      handleRouting();
    }
  }

  function wrapSaveSchoolDataToStorage() {
    if (typeof saveSchoolDataToStorage !== 'function' || saveSchoolDataToStorage._cloudWrapped) return;
    const original = saveSchoolDataToStorage;
    function wrappedSave(options) {
      const opts = Object.assign({}, options || {});
      if (opts.skipCloudPush) opts.silent = true;
      else if (isCloudOnly() && !opts.skipCloudPush) window._erpCloudMemoryDirty = true;
      const result = original.call(this, opts);
      if (!opts.skipCloudPush) scheduleCloudPush();
      return result;
    }
    wrappedSave._cloudWrapped = true;
    window.saveSchoolDataToStorage = wrappedSave;
    // Some browsers keep the lexical global binding — force both
    try { saveSchoolDataToStorage = wrappedSave; } catch (_) {}
  }

  function ensureCloudCredentials() {
    const schoolId = String(window.ERP_CLOUD_SCHOOL_ID || 'mmm-jhs').trim() || 'mmm-jhs';
    const secret = String(window.ERP_CLOUD_SECRET || '').trim();
    if (schoolId || secret) setCloudCredentials(schoolId, secret);
  }

  function startCloudPrefetch() {
    if (window._erpCloudPrefetchPromise || window.ERP_CLOUD_ONLY === false) return;
    ensureCloudCredentials();
    window._erpCloudPrefetchConsumed = false;
    window._erpCloudPrefetchPromise = fetchCloudSnapshotRaw().catch((err) => {
      console.warn('Cloud prefetch failed:', err);
      return null;
    });
  }

  async function initCloudSync() {
    ensureCloudCredentials();
    wrapSaveSchoolDataToStorage();
    if (isCloudOnly()) {
      // Block uploads until pull finishes; display-cache may already be on screen
      if (!window._erpCloudBootReady) window._erpCloudPushDisabled = true;
      if (typeof window.setCloudLoadingOverlay === 'function') {
        const hasStudents = Array.isArray(window.SchoolData?.students) && window.SchoolData.students.length > 0;
        window.setCloudLoadingOverlay(true, hasStudents ? 'Updating from cloud…' : 'Loading school data from cloud…');
      }
    }
    startCloudPrefetch();
    const cfg = await fetchCloudConfig();
    window._erpCloudServerConfig = cfg;
    window._erpCloudOnly = isCloudOnly();
    if (!cfg.configured) {
      console.info('ERP cloud sync: server not configured yet (Supabase env on Render).');
      if (isCloudOnly() && typeof showNotification === 'function') {
        showNotification('Cloud ERP is required but server is not configured. Contact admin.', 'error');
      }
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
      return { ok: false, configured: false };
    }
    if (cfg.requiresSecret && !getCloudSecret() && !cfg.siteTrusted) {
      window._erpCloudLastPullError = 'Admin: set window.ERP_CLOUD_SECRET in js/erp-cloud-config.js';
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
      return { ok: false, configured: true, error: 'Cloud secret not set in website config.' };
    }
    try {
      // Cloud-only: replace from Supabase. Hybrid: force-merge so stale PC picks up fees.
      const pull = await pullSchoolDataFromCloud({ silent: true, force: true });
      window._erpCloudLastPullError = '';
      // If a parallel prefetch held the lock, do not leave boot hanging forever.
      if (pull && pull.skipped && isCloudOnly()) {
        window._erpCloudBootReady = true;
        window._erpCloudPushDisabled = false;
      }
      if (pull.applied && typeof showNotification === 'function') {
        if (pull.migrated) {
          showNotification(`Moved ${pull.studentCount} students from this browser into cloud. Cloud is now the only copy.`, 'success');
        } else if (pull.empty || pull.studentCount === 0) {
          showNotification('Cloud ready — student list is empty. Upload your fresh roster when ready.', 'info');
        } else if (!pull.silentToast) {
          const feeNote = pull.mergedFees && pull.mergedFees.total
            ? ` · fees ₹${Number(pull.mergedFees.total).toLocaleString('en-IN')}`
            : '';
          const mode = isCloudOnly() ? 'Cloud ERP' : 'School data synced';
          const alreadyShown = Array.isArray(window.SchoolData?.students)
            && window.SchoolData.students.length === pull.studentCount;
          if (!(isCloudOnly() && alreadyShown)) {
            showNotification(`${mode} (${pull.studentCount} students${feeNote}).`, 'success');
          }
        }
      }
    } catch (err) {
      console.warn('Initial cloud pull failed:', err);
      window._erpCloudLastPullError = err.message;
      if (isCloudOnly()) {
        const hasCache = Array.isArray(window.SchoolData?.students) && window.SchoolData.students.length > 0;
        if (!hasCache) {
          const msg = String(err.message || '');
          if (/could not be applied|0 students|snapshot/i.test(msg)) {
            SchoolData.students = [];
            window._erpCloudBootReady = true;
            window._erpCloudPushDisabled = false;
            window._erpCloudLastPullError = '';
            if (typeof showNotification === 'function') {
              showNotification('Cloud ready — student list is empty. Upload your fresh roster when ready.', 'info');
            }
          } else if (typeof showNotification === 'function') {
            showNotification(`Cloud ERP failed to load: ${err.message}`, 'error');
          }
        } else if (typeof showNotification === 'function') {
          showNotification('Cloud refresh failed — showing last cloud copy from this device.', 'warning');
          window._erpCloudBootReady = true;
          window._erpCloudPushDisabled = false;
        }
      }
    } finally {
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
    }

    clearInterval(cloudPollTimer);
    // Poll the timestamp, not the roster. A full download happens only when the
    // cloud copy actually changed — skipped while this device has unsaved edits.
    cloudPollTimer = setInterval(async () => {
      if (window._erpCloudMemoryDirty) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      if (versionProbeSupported) {
        const changed = await cloudSnapshotChanged();
        if (!changed) return;
        pullSchoolDataFromCloud({ silent: true }).catch(() => {});
        return;
      }

      // No probe on the server: pull rarely instead of every tick.
      fallbackPollTicks += 1;
      if (fallbackPollTicks < FALLBACK_PULL_EVERY_TICKS) return;
      fallbackPollTicks = 0;
      pullSchoolDataFromCloud({ silent: true }).catch(() => {});
    }, CLOUD_POLL_MS);

    // Tab back in front: quick timestamp check only (never a blind full pull).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (window._erpCloudMemoryDirty) return;
      if (!versionProbeSupported) return;
      cloudSnapshotChanged()
        .then((changed) => {
          if (changed) pullSchoolDataFromCloud({ silent: true }).catch(() => {});
        })
        .catch(() => {});
    });

    return { ok: true, configured: true, cloudOnly: isCloudOnly() };
  }

  function getCloudSyncStatusText() {
    const cfg = window._erpCloudServerConfig || {};
    const mode = isCloudOnly() ? 'Cloud-only (100%)' : 'Hybrid (local+cloud)';
    if (cfg.error) return `${mode}: ${cfg.error}`;
    if (!cfg.configured) return `${mode}: not configured on server.`;
    const push = window._erpCloudLastPushAt ? `Last upload: ${window._erpCloudLastPushAt}` : 'Not uploaded yet';
    const err = window._erpCloudLastPushError || window._erpCloudLastPullError;
    const sync = versionProbeSupported
      ? `Auto-sync every ${CLOUD_POLL_MS / 1000}s (downloads only on change)`
      : `Auto-sync every ${(CLOUD_POLL_MS * FALLBACK_PULL_EVERY_TICKS) / 1000}s`;
    return err ? `${mode} · ${push} | Error: ${err}` : `${mode} · ${push} · ${sync}`;
  }

  window.isErpCloudOnly = isCloudOnly;
  window.isRealStudentPhoto = isRealStudentPhoto;
  window.preferStudentPhoto = preferStudentPhoto;
  window.getCloudSchoolId = getCloudSchoolId;
  window.getCloudSecret = getCloudSecret;
  window.setCloudCredentials = setCloudCredentials;
  window.getErpCloudApiBase = getErpCloudApiBase;
  window.initCloudSync = initCloudSync;
  window.pullSchoolDataFromCloud = pullSchoolDataFromCloud;
  window.pushSchoolDataToCloud = pushSchoolDataToCloud;
  window.applyNativeStudentLinks = applyNativeStudentLinks;
  window.scheduleCloudPush = scheduleCloudPush;
  window.cancelScheduledCloudPush = cancelScheduledCloudPush;
  window.pushStaffAuthorityToCloud = pushStaffAuthorityToCloud;
  window.pushBulkStudentPhotosToCloud = pushBulkStudentPhotosToCloud;
  window.pushBulkStudentPhotosToSupabaseStorage = pushBulkStudentPhotosToSupabaseStorage;
  window.pushBulkPhotoImportFromUrls = pushBulkPhotoImportFromUrls;
  window.flushCloudPushNow = flushCloudPushNow;
  window.getCloudSyncStatusText = getCloudSyncStatusText;
  window.mergeSchoolPayloadsForCloud = mergeSchoolPayloads;
  window.migrateLocalRosterToCloudOnce = migrateLocalRosterToCloudOnce;
  window.startCloudPrefetch = startCloudPrefetch;
  window.wipeCloudRoster = wipeCloudRoster;

  // Start download immediately — do not wait for DOMContentLoaded
  try { startCloudPrefetch(); } catch (e) {}
})();
