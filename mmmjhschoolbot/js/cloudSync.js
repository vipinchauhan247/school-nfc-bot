/**
 * Shared ERP cloud sync (Supabase via the Vercel same-origin /api endpoint).
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
  const LS_DISPLAY_CACHE_AT = 'MMM_ERP_CLOUD_DISPLAY_CACHE_AT';
  const LS_MIGRATED_FLAG = 'MMM_ERP_CLOUD_ONLY_MIGRATED';

  let cloudPushTimer = null;
  let cloudPollTimer = null;
  let cloudSyncInFlight = false;
  let confirmedSaveChain = Promise.resolve();

  // Live-sync tuning. The poll itself only fetches a timestamp, so a short
  // interval stays cheap; the roster is downloaded only when it changed.
  const CLOUD_POLL_MS = 15000;
  const FALLBACK_PULL_EVERY_TICKS = 6; // ~90s, used only if the server has no probe
  let versionProbeSupported = true;
  let fallbackPollTicks = 0;

  function normalizeSubjectsList(subjects) {
    if (Array.isArray(subjects)) return subjects.filter((s) => s && typeof s === 'object');
    if (subjects && typeof subjects === 'object') {
      return Object.values(subjects).filter((s) => s && typeof s === 'object' && (s.code || s.name || s.id));
    }
    return [];
  }

  function normalizePeriodSettingsList(periodSettings) {
    if (Array.isArray(periodSettings) && periodSettings.length) {
      return periodSettings.filter((p) => p && typeof p === 'object');
    }
    if (periodSettings && typeof periodSettings === 'object') {
      const vals = Object.values(periodSettings).filter((p) => p && typeof p === 'object' && (p.name || p.periodNo));
      if (vals.length) return vals;
    }
    return [];
  }

  function mergePeriodSettingsLists(localPeriods, remotePeriods) {
    const local = normalizePeriodSettingsList(localPeriods);
    const remote = normalizePeriodSettingsList(remotePeriods);
    return remote.length ? remote : local;
  }

  function subjectMergeKey(subject) {
    return String(subject?.code || subject?.id || subject?.name || '').trim().toLowerCase();
  }

  /** Never let an empty cloud array wipe subjects saved on another PC. */
    function mergeExamSchedulesLists(localSched, remoteSched) {
    const local = Array.isArray(localSched) ? localSched : [];
    const remote = Array.isArray(remoteSched) ? remoteSched : [];
    if (!remote.length) return local;
    if (!local.length) return remote;
    const byKey = new Map();
    const makeKey = (r) => `${String(r.className || '').trim()}_${String(r.term || '').trim()}_${String(r.section || 'ALL').trim()}_${String(r.subject || '').trim().toLowerCase()}`;
    local.forEach(r => { byKey.set(makeKey(r), r); });
    remote.forEach(r => { byKey.set(makeKey(r), { ...(byKey.get(makeKey(r)) || {}), ...r }); });
    return Array.from(byKey.values());
  }

function mergeSubjectsLists(localSubjects, remoteSubjects) {
    const local = normalizeSubjectsList(localSubjects);
    const remote = normalizeSubjectsList(remoteSubjects);
    if (!remote.length) return local;
    if (!local.length) return remote;
    const byKey = new Map();
    local.forEach((item) => {
      const key = subjectMergeKey(item);
      if (key) byKey.set(key, item);
    });
    remote.forEach((item) => {
      const key = subjectMergeKey(item);
      if (!key) return;
      byKey.set(key, { ...(byKey.get(key) || {}), ...item });
    });
    return Array.from(byKey.values());
  }

  function staffUserMergeKey(user) {
    return String(user?.username || user?.id || '').trim().toLowerCase();
  }

  function mergeStaffUsersLists(localUsers, remoteUsers) {
    const local = Array.isArray(localUsers) ? localUsers.filter(Boolean) : [];
    const remote = Array.isArray(remoteUsers) ? remoteUsers.filter(Boolean) : [];
    if (!remote.length) return local;
    if (!local.length) return remote;
    const byKey = new Map();
    // Index remote first
    remote.forEach((item) => {
      const key = staffUserMergeKey(item);
      if (key) byKey.set(key, { ...item });
    });
    // Local overrides remote for all active edits
    local.forEach((item) => {
      const key = staffUserMergeKey(item);
      if (!key) return;
      const prev = byKey.get(key) || {};
      const mappings = (Array.isArray(item.subjectMappings) && item.subjectMappings.length)
        ? item.subjectMappings
        : (Array.isArray(prev.subjectMappings) && prev.subjectMappings.length ? prev.subjectMappings : []);
      const classes = (Array.isArray(item.assignedClasses) && item.assignedClasses.length)
        ? item.assignedClasses
        : (prev.assignedClasses || []);
      const sub = item.assignedSubject || prev.assignedSubject || '';
      byKey.set(key, {
        ...prev,
        ...item,
        password: item.password || prev.password || '',
        subjectMappings: mappings,
        assignedClasses: classes,
        assignedSubject: sub
      });
    });
    return Array.from(byKey.values());
  }

  function teacherMergeKey(teacher) {
    return String(teacher?.id || teacher?.name || '').trim().toLowerCase();
  }

  function teacherMergeKey(teacher) {
    return String(teacher?.name || teacher?.username || teacher?.id || '').trim().toLowerCase();
  }

        function mergeClassesLists(localClasses, remoteClasses) {
    const local = Array.isArray(localClasses) ? localClasses.filter(Boolean) : [];
    const remote = Array.isArray(remoteClasses) ? remoteClasses.filter(Boolean) : [];
    if (!remote.length) return local;
    if (!local.length) return remote;
    const byName = new Map();

    // Start with remote as baseline
    remote.forEach(c => {
      const key = String(c.name || c.id || '').trim().toLowerCase();
      if (key) byName.set(key, { ...c });
    });

    // Merge local on top
    local.forEach(c => {
      const key = String(c.name || c.id || '').trim().toLowerCase();
      if (!key) return;
      if (!byName.has(key)) {
        byName.set(key, { ...c });
      } else {
        const prev = byName.get(key);
        const mergedSectionTeachers = {};
        const remoteST = prev.sectionTeachers || {};
        const localST = c.sectionTeachers || {};
        const allSecs = Array.from(new Set([...Object.keys(remoteST), ...Object.keys(localST)]));
        allSecs.forEach(sec => {
          // If local has a non-empty teacher, LOCAL WINS. If local is empty, keep remote.
          const locVal = String(localST[sec] || '').trim();
          const remVal = String(remoteST[sec] || '').trim();
          mergedSectionTeachers[sec] = locVal || remVal || '';
        });
        const locT = String(c.teacher || localST['A'] || '').trim();
        const remT = String(prev.teacher || remoteST['A'] || '').trim();
        const teacher = locT || remT || Object.values(mergedSectionTeachers).find(v => v) || '';
        byName.set(key, {
          ...prev,
          ...c,
          teacher,
          sectionTeachers: mergedSectionTeachers
        });
      }
    });

    return Array.from(byName.values());
  }


