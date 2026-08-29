/**
 * Filtered marks live-sync for the currently selected class and subject.
 * Prefers Supabase Realtime when an authenticated bootstrap returns an anon
 * key (RLS-safe). Otherwise reconciles with getMarksV2 after reconnect /
 * while the marks screen is open. Never downloads the full school snapshot.
 */
(function () {
  'use strict';

  let channel = null;
  let pollTimer = null;
  let lastSince = '';
  let currentFilter = { className: '', subjectCode: '' };
  let supabaseClient = null;

  function marksPageOpen() {
    return String(window.location.hash || '').toLowerCase().indexOf('exams') === 0;
  }

  function currentSelection() {
    return {
      className: String(window.activeExamClass || window.activeMobileExamClass || '').trim(),
      subjectCode: String(window.activeSelectedSubjectFilter || window.activeExamSubject || window.activeMobileExamSubject || '').trim()
    };
  }

  function setStatus(kind, text) {
    window._erpMarksLiveState = { kind, text, at: Date.now() };
    window.dispatchEvent(new CustomEvent('erp:marks-live-status', { detail: window._erpMarksLiveState }));
    const nodes = [
      document.getElementById('examFocusCloudSyncStatus'),
      document.getElementById('mobileSaveStatusIndicator')
    ].filter(Boolean);
    const colors = {
      saving: '#38bdf8',
      saved: '#34d399',
      remote: '#a78bfa',
      conflict: '#f59e0b',
      offline: '#94a3b8'
    };
    nodes.forEach((node) => {
      node.style.color = colors[kind] || colors.saved;
      if (node.id === 'mobileSaveStatusIndicator' && kind !== 'saving') {
        node.className = kind === 'conflict' ? 'badge badge-warning' : (kind === 'saved' ? 'badge badge-success' : 'badge badge-info');
      }
    });
  }

  async function reconcile() {
    if (!marksPageOpen() || typeof window.refreshStudentMarksFromV2 !== 'function') return;
    const filter = currentSelection();
    currentFilter = filter;
    const result = await window.refreshStudentMarksFromV2({
      className: filter.className,
      subjectCode: filter.subjectCode === 'ALL' ? '' : filter.subjectCode,
      since: lastSince
    });
    if (result && result.ok) {
      lastSince = new Date().toISOString();
      if (result.applied > 0) setStatus('remote', 'Updated on another device');
      const hash = String(window.location.hash || '');
      if (hash.indexOf('exams') === 0 && typeof handleRouting === 'function') {
        const active = document.activeElement;
        if (!active || !active.classList || !/marks-input|exam-focus-input|mobile-term-input/.test(active.className || '')) {
          handleRouting();
        }
      }
    }
  }

  async function connectRealtime() {
    stop();
    if (!marksPageOpen()) return;
    const filter = currentSelection();
    currentFilter = filter;
    if (typeof window.getErpSessionToken === 'function' && !window.getErpSessionToken()) return;

    let config = null;
    try {
      const token = (typeof window.getErpSessionToken === 'function' && window.getErpSessionToken()) || '';
      const schoolId = String(window.ERP_CLOUD_SCHOOL_ID || 'mmm-jhs');
      const response = await fetch(`/api/erp-cloud?action=marksRealtimeConfig&schoolId=${encodeURIComponent(schoolId)}`, {
        cache: 'no-store',
        headers: token ? { 'X-ERP-Session': token, Accept: 'application/json' } : { Accept: 'application/json' }
      });
      config = await response.json();
    } catch (error) {
      config = null;
    }

    if (config && config.ok && config.enabled && config.url && config.anonKey && window.supabase?.createClient) {
      try {
        supabaseClient = window.supabase.createClient(config.url, config.anonKey, {
          realtime: { params: { eventsPerSecond: 5 } }
        });
        const cls = filter.className.replace(/,/g, '');
        const sub = String(filter.subjectCode || '').toLowerCase().replace(/,/g, '');
        const filterSql = [
          `school_id=eq.${config.schoolId}`,
          cls ? `class_name=eq.${cls}` : '',
          sub && sub !== 'all' ? `subject_code=eq.${sub}` : ''
        ].filter(Boolean).join(',');
        channel = supabaseClient.channel(`marks:${cls}:${sub}`);
        channel.on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'erp_marks',
          filter: filterSql
        }, () => { void reconcile(); });
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') setStatus('saved', 'Live marks sync connected');
        });
      } catch (error) {
        console.warn('[ERP-MARKS] realtime subscribe failed; using reconcile polling', error);
      }
    }

    await reconcile();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!marksPageOpen()) return;
      if (navigator.onLine === false) {
        setStatus('offline', 'Offline / pending');
        return;
      }
      void reconcile();
    }, 8000);
  }

  function stop() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (channel && supabaseClient) {
      try { supabaseClient.removeChannel(channel); } catch (error) {}
    }
    channel = null;
  }

  window.ErpMarksRealtime = {
    connect: connectRealtime,
    stop,
    reconcile,
    setStatus
  };

  window.addEventListener('hashchange', () => {
    if (marksPageOpen()) void connectRealtime();
    else stop();
  });
  window.addEventListener('online', () => {
    if (marksPageOpen()) void reconcile();
  });
  window.addEventListener('offline', () => setStatus('offline', 'Offline / pending'));
})();
