'use strict';

const assert = require('assert');
const lean = require('../lib/erpLean');

function fakePhoto(admission) {
  const pad = 'A'.repeat(40 * 1024);
  return `data:image/jpeg;base64,${Buffer.from(`photo-${admission}-${pad}`).toString('base64')}`;
}

function buildSchool(studentCount) {
  const students = [];
  for (let i = 1; i <= studentCount; i += 1) {
    const admissionNo = String(2500 + i);
    const className = i <= 40 ? 'Class 5' : (i <= 80 ? 'Class 6' : 'Class 7');
    students.push({
      admissionNo,
      name: `Student ${i}`,
      currentClass: className,
      currentSection: 'A',
      parentName: `Parent ${i}`,
      parentPhone: '9990000000',
      photo: fakePhoto(admissionNo),
      photoDataUrl: fakePhoto(admissionNo),
      examMarks: {
        eng: { ut1: 18, hy: 55, revision: 1 }
      },
      feeRecords: {
        '2026-27': {
          monthlyTuition: 1500,
          payments: [{ receiptNo: `R${admissionNo}`, amount: 1500, date: '2026-04-01' }]
        }
      },
      attendanceLogs: { '2026-08-01': { status: 'Present', inTime: '08:01' } }
    });
  }
  return {
    version: '2.1',
    savedAt: '2026-08-29T08:00:00.000Z',
    activeSession: '2026-27',
    classes: ['Class 5', 'Class 6', 'Class 7'],
    subjects: { eng: { code: 'ENG', name: 'English' } },
    staffUsers: [{ id: 'u1', username: 'admin', name: 'Admin', password: 'secret' }],
    schoolProfile: { name: 'MMM JHS', logoDataUrl: `data:image/png;base64,${'B'.repeat(8000)}` },
    students
  };
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

const school = buildSchool(800);
const fullBytes = lean.byteLength(school);
const leanAll = lean.leanPayload(school, { page: 1, pageSize: 5000 });
const leanPage = lean.leanPayload(school, { page: 1, pageSize: 50, className: 'Class 5' });
const marks = lean.extractMarks(school.students, { className: 'Class 5', subjectCode: 'eng' });
const marksBytes = lean.byteLength({ ok: true, marks: lean.marksMapFromRows(marks), rows: marks });
const versionBytes = lean.byteLength({ ok: true, savedAt: school.savedAt, version: school.version });

section('Before/after payload sizes (synthetic 800-student school, photos embedded)');
const table = [
  ['Workflow', 'Before (full snapshot)', 'After (V2/lean)', 'Requests'],
  ['Boot / dashboard', `${fullBytes} bytes`, `${lean.byteLength(leanAll)} bytes directory / ${lean.byteLength(leanPage)} first page`, '1 lean boot, not full JSONB'],
  ['Students page (Class 5, page 1)', `${fullBytes} bytes`, `${lean.byteLength(leanPage)} bytes`, '1 targeted page'],
  ['Marks page Class 5 English', `${fullBytes} bytes`, `${marksBytes} bytes`, '1 getMarksV2'],
  ['Idle poll / 15s', `${fullBytes} if changed, else probe`, `${versionBytes} byte cloudVersion`, '1 timestamp'],
  ['Photo at startup', `${800} embedded data URLs`, '0 (lazy photoUrl only)', 'none until row visible']
];
table.forEach((row) => console.log(row.join(' | ')));

assert.ok(fullBytes > 10_000_000, `full snapshot should be tens of MB, got ${fullBytes}`);
assert.ok(lean.byteLength(leanAll) < fullBytes / 20, 'lean directory must be far smaller than full snapshot');
assert.ok(lean.byteLength(leanPage) < 80_000, `class page should be small, got ${lean.byteLength(leanPage)}`);
assert.ok(marksBytes < 80_000, `marks slice should be small, got ${marksBytes}`);
assert.ok(!JSON.stringify(leanAll).includes('data:image'), 'lean payload must omit data URLs');
assert.ok(leanAll.students.every((s) => !s.photo && !s.photoDataUrl && !s.feeRecords && !s.examMarks));
assert.equal(leanPage.students.length, 40);
assert.equal(leanPage.pageSize, 50);

section('Marks OCC');
const student = { admissionNo: '2501', examMarks: { eng: { ut1: { value: 18, revision: 2, updatedAt: '2026-08-29T08:00:00.000Z' } } } };
const stale = lean.applyMarksDelta(student, {
  subjectCode: 'eng',
  assessments: [{ key: 'ut1', value: '11', expectedRevision: 1 }]
}, { name: 'Phone' });
assert.equal(stale.status, 409);
assert.equal(stale.conflict, true);
assert.equal(student.examMarks.eng.ut1.value, 18);

const freshStudent = { admissionNo: '2501', examMarks: { eng: { ut1: { value: 18, revision: 2 } } } };
const ok = lean.applyMarksDelta(freshStudent, {
  subjectCode: 'eng',
  assessments: [{ key: 'ut1', value: '19', expectedRevision: 2 }]
}, { name: 'PC', userId: 'u1' });
assert.equal(ok.ok, true);
assert.equal(freshStudent.examMarks.eng.ut1.value, '19');
assert.equal(freshStudent.examMarks.eng.ut1.revision, 3);
assert.equal(ok.audit[0].oldValue, 18);
assert.equal(ok.audit[0].newValue, '19');

section('Cell conflict helper');
const cell = lean.applyMarkCell({ value: 40, revision: 5 }, { value: 12, expectedRevision: 4 });
assert.equal(cell.conflict, true);
assert.equal(cell.status, 409);

section('Save & Next index math');
function nextIndex(current, total) {
  return current < total - 1 ? current + 1 : current;
}
assert.equal(nextIndex(0, 30), 1);
assert.equal(nextIndex(28, 30), 29);
assert.equal(nextIndex(29, 30), 29);

section('Evidence table (production, no mutation)');
console.log([
  'URL', 'Size', 'Frequency', 'Initiator', 'Counts as Supabase egress?'
].join(' | '));
const evidence = [
  ['https://www.mmmjhschool.com/', '25110 B', '1 per load', 'document', 'No — Vercel HTML'],
  ['js/app.js?v=20260828_v183', '1332322 B', '1 per load', 'index.html', 'No — Vercel static'],
  ['js/cloudSync.js?v=20260828_v181', '96016 B', '1 per load', 'index.html', 'No — Vercel static'],
  ['cdnjs font-awesome / jspdf / fonts', '~0.5–2 MB', '1 per load', 'index.html', 'No — third party / Vercel'],
  ['GET /api/mmmjhs-bot?action=cloudConfig', '251 B', '1 per boot', 'cloudSync.js', 'No DB read'],
  ['GET cloudVersion', '~100 B when authorized', 'every 15s', 'cloudSync poll', 'Yes — tiny saved_at select'],
  ['GET cloudPull (legacy full)', 'previously ~3.67 MB uncompressed; photos can push this to 10–40 MB', '1 per cold boot + every snapshot change', 'cloudSync prefetch/pull', 'YES — erp_snapshots.payload'],
  ['GET nativeStudents (legacy overlay)', 'full student payloads', '1 after every pull', 'applyNativeStudentLinks', 'YES — erp_students.payload'],
  ['GET erp_payments overlay', 'up to 20k payment rows', '1 after every full pull', 'erp-cloud GET', 'YES'],
  ['GET /api/latest-tap', '79 B 404 production', 'every 800ms if poller enabled', 'setupEsp8266HardwarePoller', 'No — Vercel 404; Render NFC is separate'],
  ['POST saveMarksDelta', 'hundreds of bytes', 'per student/subject save', 'erpOutbox', 'Yes — erp_marks row only after this PR']
];
evidence.forEach((row) => console.log(row.join(' | ')));

const reduction = (1 - (lean.byteLength(leanPage) / fullBytes)) * 100;
console.log(`\nMeasured reduction for Students page vs full snapshot: ${reduction.toFixed(2)}%`);
console.log(`Full snapshot bytes: ${fullBytes}`);
console.log(`Lean all-directory bytes: ${lean.byteLength(leanAll)}`);
console.log(`Class 5 page bytes: ${lean.byteLength(leanPage)}`);
console.log(`Marks Class 5 English bytes: ${marksBytes}`);
console.log('OK');
