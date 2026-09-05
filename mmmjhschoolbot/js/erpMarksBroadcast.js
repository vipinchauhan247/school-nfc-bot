/**
 * MMM JHS Zero-Egress Same-Device Multi-Tab Marks Synchronization.
 *
 * Uses native browser BroadcastChannel to instantly synchronize confirmed mark saves
 * across open tabs on the same device with zero additional network/Supabase egress.
 */
(function exposeErpMarksBroadcast(root, factory) {
  const api = factory(root);
  api.createInstance = factory;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ERPMarksBroadcast = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function createErpMarksBroadcast(root) {
  'use strict';

  const SOURCE_TAB_ID = 'tab_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now().toString(36);
  const SESSION_USER_KEY = 'MMM_ERP_SessionUserId';
  const SCHOOL_ID_KEY = 'MMM_ERP_CLOUD_SCHOOL_ID';
  const STORAGE_SYNC_KEY = 'MMM_ERP_MARKS_SYNC_LAST';
  const MAX_SEEN_MUTATIONS = 500;

  const seenMutationIds = new Set();
  let userChannel = null;
  let schoolChannel = null;
  let boundUserChannelName = '';
  let boundSchoolChannelName = '';

  function safeStorageGet(storage, key) {
    try {
      if (storage) return String(storage.getItem(key) || '').trim();
    } catch (error) {}
    return '';
  }

  function safeLocalGet(key) {
    return safeStorageGet(root && root.localStorage, key);
  }

  function currentUserId() {
    return safeLocalGet(SESSION_USER_KEY) || safeStorageGet(root && root.sessionStorage, SESSION_USER_KEY);
  }

  function currentSchoolId() {
    return safeLocalGet(SCHOOL_ID_KEY) || String(root?.ERP_CLOUD_SCHOOL_ID || 'mmm-jhs').trim();
  }

  function getChannelName() {
    const schoolId = currentSchoolId().toLowerCase() || 'mmm-jhs';
    const userId = currentUserId() || 'anon';
    return `MMM_ERP_MARKS_SYNC_${schoolId}_${userId}`;
  }

  function getSchoolChannelName() {
    const schoolId = currentSchoolId().toLowerCase() || 'mmm-jhs';
    return `MMM_ERP_MARKS_SYNC_${schoolId}`;
  }

  function getBroadcastChannelClass() {
    return (root && root.BroadcastChannel) ? root.BroadcastChannel : (typeof BroadcastChannel !== 'undefined' ? BroadcastChannel : null);
  }

  function bindNamedChannel(current, boundName, desiredName) {
    if (current && boundName === desiredName) return { channel: current, boundName };
    if (current && typeof current.close === 'function') {
      try { current.close(); } catch (_) {}
    }
    const BroadcastChannelClass = getBroadcastChannelClass();
    if (!BroadcastChannelClass || !desiredName) return { channel: null, boundName: '' };
    try {
      const channel = new BroadcastChannelClass(desiredName);
      channel.onmessage = handleIncomingMessage;
      if (typeof channel.addEventListener === 'function') {
        channel.addEventListener('message', handleIncomingMessage);
      }
      return { channel, boundName: desiredName };
    } catch (err) {
      return { channel: null, boundName: '' };
    }
  }

  function getBroadcastChannel() {
    ensureListening();
    return userChannel || schoolChannel;
  }

  function ensureListening() {
    const userBind = bindNamedChannel(userChannel, boundUserChannelName, getChannelName());
    userChannel = userBind.channel;
    boundUserChannelName = userBind.boundName;
    const schoolBind = bindNamedChannel(schoolChannel, boundSchoolChannelName, getSchoolChannelName());
    schoolChannel = schoolBind.channel;
    boundSchoolChannelName = schoolBind.boundName;
    return userChannel || schoolChannel;
  }

  function isListening() {
    return Boolean(
      (userChannel && boundUserChannelName === getChannelName()) ||
      (schoolChannel && boundSchoolChannelName === getSchoolChannelName())
    );
  }

  function postToOpenChannels(message) {
    ensureListening();
    let sent = false;
    [userChannel, schoolChannel].forEach(ch => {
      if (!ch || typeof ch.postMessage !== 'function') return;
      try {
        ch.postMessage(message);
        sent = true;
      } catch (err) {}
    });
    // Same-origin tabs always get storage events, even when BroadcastChannel
    // is blocked, bound to a different user id, or not yet listening.
    try {
      if (root && root.localStorage && typeof root.localStorage.setItem === 'function') {
        root.localStorage.setItem(STORAGE_SYNC_KEY, JSON.stringify({
          ...message,
          postedAt: Date.now()
        }));
        sent = true;
      }
    } catch (err) {}
    return sent;
  }

  function broadcastConfirmedMarks(item, result) {
    if (!item || item.action !== 'saveMarksDelta' || !result || result.ok !== true) return false;
    const payload = item.payload || {};
    const mutationId = String(item.id || payload.mutationId || '');
    if (!mutationId) return false;

    // Track as seen locally so we never process our own broadcast
    seenMutationIds.add(mutationId);

    const assessments = Array.isArray(payload.assessments) ? payload.assessments.map(a => ({
      key: String(a.key || '').trim().toLowerCase(),
      value: String(a.value !== undefined && a.value !== null ? a.value : '').trim().toUpperCase(),
      max: Number(a.max || 100)
    })) : [];

    const message = {
      type: 'marks:saved',
      sourceTabId: SOURCE_TAB_ID,
      mutationId,
      schoolId: String(item.schoolId || currentSchoolId() || 'mmm-jhs').trim(),
      actorUserId: String(item.actorUserId || currentUserId() || '').trim(),
      sessionName: String(payload.sessionName || ''),
      className: String(payload.className || ''),
      section: String(payload.section || ''),
      admissionNo: String(payload.admissionNo || '').trim(),
      subjectCode: String(payload.subjectCode || '').trim().toLowerCase(),
      term: String(payload.term || '').trim().toLowerCase(),
      assessments,
      revisions: (result.revisions && typeof result.revisions === 'object') ? result.revisions : {},
      savedAt: result.savedAt || new Date().toISOString()
    };

    return postToOpenChannels(message);
  }

  function handleIncomingMessage(event) {
    const data = event?.data;
    if (!data || data.type !== 'marks:saved') return;

    // 1. Ignore events originated from this tab
    if (data.sourceTabId === SOURCE_TAB_ID) return;

    // 2. Ignore events from a different school
    const schoolId = currentSchoolId();
    if (data.schoolId && schoolId && String(data.schoolId).trim().toLowerCase() !== String(schoolId).trim().toLowerCase()) {
      return;
    }

    // 3. Duplicate and loop protection
    const mutationId = String(data.mutationId || '');
    if (mutationId) {
      if (seenMutationIds.has(mutationId)) return;
      seenMutationIds.add(mutationId);
      if (seenMutationIds.size > MAX_SEEN_MUTATIONS) {
        const first = seenMutationIds.values().next().value;
        seenMutationIds.delete(first);
      }
    }

    // 5. Apply confirmed marks to ErpV2ReadModel / SchoolData
    const admissionNo = String(data.admissionNo || '').trim();
    const subjectCode = String(data.subjectCode || '').trim().toLowerCase();
    const assessments = Array.isArray(data.assessments) ? data.assessments : [];
    const revisions = data.revisions;

    if (admissionNo && subjectCode && assessments.length) {
      const marksMap = { [admissionNo]: { [subjectCode]: {} } };
      assessments.forEach(a => {
        if (a && a.key) marksMap[admissionNo][subjectCode][a.key] = a.value;
      });

      if (root?.SchoolData && root?.ErpV2ReadModel) {
        if (typeof root.ErpV2ReadModel.applyMarks === 'function') {
          root.ErpV2ReadModel.applyMarks({ schoolData: root.SchoolData, marks: marksMap });
        }
        if (revisions && typeof root.ErpV2ReadModel.applyMarkRevisions === 'function') {
          root.ErpV2ReadModel.applyMarkRevisions({ schoolData: root.SchoolData, revisions });
        }
      }

      // Update outbox revisions (only updates active pending/retry items, NEVER revives conflicts)
      if (revisions && root?.ERPOutbox?.applyRevisions) {
        root.ERPOutbox.applyRevisions(revisions);
      }

      // Save to local storage silently without network egress
      if (typeof root?.saveSchoolDataToStorage === 'function') {
        try { root.saveSchoolDataToStorage({ skipCloudPush: true }); } catch (_) {}
      }

      // 6. Update currently visible UI DOM elements
      if (typeof root?.applyRemoteMarksToDom === 'function') {
        root.applyRemoteMarksToDom({
          admissionNo,
          subjectCode,
          className: data.className,
          term: data.term,
          assessments
        });
      }
      if (typeof root?.syncVisibleMarksInputsFromModel === 'function') {
        root.syncVisibleMarksInputsFromModel();
      }

      if (root && typeof root.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        root.dispatchEvent(new CustomEvent('erp:marks-sync-received', { detail: data }));
      }
    }
  }

  // Hook to erp:outbox-saved event
  if (root && typeof root.addEventListener === 'function') {
    root.addEventListener('erp:outbox-saved', event => {
      const detail = event?.detail;
      if (detail?.action === 'saveMarksDelta' && detail?.result?.ok === true) {
        broadcastConfirmedMarks(detail.item, detail.result);
      }
    });
    root.addEventListener('storage', event => {
      if (event.key === SESSION_USER_KEY || event.key === SCHOOL_ID_KEY || event.key == null) {
        ensureListening();
      }
      if (event.key === STORAGE_SYNC_KEY && event.newValue) {
        try {
          handleIncomingMessage({ data: JSON.parse(event.newValue) });
        } catch (_) {}
      }
    });
    root.addEventListener('focus', () => { ensureListening(); });
    root.addEventListener('pageshow', () => { ensureListening(); });
    if (root.document && typeof root.document.addEventListener === 'function') {
      root.document.addEventListener('visibilitychange', () => { ensureListening(); });
    }
  }

  // Passive receiver: open the channel on load. Do not wait for this tab to save.
  // Skip the host global in Node (no localStorage/document) so unit tests can exit.
  if (root && (root.localStorage || root.document || (typeof window !== 'undefined' && root === window))) {
    ensureListening();
  }

  return Object.freeze({
    SOURCE_TAB_ID,
    getChannelName,
    getSchoolChannelName,
    broadcastConfirmedMarks,
    handleIncomingMessage,
    getBroadcastChannel,
    ensureListening,
    isListening,
    getBoundChannelName: () => boundUserChannelName,
    createInstance: (customRoot) => createErpMarksBroadcast(customRoot)
  });
});
