'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appJs = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
const start = appJs.indexOf('function padDatePart(');
const mid = appJs.indexOf('function formatReceiptDateDisplay(');
const inputStart = appJs.indexOf('function formatDobForDateInput(');
const inputEnd = appJs.indexOf('function parseSimpleCsvRows(');
assert.ok(start >= 0 && mid > start, 'Could not extract DOB helpers from app.js');
assert.ok(inputStart > mid && inputEnd > inputStart, 'Could not extract formatDobForDateInput from app.js');
const sandbox = {};
vm.runInNewContext(`${appJs.slice(start, mid)}\n${appJs.slice(inputStart, inputEnd)}`, sandbox);

const { formatDobToDDMMYYYY, formatDobForDateInput, formatStudentDob } = sandbox;

assert.strictEqual(formatDobToDDMMYYYY('2012-12-19T00:00:00.000Z'), '19/12/2012');
assert.strictEqual(formatDobToDDMMYYYY('2011-10-26T00:00:00.000Z'), '26/10/2011');
assert.strictEqual(formatDobToDDMMYYYY('19T00:00:00.000Z/12/2012'), '19/12/2012');
assert.strictEqual(formatDobToDDMMYYYY('26T00:00:00.000Z/10/2011'), '26/10/2011');
assert.strictEqual(formatDobToDDMMYYYY('2012-12-19'), '19/12/2012');
assert.strictEqual(formatDobToDDMMYYYY('19/12/2012'), '19/12/2012');
assert.strictEqual(formatDobToDDMMYYYY('05-04-2015'), '05/04/2015');
assert.strictEqual(formatDobToDDMMYYYY('N/A'), 'N/A');

assert.strictEqual(formatDobForDateInput('2012-12-19T00:00:00.000Z'), '2012-12-19');
assert.strictEqual(formatDobForDateInput('19T00:00:00.000Z/12/2012'), '2012-12-19');
assert.strictEqual(formatDobForDateInput('19/12/2012'), '2012-12-19');

assert.strictEqual(formatStudentDob({ dateOfBirth: '2012-12-19T00:00:00.000Z' }), '19/12/2012');
assert.strictEqual(formatStudentDob({ dob: '', dateOfBirth: '2011-10-26T00:00:00.000Z' }), '26/10/2011');
assert.strictEqual(formatStudentDob({ dob: '19/12/2012' }), '19/12/2012');

const lean = require('../lib/erpLean');
const dir = lean.directoryStudent({
  admissionNo: '1001',
  name: 'Test Student',
  currentClass: 'Class 8',
  currentSection: 'A',
  dob: '2012-12-19T00:00:00.000Z',
  dateOfBirth: '2012-12-19T00:00:00.000Z'
});
assert.strictEqual(dir.dob, '2012-12-19');
assert.strictEqual(dir.dateOfBirth, '2012-12-19');

console.log('dob-format tests passed');
