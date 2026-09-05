'use strict';

(function exposeErpV2ReadModel(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ErpV2ReadModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function createErpV2ReadModel() {
  function normalizeAdmission(value) {
    const raw = String(value || '').trim();
    return raw.replace(/^0+/, '') || raw;
  }

  function paymentKey(payment) {
    return String(payment?.receiptNo || payment?.paymentId || '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase();
  }

  function uniquePosted(payments) {
    const seen = new Set();
    return (Array.isArray(payments) ? payments : []).filter(payment => {
      if (!payment || payment.cancelled === true || ['cancelled', 'refunded'].includes(String(payment.status || '').toLowerCase())) return false;
      const key = paymentKey(payment);
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });
  }

  function findStudent(schoolData, admissionNo) {
    if (!schoolData || !Array.isArray(schoolData.students)) return null;
    const wanted = normalizeAdmission(admissionNo);
    return schoolData.students.find(student => (
      normalizeAdmission(student?.admissionNo || student?.AdmissionNo) === wanted
    )) || null;
  }

  function applyMarks({ schoolData, marks }) {
    let applied = 0;
    if (Array.isArray(marks)) {
      for (const row of marks) {
        const student = findStudent(schoolData, row?.admission_no || row?.admissionNo);
        const subject = String(row?.subject_code || row?.subjectCode || '').trim().toLowerCase();
        const assessment = String(row?.assessment_key || row?.assessmentKey || '').trim().toLowerCase();
        if (!student || !subject || !assessment) continue;
        if (!student.examMarks || typeof student.examMarks !== 'object') student.examMarks = {};
        if (!student.examMarks[subject] || typeof student.examMarks[subject] !== 'object') student.examMarks[subject] = {};
        student.examMarks[subject][assessment] = (row && typeof row === 'object' && (row.revision || row.updated_at))
          ? { value: row?.score_raw ?? row?.raw_value ?? row?.value, revision: Number(row.revision || 1), updatedAt: row.updatedAt || row.updated_at || '' }
          : (row?.score_raw ?? row?.raw_value ?? row?.value);
        applied += 1;
      }
      return { applied };
    }

    for (const [admissionNo, subjects] of Object.entries(marks && typeof marks === 'object' ? marks : {})) {
      const student = findStudent(schoolData, admissionNo);
      if (!student || !subjects || typeof subjects !== 'object') continue;
      if (!student.examMarks || typeof student.examMarks !== 'object') student.examMarks = {};
      for (const [subjectCode, assessments] of Object.entries(subjects)) {
        const subject = String(subjectCode || '').trim().toLowerCase();
        if (!subject || !assessments || typeof assessments !== 'object') continue;
        if (!student.examMarks[subject] || typeof student.examMarks[subject] !== 'object') student.examMarks[subject] = {};
        for (const [assessmentKey, value] of Object.entries(assessments)) {
          const assessment = String(assessmentKey || '').trim().toLowerCase();
          if (!assessment) continue;
          student.examMarks[subject][assessment] = value && typeof value === 'object' && value.revision
            ? value
            : value;
          applied += 1;
        }
      }
    }
    return { applied };
  }

  function applyAttendance({ schoolData, attendance }) {
    let applied = 0;
    if (Array.isArray(attendance)) {
      for (const row of attendance) {
        const student = findStudent(schoolData, row?.admission_no || row?.admissionNo);
        const date = String(row?.date || row?.attendance_date || '').slice(0, 10);
        const status = typeof row?.status === 'object' ? row.status.status : row?.status;
        if (!student || !date || !status) continue;
        if (!student.attendance || typeof student.attendance !== 'object') student.attendance = {};
        student.attendance[date] = status;
        applied += 1;
      }
      return { applied };
    }

    for (const [admissionNo, dates] of Object.entries(attendance && typeof attendance === 'object' ? attendance : {})) {
      const student = findStudent(schoolData, admissionNo);
      if (!student || !dates || typeof dates !== 'object') continue;
      if (!student.attendance || typeof student.attendance !== 'object') student.attendance = {};
      for (const [dateKey, record] of Object.entries(dates)) {
        const date = String(dateKey || '').slice(0, 10);
        const status = record && typeof record === 'object' ? record.status : record;
        if (!date || !status) continue;
        student.attendance[date] = status;
        applied += 1;
      }
    }
    return { applied };
  }

  function applyStudents({ schoolData, students }) {
    let applied = 0;
    for (const row of Array.isArray(students) ? students : []) {
      const student = findStudent(schoolData, row?.admission_no || row?.admissionNo);
      if (!student) continue;
      const fullName = row?.full_name ?? row?.fullName ?? row?.name;
      const className = row?.class_name ?? row?.current_class ?? row?.currentClass;
      const sectionName = row?.section_name ?? row?.current_section ?? row?.currentSection;
      const mappings = [
        [['name', 'fullName'], fullName],
        [['currentClass', 'className'], className],
        [['currentSection', 'section'], sectionName],
        [['rollNo'], row?.roll_no ?? row?.rollNo],
        [['gender'], row?.gender],
        [['dateOfBirth', 'dob'], row?.date_of_birth ?? row?.dateOfBirth],
        [['status'], row?.status],
        [['parentName'], row?.parent_name ?? row?.parentName],
        [['parentPhone'], row?.parent_phone ?? row?.parentPhone],
        [['nfcUid'], row?.nfc_uid ?? row?.nfcUid]
      ];
      mappings.forEach(([keys, value]) => {
        if (value === undefined || value === null || value === '') return;
        keys.forEach(key => { student[key] = value; });
      });
      applied += 1;
    }
    return { applied };
  }

  function flattenExamSchedules(schedules) {
    const rows = [];
    for (const schedule of Array.isArray(schedules) ? schedules : []) {
      const papers = Array.isArray(schedule?.papers) ? schedule.papers : null;
      if (!papers) {
        rows.push(schedule);
        continue;
      }
      papers.forEach((paper, index) => {
        rows.push({
          id: `${schedule.id || 'schedule'}:${paper.id || index}`,
          scheduleId: schedule.id || null,
          title: schedule.title || '',
          status: schedule.status || '',
          term: schedule.term || '',
          className: schedule.className || schedule.class_name || '',
          section: paper.section || schedule.section || 'ALL',
          subject: paper.subject || paper.subject_code || '',
          subjectName: paper.subjectName || paper.subject_name || '',
          date: paper.date || paper.exam_date || '',
          startTime: paper.startTime || paper.start_time || '',
          endTime: paper.endTime || paper.end_time || '',
          maxMarks: paper.maxMarks ?? paper.max_marks ?? '',
          instructions: paper.instructions || ''
        });
      });
    }
    return rows;
  }

  function applyExamSchedules({ schoolData, schedules }) {
    if (!schoolData || typeof schoolData !== 'object') return { applied: 0 };
    const rows = flattenExamSchedules(schedules);
    schoolData.examSchedules = rows;
    return { applied: rows.length };
  }

  function applyFeeLedger({ schoolData, payments, requestedAdmission, complete }) {
    if (!schoolData || !Array.isArray(schoolData.students)) return { reconciledStudents: 0, mismatchedStudents: 0 };
    const rowsByAdmission = new Map();
    for (const payment of Array.isArray(payments) ? payments : []) {
      const key = normalizeAdmission(payment?.admissionNo);
      if (!key) continue;
      if (!rowsByAdmission.has(key)) rowsByAdmission.set(key, []);
      rowsByAdmission.get(key).push(payment);
    }

    const requested = normalizeAdmission(requestedAdmission);
    const targets = requested
      ? schoolData.students.filter(student => normalizeAdmission(student?.admissionNo || student?.AdmissionNo) === requested)
      : schoolData.students;
    let reconciledStudents = 0;
    let mismatchedStudents = 0;

    for (const student of targets) {
      const admission = normalizeAdmission(student?.admissionNo || student?.AdmissionNo);
      const v2Rows = rowsByAdmission.get(admission) || [];
      const v2Posted = uniquePosted(v2Rows);
      const snapshotRows = Object.values(student?.feeRecords || {})
        .flatMap(record => Array.isArray(record?.payments) ? record.payments : []);
      const snapshotPosted = uniquePosted(snapshotRows);
      const v2Total = v2Posted.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const snapshotTotal = snapshotPosted.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const reconciled = Math.abs(v2Total - snapshotTotal) < 0.005;

      student.v2FeePayments = v2Rows;
      student.feeTotalPaidV2 = v2Total;
      student.v2Reconciled = reconciled;
      if (!reconciled || complete !== true) {
        mismatchedStudents += 1;
        continue;
      }

      const postedBySession = new Map();
      for (const payment of v2Posted) {
        const sessionName = String(payment.sessionName || schoolData.activeSession || '').trim();
        if (!sessionName) continue;
        if (!postedBySession.has(sessionName)) postedBySession.set(sessionName, []);
        postedBySession.get(sessionName).push(payment);
      }
      if (!student.feeRecords || typeof student.feeRecords !== 'object') student.feeRecords = {};
      const sessions = new Set([...Object.keys(student.feeRecords), ...postedBySession.keys()]);
      sessions.forEach(sessionName => {
        const existing = student.feeRecords[sessionName] && typeof student.feeRecords[sessionName] === 'object'
          ? student.feeRecords[sessionName]
          : {};
        student.feeRecords[sessionName] = { ...existing, payments: postedBySession.get(sessionName) || [] };
      });
      const activeSession = String(schoolData.activeSession || '').trim();
      if (activeSession && student.feeRecords[activeSession]) student.currentFeeInfo = student.feeRecords[activeSession];
      reconciledStudents += 1;
    }

    return { reconciledStudents, mismatchedStudents };
  }

  return {
    normalizeAdmission,
    uniquePosted,
    applyMarks,
    applyAttendance,
    applyStudents,
    flattenExamSchedules,
    applyExamSchedules,
    applyFeeLedger
  };
});
