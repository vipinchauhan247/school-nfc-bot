/**
 * MMM JHS durable browser mutation outbox.
 *
 * Small, module-scoped edits are written to IndexedDB before navigation. The
 * queue survives refresh, browser close, mobile restarts, and temporary loss of
 * internet. Only a real server acknowledgement changes an item to `saved`.
 */
(function () {
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

  function randomId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (window.crypto && typeof window.crypto.getRandomValues === 'function') window.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function safeLocalGet(key) {
    try { return String(localStorage.getItem(key) || '').trim(); } catch (error) { return ''; }
  }

  function safeLocalSet(key, value) {
    try { localStorage.setItem(key, value); } catch (error) {}
  }

  function deviceId() {
    let value = safeLocalGet(DEVICE_ID_KEY);
    if (!value) {
      value = randomId();
      safeLocalSet(DEVICE_ID_KEY, value);
    }
    return value;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('IndexedDB is not available on this device.'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
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
    return withStore('readwrite', store => store.put(item));
  }

  async function getAll() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
      request.onerror = () => reject(request.error || new Error('Could not read the offline save queue.'));
    });
  }

  async function deleteIds(ids) {
    if (!ids.length) return;
    await withStore('readwrite', store => ids.forEach(id => store.delete(id)));
  }

  function backoffMs(attempts) {
    return Math.min(5 * 60 * 1000, Math.max(1500, (2 ** Math.min(8, attempts)) * 1000));
  }

  function apiBase() {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      const port = String(window.MMMJHS_BOT_LOCAL_PORT || '8085').trim();
      return `${window.location.protocol}//${host}:${port}/api/erp-cloud`;
    }
    return '/api/erp-cloud';
  }

  async function statusSnapshot() {
    const items = await getAll();
    const actorUserId = safeLocalGet(SESSION_USER_KEY);
    const own = items.filter(item => !item.actorUserId || item.actorUserId === actorUserId);
    const summarize = rows => ({
      pending: rows.filter(item => ['pending', 'retry', 'syncing', 'conflict'].includes(item.status)).length,
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
      window.dispatchEvent(new CustomEvent('erp:outbox-status', { detail }));
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
    const response = await fetch(`${apiBase()}?action=${encodeURIComponent(item.action)}`, {
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
      const error = new Error(data?.error || `Cloud save failed (HTTP ${response.status}).`);
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
        if (navigator.onLine === false) {
          lastError = 'Offline — changes are waiting on this device.';
          await emitStatus();
          return;
        }
        const actorUserId = safeLocalGet(SESSION_USER_KEY);
        const now = Date.now();
        const items = (await getAll())
          .filter(item => ['pending', 'retry', 'syncing', 'conflict'].includes(item.status))
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
            if (result?.savedAt && typeof window.recordCloudMutationRevision === 'function') {
              window.recordCloudMutationRevision(result.savedAt);
            }
            await put(item);
            window.dispatchEvent(new CustomEvent('erp:outbox-saved', {
              detail: { id: item.id, action: item.action, result }
            }));
          } catch (error) {
            item.attempts = Number(item.attempts || 0) + 1;
            item.updatedAt = Date.now();
            item.lastError = error?.message || 'Cloud save failed.';
            lastError = item.lastError;
            if (error?.permanent || item.attempts >= MAX_ATTEMPTS) {
              item.status = 'failed';
              item.nextAttemptAt = 0;
            } else {
              item.status = error?.conflict ? 'conflict' : 'retry';
              item.nextAttemptAt = Date.now() + backoffMs(item.attempts);
            }
            await put(item);
            if (item.status !== 'failed') scheduleFlush(Math.max(1000, item.nextAttemptAt - Date.now()));
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
        .filter(item => ['pending', 'retry', 'conflict'].includes(item.status))
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
    const item = {
      id: randomId(),
      action,
      payload: payload && typeof payload === 'object' ? payload : {},
      schoolId: safeLocalGet(SCHOOL_ID_KEY) || String(window.ERP_CLOUD_SCHOOL_ID || 'mmm-jhs'),
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
      if (!['pending', 'retry', 'conflict'].includes(item.status)) continue;
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

  const status = { pending: 0, failed: 0, syncing: false, byAction: {}, lastError: '', lastSavedAt: 0 };
  window.addEventListener('erp:outbox-status', event => Object.assign(status, event.detail || {}));
  window.addEventListener('online', () => scheduleFlush(0));
  window.addEventListener('load', () => {
    void emitStatus();
    scheduleFlush(250);
    setInterval(() => scheduleFlush(0), 15000);
  });

  window.ERPOutbox = Object.freeze({
    enqueue,
    flush,
    flushNow,
    retryFailed,
    getStatus: () => ({ ...status, byAction: { ...(status.byAction || {}) } }),
    getStatusFor: action => ({ ...((status.byAction || {})[action] || { pending: 0, failed: 0, syncing: false }), lastError, lastSavedAt })
  });
})();
