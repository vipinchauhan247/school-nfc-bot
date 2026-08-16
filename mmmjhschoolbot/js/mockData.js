/**
 * Madan Mohan Malviya School ERP - empty SchoolData shell (cloud-only).
 * File: js/mockData.js
 *
 * Keep this file (index.html loads it). Do NOT delete it.
 * Students / staff / teachers come from Supabase after cloud sync.
 * No demo students or fake teacher logins.
 */

const SchoolData = {
  activeSession: '2026-27',
  activeRole: 'Super Admin',
  theme: 'dark',

  signatures: (function () {
    try {
      return JSON.parse(localStorage.getItem('school_signatures')) || {
        teacherSig: null,
        teacherName: '',
        principalSig: null,
        principalName: '',
        schoolStamp: null
      };
    } catch (e) {
      return {
        teacherSig: null,
        teacherName: '',
        principalSig: null,
        principalName: '',
        schoolStamp: null
      };
    }
  })(),

  schoolProfile: {
    name: 'Madan Mohan Malviya Junior High School',
    shortName: 'MMM Jr High',
    address: 'Sector 53, Noida',
    logoDataUrl: '',
    principalSignatureDataUrl: '',
    paymentQrDataUrl: ''
  },

  weightageRules: {
    default: { ut1: 15, ut2: 15, hy: 70, ut3: 15, ut4: 15, fin: 70 },
    'Class 5': { ut1: 15, ut2: 15, hy: 70, ut3: 15, ut4: 15, fin: 70 },
    'Class 4': { ut1: 15, ut2: 15, hy: 70, ut3: 15, ut4: 15, fin: 70 },
    'Class 8': { ut1: 15, ut2: 15, hy: 70, ut3: 15, ut4: 15, fin: 70 },
    'Class 10': { ut1: 10, ut2: 10, hy: 80, ut3: 10, ut4: 10, fin: 80 },
    LKG: { ut1: 15, ut2: 15, hy: 70, ut3: 15, ut4: 15, fin: 70 }
  },

  userPermissions: {
    'Super Admin': { weightage: true, teachers: true, students: true, fees: true, reportCards: true, timetable: true, attendance: true },
    Principal: { weightage: true, teachers: true, students: true, fees: true, reportCards: true, timetable: true, attendance: true },
    Accountant: { weightage: false, teachers: false, students: true, fees: true, reportCards: false, timetable: false, attendance: false },
    'Class Teacher': { weightage: false, teachers: false, students: true, fees: false, reportCards: true, timetable: true, attendance: true },
    'Exam Incharge': { weightage: true, teachers: false, students: true, fees: false, reportCards: true, timetable: false, attendance: false },
    Salesman: { weightage: false, teachers: false, students: true, fees: false, reportCards: true, timetable: false, attendance: false }
  },

  periodSettings: [
    { periodNo: 1, name: 'Period 1', startTime: '08:30 AM', endTime: '09:15 AM', durationMins: 45, isBreak: false },
    { periodNo: 2, name: 'Period 2', startTime: '09:15 AM', endTime: '10:00 AM', durationMins: 45, isBreak: false },
    { periodNo: 3, name: 'Period 3', startTime: '10:00 AM', endTime: '10:45 AM', durationMins: 45, isBreak: false },
    { periodNo: 4, name: 'RECESS / LUNCH', startTime: '10:45 AM', endTime: '11:15 AM', durationMins: 30, isBreak: true },
    { periodNo: 5, name: 'Period 4', startTime: '11:15 AM', endTime: '12:00 PM', durationMins: 45, isBreak: false },
    { periodNo: 6, name: 'Period 5', startTime: '12:00 PM', endTime: '12:45 PM', durationMins: 45, isBreak: false },
    { periodNo: 7, name: 'Period 6', startTime: '12:45 PM', endTime: '01:30 PM', durationMins: 45, isBreak: false },
    { periodNo: 8, name: 'Period 7', startTime: '01:30 PM', endTime: '02:15 PM', durationMins: 45, isBreak: false }
  ],

  // Empty — loaded from cloud. Do not put demo staff here.
  staffUsers: [],
  teachers: [],
  students: [],
  subjects: [],
  telegramLogs: [],
  cancelledReceipts: [],
  examSubjectConfigs: {},
  classFeeMaster: {},
  feeScheduleRules: {},
  printSettings: {},

  classes: [
    { id: 'nursery', name: 'Nursery', sections: ['A'], teacher: '' },
    { id: 'lkg', name: 'LKG', sections: ['A', 'B'], teacher: '' },
    { id: 'ukg', name: 'UKG', sections: ['A', 'B'], teacher: '' },
    { id: 'class-1', name: 'Class 1', sections: ['A', 'B'], teacher: '' },
    { id: 'class-2', name: 'Class 2', sections: ['A', 'B'], teacher: '' },
    { id: 'class-3', name: 'Class 3', sections: ['A', 'B'], teacher: '' },
    { id: 'class-4', name: 'Class 4', sections: ['A', 'B'], teacher: '' },
    { id: 'class-5', name: 'Class 5', sections: ['A', 'B'], teacher: '' },
    { id: 'class-6', name: 'Class 6', sections: ['A', 'B'], teacher: '' },
    { id: 'class-7', name: 'Class 7', sections: ['A', 'B'], teacher: '' },
    { id: 'class-8', name: 'Class 8', sections: ['A', 'B'], teacher: '' },
    { id: 'class-9', name: 'Class 9', sections: ['A', 'B'], teacher: '' },
    { id: 'class-10', name: 'Class 10', sections: ['A', 'B'], teacher: '' }
  ],

  sessions: {
    '2026-27': { label: '2026-27', active: true }
  }
};

window.SchoolData = SchoolData;
