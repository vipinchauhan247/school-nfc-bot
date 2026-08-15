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

  function getErpCloudApiBase() {
    if (typeof getMmmjhsBotApiBase === 'function') return getMmmjhsBotApiBase();
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      const port = String(window.MMMJHS_BOT_LOCAL_PORT || '8085').trim();
      return `${window.location.protocol}//${host}:${port}/api/mmmjhs-bot`;
    }
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
      try {
        return await fetch(url, options);
      } catch (err) {
        lastErr = err;
        if (attempt < max) await new Promise((resolve) => setTimeout(resolve, 3500));
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
        throw new Error('Cloud API not found on Render (404). Redeploy render-server.js + api/erp-cloud.js.');
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

  function mergeStudent(localStudent, remoteStudent) {
    const L = localStudent || {};
    const R = remoteStudent || {};
    const base = { ...R, ...L };
    return {
      ...base,
      name: resolveStudentName(L, R),
      parentName: preferText(L.parentName, R.parentName),
      phone: preferText(L.phone, R.phone),
      cardUid: preferText(L.cardUid || L.nfcUid, R.cardUid || R.nfcUid) || L.cardUid || R.cardUid,
      nfcUid: preferText(L.nfcUid, R.nfcUid) || L.nfcUid || R.nfcUid,
      telegramChatId: preferText(L.telegramChatId, R.telegramChatId) || L.telegramChatId || R.telegramChatId,
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

    return {
      ...olderMeta,
      ...newerMeta,
      version: newerMeta.version || olderMeta.version || '2.0',
      savedAt: new Date().toISOString(),
      students,
      cancelledReceipts,
      classes: (newerMeta.classes && newerMeta.classes.length) ? newerMeta.classes : (olderMeta.classes || []),
      staffUsers: (newerMeta.staffUsers && newerMeta.staffUsers.length) ? newerMeta.staffUsers : (olderMeta.staffUsers || []),
      schoolProfile: newerMeta.schoolProfile || olderMeta.schoolProfile,
      signatures: newerMeta.signatures || olderMeta.signatures,
      teachers: (newerMeta.teachers && newerMeta.teachers.length) ? newerMeta.teachers : (olderMeta.teachers || []),
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
      if (!snapshot || !snapshot.payload) {
        if (isCloudOnly()) {
          try {
            const migrated = await migrateLocalRosterToCloudOnce();
            if (migrated.migrated) {
              window._erpCloudBootReady = true;
              window._erpCloudPushDisabled = false;
              window._erpCloudMemoryDirty = false;
              if (typeof window.saveCloudDisplayCache === 'function' && typeof buildSchoolDataStoragePayload === 'function') {
                try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
              }
              if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
              refreshUiAfterCloudApply(options);
              return {
                ok: true,
                configured: true,
                applied: true,
                migrated: true,
                studentCount: migrated.studentCount,
                message: 'Uploaded previous browser data to cloud (one-time). Cloud is now the source of truth.'
              };
            }
          } catch (err) {
            console.warn('Cloud-only local migrate failed:', err);
          }
        }
        window._erpCloudBootReady = true;
        window._erpCloudPushDisabled = false;
        return { ok: true, configured: true, empty: true, message: 'No cloud snapshot yet. Upload from phone/PC that has correct fees.' };
      }

      const localPayload = buildSchoolDataStoragePayload();
      const cloudPayload = snapshot.payload;
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

      const applied = applySchoolDataStoragePayload(merged);
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

    // Hybrid: merge with current cloud so ₹0 PC cannot wipe ₹1900 phone.
    // Cloud-only: still soft-merge fees for admissions this device already has, so two
    // open PCs do not clobber each other — but never resurrect students from cloud
    // that this device deleted (localStudentsAuthoritative).
    if (!(options && options.skipMergePull)) {
      try {
        const remote = await fetchCloudSnapshot();
        if (remote.configured && remote.snapshot && remote.snapshot.payload) {
          payload = mergeSchoolPayloads(payload, remote.snapshot.payload, { localStudentsAuthoritative: true });
          if (typeof applySchoolDataStoragePayload === 'function') {
            applySchoolDataStoragePayload(payload);
            if (typeof saveSchoolDataToStorage === 'function') {
              saveSchoolDataToStorage({ skipCloudPush: true });
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

  function flushCloudPushNow() {
    scheduleCloudPush(0);
  }

  function refreshUiAfterCloudApply(options) {
    if (typeof handleRouting !== 'function') return;
    if (!options?.silent) {
      handleRouting();
      return;
    }
    // Silent live sync: still refresh fee/receipt screens so other PCs see new slips
    const hash = String(window.location.hash || '').toLowerCase();
    if (/receipt|fee|dashboard|student|backup/.test(hash)) {
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
      if (pull.applied && typeof showNotification === 'function') {
        if (pull.migrated) {
          showNotification(`Moved ${pull.studentCount} students from this browser into cloud. Cloud is now the only copy.`, 'success');
        } else if (!pull.silentToast) {
          const feeNote = pull.mergedFees && pull.mergedFees.total
            ? ` · fees ₹${Number(pull.mergedFees.total).toLocaleString('en-IN')}`
            : '';
          const mode = isCloudOnly() ? 'Cloud ERP' : 'School data synced';
          // Quiet toast when display-cache already showed the same roster
          const alreadyShown = Array.isArray(window.SchoolData?.students)
            && window.SchoolData.students.length === pull.studentCount;
          if (!(isCloudOnly() && alreadyShown)) {
            showNotification(`${mode} (${pull.studentCount} students${feeNote}).`, 'success');
          }
        }
      } else if (pull.empty && isCloudOnly() && typeof showNotification === 'function') {
        showNotification(pull.message || 'Cloud is empty. Add students — they will save to cloud only.', 'warning');
      }
    } catch (err) {
      console.warn('Initial cloud pull failed:', err);
      window._erpCloudLastPullError = err.message;
      if (isCloudOnly()) {
        const hasCache = Array.isArray(window.SchoolData?.students) && window.SchoolData.students.length > 0;
        if (!hasCache) {
          const recovered = typeof window.loadEmergencyLocalSchoolCache === 'function'
            && window.loadEmergencyLocalSchoolCache();
          if (recovered && typeof showNotification === 'function') {
            showNotification('Cloud unreachable — emergency local cache loaded. Reconnect soon; do not trust this copy long-term.', 'warning');
          } else if (typeof showNotification === 'function') {
            showNotification(`Cloud ERP failed to load: ${err.message}`, 'error');
          }
        } else if (typeof showNotification === 'function') {
          showNotification('Cloud refresh failed — showing last cloud copy from this device.', 'warning');
          // Allow working from display-cache until reconnect
          window._erpCloudBootReady = true;
          window._erpCloudPushDisabled = false;
        }
      }
    } finally {
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
    }

    clearInterval(cloudPollTimer);
    // Live poll ~every 5s so PC1 / PC2 / laptop see new receipts without manual Download
    cloudPollTimer = setInterval(() => {
      pullSchoolDataFromCloud({ silent: true }).catch(() => {});
    }, 5000);

    // Also sync when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        pullSchoolDataFromCloud({ silent: true }).catch(() => {});
      }
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
    return err ? `${mode} · ${push} | Error: ${err}` : `${mode} · ${push} · Auto-sync every 5s`;
  }

  window.isErpCloudOnly = isCloudOnly;
  window.getCloudSchoolId = getCloudSchoolId;
  window.getCloudSecret = getCloudSecret;
  window.setCloudCredentials = setCloudCredentials;
  window.getErpCloudApiBase = getErpCloudApiBase;
  window.initCloudSync = initCloudSync;
  window.pullSchoolDataFromCloud = pullSchoolDataFromCloud;
  window.pushSchoolDataToCloud = pushSchoolDataToCloud;
  window.applyNativeStudentLinks = applyNativeStudentLinks;
  window.scheduleCloudPush = scheduleCloudPush;
  window.flushCloudPushNow = flushCloudPushNow;
  window.getCloudSyncStatusText = getCloudSyncStatusText;
  window.mergeSchoolPayloadsForCloud = mergeSchoolPayloads;
  window.migrateLocalRosterToCloudOnce = migrateLocalRosterToCloudOnce;
  window.startCloudPrefetch = startCloudPrefetch;

  // Start download immediately — do not wait for DOMContentLoaded
  try { startCloudPrefetch(); } catch (e) {}
})();
