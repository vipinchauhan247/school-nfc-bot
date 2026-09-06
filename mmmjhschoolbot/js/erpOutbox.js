/**
 * MMM JHS durable browser mutation outbox.
 *
 * Small, module-scoped edits are written to IndexedDB before navigation. The
 * queue survives refresh, browser close, mobile restarts, and temporary loss of
 * internet. Only a real server acknowledgement changes an item to `saved`.
 */
(function exposeErpOutbox(root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ERPOutbox = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createErpOutbox(root) {
  'use strict';

  const DB_NAME = 'MMM_ERP_Reliability';
  const DB_VERSION = 1;
  const STORE = 'mutations';
  const SESSION_TOKEN_KEY = 'MMM_ERP_SessionToken';
  const SESSION_USER_KEY = 'MMM_ERP_SessionUserId';
  const SCHOOL_ID_KEY = 'MMM_ERP_CLOUD_SCHOOL_ID';
  const DEVICE_ID_KEY = 'MMM_ERP_DeviceId';
  const MAX_ATTEMPTS = 20;
  const SAVED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
  const ALLOWED_ACTIONS = new Set(['saveMarksDelta', 'saveExamScheduleDelta', 'saveDirectoryDelta', 'saveAttendanceDelta']);

  let dbPromise = null;
  let flushPromise = null;
  let wakeTimer = null;
  let lastError = '';
  let lastSavedAt = 0;

  // Fallback in-memory map for environments where IndexedDB is unavailable (e.g. Node tests)
  const memStore = new Map();

  function randomId() {
    const cryptoObj = (root && root.crypto) ? root.crypto : (typeof crypto !== 'undefined' ? crypto : null);
    if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID();
    const bytes = new Uint8Array(16);
    if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') cryptoObj.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function safeLocalGet(key) {
    try {
      if (root && root.localStorage) return String(root.localStorage.getItem(key) || '').trim();
    } catch (error) {}
    return '';
  }

  function safeLocalSet(key, value) {
    try {
      if (root && root.localStorage) root.localStorage.setItem(key, value);
    } catch (error) {}
  }

  function deviceId() {
    let value = safeLocalGet(DEVICE_ID_KEY);
    if (!value) {
      value = randomId();
      safeLocalSet(DEVICE_ID_KEY, value);
    }
    return value;
  }

  function marksScopeKey(payload, defaultSchoolId) {
    const school = String(payload?.schoolId || defaultSchoolId || '').trim();
    const session = String(payload?.sessionName || '').trim();
    const term = String(payload?.term || '').trim().toLowerCase();
    const cls = String(payload?.className || '').trim().toLowerCase();
    const sec = String(payload?.section || '').trim().toLowerCase();
    const adm = String(payload?.admissionNo || '').trim();
    const subj = String(payload?.subjectCode || '').trim().toLowerCase();
    return `${school}|${session}|${term}|${cls}|${sec}|${adm}|${subj}`;
  }

  function normalizeAdmissionNo(value) {
    const raw = String(value || '').trim();
    return raw.replace(/^0+/, '') || raw;
  }

  function lookupSubjectRevisions(revisions, admissionNo, subjectCode) {
    if (!revisions || typeof revisions !== 'object') return null;
    const subj = String(subjectCode || '').trim().toLowerCase();
    if (!subj) return null;
    const wanted = normalizeAdmissionNo(admissionNo);
    const aliases = {
      eng: ['english'],
      english: ['eng'],
      hin: ['hindi'],
      hindi: ['hin']
    };
    const subjectKeys = [subj, ...(aliases[subj] || [])];
    for (const [key, subjects] of Object.entries(revisions)) {
      if (normalizeAdmissionNo(key) !== wanted || !subjects || typeof subjects !== 'object') continue;
      for (const subjectKey of subjectKeys) {
        if (subjects[subjectKey] && typeof subjects[subjectKey] === 'object') return subjects[subjectKey];
      }
    }
    return null;
  }

  function applyExpectedRevisionsToItem(item, revisions) {
    if (!item || item.action !== 'saveMarksDelta') return false;
    const studentRev = lookupSubjectRevisions(
      revisions,
      item.payload?.admissionNo,
      item.payload?.subjectCode
    );
    if (!studentRev) return false;
    let changed = false;
    (Array.isArray(item.payload?.assessments) ? item.payload.assessments : []).forEach(ass => {
      const k = String(ass?.key || '').trim().toLowerCase();
      if (!k || studentRev[k] === undefined || studentRev[k] === null) return;
      const newRev = Number(studentRev[k]);
      if (!Number.isInteger(newRev) || newRev < 0 || ass.expectedRevision === newRev) return;
      ass.expectedRevision = newRev;
      changed = true;
    });
    return changed;
  }

  function hasIndexedDB() {
    return Boolean(root && root.indexedDB);
  }

  function openDb() {
    if (!hasIndexedDB()) return null;
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = root.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains(STORE)
          ? request.transaction.objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: 'id' });
        if (!store.indexNames.contains('status')) store.createIndex('status', 'status', { unique: false });
        if (!store.indexNames.contains('nextAttemptAt')) store.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });
        if (!store.indexNames.contains('actorUserId')) store.createIndex('actorUserId', 'actorUserId', { unique: false });
        if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt', { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open the offline save queue.'));
    });
    return dbPromise;
  }

  async function withStore(mode, operation) {
    if (!hasIndexedDB()) return null;
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const store = transaction.objectStore(STORE);
      let result;
      try { result = operation(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('Offline save queue transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('Offline save queue transaction was aborted.'));
    });
  }

  async function put(item) {
    if (hasIndexedDB()) {
      return withStore('readwrite', store => store.put(item));
    }
    memStore.set(item.id, JSON.parse(JSON.stringify(item)));
    return item;
  }

  async function get(id) {
    if (hasIndexedDB()) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('Could not read the item.'));
      });
    }
    return memStore.get(id) || null;
  }

  async function getAll() {
    if (hasIndexedDB()) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
        request.onerror = () => reject(request.error || new Error('Could not read the offline save queue.'));
      });
    }
    return Array.from(memStore.values());
  }

  async function deleteIds(ids) {
    if (!ids || !ids.length) return;
    if (hasIndexedDB()) {
      await withStore('readwrite', store => ids.forEach(id => store.delete(id)));
    } else {
      ids.forEach(id => memStore.delete(id));
    }
  }

  function backoffMs(attempts) {
    return Math.min(5 * 60 * 1000, Math.max(1500, (2 ** Math.min(8, attempts)) * 1000));
  }

  function apiBase() {
    if (root && root.location) {
      const host = String(root.location.hostname || '').toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1') {
        const port = String(root.MMMJHS_BOT_LOCAL_PORT || '8085').trim();
        return `${root.location.protocol}//${host}:${port}/api/erp-cloud`;
      }
    }
    return '/api/erp-cloud';
  }

  async function statusSnapshot() {
    const items = await getAll();
    const actorUserId = safeLocalGet(SESSION_USER_KEY);
    const own = items.filter(item => !item.actorUserId || item.actorUserId === actorUserId);
    const summarize = rows => ({
      pending: rows.filter(item => ['pending', 'retry', 'syncing'].includes(item.status)).length,
      conflicts: rows.filter(item => item.status === 'conflict').length,
      failed: rows.filter(item => item.status === 'failed').length,
      syncing: rows.some(item => item.status === 'syncing')
    });
    const byAction = {};
    ALLOWED_ACTIONS.forEach(action => { byAction[action] = summarize(own.filter(item => item.action === action)); });
    return {
      ...summarize(own),
      byAction,
      lastError,
      lastSavedAt
    };
  }

  async function emitStatus() {
    try {
      const detail = await statusSnapshot();
      Object.assign(status, detail);
      if (root && typeof root.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        root.dispatchEvent(new CustomEvent('erp:outbox-status', { detail }));
      }
    } catch (error) {}
  }

  function scheduleFlush(delay) {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => { void flush(); }, Math.max(0, Number(delay) || 0));
  }

  async function send(item) {
    const token = safeLocalGet(SESSION_TOKEN_KEY);
    if (!token) {
      const error = new Error('Sign in is required before pending changes can reach the cloud.');
      error.permanent = true;
      throw error;
    }
    const fetchFn = (root && typeof root.fetch === 'function') ? root.fetch : (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) throw new Error('Fetch API is not available.');
    const response = await fetchFn(`${apiBase()}?action=${encodeURIComponent(item.action)}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-ERP-Session': token
      },
      body: JSON.stringify({
        ...item.payload,
        mutationId: item.id,
        deviceId: item.deviceId
      })
    });
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
    if (!response.ok || !data || data.ok !== true) {
      const serverError = typeof data?.error === 'string'
        ? data.error
        : (data?.error && typeof data.error === 'object' ? (data.error.message || JSON.stringify(data.error)) : '');
      const error = new Error(serverError || `Cloud save failed (HTTP ${response.status}).`);
      error.status = response.status;
      error.conflict = response.status === 409 || data?.conflict === true;
      error.permanent = response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404;
      throw error;
    }
    return data;
  }

  async function flush() {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      try {
        if (root && root.navigator && root.navigator.onLine === false) {
          lastError = 'Offline — changes are waiting on this device.';
          await emitStatus();
          return;
        }
        const actorUserId = safeLocalGet(SESSION_USER_KEY);
        const now = Date.now();
        // Conflict items are quarantined and NEVER picked up by automatic flush
        const items = (await getAll())
          .filter(item => ['pending', 'retry', 'syncing'].includes(item.status))
          .filter(item => !item.actorUserId || item.actorUserId === actorUserId)
          .filter(item => Number(item.nextAttemptAt || 0) <= now)
          .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));

        for (const item of items) {
          item.status = 'syncing';
          item.updatedAt = Date.now();
          await put(item);
          await emitStatus();
          try {
            const result = await send(item);
            item.status = 'saved';
            item.serverResponse = result;
            item.savedAt = Date.now();
            item.updatedAt = Date.now();
            item.lastError = '';
            lastError = '';
            lastSavedAt = item.savedAt;
            if (result?.savedAt && root && typeof root.recordCloudMutationRevision === 'function') {
              root.recordCloudMutationRevision(result.savedAt);
            }
            await put(item);
            if (root && typeof root.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
              root.dispatchEvent(new CustomEvent('erp:outbox-saved', {
                detail: { id: item.id, action: item.action, item, result }
              }));
            }
          } catch (error) {
            item.attempts = Number(item.attempts || 0) + 1;
            item.updatedAt = Date.now();
            item.lastError = error?.message || 'Cloud save failed.';
            lastError = item.lastError;
            if (error?.conflict) {
              item.status = 'conflict';
              item.nextAttemptAt = 0; // Quarantined; never automatically retried
            } else if (error?.permanent || item.attempts >= MAX_ATTEMPTS) {
              item.status = 'failed';
              item.nextAttemptAt = 0;
            } else {
              item.status = 'retry';
              item.nextAttemptAt = Date.now() + backoffMs(item.attempts);
            }
            await put(item);
            if (item.status === 'retry') scheduleFlush(Math.max(1000, item.nextAttemptAt - Date.now()));
            if (error?.conflict && root && typeof root.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
              root.dispatchEvent(new CustomEvent('erp:outbox-conflict', {
                detail: { id: item.id, action: item.action, item, error }
              }));
            }
          }
          await emitStatus();
        }

        const cutoff = Date.now() - SAVED_RETENTION_MS;
        const expired = (await getAll()).filter(item => item.status === 'saved' && Number(item.savedAt || 0) < cutoff).map(item => item.id);
        await deleteIds(expired);
      } finally {
        flushPromise = null;
      }
    })();
    return flushPromise;
  }

  async function enqueue(action, payload) {
    if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Unsupported durable save action: ${action}`);
    const actorUserId = safeLocalGet(SESSION_USER_KEY);
    const now = Date.now();
    if (action === 'saveAttendanceDelta') {
      const rows = Array.isArray(payload?.records) ? payload.records : [];
      const existing = (await getAll())
        .filter(item => item.action === action && (!item.actorUserId || item.actorUserId === actorUserId))
        .filter(item => ['pending', 'retry'].includes(item.status))
        .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
      if (existing) {
        const byKey = new Map();
        (Array.isArray(existing.payload?.records) ? existing.payload.records : []).forEach(record => {
          const key = `${String(record?.admissionNo || '').trim()}|${String(record?.attendanceDate || '').trim()}`;
          if (key !== '|') byKey.set(key, record);
        });
        rows.forEach(record => {
          const key = `${String(record?.admissionNo || '').trim()}|${String(record?.attendanceDate || '').trim()}`;
          if (key !== '|') byKey.set(key, record);
        });
        existing.payload = { ...(existing.payload || {}), ...(payload || {}), records: Array.from(byKey.values()) };
        existing.status = 'pending';
        existing.attempts = 0;
        existing.lastError = '';
        existing.nextAttemptAt = now + 5000;
        existing.updatedAt = now;
        await put(existing);
        await emitStatus();
        scheduleFlush(5000);
        return { id: existing.id, status: existing.status, coalesced: true };
      }
    }
    if (action === 'saveMarksDelta') {
      const defaultSchool = safeLocalGet(SCHOOL_ID_KEY) || String(root?.ERP_CLOUD_SCHOOL_ID || 'mmm-jhs');
      const targetScopeKey = marksScopeKey(payload, defaultSchool);
      const assessments = Array.isArray(payload?.assessments) ? payload.assessments : [];
      // Coalesce ONLY into active pending/retry items (never onto quarantined conflict/failed items)
      const existing = (await getAll())
        .filter(item => item.action === action && (!item.actorUserId || item.actorUserId === actorUserId))
        .filter(item => ['pending', 'retry'].includes(item.status))
        .find(item => marksScopeKey(item.payload, item.schoolId) === targetScopeKey);
      if (existing) {
        const byKey = new Map();
        (Array.isArray(existing.payload?.assessments) ? existing.payload.assessments : []).forEach(a => {
          const k = String(a?.key || '').trim().toLowerCase();
          if (k) byKey.set(k, a);
        });
        assessments.forEach(a => {
          const k = String(a?.key || '').trim().toLowerCase();
          if (k) byKey.set(k, a);
        });
        existing.payload = {
          ...(existing.payload || {}),
          ...(payload || {}),
          assessments: Array.from(byKey.values())
        };
        existing.status = 'pending';
        existing.attempts = 0;
        existing.lastError = '';
        existing.nextAttemptAt = now;
        existing.updatedAt = now;
        await put(existing);
        await emitStatus();
        scheduleFlush(0);
        return { id: existing.id, status: existing.status, coalesced: true };
      }
    }
    const item = {
      id: randomId(),
      action,
      payload: payload && typeof payload === 'object' ? payload : {},
      schoolId: safeLocalGet(SCHOOL_ID_KEY) || String(root?.ERP_CLOUD_SCHOOL_ID || 'mmm-jhs'),
      actorUserId,
      deviceId: deviceId(),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: action === 'saveAttendanceDelta' ? now + 5000 : 0,
      createdAt: now,
      updatedAt: now,
      lastError: ''
    };
    await put(item);
    await emitStatus();
    scheduleFlush(action === 'saveAttendanceDelta' ? 5000 : 0);
    return { id: item.id, status: item.status };
  }

  async function flushNow(action) {
    const actorUserId = safeLocalGet(SESSION_USER_KEY);
    const items = await getAll();
    for (const item of items) {
      if (action && item.action !== action) continue;
      if (item.actorUserId && item.actorUserId !== actorUserId) continue;
      // Conflicted items are quarantined and NOT selected by flushNow
      if (!['pending', 'retry'].includes(item.status)) continue;
      item.nextAttemptAt = 0;
      item.updatedAt = Date.now();
      await put(item);
    }
    await emitStatus();
    return flush();
  }

  async function retryFailed() {
    const actorUserId = safeLocalGet(SESSION_USER_KEY);
    const items = await getAll();
    for (const item of items) {
      if (item.status !== 'failed' || (item.actorUserId && item.actorUserId !== actorUserId)) continue;
      item.status = 'retry';
      item.attempts = 0;
      item.nextAttemptAt = 0;
      item.lastError = '';
      await put(item);
    }
    lastError = '';
    await emitStatus();
    scheduleFlush(0);
  }

  async function getItem(id) {
    if (!id) return null;
    return get(id);
  }

  async function applyRevisions(revisions) {
    if (!revisions || typeof revisions !== 'object') return;
    // Only update expected revisions for active pending/retry items that have NOT conflicted.
    // Conflicted items represent rejected edits and MUST NEVER be automatically re-armed or replayed.
    const items = (await getAll()).filter(item => item.action === 'saveMarksDelta' && ['pending', 'retry'].includes(item.status));
    let changed = false;
    for (const item of items) {
      if (!applyExpectedRevisionsToItem(item, revisions)) continue;
      item.updatedAt = Date.now();
      await put(item);
      changed = true;
    }
    if (changed) {
      await emitStatus();
    }
  }

  async function rearmConflict(id, revisions) {
    const item = await get(id);
    if (!item || item.action !== 'saveMarksDelta' || item.status !== 'conflict') return false;
    applyExpectedRevisionsToItem(item, revisions);
    item.status = 'pending';
    item.attempts = 0;
    item.lastError = '';
    item.nextAttemptAt = 0;
    item.updatedAt = Date.now();
    await put(item);
    await emitStatus();
    return true;
  }

  async function dismissConflicts(action) {
    const actorUserId = safeLocalGet(SESSION_USER_KEY);
    const items = await getAll();
    const toDelete = items
      .filter(item => item.status === 'conflict')
      .filter(item => !action || item.action === action)
      .filter(item => !item.actorUserId || item.actorUserId === actorUserId)
      .map(item => item.id);
    await deleteIds(toDelete);
    await emitStatus();
  }

  async function clearAll() {
    const items = await getAll();
    await deleteIds(items.map(item => item.id));
    await emitStatus();
  }

  const status = { pending: 0, conflicts: 0, failed: 0, syncing: false, byAction: {}, lastError: '', lastSavedAt: 0 };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('erp:outbox-status', event => Object.assign(status, event.detail || {}));
    window.addEventListener('online', () => scheduleFlush(0));
    window.addEventListener('load', () => {
      void emitStatus();
      scheduleFlush(250);
      setInterval(() => scheduleFlush(0), 15000);
    });
  }

  return Object.freeze({
    enqueue,
    flush,
    flushNow,
    retryFailed,
    getItem,
    applyRevisions,
    rearmConflict,
    dismissConflicts,
    clearAll,
    marksScopeKey,
    getStatus: () => ({ ...status, byAction: { ...(status.byAction || {}) } }),
    getStatusFor: action => ({ ...((status.byAction || {})[action] || { pending: 0, conflicts: 0, failed: 0, syncing: false }), lastError, lastSavedAt })
  });
});
