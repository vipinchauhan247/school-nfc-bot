/**
 * Unit checks for timetable subject dropdown helpers.
 * Reads the live helper source from js/app.js so regressions fail here.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const appPath = path.join(__dirname, '..', 'js', 'app.js');
const src = fs.readFileSync(appPath, 'utf8');

function fail(message) {
  throw new Error(message);
}

function extractBlock(startNeedle, endNeedle) {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle);
  if (start < 0 || end < 0 || end <= start) {
    fail(`Could not extract block starting at ${startNeedle}`);
  }
  return src.slice(start, end);
}

const helperSrc = extractBlock(
  'function normalizeTimetableSubjectKey',
  'function renderTimetableClassPage'
);

const SchoolData = {
  teachers: [
    { id: 't-shivani', name: 'Mrs. Shivani', subjectMappings: [{ class: 'Class 6', section: 'ALL', subjectName: 'S.St' }], assignedSubject: 'S.St' }
  ],
  staffUsers: [
    { id: 't-shivani', name: 'Mrs. Shivani', subjectMappings: [{ class: 'Class 6', section: 'ALL', subjectName: 'S.St' }], assignedSubject: 'S.St' }
  ],
  classTimetables: {
    'Class 6': {
      Mon: {
        1: { teacherId: 't-shivani', teacherName: 'Mrs. Shivani', subject: 'Hindi' }
      }
    },
    'UKG A': {
      Mon: {
        1: { teacherId: 't-babita', teacherName: 'Mrs. Babita Verma', subject: 'All Subjects' }
      }
    }
  }
};

function getSubjectsForClass(className) {
  const n = String(className || '').toLowerCase();
  if (n.startsWith('ukg') || n.startsWith('nursery') || n.startsWith('lkg') || /^class\s*[123]/.test(n)) {
    return [{ name: 'ENGLISH', code: 'ENG' }, { name: 'HINDI', code: 'HIN' }];
  }
  if (n === 'class 6 a') {
    return [{ name: 'ENGLISH', code: 'ENG' }, { name: 'HINDI', code: 'HIN' }];
  }
  if (n === 'class 6') {
    return [
      { name: 'ENGLISH', code: 'ENG' },
      { name: 'HINDI', code: 'HIN' },
      { name: 'MATHEMATICS', code: 'MAT' },
      { name: 'SOCIAL STUDIES', code: 'SST' },
      { name: 'SCIENCE', code: 'SCI' }
    ];
  }
  return [
    { name: 'ENGLISH', code: 'ENG' },
    { name: 'HINDI', code: 'HIN' },
    { name: 'MATHEMATICS', code: 'MAT' },
    { name: 'SOCIAL STUDIES', code: 'SST' },
    { name: 'SCIENCE', code: 'SCI' }
  ];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const sandbox = {
  SchoolData,
  getSubjectsForClass,
  escapeHtml,
  console
};
vm.createContext(sandbox);
vm.runInContext(helperSrc, sandbox);

assert.strictEqual(sandbox.normalizeTimetableSubjectKey('S.St'), 'sst');
assert.strictEqual(sandbox.normalizeTimetableSubjectKey('Social Studies'), 'socialstudies');
assert.ok(sandbox.isPrimaryTimetableClass('UKG A'));
assert.ok(sandbox.isPrimaryTimetableClass('Class 2 B'));
assert.ok(!sandbox.isPrimaryTimetableClass('Class 6'));

const class6 = sandbox.getTimetableSubjectChoices('Class 6');
assert.ok(class6.includes('HINDI'));
assert.ok(class6.includes('SOCIAL STUDIES'));
assert.ok(!class6.includes('All Subjects'));

const class6A = sandbox.getTimetableSubjectChoices('Class 6 A');
assert.ok(class6A.includes('SOCIAL STUDIES'), 'sectioned class names must inherit base-class subjects');
assert.ok(class6A.includes('SCIENCE'));
assert.ok(!class6A.includes('All Subjects'));

const ukg = sandbox.getTimetableSubjectChoices('UKG A');
assert.strictEqual(ukg[0], 'All Subjects');
assert.ok(ukg.includes('ENGLISH'));

const matched = sandbox.resolveTimetableSubjectSelection('Hindi', class6);
assert.strictEqual(matched.selected, 'HINDI');
assert.strictEqual(matched.extra, '');

const unmatched = sandbox.resolveTimetableSubjectSelection('Smart Science', class6);
assert.strictEqual(unmatched.extra, 'Smart Science');

const html = sandbox.buildTimetableSubjectSelectHtml('Class 6', 'Hindi', 'Mon', 1);
assert.ok(html.includes('class="session-dropdown timetable-subject-select'));
assert.ok(html.includes('data-day="Mon"'));
assert.ok(html.includes('data-period="1"'));
assert.ok(html.includes('value="HINDI" selected'));
assert.ok(!html.includes('<input'));

const tableHtml = sandbox.renderClassTimetableMatrixTable('Class 6', [
  { name: 'Period 1', startTime: '08:30 AM', endTime: '09:15 AM', isBreak: false },
  { name: 'Lunch', startTime: '10:45 AM', endTime: '11:15 AM', isBreak: true }
], [{ id: 't-shivani', name: 'Mrs. Shivani' }]);
assert.ok(tableHtml.includes('id="classTimetableMatrixTable"'));
assert.ok(tableHtml.includes('timetable-subject-select'));
assert.ok(tableHtml.includes('tt-teacher-select'));
assert.ok(tableHtml.includes('BREAK'));
assert.ok(!tableHtml.includes('tt-subject-input'));

const frozen = sandbox.freezeTeacherDirectoryMappings();
SchoolData.teachers[0].subjectMappings = [{ class: 'Nursery', subjectName: 'All Subjects' }];
SchoolData.staffUsers[0].assignedSubject = 'All Subjects';
sandbox.restoreTeacherDirectoryMappingsIfMutated(frozen);
assert.strictEqual(SchoolData.teachers[0].subjectMappings[0].subjectName, 'S.St');
assert.strictEqual(SchoolData.staffUsers[0].assignedSubject, 'S.St');

const saveFn = src.slice(src.indexOf('async function saveClassTimetableFromUI'), src.indexOf('function downloadTimetableExcelTemplate'));
assert.ok(saveFn.includes('timetable-subject-select'));
assert.ok(saveFn.includes('freezeTeacherDirectoryMappings'));
assert.ok(!saveFn.includes('tt-subject-input'));
assert.ok(!/teachers\[.*\]\.subjectMappings\s*=/.test(saveFn));
assert.ok(!/staffUsers\[.*\]\.subjectMappings\s*=/.test(saveFn));

const importBlock = src.slice(src.indexOf('async function handleTimetableExcelUpload'), src.indexOf('function renderTimetableTeacherPage'));
assert.ok(importBlock.includes('restoreTeacherDirectoryMappingsIfMutated'));
assert.ok(!importBlock.includes('staff.subjectMappings = subArray'));
assert.ok(!importBlock.includes("persistDirectoryDelta({ scope: 'staff'"));

const versions = {
  index: fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'),
  sw: fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8')
};
assert.ok(versions.index.includes("window.__ERP_BUILD_VERSION = '20260906_v268'"));
assert.ok(versions.index.includes('Build: v268'));
assert.ok(versions.index.includes('js/app.js?v=20260906_v268'));
assert.ok(versions.index.includes('/sw.js?v=20260906_v268'));
assert.ok(versions.sw.includes("CACHE_NAME = 'mmmjhs-pwa-20260906-v268'"));

console.log('timetable-subject-select tests passed');
