/**
 * Targeted V2 ERP reads/writes. Routine traffic must not download the full
 * school snapshot or embedded photos. Marks are one row per
 * student+subject+assessment with revision-based OCC (HTTP 409).
 */
'use strict';

const lean = require('../lib/erpLean');

const V2_ACTIONS = new Set([
  'getBootV2', 'v2Boot',
  'getStudentsV2', 'v2Students',
  'getMarksV2', 'v2Marks', 'getMarksDelta',
  'saveMarksDelta',
  'getAttendanceV2',
  'getExamSchedulesV2',
  'getFeeLedgerV2',
  'getPhotoV2', 'v2Photo',
  'marksRealtimeConfig',
  'cloudPullLean'
]);

function createErpV2(deps) {
  const {
    json,
    supabaseRequest,
    readSnapshot,
    readSnapshotVersion,
    writeSnapshot,
    snapshotForBrowser,
    requireErpSession,
    authorize,
    schoolIdDefault,
    writeAuditLog,
    listNativeStudents,
    listNativePayments
  } = deps;

  async function tryLeanBootRpc(schoolId) {
    try {
      const rows = await supabaseRequest('POST', 'rpc/erp_lean_boot', { p_school_id: schoolId });
      const data = Array.isArray(rows) ? rows[0] : rows;
      if (data && data.ok !== false) return data;
    } catch (error) {
      return null;
    }
    return null;
  }

  async function loadSnapshot(schoolId) {
    const snapshot = await readSnapshot(schoolId);
    return snapshot || null;
  }

  async function handleBoot(req, res, schoolId) {
    const rpc = await tryLeanBootRpc(schoolId);
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || req.query.limit || 50);
    const className = String(req.query.className || req.query.classKey || '').trim();
    if (rpc && rpc.students) {
      const filtered = lean.filterStudents(rpc.students, { className, search: req.query.q });
      const paged = lean.paginate(filtered, page, pageSize);
      return json(res, 200, {
        ok: true,
        configured: true,
        schoolId,
        v2: true,
        source: 'rpc',
        savedAt: rpc.savedAt || '',
        version: rpc.version || '',
        activeSession: rpc.activeSession || '',
        classes: rpc.classes || [],
        subjects: rpc.subjects || {},
        staffUsers: Array.isArray(rpc.staffUsers) ? rpc.staffUsers.map((user) => {
          if (!user) return user;
          const copy = { ...user };
          delete copy.password;
          delete copy.passwordHash;
          return copy;
        }) : [],
        teachers: rpc.teachers || [],
        schoolProfile: lean.stripProfileImages(rpc.schoolProfile),
        examSubjectConfigs: rpc.examSubjectConfigs || {},
        periodSettings: rpc.periodSettings || {},
        students: paged.items,
        studentCount: Number(rpc.studentCount || rpc.students.length || 0),
        filteredCount: filtered.length,
        page: paged.page,
        pageSize: paged.pageSize,
        pages: paged.pages,
        hasMore: paged.hasMore,
        photosOmitted: true,
        lean: true
      });
    }

    const snapshot = await loadSnapshot(schoolId);
    const payload = lean.leanPayload(snapshot?.payload || {}, {
      page, pageSize, className, search: req.query.q
    });
    return json(res, 200, {
      ok: true,
      configured: true,
      schoolId,
      v2: true,
      source: 'snapshot-stripped',
      savedAt: snapshot?.saved_at || payload.savedAt || '',
      ...payload
    });
  }

  async function handleStudents(req, res, schoolId) {
    const page = Number(req.query.page || 1);
    const pageSize = Number(req.query.pageSize || req.query.limit || 50);
    const className = String(req.query.className || req.query.classKey || '').trim();
    const admissionNo = lean.normalizeAdmission(req.query.admissionNo);
    let rows = [];
    try {
      const native = await supabaseRequest(
        'GET',
        `erp_students?school_id=eq.${encodeURIComponent(schoolId)}&select=${lean.nativeStudentSelect()}&order=admission_no.asc&limit=5000`
      );
      rows = (Array.isArray(native) ? native : []).map((row) => ({
        admissionNo: row.admission_no,
        name: row.name,
        currentClass: row.current_class,
        currentSection: row.current_section,
        parentName: row.parent_name,
        parentPhone: row.parent_phone,
        nfcUid: row.nfc_uid,
        telegramChatId: row.school_bot_chat_id,
        telegramUserName: row.telegram_user_name,
        status: row.status,
        updatedAt: row.updated_at
      }));
    } catch (error) {
      const snapshot = await loadSnapshot(schoolId);
      rows = (snapshot?.payload?.students || []).map(lean.directoryStudent);
    }
    if (admissionNo) {
      rows = rows.filter((row) => lean.normalizeAdmission(row.admissionNo) === admissionNo);
    }
    const filtered = lean.filterStudents(rows, {
      className,
      section: req.query.section,
      search: req.query.q,
      fromAdmission: req.query.fromAdmission,
      toAdmission: req.query.toAdmission
    });
    const paged = lean.paginate(filtered, page, pageSize);
    return json(res, 200, {
      ok: true,
      v2: true,
      schoolId,
      students: paged.items,
      count: filtered.length,
      page: paged.page,
      pageSize: paged.pageSize,
      pages: paged.pages,
      hasMore: paged.hasMore,
      photosOmitted: true
    });
  }

  async function readMarksTable(schoolId, options) {
    const parts = [`school_id=eq.${encodeURIComponent(schoolId)}`];
    if (options.className) parts.push(`class_name=eq.${encodeURIComponent(options.className)}`);
    if (options.subjectCode) parts.push(`subject_code=eq.${encodeURIComponent(lean.normalizeKey(options.subjectCode))}`);
    if (options.admissionNo) parts.push(`admission_no=eq.${encodeURIComponent(options.admissionNo)}`);
    if (options.sessionName) parts.push(`session_name=eq.${encodeURIComponent(options.sessionName)}`);
    if (options.since) parts.push(`updated_at=gt.${encodeURIComponent(options.since)}`);
    const query = `erp_marks?${parts.join('&')}&select=admission_no,subject_code,assessment_key,session_name,class_name,section,term,value,max_marks,revision,updated_at,updated_by&order=admission_no.asc&limit=5000`;
    const rows = await supabaseRequest('GET', query);
    return Array.isArray(rows) ? rows.map((row) => ({
      admissionNo: row.admission_no,
      subjectCode: row.subject_code,
      assessmentKey: row.assessment_key,
      sessionName: row.session_name,
      className: row.class_name,
      section: row.section,
      term: row.term,
      value: row.value,
      max: row.max_marks,
      revision: Number(row.revision || 1),
      updatedAt: row.updated_at,
      updatedBy: row.updated_by
    })) : [];
  }

  async function handleMarksGet(req, res, schoolId) {
    const options = {
      className: String(req.query.className || req.query.classKey || '').trim(),
      subjectCode: String(req.query.subjectCode || req.query.subject || '').trim(),
      admissionNo: lean.normalizeAdmission(req.query.admissionNo),
      sessionName: String(req.query.sessionName || req.query.session || '').trim(),
      since: String(req.query.since || '').trim()
    };
    let rows = [];
    let source = 'snapshot';
    try {
      rows = await readMarksTable(schoolId, options);
      source = 'erp_marks';
    } catch (error) {
      const snapshot = await loadSnapshot(schoolId);
      rows = lean.extractMarks(snapshot?.payload?.students || [], options);
    }
    return json(res, 200, {
      ok: true,
      v2: true,
      schoolId,
      source,
      marks: lean.marksMapFromRows(rows),
      rows,
      count: rows.length
    });
  }

  async function upsertMarkRow(schoolId, row) {
    const existing = await supabaseRequest(
      'GET',
      `erp_marks?school_id=eq.${encodeURIComponent(schoolId)}&admission_no=eq.${encodeURIComponent(row.admission_no)}&subject_code=eq.${encodeURIComponent(row.subject_code)}&assessment_key=eq.${encodeURIComponent(row.assessment_key)}&session_name=eq.${encodeURIComponent(row.session_name)}&select=*&limit=1`
    );
    const current = Array.isArray(existing) && existing[0] ? existing[0] : null;
    const expected = Number(row.expected_revision || 0);
    const actual = Number(current?.revision || 0);
    if (current && expected > 0 && expected < actual) {
      return { conflict: true, current };
    }
    const next = {
      school_id: schoolId,
      admission_no: row.admission_no,
      subject_code: row.subject_code,
      assessment_key: row.assessment_key,
      session_name: row.session_name || '',
      class_name: row.class_name || '',
      section: row.section || '',
      term: row.term || '',
      value: row.value,
      max_marks: row.max_marks,
      revision: actual + 1,
      updated_at: new Date().toISOString(),
      updated_by: row.updated_by || '',
      updated_by_user_id: row.updated_by_user_id || '',
      device_id: row.device_id || ''
    };
    await supabaseRequest(
      'POST',
      'erp_marks?on_conflict=school_id,admission_no,subject_code,assessment_key,session_name',
      next,
      'resolution=merge-duplicates,return=minimal'
    );
    return { conflict: false, next, previous: current };
  }

  async function handleMarksSave(req, res, schoolId) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST required.' });
    const session = await requireErpSession(req, res);
    if (!session) return;
    const body = req.body || {};
    const admissionNo = lean.normalizeAdmission(body.admissionNo);
    const subjectCode = lean.normalizeKey(body.subjectCode);
    const assessments = Array.isArray(body.assessments) ? body.assessments : [];
    if (!admissionNo || !subjectCode || !assessments.length) {
      return json(res, 400, { ok: false, error: 'admissionNo, subjectCode and assessments are required.' });
    }

    let student = null;
    let snapshot = null;
    try {
      const native = await supabaseRequest(
        'GET',
        `erp_students?school_id=eq.${encodeURIComponent(schoolId)}&admission_no=eq.${encodeURIComponent(admissionNo)}&select=${lean.nativeStudentSelect()}&limit=1`
      );
      const row = Array.isArray(native) && native[0];
      if (row) {
        student = {
          admissionNo: row.admission_no,
          name: row.name,
          currentClass: row.current_class,
          currentSection: row.current_section,
          examMarks: {}
        };
      }
    } catch (error) {}
    if (!student) {
      snapshot = await loadSnapshot(schoolId);
      const students = Array.isArray(snapshot?.payload?.students) ? snapshot.payload.students : [];
      student = students.find((item) => lean.normalizeAdmission(item?.admissionNo || item?.AdmissionNo) === admissionNo) || null;
    }
    if (!student) return json(res, 404, { ok: false, error: 'Student not found.' });

    const actor = {
      userId: session.user_id,
      username: session.username,
      name: session.user_name
    };
    const memoryResult = lean.applyMarksDelta({ ...student, examMarks: student.examMarks ? { ...student.examMarks } : {} }, body, actor);

    const tableConflicts = [];
    const tableApplied = [];
    for (const item of assessments) {
      const key = lean.normalizeKey(item.key || item.assessmentKey);
      if (!key) continue;
      try {
        const saved = await upsertMarkRow(schoolId, {
          admission_no: admissionNo,
          subject_code: subjectCode,
          assessment_key: key,
          session_name: String(body.sessionName || snapshot?.payload?.activeSession || ''),
          class_name: String(body.className || student.currentClass || ''),
          section: String(body.section || student.currentSection || ''),
          term: String(body.term || ''),
          value: item.value,
          max_marks: item.max,
          expected_revision: item.expectedRevision || item.revision || body.expectedRevision,
          updated_by: actor.name,
          updated_by_user_id: actor.userId,
          device_id: body.deviceId || ''
        });
        if (saved.conflict) {
          tableConflicts.push({
            assessmentKey: key,
            current: saved.current,
            attempted: item.value
          });
        } else {
          tableApplied.push(saved.next);
          try {
            await supabaseRequest('POST', 'erp_marks_audit', {
              school_id: schoolId,
              admission_no: admissionNo,
              subject_code: subjectCode,
              assessment_key: key,
              session_name: String(body.sessionName || ''),
              old_value: saved.previous ? String(saved.previous.value ?? '') : '',
              new_value: String(item.value ?? ''),
              actor_user_id: actor.userId,
              actor_username: actor.username,
              actor_name: actor.name,
              device_id: body.deviceId || ''
            }, 'return=minimal');
          } catch (auditError) {
            console.error('[ERP-V2] marks audit failed:', auditError.message);
          }
        }
      } catch (error) {
        if (!/erp_marks|schema cache|does not exist/i.test(String(error.message || ''))) {
          console.error('[ERP-V2] marks table write failed:', error.message);
        }
      }
    }

    if (tableConflicts.length && !tableApplied.length) {
      return json(res, 409, {
        ok: false,
        conflict: true,
        error: 'Updated on another device. Refresh to load the latest marks.',
        conflicts: tableConflicts
      });
    }

    if (memoryResult.conflict && !memoryResult.applied?.length && !tableApplied.length) {
      return json(res, 409, memoryResult);
    }

    // Authoritative path is erp_marks. Do not rewrite the full school snapshot
    // on every cell save — that was a primary egress and last-write-wins source.
    if (!tableApplied.length && snapshot && Array.isArray(snapshot.payload?.students)) {
      const payload = { ...snapshot.payload, students: snapshot.payload.students, savedAt: new Date().toISOString() };
      const idx = payload.students.findIndex((item) => lean.normalizeAdmission(item?.admissionNo) === admissionNo);
      if (idx >= 0 && memoryResult.student) payload.students[idx] = memoryResult.student;
      await writeSnapshot(schoolId, payload, `marks-delta:${actor.username || actor.userId}`);
    }

    await writeAuditLog({
      school_id: schoolId,
      actor_user_id: actor.userId,
      actor_username: actor.username,
      actor_name: actor.name,
      actor_role: session.role,
      login_session_id: session.id,
      action: 'MARKS_DELTA',
      entity_type: 'exam_marks',
      entity_id: `${admissionNo}:${subjectCode}`,
      metadata: {
        applied: (tableApplied.length || memoryResult.applied?.length || 0),
        conflicts: (tableConflicts.length || memoryResult.conflicts?.length || 0),
        mutationId: body.mutationId || '',
        table: tableApplied.length > 0
      }
    });

    const conflicts = [...(memoryResult.conflicts || []), ...tableConflicts];
    const status = (tableConflicts.length && !tableApplied.length) || (conflicts.length && !tableApplied.length && !memoryResult.applied?.length) ? 409 : 200;
    return json(res, status, {
      ok: status === 200,
      conflict: status === 409,
      savedAt: new Date().toISOString(),
      applied: tableApplied.length ? tableApplied.map((row) => ({
        assessmentKey: row.assessment_key,
        value: row.value,
        revision: row.revision,
        updatedAt: row.updated_at
      })) : memoryResult.applied,
      conflicts,
      table: tableApplied.length > 0
    });
  }

  async function handleAttendance(req, res, schoolId) {
    const snapshot = await loadSnapshot(schoolId);
    const admissionNo = lean.normalizeAdmission(req.query.admissionNo);
    const date = String(req.query.date || '').slice(0, 10);
    const attendance = {};
    (snapshot?.payload?.students || []).forEach((student) => {
      const adm = lean.normalizeAdmission(student.admissionNo);
      if (admissionNo && adm !== admissionNo) return;
      const logs = student.attendanceLogs || student.attendance || {};
      if (date) {
        if (logs[date]) {
          attendance[adm] = { [date]: logs[date] };
        }
      } else {
        attendance[adm] = logs;
      }
    });
    return json(res, 200, { ok: true, v2: true, schoolId, attendance });
  }

  async function handleExamSchedules(req, res, schoolId) {
    const snapshot = await loadSnapshot(schoolId);
    const schedules = snapshot?.payload?.examSchedules || snapshot?.payload?.examSubjectConfigs || [];
    return json(res, 200, { ok: true, v2: true, schoolId, schedules });
  }

  async function handleFeeLedger(req, res, schoolId) {
    const admissionNo = lean.normalizeAdmission(req.query.admissionNo);
    let payments = [];
    try {
      const native = await listNativePayments(schoolId);
      payments = (native || []).filter((row) => !admissionNo || lean.normalizeAdmission(row.admission_no) === admissionNo)
        .map((row) => ({
          admissionNo: row.admission_no,
          receiptNo: row.receipt_no,
          sessionName: row.session_name,
          amount: row.amount,
          paidOn: row.paid_on,
          month: row.month,
          mode: row.mode,
          cancelled: row.cancelled
        }));
    } catch (error) {
      const snapshot = await loadSnapshot(schoolId);
      (snapshot?.payload?.students || []).forEach((student) => {
        const adm = lean.normalizeAdmission(student.admissionNo);
        if (admissionNo && adm !== admissionNo) return;
        Object.values(student.feeRecords || {}).forEach((fee) => {
          (fee.payments || []).forEach((payment) => payments.push({ ...payment, admissionNo: adm }));
        });
      });
    }
    return json(res, 200, {
      ok: true,
      v2: true,
      schoolId,
      payments,
      complete: !!admissionNo,
      count: payments.length
    });
  }

  async function handlePhoto(req, res, schoolId) {
    const admissionNo = lean.normalizeAdmission(req.query.admissionNo);
    if (!admissionNo) return json(res, 400, { ok: false, error: 'admissionNo is required.' });
    try {
      const rows = await supabaseRequest(
        'GET',
        `erp_photos?school_id=eq.${encodeURIComponent(schoolId)}&admission_no=eq.${encodeURIComponent(admissionNo)}&select=photo_url,updated_at&limit=1`
      );
      const row = Array.isArray(rows) && rows[0];
      if (row?.photo_url) {
        return json(res, 200, { ok: true, admissionNo, photoUrl: row.photo_url, updatedAt: row.updated_at });
      }
    } catch (error) {}
    const snapshot = await loadSnapshot(schoolId);
    const student = (snapshot?.payload?.students || []).find(
      (item) => lean.normalizeAdmission(item?.admissionNo) === admissionNo
    );
    const photo = String(student?.photo || student?.photoDataUrl || student?.photoUrl || '').trim();
    const photoUrl = lean.isPhotoUrl(photo) ? photo : '';
    return json(res, 200, {
      ok: true,
      admissionNo,
      photoUrl,
      hasEmbedded: lean.isDataUrl(photo),
      omitted: lean.isDataUrl(photo)
    });
  }

  async function handleRealtimeConfig(req, res, schoolId) {
    const session = await requireErpSession(req, res);
    if (!session) return;
    const anon = String(process.env.ERP_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '').trim();
    const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const enabled = !!(anon && url && String(process.env.ERP_ENABLE_MARKS_REALTIME || '1') !== '0');
    return json(res, 200, {
      ok: true,
      enabled,
      url: enabled ? url : '',
      anonKey: enabled ? anon : '',
      table: 'erp_marks',
      schoolId,
      filterHint: `school_id=eq.${schoolId}`
    });
  }

  async function handleLeanPull(req, res, schoolId) {
    const snapshot = await loadSnapshot(schoolId);
    const payload = lean.leanPayload(snapshot?.payload || {}, {
      page: req.query.page,
      pageSize: req.query.pageSize || 80,
      className: req.query.className,
      search: req.query.q
    });
    return json(res, 200, {
      ok: true,
      configured: true,
      schoolId,
      snapshot: snapshotForBrowser({
        ...(snapshot || {}),
        payload
      }),
      studentCount: payload.studentCount,
      lean: true,
      native: true,
      feesNative: true
    });
  }

  async function route(req, res, action, schoolId) {
    const act = String(action || '').trim();
    if (!V2_ACTIONS.has(act)) return false;
    if (act === 'saveMarksDelta') {
      await handleMarksSave(req, res, schoolId);
      return true;
    }
    if (req.method !== 'GET' && act !== 'saveMarksDelta') {
      return json(res, 405, { ok: false, error: 'GET required.' }) || true;
    }
    if (act === 'getBootV2' || act === 'v2Boot' || act === 'cloudPullLean') {
      await handleBoot(req, res, schoolId);
      return true;
    }
    if (act === 'getStudentsV2' || act === 'v2Students') {
      await handleStudents(req, res, schoolId);
      return true;
    }
    if (act === 'getMarksV2' || act === 'v2Marks' || act === 'getMarksDelta') {
      await handleMarksGet(req, res, schoolId);
      return true;
    }
    if (act === 'getAttendanceV2') {
      await handleAttendance(req, res, schoolId);
      return true;
    }
    if (act === 'getExamSchedulesV2') {
      await handleExamSchedules(req, res, schoolId);
      return true;
    }
    if (act === 'getFeeLedgerV2') {
      await handleFeeLedger(req, res, schoolId);
      return true;
    }
    if (act === 'getPhotoV2' || act === 'v2Photo') {
      await handlePhoto(req, res, schoolId);
      return true;
    }
    if (act === 'marksRealtimeConfig') {
      await handleRealtimeConfig(req, res, schoolId);
      return true;
    }
    return false;
  }

  return {
    V2_ACTIONS,
    route,
    handleBoot,
    handleStudents,
    handleMarksGet,
    handleMarksSave,
    tryLeanBootRpc
  };
}

createErpV2.V2_ACTIONS = V2_ACTIONS;
module.exports = createErpV2;
