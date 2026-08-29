/**
 * Pure helpers for lean ERP payloads, targeted V2 reads, and per-cell marks OCC.
 * No I/O. Used by the API and by the offline measurement tests.
 */
'use strict';

const HEAVY_STUDENT_KEYS = [
  'photo', 'photoDataUrl', 'photo_url', 'signature', 'signatureDataUrl'
];

const DIRECTORY_KEEP_KEYS = [
  'id', 'admissionNo', 'AdmissionNo', 'name', 'fullName',
  'currentClass', 'class', 'className', 'currentSection', 'section',
  'rollNo', 'roll_no', 'gender', 'status', 'parentName', 'parentPhone', 'phone',
  'nfcUid', 'cardUid', 'telegramChatId', 'schoolBotChatId', 'telegramUserName',
  'dob', 'dateOfBirth', 'hasPhoto', 'photoUrl', 'updatedAt'
];

function normalizeAdmission(value) {
  let s = String(value || '').trim();
  if (s.endsWith('.0') && /^\d+$/.test(s.slice(0, -2))) s = s.slice(0, -2);
  return s;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isDataUrl(value) {
  return typeof value === 'string' && value.indexOf('data:') === 0 && value.length > 64;
}

function isPhotoUrl(value) {
  const photo = String(value || '').trim();
  if (!photo) return false;
  if (photo.startsWith('assets/students/') && /\.(jpe?g|png|webp)$/i.test(photo)) return true;
  if (/supabase\.co\/storage\/v1\/object\/public\//i.test(photo)) return true;
  if (/^https?:\/\//i.test(photo) && !/unsplash|placeholder|dicebear|gravatar/i.test(photo)) return true;
  return false;
}

function byteLength(value) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function stripStudentPhotos(student) {
  if (!student || typeof student !== 'object') return student;
  const copy = { ...student };
  const photo = String(copy.photo || copy.photoDataUrl || '').trim();
  const hasEmbedded = isDataUrl(photo);
  const url = isPhotoUrl(photo) ? photo : (isPhotoUrl(copy.photoUrl) ? copy.photoUrl : '');
  copy.hasPhoto = !!(hasEmbedded || url || copy.hasPhoto);
  copy.photoUrl = url || '';
  HEAVY_STUDENT_KEYS.forEach((key) => { delete copy[key]; });
  return copy;
}

function directoryStudent(student) {
  const stripped = stripStudentPhotos(student);
  const out = {};
  DIRECTORY_KEEP_KEYS.forEach((key) => {
    if (stripped[key] !== undefined && stripped[key] !== null && stripped[key] !== '') {
      out[key] = stripped[key];
    }
  });
  out.admissionNo = normalizeAdmission(stripped.admissionNo || stripped.AdmissionNo);
  out.name = String(stripped.name || stripped.fullName || '').trim();
  out.currentClass = String(stripped.currentClass || stripped.class || stripped.className || '').trim();
  out.currentSection = String(stripped.currentSection || stripped.section || '').trim();
  out.hasPhoto = !!stripped.hasPhoto;
  out.photoUrl = stripped.photoUrl || '';
  return out;
}

function stripProfileImages(profile) {
  if (!profile || typeof profile !== 'object') return profile || {};
  const copy = { ...profile };
  Object.keys(copy).forEach((key) => {
    if (typeof copy[key] === 'string' && isDataUrl(copy[key])) {
      copy[key] = copy[key].length > 200 ? `[omitted ${copy[key].length} bytes]` : '';
    }
  });
  return copy;
}

function stripSignatures(signatures) {
  if (!signatures || typeof signatures !== 'object') return {};
  const copy = {};
  Object.keys(signatures).forEach((key) => {
    const value = signatures[key];
    if (typeof value === 'string' && isDataUrl(value)) {
      copy[key] = { present: true, bytes: value.length };
    } else {
      copy[key] = value;
    }
  });
  return copy;
}

function paginate(items, page, pageSize) {
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const total = Array.isArray(items) ? items.length : 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(pages, Math.max(1, Number(page) || 1));
  const start = (current - 1) * size;
  return {
    page: current,
    pageSize: size,
    total,
    pages,
    hasMore: current < pages,
    items: Array.isArray(items) ? items.slice(start, start + size) : []
  };
}

function filterStudents(students, options) {
  const className = String(options?.className || options?.classKey || '').trim();
  const section = String(options?.section || '').trim();
  const search = normalizeKey(options?.search || options?.q || '');
  const rangeStart = normalizeAdmission(options?.fromAdmission || options?.rangeStart || '');
  const rangeEnd = normalizeAdmission(options?.toAdmission || options?.rangeEnd || '');
  return (Array.isArray(students) ? students : []).filter((student) => {
    const currentClass = String(student.currentClass || student.class || '').trim();
    const currentSection = String(student.currentSection || student.section || '').trim();
    if (className && className !== 'ALL' && currentClass !== className) return false;
    if (section && section !== 'ALL' && currentSection !== section) return false;
    const admission = normalizeAdmission(student.admissionNo || student.AdmissionNo);
    if (rangeStart && admission && admission < rangeStart) return false;
    if (rangeEnd && admission && admission > rangeEnd) return false;
    if (search) {
      const hay = normalizeKey([
        student.name, admission, student.parentName, student.parentPhone, student.nfcUid
      ].join(' '));
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function leanPayload(payload, options) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const students = Array.isArray(src.students) ? src.students.map(directoryStudent) : [];
  const filtered = filterStudents(students, options || {});
  const page = paginate(filtered, options?.page, options?.pageSize);
  return {
    version: src.version || '2.1',
    savedAt: src.savedAt || '',
    activeSession: src.activeSession || '',
    classes: src.classes || [],
    subjects: src.subjects || {},
    staffUsers: Array.isArray(src.staffUsers) ? src.staffUsers.map((user) => {
      if (!user || typeof user !== 'object') return user;
      const copy = { ...user };
      delete copy.password;
      delete copy.passwordHash;
      delete copy.password_hash;
      return copy;
    }) : [],
    teachers: Array.isArray(src.teachers) ? src.teachers.map((teacher) => {
      if (!teacher || typeof teacher !== 'object') return teacher;
      const copy = { ...teacher };
      delete copy.photo;
      delete copy.photoDataUrl;
      delete copy.signature;
      return copy;
    }) : [],
    schoolProfile: stripProfileImages(src.schoolProfile),
    signatures: stripSignatures(src.signatures),
    examSubjectConfigs: src.examSubjectConfigs || {},
    periodSettings: src.periodSettings || {},
    classFeeMaster: src.classFeeMaster || {},
    feeScheduleRules: src.feeScheduleRules || {},
    weightageRules: src.weightageRules || {},
    userPermissions: src.userPermissions || {},
    sessions: src.sessions || {},
    students: page.items,
    studentCount: students.length,
    filteredCount: filtered.length,
    page: page.page,
    pageSize: page.pageSize,
    pages: page.pages,
    hasMore: page.hasMore,
    lean: true,
    photosOmitted: true,
    feesOmitted: true,
    marksOmitted: true,
    attendanceOmitted: true
  };
}

function extractMarks(students, options) {
  const className = String(options?.className || '').trim();
  const subjectCode = normalizeKey(options?.subjectCode || options?.subject);
  const admissionNo = normalizeAdmission(options?.admissionNo);
  const rows = [];
  (Array.isArray(students) ? students : []).forEach((student) => {
    const currentClass = String(student.currentClass || student.class || '').trim();
    if (className && className !== 'ALL' && currentClass !== className) return;
    const adm = normalizeAdmission(student.admissionNo || student.AdmissionNo);
    if (admissionNo && adm !== admissionNo) return;
    const examMarks = student.examMarks && typeof student.examMarks === 'object' ? student.examMarks : {};
    Object.keys(examMarks).forEach((subject) => {
      if (subjectCode && normalizeKey(subject) !== subjectCode) return;
      const assessments = examMarks[subject] && typeof examMarks[subject] === 'object' ? examMarks[subject] : {};
      Object.keys(assessments).forEach((assessmentKey) => {
        const value = assessments[assessmentKey];
        if (value === undefined || value === null || value === '') return;
        const meta = (typeof value === 'object' && value !== null && !Array.isArray(value))
          ? value
          : { value };
        rows.push({
          admissionNo: adm,
          name: student.name || '',
          className: currentClass,
          section: String(student.currentSection || student.section || '').trim(),
          subjectCode: normalizeKey(subject),
          assessmentKey: normalizeKey(assessmentKey),
          value: meta.value !== undefined ? meta.value : value,
          revision: Number(meta.revision || meta.rev || 1) || 1,
          updatedAt: meta.updatedAt || meta.updated_at || '',
          updatedBy: meta.updatedBy || meta.updated_by || ''
        });
      });
    });
  });
  return rows;
}

function marksMapFromRows(rows) {
  const marks = {};
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const admission = normalizeAdmission(row.admissionNo || row.admission_no);
    const subject = normalizeKey(row.subjectCode || row.subject_code);
    const assessment = normalizeKey(row.assessmentKey || row.assessment_key);
    if (!admission || !subject || !assessment) return;
    if (!marks[admission]) marks[admission] = {};
    if (!marks[admission][subject]) marks[admission][subject] = {};
    marks[admission][subject][assessment] = row.value;
  });
  return marks;
}

function applyMarkCell(existing, incoming) {
  const current = existing && typeof existing === 'object' ? existing : null;
  const expected = Number(incoming.expectedRevision || incoming.baseRevision || 0);
  const actual = Number(current?.revision || 0);
  if (current && expected > 0 && actual > 0 && expected < actual) {
    return {
      ok: false,
      conflict: true,
      status: 409,
      current,
      incoming
    };
  }
  const nextRevision = Math.max(actual, expected) + 1;
  return {
    ok: true,
    conflict: false,
    previous: current,
    next: {
      value: incoming.value,
      max: incoming.max,
      revision: nextRevision,
      updatedAt: incoming.updatedAt || new Date().toISOString(),
      updatedBy: incoming.updatedBy || '',
      updatedByUserId: incoming.updatedByUserId || '',
      deviceId: incoming.deviceId || ''
    }
  };
}

function applyMarksDelta(student, delta, actor) {
  if (!student || typeof student !== 'object') {
    return { ok: false, error: 'Student not found.', status: 404 };
  }
  const subjectCode = normalizeKey(delta?.subjectCode);
  if (!subjectCode) return { ok: false, error: 'subjectCode is required.', status: 400 };
  const assessments = Array.isArray(delta?.assessments) ? delta.assessments : [];
  if (!assessments.length) return { ok: false, error: 'assessments are required.', status: 400 };

  if (!student.examMarks || typeof student.examMarks !== 'object') student.examMarks = {};
  if (!student.examMarks[subjectCode] || typeof student.examMarks[subjectCode] !== 'object') {
    student.examMarks[subjectCode] = {};
  }

  const applied = [];
  const conflicts = [];
  const audit = [];
  const now = new Date().toISOString();

  assessments.forEach((item) => {
    const key = normalizeKey(item?.key || item?.assessmentKey);
    if (!key) return;
    const stored = student.examMarks[subjectCode][key];
    const existing = (stored && typeof stored === 'object' && stored.revision)
      ? stored
      : (stored === undefined || stored === '' ? null : { value: stored, revision: 1 });
    const result = applyMarkCell(existing, {
      value: item.value,
      max: item.max,
      expectedRevision: item.expectedRevision || item.revision || delta.expectedRevision,
      updatedAt: now,
      updatedBy: actor?.name || '',
      updatedByUserId: actor?.userId || '',
      deviceId: delta.deviceId || ''
    });
    if (result.conflict) {
      conflicts.push({
        admissionNo: normalizeAdmission(student.admissionNo),
        subjectCode,
        assessmentKey: key,
        current: result.current,
        attempted: item.value
      });
      return;
    }
    const oldValue = existing ? existing.value : '';
    if (item.value === '' || item.value == null) {
      delete student.examMarks[subjectCode][key];
    } else {
      student.examMarks[subjectCode][key] = result.next;
    }
    applied.push({
      assessmentKey: key,
      value: item.value,
      revision: result.next.revision,
      updatedAt: result.next.updatedAt
    });
    audit.push({
      admissionNo: normalizeAdmission(student.admissionNo),
      subjectCode,
      assessmentKey: key,
      oldValue,
      newValue: item.value,
      actorUserId: actor?.userId || '',
      actorUsername: actor?.username || '',
      actorName: actor?.name || '',
      deviceId: delta.deviceId || '',
      createdAt: now
    });
  });

  if (conflicts.length && !applied.length) {
    return {
      ok: false,
      conflict: true,
      status: 409,
      error: 'Updated on another device. Refresh to load the latest marks.',
      conflicts
    };
  }

  return {
    ok: true,
    conflict: conflicts.length > 0,
    status: conflicts.length ? 409 : 200,
    applied,
    conflicts,
    audit,
    student
  };
}

function nativeStudentSelect() {
  return 'admission_no,name,current_class,current_section,parent_name,parent_phone,nfc_uid,school_bot_chat_id,telegram_user_name,status,updated_at';
}

module.exports = {
  HEAVY_STUDENT_KEYS,
  DIRECTORY_KEEP_KEYS,
  normalizeAdmission,
  normalizeKey,
  isDataUrl,
  isPhotoUrl,
  byteLength,
  stripStudentPhotos,
  directoryStudent,
  stripProfileImages,
  stripSignatures,
  paginate,
  filterStudents,
  leanPayload,
  extractMarks,
  marksMapFromRows,
  applyMarkCell,
  applyMarksDelta,
  nativeStudentSelect
};
