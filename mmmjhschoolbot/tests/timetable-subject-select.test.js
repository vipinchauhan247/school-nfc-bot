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
  subjects: [
    { id: 'sub_eng', code: 'ENG', name: 'English', classes: ['ALL CLASSES'] },
    { id: 'sub_hin', code: 'HIN', name: 'Hindi', classes: ['ALL CLASSES'] },
    { id: 'sub_mat', code: 'MAT', name: 'Mathematics', classes: ['ALL CLASSES'] },
    { id: 'sub_sst', code: 'SST', name: 'Social Studies', classes: ['Class 6', 'Class 7', 'Class 8'] },
    { id: 'sub_sci', code: 'SCI', name: 'Science', classes: ['Class 6', 'Class 7', 'Class 8'] }
  ],
  teachers: [
    {
      id: 't-shivani',
      name: 'Mrs. Shivani',
      subjectMappings: [{ subjectCode: 'SST', subjectName: 'S.St', class: 'Class 6', classes: ['Class 6'], section: 'ALL' }],
      classesTaught: ['Class 6'],
      assignedSubject: 'S.St'
    },
    { id: 't-priya', name: 'Miss Priya', subjectMappings: [], classesTaught: [] },
    { id: 't-babita', name: 'Mrs. Babita Verma', subjectMappings: [], classesTaught: [] }
  ],
  staffUsers: [
    { id: 't-shivani', name: 'Mrs. Shivani', subjectMappings: [{ subjectCode: 'SST', subjectName: 'S.St', class: 'Class 6', classes: ['Class 6'], section: 'ALL' }], assignedSubject: 'S.St' },
    { id: 't-priya', name: 'Miss Priya', subjectMappings: [] },
    { id: 't-babita', name: 'Mrs. Babita Verma', subjectMappings: [] }
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

function normalizeSubjectCodeBase(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '').replace(/-\d+$/g, '');
}
function isUniversalSubjectClass(cls) {
  const c = String(cls || '').trim().toUpperCase();
  return !c || c === 'ALL' || c === 'ALL CLASSES';
}
function mappingAppliesToClass(mapping, activeClass) {
  if (!activeClass) return true;
  if (!mapping) return false;
  if (isUniversalSubjectClass(mapping.class)) return true;
  if (Array.isArray(mapping.classes) && mapping.classes.length) {
    if (mapping.classes.some((c) => isUniversalSubjectClass(c))) return true;
    const want = String(activeClass).trim().toLowerCase();
    return mapping.classes.some((c) => String(c).trim().toLowerCase() === want);
  }
  return String(mapping.class || '').trim().toLowerCase() === String(activeClass).trim().toLowerCase();
}
function getDirectorySubjectsUnique() {
  return SchoolData.subjects;
}
function findStaffUserForTeacher(teacher) {
  return (SchoolData.staffUsers || []).find((s) => s.id === teacher.id) || null;
}
function applyTeacherMappingsToSubjectsDirectory() {
  return false;
}

const sandbox = {
  SchoolData,
  getSubjectsForClass,
  escapeHtml,
  normalizeSubjectCodeBase,
  isUniversalSubjectClass,
  mappingAppliesToClass,
  getDirectorySubjectsUnique,
  findStaffUserForTeacher,
  applyTeacherMappingsToSubjectsDirectory,
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

const split = sandbox.splitTimetableClassAndSection('Class 6 A');
assert.strictEqual(split.className, 'Class 6');
assert.strictEqual(split.section, 'A');

const hindiAdd = sandbox.addTeacherDirectoryMappingFromTimetable('t-priya', 'HINDI', 'Class 6 A', 'Miss Priya');
assert.ok(hindiAdd && hindiAdd.added === 1);
assert.strictEqual(SchoolData.teachers[1].subjectMappings.length, 1);
assert.strictEqual(SchoolData.teachers[1].subjectMappings[0].subjectName, 'Hindi');
assert.strictEqual(SchoolData.teachers[1].subjectMappings[0].class, 'Class 6');
assert.strictEqual(SchoolData.teachers[1].subjectMappings[0].section, 'A');
assert.strictEqual(SchoolData.staffUsers[1].subjectMappings.length, 1);

const shivaniBefore = JSON.stringify(SchoolData.teachers[0].subjectMappings);
const shivaniHindi = sandbox.addTeacherDirectoryMappingFromTimetable('t-shivani', 'Hindi', 'Class 6 A', 'Mrs. Shivani');
assert.ok(shivaniHindi && shivaniHindi.added === 1);
assert.ok(SchoolData.teachers[0].subjectMappings.some((m) => m.subjectName === 'S.St' || m.subjectCode === 'SST'));
assert.ok(SchoolData.teachers[0].subjectMappings.some((m) => String(m.subjectName).toLowerCase() === 'hindi'));
assert.notStrictEqual(JSON.stringify(SchoolData.teachers[0].subjectMappings), shivaniBefore);

const shivaniDup = sandbox.addTeacherDirectoryMappingFromTimetable('t-shivani', 'S.St', 'Class 6 A', 'Mrs. Shivani');
assert.strictEqual(shivaniDup, null, 'existing S.St Class 6 ALL must not be duplicated');

const otherTeacherUnchanged = SchoolData.teachers[1].subjectMappings.length;
sandbox.addTeacherDirectoryMappingFromTimetable('t-shivani', 'SCIENCE', 'Class 6 A', 'Mrs. Shivani');
assert.strictEqual(SchoolData.teachers[1].subjectMappings.length, otherTeacherUnchanged, 'other teachers stay untouched');

const babita = sandbox.addTeacherDirectoryMappingFromTimetable('t-babita', 'All Subjects', 'UKG A', 'Mrs. Babita Verma');
assert.ok(babita && babita.added >= 2);
assert.ok(SchoolData.teachers[2].subjectMappings.some((m) => String(m.subjectName).toLowerCase() === 'english'));
assert.ok(SchoolData.teachers[2].subjectMappings.every((m) => m.class === 'UKG' && m.section === 'A'));
assert.ok(!SchoolData.teachers[0].subjectMappings.some((m) => m.class === 'UKG'));

const saveFn = src.slice(src.indexOf('async function saveClassTimetableFromUI'), src.indexOf('function downloadTimetableExcelTemplate'));
assert.ok(saveFn.includes('timetable-subject-select'));
assert.ok(saveFn.includes('applyTimetableDirectoryMappingsForPairs'));
assert.ok(saveFn.includes('collectUniqueTimetableTeacherSubjects'));
assert.ok(!saveFn.includes('tt-subject-input'));
assert.ok(!saveFn.includes('freezeTeacherDirectoryMappings'));

const importBlock = src.slice(src.indexOf('async function handleTimetableExcelUpload'), src.indexOf('function renderTimetableTeacherPage'));
assert.ok(importBlock.includes('applyTimetableDirectoryMappingsForClasses'));
assert.ok(!importBlock.includes('staff.subjectMappings = subArray'));

const versions = {
  index: fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'),
  sw: fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8')
};
assert.ok(versions.index.includes("window.__ERP_BUILD_VERSION = '20260906_v269'"));
assert.ok(versions.index.includes('Build: v269'));
assert.ok(versions.index.includes('js/app.js?v=20260906_v269'));
assert.ok(versions.index.includes('/sw.js?v=20260906_v269'));
assert.ok(versions.sw.includes("CACHE_NAME = 'mmmjhs-pwa-20260906-v269'"));

console.log('timetable-subject-select tests passed');
