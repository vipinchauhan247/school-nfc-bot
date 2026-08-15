const crypto = require('crypto');
const https = require('https');

let erpCloud = null;
try {
  erpCloud = require('./erp-cloud');
} catch (error) {
  console.error('[ERP] erp-cloud module missing:', error.message);
}

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SCHOOL_NAME = 'Madan Mohan Malviya Junior High School';

const SHEET_HEADERS = {
  Students: [
    'AdmissionNo', 'StudentName', 'Class', 'Section', 'ParentName', 'ParentPhone',
    'NfcUid', 'SchoolBotChatId', 'TelegramUserName', 'Status', 'DueMonths',
    'TuitionDue', 'ExamFeeDue', 'ComputerFeeDue', 'AnnualFeeDue', 'PreviousSessionDue', 'TotalDue'
  ],
  Registrations: [
    'DateTime', 'AdmissionNo', 'StudentName', 'Class', 'Section', 'ParentName',
    'ParentPhone', 'SchoolBotChatId', 'TelegramUserName', 'LinkSource', 'Status'
  ],
  Fee_Due_Messages: [
    'DateTime', 'AdmissionNo', 'StudentName', 'Class', 'Section', 'SchoolBotChatId',
    'DueMonths', 'TuitionDue', 'ExamFeeDue', 'ComputerFeeDue', 'AnnualFeeDue',
    'PreviousSessionDue', 'TotalDue', 'SentBy', 'Status', 'TelegramMessageId'
  ],
  Fee_Receipt_Messages: [
    'DateTime', 'ReceiptNo', 'AdmissionNo', 'StudentName', 'Class', 'Section',
    'SchoolBotChatId', 'AmountPaid', 'PaymentMode', 'ReceiptType', 'SentBy',
    'Status', 'TelegramMessageId'
  ],
  School_Messages: [
    'DateTime', 'MessageCategory', 'TargetType', 'TargetValue', 'AdmissionNos',
    'StudentNames', 'SchoolBotChatIds', 'MessageText', 'SentBy', 'Status',
    'TelegramMessageIds'
  ],
  Exam_Schedule_Messages: [
    'DateTime', 'ExamTerm', 'Class', 'Section', 'Subject', 'ExamDate', 'StartTime',
    'EndTime', 'MaxMarks', 'TargetType', 'SentBy', 'Status', 'TelegramMessageIds'
  ],
  Bot_Events: [
    'DateTime', 'ChatId', 'TelegramUserName', 'Command', 'AdmissionNo', 'Status', 'Message'
  ]
};

const SHEET_ALIASES = {
  Students: ['Students', 'Students Record', 'Student Record', 'Student Records', 'Student', 'student'],
  Registrations: ['Registrations', 'Registration'],
  Fee_Due_Messages: ['Fee_Due_Messages', 'Fee Due Messages'],
  Fee_Receipt_Messages: ['Fee_Receipt_Messages', 'Fee Receipt Messages', 'Fee_Receipts'],
  School_Messages: ['School_Messages', 'School Messages'],
  Exam_Schedule_Messages: ['Exam_Schedule_Messages', 'Exam Schedule Messages'],
  Bot_Events: ['Bot_Events', 'Bot Events']
};

const HEADER_ALIASES = {
  AdmissionNo: ['AdmissionNo', 'Admission No', 'Admission Number', 'AdmissionNo.', 'Adm No', 'Adm No.', 'dmission Numb'],
  StudentName: ['StudentName', 'Student Name', 'Name'],
  Class: ['Class', 'Class & Section', 'Class Sec'],
  Section: ['Section', 'Sec'],
  ParentName: ['ParentName', 'Parent Name', 'Father Name', "Father's Name", 'FatherName'],
  ParentPhone: ['ParentPhone', 'Parent Phone', 'Mobile', 'Phone', 'Parent Mobile', 'Contact'],
  NfcUid: ['NfcUid', 'NFC UID', 'NFC ID', 'Nfc ID', 'NFC Card UID'],
  SchoolBotChatId: ['SchoolBotChatId', 'School Bot Chat ID', 'Parent Telegram Chat ID', 'Telegram Chat ID', 'TelegramChatId'],
  TelegramUserName: ['TelegramUserName', 'Telegram User Name', 'Telegram Username', 'Username'],
  Status: ['Status'],
  DueMonths: ['DueMonths', 'Due Months'],
  TuitionDue: ['TuitionDue', 'Tuition Due'],
  ExamFeeDue: ['ExamFeeDue', 'Exam Fee Due'],
  ComputerFeeDue: ['ComputerFeeDue', 'Computer Fee Due'],
  AnnualFeeDue: ['AnnualFeeDue', 'Annual Fee Due'],
  PreviousSessionDue: ['PreviousSessionDue', 'Previous Session Due'],
  TotalDue: ['TotalDue', 'Total Due']
};

function getEnv(name) {
  return process.env[name] || '';
}

function firstEnv(names) {
  for (const name of names) {
    const value = getEnv(name);
    if (value) return value;
  }
  return '';
}

function botToken() {
  const token = firstEnv(['MMMJHS_BOT_TOKEN', 'BOT_TOKEN']);
  if (!token) throw new Error('Bot token is missing. Add MMMJHS_BOT_TOKEN or BOT_TOKEN in Render Environment.');
  return token;
}