function mergeTeachersLists(localTeachers, remoteTeachers) {
    const local = Array.isArray(localTeachers) ? localTeachers.filter(Boolean) : [];
    const remote = Array.isArray(remoteTeachers) ? remoteTeachers.filter(Boolean) : [];
    const combined = [...local, ...remote];
    const byName = new Map();
    combined.forEach((item) => {
      const key = teacherMergeKey(item);
      if (!key) return;
      if (!byName.has(key)) {
        byName.set(key, { ...item });
      } else {
        const prev = byName.get(key);
        const mergedClasses = Array.from(new Set([...(prev.classes || []), ...(item.classes || []), ...(prev.classesTaught || []), ...(item.classesTaught || [])]));
        const sig = item.signatureDataUrl || item.signature || prev.signatureDataUrl || prev.signature || '';
        const photo = item.photo || prev.photo || '';
        const mappings = (Array.isArray(item.subjectMappings) && item.subjectMappings.length)
          ? item.subjectMappings
          : (Array.isArray(prev.subjectMappings) && prev.subjectMappings.length ? prev.subjectMappings : []);
        byName.set(key, {
          ...prev,
          ...item,
          classes: mergedClasses,
          classesTaught: mergedClasses,
          signatureDataUrl: sig,
          signature: sig,
          photo: photo,
          subjectMappings: mappings
        });
      }
    });
    return Array.from(byName.values());
  }

  function mergePlainObjectsPreferNonEmpty(localObj, remoteObj) {
    const local = localObj && typeof localObj === 'object' ? localObj : {};
    const remote = remoteObj && typeof remoteObj === 'object' ? remoteObj : {};
    const localKeys = Object.keys(local);
    const remoteKeys = Object.keys(remote);
    if (!remoteKeys.length) return local;
    if (!localKeys.length) return remote;
    return { ...local, ...remote };
  }

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
    return '/api/mmmjhs-bot';
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
    const sessionToken = typeof getErpSessionToken === 'function' ? String(getErpSessionToken() || '').trim() : '';
    if (sessionToken) headers['X-ERP-Session'] = sessionToken;
    return headers;
  }

  function compressBase64Image(base64Str, maxW = 200, maxH = 200) {
    return new Promise((resolve) => {
      if (!base64Str || !base64Str.startsWith('data:') || base64Str.length < 20000) {
        resolve(base64Str);
        return;
      }
      const img = new Image();
      img.onload = function() {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > h) {
          if (w > maxW) { h = Math.round((h * maxW) / w); w = maxW; }
        } else {
          if (h > maxH) { w = Math.round((w * maxH) / h); h = maxH; }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => resolve(base64Str);
      img.src = base64Str;
    });
  }

  function isPhotoApiUnavailableError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return /not deployed|not found \(404\)|unknown action|cloud api not found|fake ok/i.test(msg);
  }

  async function fetchWithRetry(url, options, retries) {
    const max = retries == null ? 2 : retries;
    let lastErr;
    for (let attempt = 0; attempt <= max; attempt++) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timeoutMs = Number(options?.timeoutMs) || 20000;
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
          error: 'Vercel API is outdated. Deploy api/mmmjhs-bot.js + api/erp-cloud.js and refresh the site.'
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
    const receipt = String(payment.receiptNo || payment.receipt || payment.billNo || payment.id || '').replace(/^rec[-_]?/i, '').trim().toLowerCase();
    if (receipt && receipt !== 'undefined' && receipt !== 'null') {
      return `r:${receipt}`;
    }
    const date = String(payment.date || payment.paidAt || '').split('T')[0].trim();
    const amount = Number(payment.amount || 0);
    const month = String(payment.month || (Array.isArray(payment.paidCurrentMonths) ? payment.paidCurrentMonths.join(',') : '')).trim().toLowerCase();
    const mode = String(payment.mode || 'Cash').trim().toLowerCase();
    return `f:${date}|${amount}|${month}|${mode}`;
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

  function normalizeClassesList(classes) {
    if (Array.isArray(classes)) return classes.filter((c) => c && typeof c === 'object' && (c.name || c.id));
    if (classes && typeof classes === 'object') {
      return Object.values(classes).filter((c) => c && typeof c === 'object' && (c.name || c.id));
    }
    return [];
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

  
  function mergeExamMarks(localMarks, remoteMarks) {
    if (!localMarks && !remoteMarks) return {};
    if (!localMarks) return JSON.parse(JSON.stringify(remoteMarks));
    if (!remoteMarks) return JSON.parse(JSON.stringify(localMarks));

    const result = JSON.parse(JSON.stringify(remoteMarks));
    for (const subKey of Object.keys(localMarks)) {
      if (!result[subKey]) {
        result[subKey] = {};
      }
      const localSub = localMarks[subKey];
      if (typeof localSub === 'object' && localSub !== null) {
        for (const comp of Object.keys(localSub)) {
          const val = localSub[comp];
          if (val !== undefined && val !== '') {
            result[subKey][comp] = val;
          }
        }
      } else if (localSub !== undefined && localSub !== '') {
        result[subKey] = localSub;
      }
    }
    return result;
  }

  function mergeAllTermMarks(localTermMarks, remoteTermMarks) {
    if (!localTermMarks && !remoteTermMarks) return {};
    if (!localTermMarks) return JSON.parse(JSON.stringify(remoteTermMarks));
    if (!remoteTermMarks) return JSON.parse(JSON.stringify(localTermMarks));

    const result = JSON.parse(JSON.stringify(remoteTermMarks));
    for (const term of Object.keys(localTermMarks)) {
      if (!result[term]) result[term] = {};
      result[term] = mergeExamMarks(localTermMarks[term], result[term]);
    }
    return result;
  }

  function mergeCloudOnlyStudents(localStudents, remoteStudents) {
    const localByAdm = new Map((localStudents || []).map((s) => [admissionKey(s), s]));
    const cache = window._erpStudentPhotoCache || {};
    return (remoteStudents || []).map((remoteStudent) => {
      const key = admissionKey(remoteStudent);
      const adm = String(remoteStudent.admissionNo || '').replace(/\.0$/, '').trim();
      const localStudent = localByAdm.get(key);
      const cachedPhoto = (adm && cache[adm]) ? cache[adm] : '';
      const localPhoto = localStudent ? (localStudent.photo || localStudent.photoDataUrl || '') : '';
      const remotePhoto = remoteStudent.photo || remoteStudent.photoDataUrl || '';
      const photo = preferStudentPhoto(
        localPhoto || cachedPhoto,
        remotePhoto || cachedPhoto
      ) || cachedPhoto || localPhoto || remotePhoto;

      const mergedExamMarks = localStudent ? mergeExamMarks(localStudent.examMarks, remoteStudent.examMarks) : (remoteStudent.examMarks || {});
      const mergedMarks = localStudent ? mergeAllTermMarks(localStudent.marks, remoteStudent.marks) : (remoteStudent.marks || {});

      return {
        ...remoteStudent,
        photo,
        photoDataUrl: photo,
        examMarks: mergedExamMarks,
        marks: mergedMarks
      };
    });
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
      examMarks: mergeExamMarks(L.examMarks, R.examMarks),
      marks: mergeAllTermMarks(L.marks, R.marks),
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
      staffUsers = mergeStaffUsersLists(local.staffUsers, remote.staffUsers);
      teachers = mergeTeachersLists(local.teachers, remote.teachers);
    } else if (remoteStudentsAuthoritative) {
      staffUsers = mergeStaffUsersLists(remote.staffUsers, local.staffUsers);
      teachers = mergeTeachersLists(remote.teachers, local.teachers);
    } else {
      staffUsers = mergeStaffUsersLists(olderMeta.staffUsers, newerMeta.staffUsers);
      teachers = mergeTeachersLists(olderMeta.teachers, newerMeta.teachers);
    }

    const mergedSubjects = Array.isArray(newerMeta.subjects) ? newerMeta.subjects : (Array.isArray(olderMeta.subjects) ? olderMeta.subjects : []);

    return {
      ...olderMeta,
      ...newerMeta,
      version: newerMeta.version || olderMeta.version || '2.0',
      savedAt: new Date().toISOString(),
      students,
      cancelledReceipts,
      classes: mergeClassesLists(local.classes, remote.classes),
      staffUsers,
      schoolProfile: newerMeta.schoolProfile || olderMeta.schoolProfile,
      signatures: newerMeta.signatures || olderMeta.signatures,
      teachers,
      subjects: mergedSubjects,
      sessions: newerMeta.sessions || olderMeta.sessions,
      classFeeMaster: mergePlainObjectsPreferNonEmpty(olderMeta.classFeeMaster, newerMeta.classFeeMaster),
      feeScheduleRules: mergePlainObjectsPreferNonEmpty(olderMeta.feeScheduleRules, newerMeta.feeScheduleRules),
      feeStructureBySession: mergePlainObjectsPreferNonEmpty(olderMeta.feeStructureBySession, newerMeta.feeStructureBySession),
      feeSettingsVersions: mergePlainObjectsPreferNonEmpty(olderMeta.feeSettingsVersions, newerMeta.feeSettingsVersions),
      feeSettingsMutationIds: mergePlainObjectsPreferNonEmpty(olderMeta.feeSettingsMutationIds, newerMeta.feeSettingsMutationIds),
      configurationVersions: mergePlainObjectsPreferNonEmpty(olderMeta.configurationVersions, newerMeta.configurationVersions),
      configurationMutationIds: mergePlainObjectsPreferNonEmpty(olderMeta.configurationMutationIds, newerMeta.configurationMutationIds),
      examConfigurationVersions: mergePlainObjectsPreferNonEmpty(olderMeta.examConfigurationVersions, newerMeta.examConfigurationVersions),
      examConfigurationMutationIds: mergePlainObjectsPreferNonEmpty(olderMeta.examConfigurationMutationIds, newerMeta.examConfigurationMutationIds),
      directoryEntityVersions: mergePlainObjectsPreferNonEmpty(olderMeta.directoryEntityVersions, newerMeta.directoryEntityVersions),
      directoryMutationIds: mergePlainObjectsPreferNonEmpty(olderMeta.directoryMutationIds, newerMeta.directoryMutationIds),
      directoryTombstones: newerMeta.directoryTombstones || olderMeta.directoryTombstones || {},
      examSubjectConfigs: mergePlainObjectsPreferNonEmpty(olderMeta.examSubjectConfigs, newerMeta.examSubjectConfigs),
      weightageRules: mergePlainObjectsPreferNonEmpty(olderMeta.weightageRules, newerMeta.weightageRules),
      userPermissions: mergePlainObjectsPreferNonEmpty(olderMeta.userPermissions, newerMeta.userPermissions),
      examSchedules: mergeExamSchedulesLists(olderMeta.examSchedules, newerMeta.examSchedules),
      attendance: mergePlainObjectsPreferNonEmpty(olderMeta.attendance, newerMeta.attendance),
      rolePermissionTemplates: mergePlainObjectsPreferNonEmpty(olderMeta.rolePermissionTemplates, newerMeta.rolePermissionTemplates),
      teacherPeriodMatrices: mergePlainObjectsPreferNonEmpty(olderMeta.teacherPeriodMatrices, newerMeta.teacherPeriodMatrices),
      printSettings: mergePlainObjectsPreferNonEmpty(olderMeta.printSettings, newerMeta.printSettings),
      telegramLogs: Array.isArray(newerMeta.telegramLogs) && newerMeta.telegramLogs.length ? newerMeta.telegramLogs : (olderMeta.telegramLogs || []),
      periodSettings: mergePeriodSettingsLists(olderMeta.periodSettings, newerMeta.periodSettings),
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

  function sameCloudRevision(left, right) {
    const a = String(left || '').trim();
    const b = String(right || '').trim();
    if (!a || !b) return false;
    const aTime = Date.parse(a);
    const bTime = Date.parse(b);
    return Number.isFinite(aTime) && Number.isFinite(bTime) ? aTime === bTime : a === b;
  }

  function recordCloudMutationRevision(savedAt) {
    const stamp = String(savedAt || '').trim();
    if (!stamp) return;
    localStorage.setItem(LS_LAST_CLOUD_AT, stamp);
    localStorage.setItem(LS_LAST_PULL, stamp);
    window._erpCloudLastPushAt = stamp;
    window._erpCloudLastPushError = '';
  }
  window.recordCloudMutationRevision = recordCloudMutationRevision;

  async function fetchCloudVersionRaw() {
    const res = await fetchWithRetry(cloudVersionUrl(), { headers: cloudHeaders(), cache: 'no-store' });
    return parseCloudResponse(res);
  }

  /**
   * Ask the server for just the snapshot timestamp (~80 bytes) instead of
   * re-downloading the whole roster on every poll.
   * Returns true when a full pull is actually needed.
   */
  async function cloudSnapshotChanged() {
    try {
      const data = await fetchCloudVersionRaw();
      if (!data || !data.ok || !data.savedAt) {
        // Older server without the probe — fall back to slow full polling.
        versionProbeSupported = false;
        return false;
      }
      versionProbeSupported = true;
      const known = String(localStorage.getItem(LS_LAST_CLOUD_AT) || '');
      return !sameCloudRevision(data.savedAt, known);
    } catch (err) {
      versionProbeSupported = false;
      return false;
    }
  }

  async function fetchCloudSnapshotRaw() {
    try {
      const res = await fetchWithRetry(cloudPullUrl(), { headers: cloudHeaders(), cache: 'no-store', timeoutMs: 90000 });
      const data = await parseCloudResponse(res);
      if (!data.ok) {
        throw new Error(data.error || 'Cloud pull failed.');
      }
      return data;
    } catch (err) {
      throw err;
    }
  }

  /**
   * Fast startup for returning devices. The display cache is accepted only
   * when IndexedDB previously confirmed it was written and both local revision
   * markers match the tiny authoritative cloudVersion response. Any doubt,
   * missing cache, old server, or changed revision falls back to a full pull.
   */
  async function fetchCloudSnapshotForStartup() {
    const knownCloudAt = String(localStorage.getItem(LS_LAST_CLOUD_AT) || '').trim();
    const durableCacheAt = String(localStorage.getItem(LS_DISPLAY_CACHE_AT) || '').trim();
    if (knownCloudAt && sameCloudRevision(knownCloudAt, durableCacheAt)) {
      try {
        const version = await fetchCloudVersionRaw();
        if (version?.ok && version.savedAt && sameCloudRevision(version.savedAt, knownCloudAt)) {
          versionProbeSupported = true;
          return {
            ok: true,
            configured: true,
            schoolId: version.schoolId || getCloudSchoolId(),
            unchanged: true,
            savedAt: version.savedAt,
            version: version.version || ''
          };
        }
      } catch (err) {
        // A failed revision probe must never weaken startup reliability. The
        // authoritative full pull below remains the compatibility fallback.
      }
    }
    return fetchCloudSnapshotRaw();
  }

  async function fetchCloudSnapshot() {
    // Use boot prefetch when available (starts as soon as cloudSync.js loads)
    if (window._erpCloudPrefetchPromise && !window._erpCloudPrefetchConsumed) {
      window._erpCloudPrefetchConsumed = true;
      try {
        const prefetched = await window._erpCloudPrefetchPromise;
        window._erpCloudPrefetchPromise = null;
        if (prefetched?.unchanged) {
          const hasDurableDisplayData = (
            Array.isArray(window.SchoolData?.students) && window.SchoolData.students.length > 0
          ) || (
            Array.isArray(window.SchoolData?.staffUsers) && window.SchoolData.staffUsers.length > 0
          );
          // A local revision marker can outlive a manually cleared browser
          // cache. Never trust the marker unless initApp loaded real data.
          if (!hasDurableDisplayData) return fetchCloudSnapshotRaw();
        }
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
      body: JSON.stringify({ schoolId: getCloudSchoolId() }),
      timeoutMs: 90000
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
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
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

      if (data.unchanged) {
        const cloudStamp = String(data.savedAt || localStorage.getItem(LS_LAST_CLOUD_AT) || '').trim();
        if (cloudStamp) {
          localStorage.setItem(LS_LAST_PULL, cloudStamp);
          localStorage.setItem(LS_LAST_CLOUD_AT, cloudStamp);
        }
        window._erpCloudBootReady = true;
        window._erpCloudPushDisabled = false;
        window._erpCloudMemoryDirty = false;
        window._erpCloudLastPullError = '';
        if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
        return {
          ok: true,
          configured: true,
          unchanged: true,
          cached: true,
          studentCount: Array.isArray(window.SchoolData?.students) ? window.SchoolData.students.length : 0,
          savedAt: cloudStamp
        };
      }

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
        const remoteClasses = normalizeClassesList(cloudPayload.classes);
        const localClasses = normalizeClassesList(localPayload.classes);
        merged = {
          ...cloudPayload,
          students: mergeCloudOnlyStudents(localPayload.students, cloudPayload.students),
          // Cloud-only startup must show the exact same class/section teachers
          // on every device. A stale browser cache must never override cloud.
          classes: remoteClasses.length ? remoteClasses : localClasses,
          subjects: Array.isArray(cloudPayload.subjects) ? cloudPayload.subjects : (Array.isArray(localPayload.subjects) ? localPayload.subjects : []),
          staffUsers: mergeStaffUsersLists(localPayload.staffUsers, cloudPayload.staffUsers),
          teachers: mergeTeachersLists(localPayload.teachers, cloudPayload.teachers),
          // Versioned exam setup is cloud-authoritative. Merging an older display
          // cache could otherwise resurrect removed subjects or old max marks.
          examSubjectConfigs: cloudPayload.examSubjectConfigs && typeof cloudPayload.examSubjectConfigs === 'object'
            ? cloudPayload.examSubjectConfigs
            : (localPayload.examSubjectConfigs || {}),
          classFeeMaster: mergePlainObjectsPreferNonEmpty(localPayload.classFeeMaster, cloudPayload.classFeeMaster),
          feeScheduleRules: mergePlainObjectsPreferNonEmpty(localPayload.feeScheduleRules, cloudPayload.feeScheduleRules),
          feeStructureBySession: cloudPayload.feeStructureBySession || localPayload.feeStructureBySession || {},
          feeSettingsVersions: cloudPayload.feeSettingsVersions || localPayload.feeSettingsVersions || {},
          feeSettingsMutationIds: cloudPayload.feeSettingsMutationIds || localPayload.feeSettingsMutationIds || {},
          configurationVersions: cloudPayload.configurationVersions || localPayload.configurationVersions || {},
          configurationMutationIds: cloudPayload.configurationMutationIds || localPayload.configurationMutationIds || {},
          examConfigurationVersions: cloudPayload.examConfigurationVersions || localPayload.examConfigurationVersions || {},
          examConfigurationMutationIds: cloudPayload.examConfigurationMutationIds || localPayload.examConfigurationMutationIds || {},
          directoryEntityVersions: cloudPayload.directoryEntityVersions || localPayload.directoryEntityVersions || {},
          directoryMutationIds: cloudPayload.directoryMutationIds || localPayload.directoryMutationIds || {},
          directoryTombstones: cloudPayload.directoryTombstones || localPayload.directoryTombstones || {},
          weightageRules: cloudPayload.weightageRules && typeof cloudPayload.weightageRules === 'object'
            ? cloudPayload.weightageRules
            : (localPayload.weightageRules || {}),
          userPermissions: mergePlainObjectsPreferNonEmpty(localPayload.userPermissions, cloudPayload.userPermissions),
          // Date sheets are also cloud-authoritative after startup. Merging a
          // stale local list made different devices show different schedules.
          examSchedules: Array.isArray(cloudPayload.examSchedules) ? cloudPayload.examSchedules : [],
          periodSettings: Array.isArray(cloudPayload.periodSettings) && cloudPayload.periodSettings.length > 0 ? cloudPayload.periodSettings : mergePeriodSettingsLists(localPayload.periodSettings, cloudPayload.periodSettings),
          signatures: cloudPayload.signatures || localPayload.signatures || {},
          schoolProfile: cloudPayload.schoolProfile || localPayload.schoolProfile || {},
          sessions: cloudPayload.sessions || localPayload.sessions || [],
          printSettings: mergePlainObjectsPreferNonEmpty(localPayload.printSettings, cloudPayload.printSettings),
          telegramLogs: Array.isArray(cloudPayload.telegramLogs) && cloudPayload.telegramLogs.length > 0 ? cloudPayload.telegramLogs : (localPayload.telegramLogs || []),
          activeSession: cloudPayload.activeSession || localPayload.activeSession || '2026-27',
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
      if (typeof ensureSchoolDataClasses === 'function') {
        ensureSchoolDataClasses();
      }
      if (typeof loadStudentPhotoCacheFromIdb === 'function') {
        try { await loadStudentPhotoCacheFromIdb(); } catch (e) {}
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
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
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

      // Native student-link overlay used to download every erp_students.payload
      // (including photos) after every pull. Directory fields already arrive
      // in the lean boot/cloudPull response.
      window._erpSkipNativeStudentOverlay = true;

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
    let expectedSavedAt = String((options && options.expectedSavedAt) || localStorage.getItem(LS_LAST_CLOUD_AT) || '').trim();
    
    // 1. Compress existing signatures/logos in the payload to reduce overall size
    if (payload && payload.signatures) {
      const keys = Object.keys(payload.signatures);
      for (let k of keys) {
        if (typeof payload.signatures[k] === 'string') {
          payload.signatures[k] = await compressBase64Image(payload.signatures[k], 200, 100);
        }
      }
    }
    if (payload && payload.schoolProfile) {
      const keys = ['logoDataUrl', 'paymentQrDataUrl', 'principalSignatureDataUrl'];
      for (let k of keys) {
        if (typeof payload.schoolProfile[k] === 'string') {
          payload.schoolProfile[k] = await compressBase64Image(payload.schoolProfile[k], 200, 200);
        }
      }
    }

    // Cache all student photos in local IndexedDB photo cache
    if (payload && Array.isArray(payload.students)) {
      window._erpStudentPhotoCache = window._erpStudentPhotoCache || {};
      payload.students.forEach(s => {
        const adm = String(s?.admissionNo || '').replace(/\.0$/, '').trim();
        const p = String(s?.photo || s?.photoDataUrl || '').trim();
        if (adm && p && (p.startsWith('data:image') || p.startsWith('http'))) {
          window._erpStudentPhotoCache[adm] = p;
        }
      });
      if (typeof saveStudentPhotoCacheToIdb === 'function') {
        try { saveStudentPhotoCacheToIdb(window._erpStudentPhotoCache); } catch(e) {}
      }
    }
    if (payload && Array.isArray(payload.teachers)) {
      payload = {
        ...payload,
        teachers: payload.teachers.map(t => {
          if (!t) return t;
          const stripped = { ...t };
          Object.keys(stripped).forEach(k => {
            if (typeof stripped[k] === 'string' && stripped[k].length > 1000) {
              delete stripped[k];
            }
          });
          return stripped;
        })
      };
    }

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
          expectedSavedAt = String(remote.snapshot.saved_at || remote.snapshot.payload.savedAt || expectedSavedAt || '').trim();
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
    let res, data;
    try {
      res = await fetchWithRetry(cloudPushUrl(), {
        method: 'POST',
        headers: { ...cloudHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolId, payload, savedBy, expectedSavedAt }),
        timeoutMs: 90000
      });
      data = await parseCloudResponse(res);
      if (!data.ok) {
        if (data.conflict) {
          const conflictError = new Error(data.error || 'Cloud data changed on another device. Refresh before saving again.');
          conflictError.code = 'ERP_CLOUD_CONFLICT';
          conflictError.savedAt = data.savedAt || '';
          throw conflictError;
        }
        const errMsg = typeof data.error === 'object' ? (data.error?.message || JSON.stringify(data.error)) : (data.error || 'Cloud push failed.');
        throw new Error(errMsg);
      }
    } catch (err) {
      if (err && err.code === 'ERP_CLOUD_CONFLICT') throw err;
      throw err;
    }
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
        await saveSchoolDataToCloudConfirmed({ skipMergePull: false });
        window._erpCloudLastPushError = '';
        window._erpCloudSyncState = 'live';
        if (typeof window.saveCloudDisplayCache === 'function' && typeof buildSchoolDataStoragePayload === 'function') {
          try { window.saveCloudDisplayCache(buildSchoolDataStoragePayload()); } catch (e) {}
        }
      } catch (err) {
        window._erpCloudLastPushError = err.message;
        window._erpCloudSyncState = 'error';
        console.warn('Cloud push failed:', err);
        const now = Date.now();
        if (typeof showNotification === 'function' && now - Number(window._erpCloudLastErrorToastAt || 0) > 8000) {
          window._erpCloudLastErrorToastAt = now;
          const message = err && err.code === 'ERP_CLOUD_CONFLICT'
            ? 'Save stopped: newer cloud data exists from another device. Refresh, verify the latest data, then save again.'
            : `Cloud save failed: ${err.message || 'Check the connection and retry.'}`;
          showNotification(message, 'error');
        }
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
      body: JSON.stringify({ schoolId, photos, savedBy }),
      timeoutMs: 90000
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
      body: JSON.stringify({ schoolId, photos, savedBy }),
      timeoutMs: 120000
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

    const BATCH_SIZE = 15;
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

  function estimatePhotoPayloadBytes(photos) {
    return (photos || []).reduce((sum, row) => {
      const photo = String(row?.photo || row?.photoDataUrl || row?.dataUrl || '');
      return sum + photo.length + 96;
    }, 200);
  }

  /** Keep each API request under Vercel ~4.5MB body limit (use 2MB safety cap). */
  function splitPhotoUploadBatches(photoRows, options) {
    const opts = options || {};
    const maxBytes = Number(opts.maxBytes) || 2000000;
    const maxCount = Number(opts.maxCount) || 12;
    const rows = Array.isArray(photoRows) ? photoRows.filter(row => row?.student && row?.dataUrl) : [];
    const batches = [];
    let current = [];
    let currentBytes = 0;

    rows.forEach((row) => {
      const item = {
        admissionNo: row.student.admissionNo || row.student.AdmissionNo,
        photo: row.dataUrl,
        photoDataUrl: row.dataUrl,
        _sourceRow: row
      };
      const itemBytes = estimatePhotoPayloadBytes([item]);
      if (current.length && (current.length >= maxCount || currentBytes + itemBytes > maxBytes)) {
        batches.push(current);
        current = [];
        currentBytes = 0;
      }
      current.push(item);
      currentBytes += itemBytes;
    });
    if (current.length) batches.push(current);
    return batches;
  }

  async function pushBulkStudentPhotosToSupabaseStorage(photoRows, options) {
    const rows = Array.isArray(photoRows) ? photoRows.filter(row => row?.student && row?.dataUrl) : [];
    if (!rows.length) throw new Error('No photos to save.');
    const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;

    cancelScheduledCloudPush();
    window._erpCloudMemoryDirty = true;
    window._erpCloudSyncState = 'syncing';

    const batches = splitPhotoUploadBatches(rows);
    let patched = 0;
    let savedAt = '';

    try {
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        if (onProgress) {
          onProgress({
            mode: 'storage',
            batch: i + 1,
            totalBatches: batches.length,
            batchSize: batch.length,
            totalPhotos: rows.length
          });
        }
        const payload = batch.map(({ admissionNo, photo, photoDataUrl }) => ({ admissionNo, photo, photoDataUrl }));
        const result = await pushStudentPhotoStorageBatchToCloud(payload);
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
  async function pushBulkStudentPhotosToCloud(photoRows, options) {
    const rows = Array.isArray(photoRows) ? photoRows.filter(row => row?.student && row?.dataUrl) : [];
    if (!rows.length) throw new Error('No photos to save.');
    const onProgress = options && typeof options.onProgress === 'function' ? options.onProgress : null;

    cancelScheduledCloudPush();
    window._erpCloudMemoryDirty = true;
    window._erpCloudSyncState = 'syncing';

    const batches = splitPhotoUploadBatches(rows);
    let patched = 0;
    let savedAt = '';

    try {
      for (let i = 0; i < batches.length; i += 1) {
        const batch = batches[i];
        if (onProgress) {
          onProgress({
            mode: 'patch',
            batch: i + 1,
            totalBatches: batches.length,
            batchSize: batch.length,
            totalPhotos: rows.length
          });
        }
        const payload = batch.map(({ admissionNo, photo, photoDataUrl }) => ({ admissionNo, photo, photoDataUrl }));
        const result = await pushStudentPhotoBatchToCloud(payload);
        payload.forEach((item) => {
          const key = String(item.admissionNo || '').trim().toLowerCase();
          const row = rows.find(r => String(r.student?.admissionNo || '').trim().toLowerCase() === key);
          if (row) {
            row.student.photo = item.photo;
            row.student.photoDataUrl = item.photo;
          }
        });
        patched += Number(result.patched || payload.length);
        savedAt = result.savedAt || savedAt;
      }

      if (savedAt) {
        localStorage.setItem(LS_LAST_CLOUD_AT, savedAt);
        localStorage.setItem(LS_LAST_PULL, savedAt);
        window._erpCloudLastPushAt = savedAt;
      }
      window._erpCloudLastPushCount = patched;
      window._erpCloudLastPushError = '';
      window._erpCloudSyncState = 'live';

      if (typeof saveSchoolDataToStorage === 'function') {
        saveSchoolDataToStorage({ skipCloudPush: true });
      }
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

  function saveSchoolDataToCloudConfirmed(options) {
    const run = async () => {
      cancelScheduledCloudPush();
      window._erpCloudMemoryDirty = true;
      window._erpCloudSyncState = 'syncing';
      // Build at execution time, not queue time, so rapid edits are serialized and
      // each request uses the revision confirmed by the preceding request.
      const payload = (options && options.payload) || buildSchoolDataStoragePayload();
      if (typeof window.saveCloudDisplayCache === 'function') {
        try { await window.saveCloudDisplayCache(payload); } catch (e) { console.warn('display cache', e); }
      }
      const result = await pushSchoolDataToCloud({ ...(options || {}), payload });
      if (!result || result.ok !== true || !result.savedAt) {
        throw new Error(result?.error || 'Cloud did not return a confirmed save timestamp.');
      }
      window._erpCloudMemoryDirty = false;
      window._erpCloudSyncState = 'live';
      window._erpCloudLastPushError = '';
      return result;
    };
    const queued = confirmedSaveChain.catch(() => {}).then(run);
    confirmedSaveChain = queued;
    return queued;
  }

  function flushCloudPushNow() {
    return saveSchoolDataToCloudConfirmed().catch((err) => {
      window._erpCloudLastPushError = err.message;
      window._erpCloudSyncState = 'error';
      const message = err && err.code === 'ERP_CLOUD_CONFLICT'
        ? 'Save stopped: another device has newer cloud data. Refresh before retrying.'
        : `Cloud save failed: ${err.message || 'Check the connection and retry.'}`;
      if (typeof showNotification === 'function') showNotification(message, 'error');
      return { ok: false, error: err.message, conflict: err.code === 'ERP_CLOUD_CONFLICT' };
    });
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
    window._erpCloudPrefetchPromise = fetchCloudSnapshotForStartup().catch((err) => {
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
      console.info('ERP cloud sync: server not configured yet (Supabase environment variables on Vercel).');
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
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
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
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
      if (typeof window.setCloudLoadingOverlay === 'function') window.setCloudLoadingOverlay(false);
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
      if (cloudSyncInFlight) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      if (versionProbeSupported) {
        const changed = await cloudSnapshotChanged();
        if (!changed) return;
        const hash = String(window.location.hash || '').toLowerCase();
        if (/exams/.test(hash) && window.ERP_V2_READ_FLAGS?.marks) {
          refreshStudentMarksFromV2({
            className: window.activeExamClass || window.activeMobileExamClass || '',
            subjectCode: window.activeSelectedSubjectFilter || window.activeExamSubject || window.activeMobileExamSubject || ''
          }).catch(() => {});
          return;
        }
        if (/students/.test(hash) && window.ERP_V2_READ_FLAGS?.students) {
          refreshStudentsFromV2({ classKey: document.getElementById('studentClassFilter')?.value || '' }).catch(() => {});
          return;
        }
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

  async function fetchMarksV2(options = {}) {
    const schoolId = getCloudSchoolId();
    const params = new URLSearchParams({ action: 'getMarksV2', schoolId });
    if (options.admissionNo) params.set('admissionNo', options.admissionNo);
    if (options.subjectCode) params.set('subjectCode', options.subjectCode);
    if (options.className || options.classKey) params.set('className', options.className || options.classKey);
    if (options.since) params.set('since', options.since);
    const url = withCloudSecret(`${getErpCloudApiBase()}?${params.toString()}`);
    try {
      const res = await fetchWithRetry(url, { headers: cloudHeaders(), cache: 'no-store', timeoutMs: 10000 });
      if (!res.ok) return { ok: false, status: res.status };
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function fetchAttendanceV2(options = {}) {
    const schoolId = getCloudSchoolId();
    const params = new URLSearchParams({ action: 'getAttendanceV2', schoolId });
    if (options.admissionNo) params.set('admissionNo', options.admissionNo);
    if (options.date) params.set('date', options.date);
    const url = withCloudSecret(`${getErpCloudApiBase()}?${params.toString()}`);
    try {
      const res = await fetchWithRetry(url, { headers: cloudHeaders(), cache: 'no-store', timeoutMs: 10000 });
      if (!res.ok) return { ok: false, status: res.status };
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function fetchExamSchedulesV2() {
    const schoolId = getCloudSchoolId();
    const params = new URLSearchParams({ action: 'getExamSchedulesV2', schoolId });
    const url = withCloudSecret(`${getErpCloudApiBase()}?${params.toString()}`);
    try {
      const res = await fetchWithRetry(url, { headers: cloudHeaders(), cache: 'no-store', timeoutMs: 10000 });
      if (!res.ok) return { ok: false, status: res.status };
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function fetchStudentsV2(options = {}) {
    const schoolId = getCloudSchoolId();
    const params = new URLSearchParams({ action: 'getStudentsV2', schoolId });
    if (options.admissionNo) params.set('admissionNo', options.admissionNo);
    if (options.classKey) params.set('classKey', options.classKey);
    const url = withCloudSecret(`${getErpCloudApiBase()}?${params.toString()}`);
    try {
      const res = await fetchWithRetry(url, { headers: cloudHeaders(), cache: 'no-store', timeoutMs: 10000 });
      if (!res.ok) return { ok: false, status: res.status };
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function fetchFeeLedgerV2(options = {}) {
    const schoolId = getCloudSchoolId();
    const params = new URLSearchParams({ action: 'getFeeLedgerV2', schoolId });
    if (options.admissionNo) params.set('admissionNo', options.admissionNo);
    const url = withCloudSecret(`${getErpCloudApiBase()}?${params.toString()}`);
    try {
      const res = await fetchWithRetry(url, { headers: cloudHeaders(), cache: 'no-store', timeoutMs: 10000 });
      if (!res.ok) return { ok: false, status: res.status };
      return await res.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ERP v2 reads are ON for Preview. Targeted class/subject/student queries
  // replace routine full-school snapshot downloads.
  window.ERP_V2_READ_FLAGS = Object.assign({
    students: true,
    examSchedules: true,
    marks: true,
    attendance: true,
    fees: true
  }, window.ERP_V2_READ_FLAGS || {});

  async function refreshStudentMarksFromV2(options = {}) {
    if (!window.ERP_V2_READ_FLAGS || !window.ERP_V2_READ_FLAGS.marks) {
      return { ok: false, fallback: true, reason: 'FLAG_DISABLED' };
    }
    const res = await fetchMarksV2(options);
    if (res && res.ok && (res.marks || res.rows) && window.SchoolData && Array.isArray(window.SchoolData.students)) {
      if (!window.ErpV2ReadModel || typeof window.ErpV2ReadModel.applyMarks !== 'function') {
        return { ok: false, fallback: true, reason: 'V2_READ_MODEL_UNAVAILABLE' };
      }
      const applied = window.ErpV2ReadModel.applyMarks({
        schoolData: window.SchoolData,
        marks: Array.isArray(res.rows) && res.rows.length ? res.rows : res.marks
      });
      try { saveSchoolDataToStorage({ skipCloudPush: true }); } catch (_) {}
      return { ...res, ...applied };
    }
    return res || { ok: false, fallback: true };
  }

  async function refreshStudentAttendanceFromV2(options = {}) {
    if (!window.ERP_V2_READ_FLAGS || !window.ERP_V2_READ_FLAGS.attendance) {
      return { ok: false, fallback: true, reason: 'FLAG_DISABLED' };
    }
    const res = await fetchAttendanceV2(options);
    if (res && res.ok && res.attendance && window.SchoolData && Array.isArray(window.SchoolData.students)) {
      if (!window.ErpV2ReadModel || typeof window.ErpV2ReadModel.applyAttendance !== 'function') {
        return { ok: false, fallback: true, reason: 'V2_READ_MODEL_UNAVAILABLE' };
      }
      const applied = window.ErpV2ReadModel.applyAttendance({ schoolData: window.SchoolData, attendance: res.attendance });
      try { saveSchoolDataToStorage({ skipCloudPush: true }); } catch (_) {}
      return { ...res, ...applied };
    }
    return res || { ok: false, fallback: true };
  }

  async function refreshStudentFeeLedgerFromV2(options = {}) {
    if (!window.ERP_V2_READ_FLAGS || !window.ERP_V2_READ_FLAGS.fees) {
      return { ok: false, fallback: true, reason: 'FLAG_DISABLED' };
    }
    const res = await fetchFeeLedgerV2(options);
    if (res && res.ok && Array.isArray(res.payments) && window.SchoolData && Array.isArray(window.SchoolData.students)) {
      if (!window.ErpV2ReadModel || typeof window.ErpV2ReadModel.applyFeeLedger !== 'function') {
        return { ok: false, fallback: true, reason: 'V2_READ_MODEL_UNAVAILABLE' };
      }
      const reconciliation = window.ErpV2ReadModel.applyFeeLedger({
        schoolData: window.SchoolData,
        payments: res.payments,
        requestedAdmission: options.admissionNo,
        complete: res.complete
      });
      try { saveSchoolDataToStorage({ skipCloudPush: true }); } catch (_) {}
      return { ...res, ...reconciliation };
    }
    return res || { ok: false, fallback: true };
  }

  async function refreshExamSchedulesFromV2() {
    if (!window.ERP_V2_READ_FLAGS || !window.ERP_V2_READ_FLAGS.examSchedules) {
      return { ok: false, fallback: true, reason: 'FLAG_DISABLED' };
    }
    const res = await fetchExamSchedulesV2();
    if (res && res.ok && Array.isArray(res.schedules) && window.SchoolData) {
      if (!window.ErpV2ReadModel || typeof window.ErpV2ReadModel.applyExamSchedules !== 'function') {
        return { ok: false, fallback: true, reason: 'V2_READ_MODEL_UNAVAILABLE' };
      }
      const applied = window.ErpV2ReadModel.applyExamSchedules({ schoolData: window.SchoolData, schedules: res.schedules });
      try { saveSchoolDataToStorage({ skipCloudPush: true }); } catch (_) {}
      return { ...res, ...applied };
    }
    return res || { ok: false, fallback: true };
  }

  async function refreshStudentsFromV2(options = {}) {
    if (!window.ERP_V2_READ_FLAGS || !window.ERP_V2_READ_FLAGS.students) {
      return { ok: false, fallback: true, reason: 'FLAG_DISABLED' };
    }
    const res = await fetchStudentsV2(options);
    if (res && res.ok && Array.isArray(res.students) && window.SchoolData && Array.isArray(window.SchoolData.students)) {
      if (!window.ErpV2ReadModel || typeof window.ErpV2ReadModel.applyStudents !== 'function') {
        return { ok: false, fallback: true, reason: 'V2_READ_MODEL_UNAVAILABLE' };
      }
      const applied = window.ErpV2ReadModel.applyStudents({ schoolData: window.SchoolData, students: res.students });
      try { saveSchoolDataToStorage({ skipCloudPush: true }); } catch (_) {}
      return { ...res, ...applied };
    }
    return res || { ok: false, fallback: true };
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
  window.saveSchoolDataToCloudConfirmed = saveSchoolDataToCloudConfirmed;
  window.applyNativeStudentLinks = applyNativeStudentLinks;
  window.scheduleCloudPush = scheduleCloudPush;
  window.cancelScheduledCloudPush = cancelScheduledCloudPush;
  window.pushStaffAuthorityToCloud = pushStaffAuthorityToCloud;
  window.pushBulkStudentPhotosToCloud = pushBulkStudentPhotosToCloud;
  window.pushBulkStudentPhotosToSupabaseStorage = pushBulkStudentPhotosToSupabaseStorage;
  window.splitPhotoUploadBatches = splitPhotoUploadBatches;
  window.isPhotoApiUnavailableError = isPhotoApiUnavailableError;
  window.pushBulkPhotoImportFromUrls = pushBulkPhotoImportFromUrls;
  window.flushCloudPushNow = flushCloudPushNow;
  window.getCloudSyncStatusText = getCloudSyncStatusText;
  window.mergeSchoolPayloadsForCloud = mergeSchoolPayloads;
  window.migrateLocalRosterToCloudOnce = migrateLocalRosterToCloudOnce;
  window.startCloudPrefetch = startCloudPrefetch;
  window.wipeCloudRoster = wipeCloudRoster;
  window.fetchMarksV2 = fetchMarksV2;
  window.fetchAttendanceV2 = fetchAttendanceV2;
  window.fetchExamSchedulesV2 = fetchExamSchedulesV2;
  window.fetchStudentsV2 = fetchStudentsV2;
  window.fetchFeeLedgerV2 = fetchFeeLedgerV2;
  window.refreshStudentMarksFromV2 = refreshStudentMarksFromV2;
  window.refreshStudentAttendanceFromV2 = refreshStudentAttendanceFromV2;
  window.refreshStudentFeeLedgerFromV2 = refreshStudentFeeLedgerFromV2;
  window.refreshExamSchedulesFromV2 = refreshExamSchedulesFromV2;
  window.refreshStudentsFromV2 = refreshStudentsFromV2;

  // Start download immediately — do not wait for DOMContentLoaded
  try { startCloudPrefetch(); } catch (e) {}
})();
