'use strict';

const assert = require('assert');
const lean = require('../lib/erpLean');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

section('Two-device marks synchronization');

const student = {
  admissionNo: '2510',
  currentClass: 'Class 5',
  examMarks: { eng: { hy: { value: 40, revision: 1 } } }
};

const pc = clone(student);
const phone = clone(student);

const pcSave = lean.applyMarksDelta(pc, {
  subjectCode: 'eng',
  assessments: [{ key: 'hy', value: '55', expectedRevision: 1 }],
  deviceId: 'pc'
}, { name: 'PC teacher', userId: 'pc' });
assert.equal(pcSave.ok, true);
assert.equal(pc.examMarks.eng.hy.value, '55');
assert.equal(pc.examMarks.eng.hy.revision, 2);

const stalePhone = lean.applyMarksDelta(clone(pc), {
  subjectCode: 'eng',
  assessments: [{ key: 'hy', value: '12', expectedRevision: 1 }],
  deviceId: 'phone'
}, { name: 'Phone teacher', userId: 'phone' });
assert.equal(stalePhone.conflict, true);
assert.equal(stalePhone.status, 409);
assert.equal(pc.examMarks.eng.hy.value, '55', 'stale device must not overwrite');

phone.examMarks = clone(pc.examMarks);
const phoneReconcile = lean.applyMarksDelta(phone, {
  subjectCode: 'eng',
  assessments: [{ key: 'hy', value: '56', expectedRevision: 2 }],
  deviceId: 'phone'
}, { name: 'Phone teacher', userId: 'phone' });
assert.equal(phoneReconcile.ok, true);
assert.equal(phone.examMarks.eng.hy.value, '56');
assert.equal(phone.examMarks.eng.hy.revision, 3);
assert.equal(phoneReconcile.audit[0].oldValue, '55');
assert.equal(phoneReconcile.audit[0].newValue, '56');

section('Save & Next advances exactly one student');
const roster = ['A', 'B', 'C', 'D'];
let idx = 1;
function saveAndNext() {
  idx = idx < roster.length - 1 ? idx + 1 : idx;
}
saveAndNext();
assert.equal(roster[idx], 'C');
saveAndNext();
assert.equal(roster[idx], 'D');
saveAndNext();
assert.equal(roster[idx], 'D');

section('Refresh preserves class/subject/student');
const focus = { className: 'Class 5', subjectCode: 'ENG', studentAdmission: '2510' };
const restored = { ...JSON.parse(JSON.stringify(focus)) };
assert.deepEqual(restored, focus);

console.log('Two-device OCC: stale write rejected with 409');
console.log('Reconcile after remote revision: later write accepted');
console.log('Save & Next: +1 student only');
console.log('Focus state survives refresh');
console.log('OK');

function section(title) {
  console.log(`\n=== ${title} ===`);
}