function adminSecret() {
  return firstEnv(['BOT_ADMIN_SECRET', 'BOT_SECRET']);
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ERP-Cloud-Secret');
  res.end(JSON.stringify(body));
}

function empty(res, status = 204) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-ERP-Cloud-Secret');
  res.end();
}

function normalizeHeaderName(header) {
  const clean = String(header || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.some(alias => String(alias).trim().toLowerCase().replace(/[^a-z0-9]/g, '') === clean)) return canonical;
  }
  return String(header || '').trim();
}

function base64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseScriptResponseText(text) {
  if (/^\s*</.test(text || '')) {
    throw new Error('GOOGLE_SCRIPT_URL returned an HTML page, not JSON. Use the Apps Script Web App URL ending in /exec and set access to Anyone.');
  }
  return text ? JSON.parse(text) : {};
}

/** Google Apps Script /exec POST needs fetch redirect following (https.request often gets HTML). */
async function requestScriptJson(method, scriptUrl, body) {
  const init = {
    method: method || 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': 'MMMJHSchoolBot/1.0'
    },
    redirect: 'follow'
  };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(scriptUrl, init);
  return parseScriptResponseText(await response.text());
}

function requestUrlJson(method, rawUrl, body, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(rawUrl);
    const requestMethod = String(method || 'GET').toUpperCase();
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method: requestMethod,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      headers: {
        'User-Agent': 'MMMJHSchoolBot/1.0',
        'Accept': 'application/json,text/plain,*/*',
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location && redirects < 5) {
        response.resume();
        const nextUrl = new URL(response.headers.location, rawUrl).toString();
        requestUrlJson(requestMethod, nextUrl, body, headers, redirects + 1).then(resolve).catch(reject);
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          if (/^\s*</.test(data || '')) {
            reject(new Error('GOOGLE_SCRIPT_URL returned an HTML page, not JSON. Use the Apps Script Web App URL ending in /exec and set access to Anyone.'));
            return;
          }
          resolve(data ? JSON.parse(data) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestJson(method, hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = https.request({
      method,
      hostname,
      path,
      headers: {
        ...headers,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestForm(method, hostname, path, form) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(form).toString();
    const req = https.request({
      method,
      hostname,
      path,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, response => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiry - 60000) return cachedAccessToken;

  const clientEmail = getEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const privateKey = String(getEnv('GOOGLE_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
  if (!clientEmail || !privateKey) throw new Error('Google service account env vars are missing.');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  }));
  const unsigned = `${header}.${claim}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(privateKey, 'base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const tokenResponse = await requestForm('POST', 'oauth2.googleapis.com', '/token', {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature}`
  });

  if (!tokenResponse.access_token) throw new Error(tokenResponse.error_description || 'Google token request failed.');
  cachedAccessToken = tokenResponse.access_token;
  cachedAccessTokenExpiry = Date.now() + (Number(tokenResponse.expires_in || 3600) * 1000);
  return cachedAccessToken;
}

async function sheetsRequest(method, path, body) {
  const token = await getAccessToken();
  return requestJson(method, 'sheets.googleapis.com', path, body, { Authorization: `Bearer ${token}` });
}

async function scriptRequest(action, payload = {}) {
  const scriptUrl = getScriptUrl();
  if (!scriptUrl) throw new Error('GOOGLE_SCRIPT_URL is missing.');
  const result = await requestScriptJson('POST', scriptUrl, { action, ...payload });
  if (!result.ok) throw new Error(result.error || `Google Script action failed: ${action}`);
  return result;
}

function getScriptUrl() {
  return String(getEnv('GOOGLE_SCRIPT_URL') || '').trim().replace(/\s+/g, '');
}

function useGoogleScript() {
  const hasServiceAccount = !!(
    getEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL') &&
    getEnv('GOOGLE_PRIVATE_KEY') &&
    getEnv('GOOGLE_SHEET_ID')
  );
  if (hasServiceAccount) return false;
  return !!getScriptUrl();
}

function sheetId() {
  const id = getEnv('GOOGLE_SHEET_ID');
  if (!id) throw new Error('GOOGLE_SHEET_ID is missing.');
  return id;
}

function asMap(headers, row) {
  const out = {};
  headers.forEach((header, index) => out[header] = row[index] || '');
  return out;
}

function rowFromMap(headers, row) {
  return headers.map(header => row[header] || '');
}

async function getRows(tab) {
  if (useGoogleScript()) {
    const result = await scriptRequest('getRows', { tab, aliases: SHEET_ALIASES[tab] || [tab], defaultHeaders: SHEET_HEADERS[tab] || [] });
    const values = result.values || [];
    const rawHeaders = result.headers && result.headers.length ? result.headers : (values[0] || SHEET_HEADERS[tab] || []);
    const headers = rawHeaders.map(normalizeHeaderName);
    const bodyRows = values.length ? values.slice(1) : (result.rows || []);
    return {
      isEmpty: !values.length && !bodyRows.length,
      headers,
      rows: bodyRows.filter(row => Array.isArray(row) && row.some(Boolean)).map((row, index) => ({
        index: Number(row.__rowIndex || result.startRow || 2) + index,
        values: row,
        data: asMap(headers, row)
      }))
    };
  }
  const encoded = encodeURIComponent(`${tab}!A:Z`);
  const result = await sheetsRequest('GET', `/v4/spreadsheets/${sheetId()}/values/${encoded}`, null);
  const values = result.values || [];
  const headers = (values[0] && values[0].length ? values[0] : SHEET_HEADERS[tab]).map(normalizeHeaderName);
  return {
    isEmpty: values.length === 0,
    headers,
    rows: values.slice(1).filter(row => row.some(Boolean)).map((row, index) => ({ index: index + 2, values: row, data: asMap(headers, row) }))
  };
}

async function updateRow(tab, rowIndex, headers, data) {
  if (useGoogleScript()) {
    await scriptRequest('updateRow', { tab, aliases: SHEET_ALIASES[tab] || [tab], rowIndex, headers, values: rowFromMap(headers, data) });
    return;
  }
  const range = encodeURIComponent(`${tab}!A${rowIndex}:Z${rowIndex}`);
  await sheetsRequest('PUT', `/v4/spreadsheets/${sheetId()}/values/${range}?valueInputOption=USER_ENTERED`, {
    values: [rowFromMap(headers, data)]
  });
}

async function appendRow(tab, values, headerList) {
  const headers = headerList && headerList.length ? headerList : (SHEET_HEADERS[tab] || []);
  const rowValues = Array.isArray(values) ? values : rowFromMap(headers, values);
  if (useGoogleScript()) {
    await scriptRequest('appendRow', { tab, aliases: SHEET_ALIASES[tab] || [tab], headers, values: rowValues });
    return;
  }
  const range = encodeURIComponent(`${tab}!A:Z`);
  await sheetsRequest('POST', `/v4/spreadsheets/${sheetId()}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    values: [rowValues]
  });
}

async function logEvent(chatId, username, command, admissionNo, status, message) {
  try {
    await appendRow('Bot_Events', [new Date().toLocaleString('en-IN'), chatId, username, command, admissionNo || '', status, message]);
  } catch (error) {
    console.error('Bot event log failed:', error.message);
  }
}

function normalizeAdmission(value) {
  return String(value || '').replace(/^#/, '').trim();
}

function getTelegramName(from = {}) {
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Parent';
}

function classSection(row) {
  const cls = row.Class || '';
  const section = row.Section || '';
  return [cls, section].filter(Boolean).join(' - ');
}

function helpMessage(name) {
  return `Welcome to ${SCHOOL_NAME}!

Hello ${name || 'Parent'}!
This is the official school ERP message bot.

Parents - link for school messages:
/register <Admission No>
/link <Admission No>
Example: /register 2507

Check registration:
/status <Admission No>
Example: /status 2507

Check fee dues:
/fees <Admission No>
Example: /fees 2507

Check which child is linked to this chat:
/whoami

Attendance card commands are handled by the separate attendance bot only.`;
}

async function sendTelegram(chatId, text) {
  const token = botToken();
  return requestJson('POST', 'api.telegram.org', `/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: `${SCHOOL_NAME}\n\n${text}`
  });
}

async function sendTelegramDocument(chatId, buffer, filename, caption, mimeType = 'application/pdf') {
  const token = botToken();
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const file = typeof File !== 'undefined'
    ? new File([buffer], filename, { type: mimeType })
    : new Blob([buffer], { type: mimeType });
  form.append('document', file, filename);
  if (caption) {
    form.append('caption', String(caption).slice(0, 1024));
    form.append('parse_mode', 'Markdown');
  }
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: form
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Telegram sendDocument failed: ${text.slice(0, 200)}`);
  }
}

function findStudentMatches(students, admissionNo) {
  const clean = normalizeAdmission(admissionNo);
  return students.filter(item => normalizeAdmission(item.data.AdmissionNo) === clean);
}

async function handleRegister(chatId, from, admissionNo, command) {
  if (!admissionNo) {
    await sendTelegram(chatId, `Usage Error\n\nPlease send:\n/register <Admission No>\nExample: /register 2507`);
    return;
  }

  const studentsResult = await getRows('Students');
  const matches = findStudentMatches(studentsResult.rows, admissionNo);
  const username = getTelegramName(from);

  if (matches.length === 0) {
    const msg = `Student Not Found\n\nNo student registered with Admission No ${admissionNo}. Please check the admission number on your school ID card or fee receipt.`;
    await sendTelegram(chatId, msg);
    await logEvent(chatId, username, command, admissionNo, 'Not Found', msg);
    return;
  }

  if (matches.length > 1) {
    const msg = `Duplicate Admission Number\n\nAdmission No ${admissionNo} is found on more than one school sheet record. Please contact the school office before linking.`;
    await sendTelegram(chatId, msg);
    await logEvent(chatId, username, command, admissionNo, 'Duplicate Blocked', msg);
    return;
  }

  const studentRow = matches[0];
  const student = studentRow.data;
  const studentHeaders = studentsResult.headers && studentsResult.headers.length ? studentsResult.headers : SHEET_HEADERS.Students;
  student.SchoolBotChatId = String(chatId);
  student.TelegramUserName = username;
  student.Status = 'Linked';
  await updateRow('Students', studentRow.index, studentHeaders, student);

  // Cloud-native dual-write: Chat ID + username into erp_students (Supabase)
  if (erpCloud && typeof erpCloud.upsertStudentLink === 'function' && erpCloud.isConfigured()) {
    try {
      await erpCloud.upsertStudentLink({
        admissionNo,
        chatId,
        username,
        student: {
          admissionNo: student.AdmissionNo,
          name: student.StudentName,
          currentClass: student.Class,
          currentSection: student.Section,
          parentName: student.ParentName,
          parentPhone: student.ParentPhone,
          nfcUid: student.NfcUid,
          SchoolBotChatId: String(chatId),
          TelegramUserName: username
        }
      });
    } catch (error) {
      console.error('Native ERP link upsert failed:', error.message);
    }
  }

  const now = new Date().toLocaleString('en-IN');
  const reg = {
    DateTime: now,
    Timestamp: now,
    AdmissionNo: student.AdmissionNo,
    StudentName: student.StudentName,
    Class: student.Class,
    Section: student.Section,
    ParentName: student.ParentName,
    ParentPhone: student.ParentPhone,
    SchoolBotChatId: String(chatId),
    TelegramUserName: username,
    LinkSource: `Telegram /${command}`,
    Status: 'Linked'
  };

  try {
    const registrations = await getRows('Registrations');
    const regHeaders = registrations.headers && registrations.headers.length
      ? registrations.headers
      : SHEET_HEADERS.Registrations;
    const existing = registrations.rows.find(row => normalizeAdmission(row.data.AdmissionNo) === normalizeAdmission(admissionNo));
    if (existing) await updateRow('Registrations', existing.index, regHeaders, reg);
    else await appendRow('Registrations', rowFromMap(regHeaders, reg), regHeaders);
  } catch (error) {
    console.error('Registration sheet update failed:', error.message);
  }

  const msg = `Successfully Linked!

Dear ${username}, your ward ${student.StudentName} (${classSection(student)}) has been connected to @mmmjhschoolbot.

You will receive fee receipts, fee reminders, school notices, and exam report alerts on this phone.`;
  await sendTelegram(chatId, msg);
  await logEvent(chatId, username, command, admissionNo, 'Linked', `Linked ${student.StudentName}`);
}

async function handleStatus(chatId, from, admissionNo) {
  if (!admissionNo) {
    await sendTelegram(chatId, `Usage Error\n\nPlease send:\n/status <Admission No>\nExample: /status 2507`);
    return;
  }
  const name = getTelegramName(from);

  const studentsResult = await getRows('Students');
  const matches = findStudentMatches(studentsResult.rows, admissionNo);
  if (matches.length === 0) {
    await sendTelegram(chatId, `Student Not Found\n\nNo student registered with Admission No ${admissionNo}. Please check the admission number on your school ID card or fee receipt.`);
    await logEvent(chatId, name, 'status', admissionNo, 'Not Found', 'Status checked but student not found');
    return;
  }
  if (matches.length > 1) {
    await sendTelegram(chatId, `Duplicate Admission Number\n\nAdmission No ${admissionNo} is found on more than one school sheet record. Please contact the school office before linking.`);
    await logEvent(chatId, name, 'status', admissionNo, 'Duplicate Blocked', 'Status checked but duplicate admission found');
    return;
  }

  const student = matches[0].data;
  let registration = null;
  try {
    const registrations = await getRows('Registrations');
    registration = registrations.rows.find(row => normalizeAdmission(row.data.AdmissionNo) === normalizeAdmission(admissionNo));
  } catch (error) {
    console.error('Registration status lookup failed:', error.message);
  }

  const savedChatId = student.SchoolBotChatId || registration?.data?.SchoolBotChatId || '';
  const sameChat = String(savedChatId || '') === String(chatId);
  const statusText = savedChatId
    ? (sameChat ? 'This phone is linked.' : 'This admission is linked to another chat ID.')
    : `Not linked yet. Send /register ${admissionNo} to link this phone.`;

  await sendTelegram(chatId, `Registration Status

Student: ${student.StudentName}
Admission No: ${student.AdmissionNo}
Class: ${classSection(student)}
Status: ${statusText}`);
  await logEvent(chatId, name, 'status', admissionNo, 'Checked', 'Status checked');
}

async function handleFees(chatId, admissionNo) {
  if (!admissionNo) {
    await sendTelegram(chatId, `Usage Error\n\nPlease send:\n/fees <Admission No>\nExample: /fees 2507`);
    return;
  }
  const { rows } = await getRows('Students');
  const matches = findStudentMatches(rows, admissionNo);
  if (matches.length !== 1) {
    await sendTelegram(chatId, matches.length > 1 ? `Duplicate Admission Number\n\nAdmission No ${admissionNo} is duplicated. Please contact the school office.` : `Student Not Found\n\nNo student registered with Admission No ${admissionNo}.`);
    return;
  }
  const s = matches[0].data;
  const lines = [];
  if (s.DueMonths) lines.push(`Due Months: ${s.DueMonths}`);
  if (s.TuitionDue) lines.push(`Tuition Due: Rs ${s.TuitionDue}`);
  if (s.ExamFeeDue) lines.push(`Exam Fee Due: Rs ${s.ExamFeeDue}`);
  if (s.ComputerFeeDue) lines.push(`Computer Fee Due: Rs ${s.ComputerFeeDue}`);
  if (s.AnnualFeeDue) lines.push(`Annual Fee Due: Rs ${s.AnnualFeeDue}`);
  if (s.PreviousSessionDue) lines.push(`Previous Session Due: Rs ${s.PreviousSessionDue}`);
  if (s.TotalDue) lines.push(`Total Due: Rs ${s.TotalDue}`);
  await sendTelegram(chatId, `Fee Status

Student: ${s.StudentName}
Admission No: ${s.AdmissionNo}
Class: ${classSection(s)}

${lines.length ? lines.join('\n') : 'Fee due fields are not filled in the Google Sheet yet.'}`);
}

async function handleWhoAmI(chatId, from) {
  const wanted = String(chatId || '').trim();
  const byAdmission = new Map();

  const addLinked = (rows) => {
    (rows || []).forEach((row) => {
      const data = normalizeRegistrationRow(row.data || row);
      const adm = normalizeAdmission(data.AdmissionNo);
      const rowChat = String(data.SchoolBotChatId || '').trim();
      if (!adm || !rowChat || rowChat !== wanted) return;
      // Prefer the first hit; Students tab can fill name/class if Registrations is thin
      if (!byAdmission.has(adm)) {
        byAdmission.set(adm, data);
        return;
      }
      const prev = byAdmission.get(adm);
      byAdmission.set(adm, {
        ...prev,
        ...data,
        StudentName: data.StudentName || prev.StudentName,
        Class: data.Class || prev.Class,
        Section: data.Section || prev.Section,
        SchoolBotChatId: wanted,
        Status: data.Status || prev.Status || 'Linked'
      });
    });
  };

  try {
    const regs = await getRows('Registrations');
    addLinked(regs.rows);
  } catch (error) {
    console.error('Whoami registration lookup failed:', error.message);
  }
  try {
    // Also include Students-tab links (/link writes Students first; Registrations can lag)
    const students = await getRows('Students');
    addLinked(students.rows);
  } catch (error) {
    console.error('Whoami students lookup failed:', error.message);
  }

  const linked = Array.from(byAdmission.values());
  if (!linked.length) {
    await sendTelegram(chatId, `No Student Linked\n\nDear ${getTelegramName(from)}, this chat is not linked with any ERP student yet.\n\nSend /register <Admission No> to link.`);
    return;
  }
  await sendTelegram(
    chatId,
    `Linked Student(s)\n\n${linked.map((row) => `Admission ${row.AdmissionNo}: ${row.StudentName} (${classSection(row)})`).join('\n')}`
  );
}

async function handleTelegramUpdate(update) {
  const message = update.message || update.edited_message;
  if (!message || !message.chat || !message.text) return;

  const chatId = message.chat.id;
  const from = message.from || {};
  const text = String(message.text || '').trim();
  const parts = text.split(/\s+/);
  const command = String(parts[0] || '').replace(/^\/+/, '').split('@')[0].toLowerCase();
  const admissionNo = normalizeAdmission(parts[1] || (/^\d{1,6}$/.test(parts[0]) ? parts[0] : ''));
  const effectiveCommand = /^\d{1,6}$/.test(parts[0]) ? 'register' : command;

  if (['start', 'help', 'commands', 'menu'].includes(effectiveCommand) && !admissionNo) {
    await sendTelegram(chatId, helpMessage(getTelegramName(from)));
    await logEvent(chatId, getTelegramName(from), effectiveCommand, '', 'Help Sent', 'Help menu sent');
    return;
  }

  if (['register', 'link', 'start'].includes(effectiveCommand)) return handleRegister(chatId, from, admissionNo, effectiveCommand);
  if (effectiveCommand === 'status') return handleStatus(chatId, from, admissionNo);
  if (['fees', 'fee', 'dues', 'due'].includes(effectiveCommand)) return handleFees(chatId, admissionNo);
  if (['whoami', 'mychildren', 'myward'].includes(effectiveCommand)) return handleWhoAmI(chatId, from);

  await sendTelegram(chatId, helpMessage(getTelegramName(from)));
}

function isLikelyChatId(value, admissionNo) {
  const s = String(value || '').trim();
  if (!/^\d{7,15}$/.test(s)) return false;
  if (normalizeAdmission(s) === normalizeAdmission(admissionNo)) return false;
  return true;
}

/** Registrations tab columns sometimes drift from bot headers — recover chat ID for ERP sync. */
function normalizeRegistrationRow(row) {
  const out = { ...(row || {}) };
  let chatId = String(out.SchoolBotChatId || out.ChatId || '').trim();

  if (!chatId && isLikelyChatId(out.ParentName, out.AdmissionNo)) {
    chatId = String(out.ParentName).trim();
    out.ParentName = '';
  }

  const statusStr = String(out.Status || '').trim();
  const extraStatus = String(out[''] || '').trim();
  if (statusStr.includes('Telegram /')) {
    out.LinkSource = out.LinkSource || statusStr;
    out.Status = extraStatus || 'Linked';
  } else if (!out.Status && extraStatus) {
    out.Status = extraStatus;
  }

  if (!out.DateTime && out.Timestamp) out.DateTime = out.Timestamp;
  out.SchoolBotChatId = chatId;
  return out;
}

async function getRegistrations() {
  const { rows } = await getRows('Registrations');
  const registrations = rows.map(row => normalizeRegistrationRow(row.data));
  const byAdmission = new Map();
  registrations.forEach(r => {
    const adm = normalizeAdmission(r.AdmissionNo);
    if (adm) byAdmission.set(adm, r);
  });

  // ERP sync reads Registrations; /link always updates Students first (Registrations can lag or misalign).
  try {
    const students = await getRows('Students');
    students.rows.forEach(row => {
      const s = row.data;
      const adm = normalizeAdmission(s.AdmissionNo);
      const chatId = String(s.SchoolBotChatId || '').trim();
      if (!adm || !chatId) return;

      if (byAdmission.has(adm)) {
        const existing = byAdmission.get(adm);
        if (!String(existing.SchoolBotChatId || '').trim()) {
          existing.SchoolBotChatId = chatId;
          existing.TelegramUserName = existing.TelegramUserName || s.TelegramUserName || '';
          if (!existing.Status || String(existing.Status).includes('Telegram /')) {
            existing.Status = 'Linked';
          }
        }
        return;
      }

      registrations.push(normalizeRegistrationRow({
        DateTime: '',
        AdmissionNo: s.AdmissionNo,
        StudentName: s.StudentName,
        Class: s.Class,
        Section: s.Section,
        ParentName: s.ParentName,
        ParentPhone: s.ParentPhone,
        SchoolBotChatId: chatId,
        TelegramUserName: s.TelegramUserName || '',
        LinkSource: 'Students tab',
        Status: s.Status || 'Linked'
      }));
      byAdmission.set(adm, registrations[registrations.length - 1]);
    });
  } catch (error) {
    console.error('Students fallback for registrations sync failed:', error.message);
  }

  return registrations;
}

async function getLinkedStudents() {
  const { rows } = await getRows('Students');
  return rows
    .map(row => row.data)
    .filter(s => String(s.SchoolBotChatId || '').trim())
    .map(s => ({
      AdmissionNo: s.AdmissionNo,
      StudentName: s.StudentName,
      Class: s.Class,
      Section: s.Section,
      SchoolBotChatId: String(s.SchoolBotChatId).trim(),
      TelegramUserName: s.TelegramUserName || '',
      Status: s.Status || 'Linked'
    }));
}

const FEE_SHEET_KEYS = ['DueMonths', 'TuitionDue', 'ExamFeeDue', 'ComputerFeeDue', 'AnnualFeeDue', 'PreviousSessionDue', 'TotalDue'];

async function syncStudentFeesOnSheet(students, dryRun = false) {
  const items = Array.isArray(students) ? students : [];
  if (!items.length) return { updated: 0, results: [], error: 'No students provided.' };

  if (useGoogleScript()) {
    const result = await scriptRequest('syncStudentFees', { students: items, dryRun });
    return { updated: Number(result.updated || 0), results: result.results || [] };
  }

  const { headers, rows } = await getRows('Students');
  const studentHeaders = headers && headers.length ? headers : SHEET_HEADERS.Students;
  const results = [];
  let updated = 0;
  const rowWrites = [];

  for (const patch of items) {
    const adm = normalizeAdmission(patch.AdmissionNo);
    if (!adm) {
      results.push({ AdmissionNo: patch.AdmissionNo || '', ok: false, error: 'missing_admission' });
      continue;
    }
    const match = rows.find(row => normalizeAdmission(row.data.AdmissionNo) === adm);
    if (!match) {
      results.push({ AdmissionNo: adm, ok: false, error: 'not_found_on_students_tab' });
      continue;
    }

    const merged = { ...match.data };
    const changes = {};
    FEE_SHEET_KEYS.forEach(key => {
      if (patch[key] === undefined) return;
      const value = patch[key] === null ? '' : String(patch[key]);
      changes[key] = value;
      merged[key] = value;
    });

    if (!dryRun) rowWrites.push({ rowIndex: match.index, values: rowFromMap(studentHeaders, merged) });
    results.push({ AdmissionNo: adm, ok: true, dryRun, rowIndex: match.index, changes });
    updated += 1;
  }

  if (!dryRun && rowWrites.length) {
    const data = rowWrites.map(write => ({
      range: `Students!A${write.rowIndex}:Z${write.rowIndex}`,
      values: [write.values]
    }));
    for (let i = 0; i < data.length; i += 100) {
      await sheetsRequest('POST', `/v4/spreadsheets/${sheetId()}/values:batchUpdate`, {
        valueInputOption: 'USER_ENTERED',
        data: data.slice(i, i + 100)
      });
    }
  }

  return { updated, results };
}

async function syncStudentFees(req, res) {
  const body = req.body || {};
  const dryRun = body.dryRun === true;
  const students = Array.isArray(body.students) ? body.students : (body.AdmissionNo ? [body] : []);
  if (!students.length) {
    return json(res, 400, { ok: false, error: 'POST body must include students[] or a single AdmissionNo payload.' });
  }
  const result = await syncStudentFeesOnSheet(students, dryRun);
  const missing = result.results.filter(r => !r.ok).length;
  return json(res, 200, {
    ok: true,
    dryRun,
    updated: result.updated,
    missing,
    results: result.results
  });
}

async function logErpMessage(req, res) {
  const body = req.body || {};
  const type = String(body.type || '').trim();
  const payload = body.payload || {};
  const now = new Date().toLocaleString('en-IN');

  if (type === 'fee_due') {
    await appendRow('Fee_Due_Messages', [
      now,
      payload.AdmissionNo || '',
      payload.StudentName || '',
      payload.Class || '',
      payload.Section || '',
      payload.SchoolBotChatId || '',
      payload.DueMonths || '',
      payload.TuitionDue || '',
      payload.ExamFeeDue || '',
      payload.ComputerFeeDue || '',
      payload.AnnualFeeDue || '',
      payload.PreviousSessionDue || '',
      payload.TotalDue || '',
      payload.SentBy || 'ERP',
      payload.Status || 'Sent',
      payload.TelegramMessageId || ''
    ]);
    return json(res, 200, { ok: true, sheet: 'Fee_Due_Messages' });
  }

  if (type === 'fee_receipt') {
    await appendRow('Fee_Receipt_Messages', [
      now,
      payload.ReceiptNo || '',
      payload.AdmissionNo || '',
      payload.StudentName || '',
      payload.Class || '',
      payload.Section || '',
      payload.SchoolBotChatId || '',
      payload.AmountPaid || '',
      payload.PaymentMode || '',
      payload.ReceiptType || '',
      payload.SentBy || 'ERP',
      payload.Status || 'Sent',
      payload.TelegramMessageId || ''
    ]);
    return json(res, 200, { ok: true, sheet: 'Fee_Receipt_Messages' });
  }

  if (type === 'school_message') {
    await appendRow('School_Messages', [
      now,
      payload.MessageCategory || '',
      payload.TargetType || '',
      payload.TargetValue || '',
      payload.AdmissionNos || '',
      payload.StudentNames || '',
      payload.SchoolBotChatIds || '',
      payload.MessageText || '',
      payload.SentBy || 'ERP',
      payload.Status || 'Sent',
      payload.TelegramMessageIds || ''
    ]);
    return json(res, 200, { ok: true, sheet: 'School_Messages' });
  }

  if (type === 'exam_schedule') {
    await appendRow('Exam_Schedule_Messages', [
      now,
      payload.ExamTerm || '',
      payload.Class || '',
      payload.Section || '',
      payload.Subject || '',
      payload.ExamDate || '',
      payload.StartTime || '',
      payload.EndTime || '',
      payload.MaxMarks || '',
      payload.TargetType || '',
      payload.SentBy || 'ERP',
      payload.Status || 'Sent',
      payload.TelegramMessageIds || ''
    ]);
    return json(res, 200, { ok: true, sheet: 'Exam_Schedule_Messages' });
  }

  return json(res, 400, { ok: false, error: 'Unknown log type.' });
}

async function sendErpTelegramMessage(req, res) {
  const body = req.body || {};
  const chatId = String(body.chatId || body.SchoolBotChatId || '').trim();
  const text = String(body.text || body.message || '').trim();
  if (!chatId || !text) {
    return json(res, 400, { ok: false, error: 'chatId and text are required.' });
  }
  const telegram = await sendTelegram(chatId, text);
  return json(res, 200, { ok: telegram?.ok !== false, telegram });
}

async function sendErpTelegramDocument(req, res) {
  const body = req.body || {};
  const chatId = String(body.chatId || body.SchoolBotChatId || '').trim();
  const filename = String(body.filename || 'document.pdf').trim() || 'document.pdf';
  const caption = String(body.caption || '').trim();
  const mimeType = String(body.mimeType || 'application/pdf').trim() || 'application/pdf';
  const documentBase64 = String(body.documentBase64 || '').trim();
  if (!chatId || !documentBase64) {
    return json(res, 400, { ok: false, error: 'chatId and documentBase64 are required.' });
  }
  const buffer = Buffer.from(documentBase64, 'base64');
  if (!buffer.length) {
    return json(res, 400, { ok: false, error: 'documentBase64 is empty or invalid.' });
  }
  const telegram = await sendTelegramDocument(chatId, buffer, filename, caption, mimeType);
  if (telegram?.ok === false) {
    return json(res, 200, {
      ok: false,
      error: telegram.description || 'Telegram rejected the document.',
      telegram
    });
  }
  return json(res, 200, { ok: true, telegram });
}

async function getTelegramChatInfo(req, res) {
  const chatId = String(req.body?.chatId || req.query.chatId || '').trim();
  if (!chatId) return json(res, 400, { ok: false, error: 'chatId is required.' });
  const token = botToken();
  const telegram = await requestJson('GET', 'api.telegram.org', `/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`);
  return json(res, 200, telegram);
}

async function checkGoogleScript(req, res) {
  const scriptUrl = getScriptUrl();
  if (!scriptUrl) {
    return json(res, 200, { ok: false, error: 'GOOGLE_SCRIPT_URL is missing.' });
  }
  const meta = {
    scriptUrlLength: scriptUrl.length,
    scriptUrlStart: scriptUrl.slice(0, 45),
    scriptUrlEnd: scriptUrl.slice(-20)
  };
  try {
    const getPing = await requestScriptJson('GET', scriptUrl);
    let postResult = null;
    let postError = '';
    try {
      postResult = await requestScriptJson('POST', scriptUrl, { action: 'setupSheet', sheetHeaders: {}, sheetAliases: {} });
    } catch (error) {
      postError = error.message;
    }
    const ok = !!(getPing && getPing.ok) && !!(postResult && postResult.ok);
    return json(res, 200, {
      ok,
      ...meta,
      getPing,
      postResult,
      postError: postError || undefined
    });
  } catch (error) {
    return json(res, 200, { ok: false, ...meta, error: error.message });
  }
}

async function setupWebhook(req, res) {
  const secret = adminSecret();
  if (secret && req.query.secret !== secret) return json(res, 403, { ok: false, error: 'Forbidden' });
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${proto}://${host}/api/mmmjhs-bot`;
  const token = botToken();
  const result = await requestJson('POST', 'api.telegram.org', `/bot${token}/setWebhook`, {
    url: webhookUrl,
    drop_pending_updates: false
  });
  return json(res, 200, { ok: true, webhookUrl, telegram: result });
}

async function setupSheet(req, res) {
  const secret = adminSecret();
  if (secret && req.query.secret !== secret) return json(res, 403, { ok: false, error: 'Forbidden' });
  if (useGoogleScript()) {
    const result = await scriptRequest('setupSheet', { sheetHeaders: SHEET_HEADERS, sheetAliases: SHEET_ALIASES });
    return json(res, 200, { ok: true, mode: 'google_script', result });
  }
  const metadata = await sheetsRequest('GET', `/v4/spreadsheets/${sheetId()}`, null);
  const existingTitles = new Set((metadata.sheets || []).map(s => s.properties.title));
  const requests = Object.keys(SHEET_HEADERS)
    .filter(title => !existingTitles.has(title))
    .map(title => ({ addSheet: { properties: { title } } }));
  if (requests.length) await sheetsRequest('POST', `/v4/spreadsheets/${sheetId()}:batchUpdate`, { requests });
  for (const [tab, headers] of Object.entries(SHEET_HEADERS)) {
    const current = await getRows(tab).catch(() => ({ headers: [], rows: [] }));
    if (current.isEmpty || !current.headers.length || current.headers.join('|') !== headers.join('|')) {
      await sheetsRequest('PUT', `/v4/spreadsheets/${sheetId()}/values/${encodeURIComponent(`${tab}!A1:Z1`)}?valueInputOption=USER_ENTERED`, { values: [headers] });
    }
  }
  return json(res, 200, { ok: true, tabs: Object.keys(SHEET_HEADERS) });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return empty(res);

    const action = String(req.query?.action || '').trim();

    // Cloud-native + snapshot compat (Supabase). Never touches @Vipinbellbot.
    if (erpCloud && ['cloudConfig', 'cloudPull', 'cloudPush', 'nativeStudents', 'nativeMigrate', 'nativePayments', 'rebuildSnapshot', 'wipeRoster'].includes(action)) {
      if (typeof erpCloud.route === 'function') {
        const handled = await erpCloud.route(req, res, action);
        if (handled !== false) return;
      }
      return erpCloud(req, res);
    }

    if (req.method === 'GET') {
      if (action === 'setupWebhook') return setupWebhook(req, res);
      if (action === 'setupSheet') return setupSheet(req, res);
      if (action === 'checkScript') return checkGoogleScript(req, res);
      if (action === 'registrations') return json(res, 200, { ok: true, registrations: await getRegistrations() });
      if (action === 'linkedStudents') return json(res, 200, { ok: true, students: await getLinkedStudents() });
      return json(res, 200, { ok: true, service: '@mmmjhschoolbot webhook' });
    }

    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed' });
    if (action === 'sendMessage') return sendErpTelegramMessage(req, res);
    if (action === 'sendDocument') return sendErpTelegramDocument(req, res);
    if (action === 'getChat') return getTelegramChatInfo(req, res);
    if (action === 'logMessage') return logErpMessage(req, res);
    if (action === 'syncStudentFees') return syncStudentFees(req, res);
    await handleTelegramUpdate(req.body || {});
    return json(res, 200, { ok: true });
  } catch (error) {
    console.error(error);
    try {
      const message = req.body?.message || req.body?.edited_message;
      const chatId = message?.chat?.id;
      if (chatId) {
        await sendTelegram(chatId, `Server Error\n\nThe school bot received your message but could not complete it.\nReason: ${error.message}\n\nPlease tell the school office/admin to check Render environment variables and Google Sheet access.`);
      }
    } catch (replyError) {
      console.error('Could not send error reply:', replyError.message);
    }
    return json(res, 200, { ok: false, error: error.message });
  }
};
