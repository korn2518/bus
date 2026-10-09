/**
 * 귀가 조사 웹앱 (서버)
 *
 * 설치: 구글 시트 > 확장 프로그램 > Apps Script 에서
 *   1) 이 파일 내용을 Code.gs 에 붙여넣고
 *   2) HTML 파일을 'Index' 라는 이름으로 추가해 Index.html 내용을 붙여넣은 뒤
 *   3) 배포 > 새 배포 > 웹 앱 (실행: 나, 액세스: 모든 사용자) 로 배포합니다.
 *
 * 화면을 GitHub에 올려 쓸 때는 2)를 건너뛰고, 3)에서 나온 웹 앱 주소(.../exec)를
 * index.html 맨 위 API_URL 에 붙여넣습니다. 이 파일은 두 방식에 똑같이 씁니다.
 * 코드를 고친 뒤에는 배포 > 배포 관리 > 수정(연필) > 버전: 새 버전 으로 다시 배포해야 반영됩니다.
 *
 * 주소 (Apps Script 주소 또는 GitHub 주소 뒤에)
 *   (없음)   학생용 (학년을 먼저 고름)
 *   ?g=1     1학년 학생용 (g=2, g=3 도 같음)
 *   ?v=t     교사용
 *
 * 조사 날짜: 기본은 매주 금요일. 설정에서 그 주(월~일) 안의 다른 날로 바꿀 수 있다.
 * 시트 탭: 설정(연도, 정원, 등록, 바뀐 날짜), 명단(학년, 번호, 이름), 응답(원본 기록),
 *          누적표 2026 1학년 ... (연도, 학년별 ○ 표)
 */

var SH = { SET: '설정', ROSTER: '명단', RESP: '응답', CUM: '누적표 ' };
var GRADES = ['1학년', '2학년', '3학년'];
var METHODS = ['대중교통', '부모님차량'];
var DAYS = ['일', '월', '화', '수', '목', '금', '토'];
var MARK = '○';
var CUM_NAME_ROW = 4;            // 누적표에서 이름이 시작되는 행
var CUM_DATE_COL = 3;            // 누적표에서 날짜가 시작되는 열 (A 번호, B 이름)
var SET_ROWS = 60;               // 설정 탭에서 읽는 줄 수 (1~3행 설정, 5행 제목, 6행부터 바뀐 날짜)
var OVR_ROW = 5;
var NAME_RE = /^[\p{L}][\p{L}\p{N} .-]{0,19}$/u;

/* ───────── 화면 ───────── */

function doGet(e) {
  var p = (e && e.parameter) || {};
  var view = p.v === 't' ? 'teacher' : 'student';
  var grade = GRADES[parseInt(p.g, 10) - 1] || '';
  var page;
  try {
    page = HtmlService.createHtmlOutputFromFile('Index').getContent();
  } catch (err) {
    // 화면을 GitHub에 올려 쓰는 경우: 이 프로젝트에는 Index 파일이 없고 저장만 맡는다
    return ContentService.createTextOutput('귀가 조사 저장 서버가 동작 중입니다. 화면은 GitHub 주소로 열어 주세요.');
  }
  var html = page
    .split('__VIEW__').join(view)
    .split('__GRADE__').join(grade)
    .split('__APP_URL__').join(ScriptApp.getService().getUrl() || '');
  return HtmlService.createHtmlOutput(html)
    .setTitle('귀가 조사')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* ───────── GitHub 화면용 API ─────────
 * 화면(index.html)이 { fn: '함수 이름', args: [...] } 를 보내면 아래 목록에 있는 함수만 실행해
 * { ok: true, data } 또는 { ok: false, error } 로 답한다.
 */

function api_() {
  return {
    getState: getState, registerName: registerName, submitResponse: submitResponse,
    checkPin: checkPin, setPin: setPin, teacherMark: teacherMark, saveSettings: saveSettings,
    renameStudent: renameStudent, addStudent: addStudent, getSummary: getSummary,
    setWeekDate: setWeekDate, teacherMemo: teacherMemo
  };
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || 'null') || {};
    var api = api_();
    if (typeof req.fn !== 'string' || !Object.prototype.hasOwnProperty.call(api, req.fn)) throw new Error('알 수 없는 요청입니다.');
    var args = Object.prototype.toString.call(req.args) === '[object Array]' ? req.args : [];
    out = { ok: true, data: api[req.fn].apply(null, args) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────── 누구나 쓰는 기능 (학생용) ───────── */

function getState(dateKey, grade) {
  fresh_();
  return state_(dateKey, grade);
}

/** QR로 들어온 학생이 자기 이름을 그 학년 명단에 올린다. 이미 있으면 그대로 둔다. */
function registerName(grade, rawName, dateKey) {
  fresh_();
  return locked_(function () {
    checkGrade_(grade);
    var name = cleanName_(rawName);
    if (readRosters_()[grade].indexOf(name) < 0) enroll_(grade, name, true);
    return state_(dateKey, grade);
  });
}

/**
 * register 가 true 이면 명단에 없는 이름을 먼저 등록한다 (요청 한 번으로 끝낸다).
 * memo 는 부모님 차량일 때만 남기는 특이사항 (적지 않아도 된다).
 */
function submitResponse(dateKey, grade, rawName, method, register, memo) {
  fresh_();
  return locked_(function () {
    if (METHODS.indexOf(method) < 0) throw new Error('귀가 방법을 골라 주세요.');
    if (register) {
      checkGrade_(grade);
      var name = cleanName_(rawName);
      if (readRosters_()[grade].indexOf(name) < 0) enroll_(grade, name, true);
    }
    return mark_(dateKey, grade, rawName, method, '학생', memo);
  });
}

/* ───────── 교사용 기능 (비밀번호 필요) ───────── */

function checkPin(pin) {
  fresh_();
  checkPin_(pin);
  return { sheetUrl: ss_().getUrl() };
}

function setPin(oldPin, newPin) {
  fresh_();
  return locked_(function () {
    if (getPin_()) checkPin_(oldPin);
    if (!/^\d{4,8}$/.test(String(newPin))) throw new Error('비밀번호는 숫자 4~8자리로 정해 주세요.');
    PropertiesService.getScriptProperties().setProperty('PIN', String(newPin));
    memo_().pin = String(newPin);
    return true;
  });
}

/** method 가 빈 문자열이면 표시를 지운다. */
function teacherMark(pin, dateKey, grade, rawName, method) {
  fresh_();
  checkPin_(pin);
  return locked_(function () {
    if (method !== '' && METHODS.indexOf(method) < 0) throw new Error('귀가 방법을 골라 주세요.');
    return mark_(dateKey, grade, rawName, method, '교사', '');
  });
}

/** 교사가 부모님 차량 학생의 특이사항을 적거나 고친다 (빈칸이면 지운다). */
function teacherMemo(pin, dateKey, grade, rawName, memo) {
  fresh_();
  checkPin_(pin);
  return locked_(function () {
    checkGrade_(grade);
    var cfg = readConfig_();
    checkSurveyDate_(dateKey, cfg);
    var name = cleanName_(rawName), text = cleanMemo_(memo), found = null;
    readResponses_().some(function (r) {
      if (r.date === dateKey && r.grade === grade && r.name === name) { found = r; return true; }
      return false;
    });
    if (!found || found.method !== METHODS[1]) throw new Error('부모님 차량으로 표시한 학생만 특이사항을 적을 수 있습니다.');
    var sh = sheet_(SH.RESP);
    sh.getRange(found.row, 7).setNumberFormat('@').setValue(text);
    sh.getRange(1, 7).setValue('특이사항');
    found.memo = text;
    return state_(dateKey, grade);
  });
}

/** cfg = { year, capacity, open, rosters: { '1학년': [이름...], ... } } */
function saveSettings(pin, cfg, dateKey, grade) {
  fresh_();
  checkPin_(pin);
  return locked_(function () {
    var year = parseInt(cfg.year, 10);
    var capacity = parseInt(cfg.capacity, 10);
    if (!(year >= 2000 && year <= 2100)) throw new Error('연도를 확인해 주세요.');
    if (!(capacity >= 1 && capacity <= 60)) throw new Error('정원은 1~60명 사이로 정해 주세요.');
    var rosters = {};
    GRADES.forEach(function (g) {
      var names = [];
      ((cfg.rosters && cfg.rosters[g]) || []).forEach(function (raw) {
        if (!String(raw == null ? '' : raw).trim()) return;
        var n = cleanName_(raw);
        if (names.indexOf(n) < 0) names.push(n);
      });
      if (names.length > capacity) throw new Error(g + ' 명단이 ' + names.length + '명으로 정원 ' + capacity + '명보다 많습니다.');
      rosters[g] = names;
    });
    writeSettings_({ year: year, capacity: capacity, open: !!cfg.open });
    writeRosters_(rosters);
    GRADES.forEach(function (g) { rebuildCumulative_(year, g); });
    return state_(dateKey, grade);
  });
}

/** 주간 표에서 이름을 고친다. 지난 응답과 누적표 기록도 새 이름으로 따라온다. */
function renameStudent(pin, grade, oldName, rawNew, dateKey) {
  fresh_();
  checkPin_(pin);
  return locked_(function () {
    checkGrade_(grade);
    var name = cleanName_(rawNew);
    var old = String(oldName == null ? '' : oldName).trim();
    var rosters = readRosters_();
    var at = rosters[grade].indexOf(old);
    if (at < 0) throw new Error(grade + ' 명단에 없는 이름입니다.');
    if (name === old) return state_(dateKey, grade);
    if (rosters[grade].indexOf(name) >= 0) throw new Error(grade + '에 이미 같은 이름이 있습니다.');
    rosters[grade][at] = name;
    writeRosters_(rosters);

    var sh = sheet_(SH.RESP), years = {};
    years[String(readConfig_().year)] = true;
    readResponses_().forEach(function (r) {
      if (r.grade !== grade || r.name !== old) return;
      sh.getRange(r.row, 4).setNumberFormat('@').setValue(name);
      years[r.date.slice(0, 4)] = true;
    });
    memo_().resp = null;
    Object.keys(years).forEach(function (y) { rebuildCumulative_(y, grade); });
    return state_(dateKey, grade);
  });
}

/** 주간 표의 빈 줄에 교사가 학생을 추가한다 (QR 등록이 닫혀 있어도 된다). */
function addStudent(pin, grade, rawName, dateKey) {
  fresh_();
  checkPin_(pin);
  return locked_(function () {
    checkGrade_(grade);
    var name = cleanName_(rawName);
    if (readRosters_()[grade].indexOf(name) >= 0) throw new Error(grade + '에 이미 같은 이름이 있습니다.');
    enroll_(grade, name, false);
    rebuildCumulative_(readConfig_().year, grade);
    return state_(dateKey, grade);
  });
}

/** 그날 대중교통으로 가는 학생을 학년별로 모은다. */
function getSummary(pin, dateKey) {
  fresh_();
  checkPin_(pin);
  if (!isDate_(dateKey)) throw new Error('날짜를 확인해 주세요.');
  var rosters = readRosters_(), by = {};
  readResponses_().forEach(function (r) {
    if (r.date === dateKey && r.method) by[r.grade + '|' + r.name] = r;
  });
  var total = 0;
  var grades = GRADES.map(function (g) {
    var transit = [], notes = [], answered = 0;
    rosters[g].forEach(function (n) {
      var r = by[g + '|' + n], m = r && r.method;
      if (m) answered++;
      if (m === METHODS[0]) transit.push(n);
      if (m === METHODS[1] && r.memo) notes.push({ name: n, memo: r.memo });
    });
    total += transit.length;
    return { grade: g, total: rosters[g].length, answered: answered, transit: transit, notes: notes };
  });
  return { date: dateKey, transitTotal: total, grades: grades };
}

/**
 * 그 주의 조사 날짜를 바꾼다. friday 는 그 주의 금요일, newDate 는 같은 주(월~일) 안의 날.
 * newDate 가 금요일 자신이면 원래대로 되돌린다. 이미 받은 응답도 새 날짜로 옮긴다.
 */
function setWeekDate(pin, friday, newDate, grade) {
  fresh_();
  checkPin_(pin);
  return locked_(function () {
    if (!isDate_(friday) || toDate_(friday).getDay() !== 5) throw new Error('기준이 되는 금요일을 확인해 주세요.');
    if (!isDate_(newDate)) throw new Error('바꿀 날짜를 확인해 주세요.');
    var cfg = readConfig_();
    if (friday.slice(0, 4) !== String(cfg.year) || newDate.slice(0, 4) !== String(cfg.year)) {
      throw new Error('설정된 연도(' + cfg.year + ')의 날짜만 고를 수 있습니다.');
    }
    if (weekFriday_(newDate) !== friday) throw new Error('같은 주(월요일~일요일) 안의 날짜만 고를 수 있습니다.');
    var old = cfg.overrides[friday] || friday;
    if (old !== newDate) {
      var sh = sheet_(SH.RESP);
      readResponses_().forEach(function (r) {
        if (r.date === old) sh.getRange(r.row, 2).setNumberFormat('@').setValue(newDate);
      });
      memo_().resp = null;
      if (newDate === friday) delete cfg.overrides[friday]; else cfg.overrides[friday] = newDate;
      writeOverrides_(cfg.overrides);
      GRADES.forEach(function (g) { rebuildCumulative_(cfg.year, g); });
    }
    return state_(newDate, grade);
  });
}

/* ───────── 내부: 상태, 검증 ───────── */

function state_(dateKey, grade) {
  var cfg = readConfig_();
  var g = GRADES.indexOf(grade) >= 0 ? grade : '';
  var all = {}, memos = {};
  GRADES.forEach(function (x) { all[x] = {}; memos[x] = {}; });
  if (isDate_(dateKey)) {
    readResponses_().forEach(function (r) {
      if (r.date !== dateKey || !r.method || !all[r.grade]) return;
      all[r.grade][r.name] = r.method;
      if (r.memo && r.method === METHODS[1]) memos[r.grade][r.name] = r.memo;
    });
  }
  var overrides = {};
  Object.keys(cfg.overrides).forEach(function (k) { overrides[k] = cfg.overrides[k]; });
  return {
    year: cfg.year, capacity: cfg.capacity, open: cfg.open,
    grades: GRADES, rosters: readRosters_(), overrides: overrides,
    responses: g ? all[g] : {}, responsesAll: all, memosAll: memos,
    date: dateKey || '', grade: g, hasPin: !!getPin_()
  };
}

function mark_(dateKey, grade, rawName, method, by, memo) {
  checkGrade_(grade);
  var cfg = readConfig_();
  checkSurveyDate_(dateKey, cfg);
  var name = cleanName_(rawName);
  var text = method === METHODS[1] ? cleanMemo_(memo) : '';     // 특이사항은 부모님 차량일 때만
  if (readRosters_()[grade].indexOf(name) < 0) throw new Error(grade + ' 명단에 없는 이름입니다.');
  upsertResponse_(dateKey, grade, name, method, by, text);
  markCumulative_(cfg.year, grade, dateKey, name, method);
  return state_(dateKey, grade);
}

/** 명단에 한 명을 넣는다. 학생이 스스로 등록할 때는 등록이 열려 있어야 한다. */
function enroll_(grade, name, byStudent) {
  var cfg = readConfig_();
  var rosters = readRosters_();
  if (byStudent && !cfg.open) throw new Error('지금은 이름 등록을 받지 않습니다. 선생님께 말씀드리세요.');
  if (rosters[grade].length >= cfg.capacity) {
    throw new Error(byStudent
      ? grade + ' 정원 ' + cfg.capacity + '명이 모두 등록되었습니다. 선생님께 말씀드리세요.'
      : grade + ' 정원 ' + cfg.capacity + '명이 모두 찼습니다. 설정에서 정원을 늘려 주세요.');
  }
  rosters[grade].push(name);
  writeRosters_(rosters);
}

/** 그 주의 조사 날짜(기본 금요일, 바뀌었으면 바뀐 날)만 받는다. */
function checkSurveyDate_(dateKey, cfg) {
  if (!isDate_(dateKey)) throw new Error('조사 날짜가 아닙니다. 날짜를 확인해 주세요.');
  var f = weekFriday_(dateKey);
  if (f.slice(0, 4) !== String(cfg.year)) throw new Error('설정된 연도(' + cfg.year + ')와 다른 날짜입니다.');
  var want = cfg.overrides[f] || f;
  if (want !== dateKey) throw new Error('조사 날짜가 아닙니다. 이 주의 조사 날짜는 ' + longDate_(want) + '입니다.');
}

function checkGrade_(grade) {
  if (GRADES.indexOf(grade) < 0) throw new Error('학년을 골라 주세요.');
}

/** 특이사항: 빈칸 정리, 수식으로 읽히지 않게 앞 기호 떼기, 40자까지 */
function cleanMemo_(raw) {
  var text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().replace(/^[=+\-@\s]+/, '');
  if (text.length > 40) throw new Error('특이사항은 40자 이내로 적어 주세요.');
  return text;
}

function cleanName_(raw) {
  var name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!NAME_RE.test(name)) throw new Error('이름은 한글이나 영문으로 20자 이내로 적어 주세요.');
  return name;
}

/** 가나다순. 한글 음절은 글자 코드 순서가 곧 사전 순서다. */
function byName_(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isDate_(key) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return false;
  var d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

function toDate_(key) {
  var p = String(key).split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

function keyOf_(d) {
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** 그 날이 들어 있는 주(월요일~일요일)의 금요일 */
function weekFriday_(key) {
  var d = toDate_(key);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 4);
  return keyOf_(d);
}

function longDate_(key) {
  var d = toDate_(key);
  return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + DAYS[d.getDay()] + '요일';
}

function getPin_() {
  var m = memo_();
  if (m.pin === undefined) m.pin = PropertiesService.getScriptProperties().getProperty('PIN') || '';
  return m.pin;
}

function checkPin_(pin) {
  var stored = getPin_();
  if (!stored) throw new Error('교사 비밀번호를 먼저 만들어 주세요.');
  if (String(pin) !== stored) throw new Error('비밀번호가 맞지 않습니다.');
}

function locked_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ───────── 내부: 한 번 실행하는 동안 읽은 것을 기억해 같은 시트를 다시 읽지 않는다 ───────── */

var M_ = {};
function fresh_() { M_ = {}; }
function memo_() { return M_; }

/* ───────── 내부: 시트 읽고 쓰기 ───────── */

function ss_() {
  var m = memo_();
  if (m.ss) return m.ss;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('구글 시트의 [확장 프로그램 > Apps Script]에서 만든 스크립트여야 합니다.');
  return (m.ss = ss);
}

/** 탭 목록은 한 번에 읽어 둔다. 없는 탭은 만든다. */
function sheets_() {
  var m = memo_();
  if (!m.sheets) {
    m.sheets = {};
    ss_().getSheets().forEach(function (sh) { m.sheets[sh.getName()] = sh; });
  }
  return m.sheets;
}

function sheet_(name) {
  var all = sheets_();
  if (all[name]) return all[name];
  var sh = ss_().insertSheet(name);
  all[name] = sh;
  if (name === SH.SET) {
    sh.getRange(1, 1, 3, 2).setValues([['연도', new Date().getFullYear()], ['학년당 정원', 20], ['QR 이름 등록', '열림']]);
    sh.getRange(1, 1, 3, 1).setFontWeight('bold');
  } else if (name === SH.ROSTER) {
    sh.getRange(1, 1, sh.getMaxRows(), 1).setNumberFormat('@');
    sh.getRange(1, 3, sh.getMaxRows(), 1).setNumberFormat('@');
    sh.getRange(1, 1, 1, 3).setValues([['학년', '번호', '이름']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (name === SH.RESP) {
    sh.getRange(1, 2, sh.getMaxRows(), 3).setNumberFormat('@');   // 날짜, 학년, 이름은 글자 그대로
    sh.getRange(1, 7, sh.getMaxRows(), 1).setNumberFormat('@');   // 특이사항
    sh.getRange(1, 1, 1, 7).setValues([['기록 시각', '날짜', '학년', '이름', '귀가 방법', '입력', '특이사항']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 설정과 바뀐 날짜를 한 번에 읽는다. */
function readConfig_() {
  var m = memo_();
  if (m.cfg) return m.cfg;
  var v = sheet_(SH.SET).getRange(1, 1, SET_ROWS, 2).getValues();
  var year = parseInt(v[0][1], 10), cap = parseInt(v[1][1], 10);
  var overrides = {};
  for (var i = OVR_ROW; i < v.length; i++) {
    var f = dateKey_(v[i][0]), d = dateKey_(v[i][1]);
    if (isDate_(f) && isDate_(d) && weekFriday_(d) === f) overrides[f] = d;
  }
  return (m.cfg = {
    year: (year >= 2000 && year <= 2100) ? year : new Date().getFullYear(),
    capacity: (cap >= 1 && cap <= 60) ? cap : 20,
    open: String(v[2][1]).trim() !== '닫힘',
    overrides: overrides
  });
}

function writeSettings_(s) {
  sheet_(SH.SET).getRange(1, 1, 3, 2)
    .setValues([['연도', s.year], ['학년당 정원', s.capacity], ['QR 이름 등록', s.open ? '열림' : '닫힘']]);
  var cfg = readConfig_();
  cfg.year = s.year; cfg.capacity = s.capacity; cfg.open = s.open;
}

/** 바뀐 날짜를 설정 탭 5행부터 다시 적는다. 하나도 없으면 제목 줄도 지운다. */
function writeOverrides_(overrides) {
  var sh = sheet_(SH.SET);
  sh.getRange(OVR_ROW, 1, SET_ROWS - OVR_ROW + 1, 2).clearContent();
  var keys = Object.keys(overrides).sort();
  if (!keys.length) return;
  sh.getRange(OVR_ROW, 1, keys.length + 1, 2).setNumberFormat('@');
  sh.getRange(OVR_ROW, 1, keys.length + 1, 2).setValues([['날짜 변경 (원래 금요일)', '바뀐 날짜']].concat(
    keys.map(function (k) { return [k, overrides[k]]; })));
  sh.getRange(OVR_ROW, 1, 1, 2).setFontWeight('bold');
}

/** { '1학년': [가나다순 이름...], '2학년': [...], '3학년': [...] } (복사본을 돌려준다) */
function readRosters_() {
  var m = memo_();
  if (!m.rosters) {
    var out = {};
    GRADES.forEach(function (g) { out[g] = []; });
    var sh = sheet_(SH.ROSTER);
    var last = sh.getLastRow();
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, 3).getValues().forEach(function (r) {
        var g = String(r[0]).trim(), n = String(r[2]).trim();
        if (out[g] && n && out[g].indexOf(n) < 0) out[g].push(n);
      });
    }
    GRADES.forEach(function (g) { out[g].sort(byName_); });
    m.rosters = out;
  }
  var copy = {};
  GRADES.forEach(function (g) { copy[g] = m.rosters[g].slice(); });
  return copy;
}

/** 학년 순, 가나다순으로 다시 적고 번호를 매긴다. */
function writeRosters_(rosters) {
  var sh = sheet_(SH.ROSTER);
  var rows = [], kept = {};
  GRADES.forEach(function (g) {
    kept[g] = (rosters[g] || []).slice().sort(byName_);
    kept[g].forEach(function (n, i) { rows.push([g, i + 1, n]); });
  });
  var last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, 3).setValues(rows);
  memo_().rosters = kept;
}

function readResponses_() {
  var m = memo_();
  if (m.resp) return m.resp;
  var sh = sheet_(SH.RESP);
  var last = sh.getLastRow();
  if (last < 2) return (m.resp = []);
  return (m.resp = sh.getRange(2, 1, last - 1, 7).getValues().map(function (v, i) {
    return { row: i + 2, date: dateKey_(v[1]), grade: String(v[2]).trim(), name: String(v[3]).trim(), method: String(v[4]).trim(), memo: String(v[6] == null ? '' : v[6]).trim() };
  }));
}

/** 같은 날짜, 학년, 이름이 있으면 그 행을 고치고, 없으면 새 행을 붙인다. method 가 비면 지운다. */
function upsertResponse_(dateKey, grade, name, method, by, memo) {
  var sh = sheet_(SH.RESP);
  var list = readResponses_(), found = null;
  list.some(function (r) {
    if (r.date === dateKey && r.grade === grade && r.name === name) { found = r; return true; }
    return false;
  });
  if (!method) {
    if (found) { sh.deleteRow(found.row); memo_().resp = null; }
    return;
  }
  memo = memo || '';
  var row = [new Date(), dateKey, grade, name, method, by, memo];
  if (memo) sh.getRange(1, 7).setValue('특이사항');              // 예전 버전에서 만든 탭에도 제목을 붙인다
  if (found) {
    sh.getRange(found.row, 2, 1, 3).setNumberFormat('@');
    sh.getRange(found.row, 7).setNumberFormat('@');
    sh.getRange(found.row, 1, 1, 7).setValues([row]);
    found.method = method; found.memo = memo;
  } else {
    sh.appendRow(row);
    list.push({ row: -1, date: dateKey, grade: grade, name: name, method: method, memo: memo });   // 행 번호는 이번 실행에서 다시 쓰지 않는다
  }
}

/** 시트가 날짜처럼 생긴 글자를 Date로 바꿔 놓아도 'YYYY-MM-DD' 로 되돌린다. */
function dateKey_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    var m = memo_();
    if (!m.tz) m.tz = ss_().getSpreadsheetTimeZone();
    return Utilities.formatDate(v, m.tz, 'yyyy-MM-dd');
  }
  return String(v).trim();
}

/* ───────── 내부: 누적표 (연도, 학년마다 탭 하나) ─────────
 *   1행  번호 | 이름 | 2026-10-02 (두 칸 병합) | 2026-10-09 ...
 *   2행       |      | 대중교통 | 부모님차량  | ...
 *   3행       | 합계 | =COUNTIF | =COUNTIF    | ...
 *   4행~  1   | 학생 |    ○     |             | ...
 */

function cumSheet_(year, grade) {
  var name = SH.CUM + year + ' ' + grade, all = sheets_();
  return all[name] || (all[name] = ss_().insertSheet(name));
}

/** 응답 한 건만 바뀌었을 때 해당 두 칸만 고친다. 표 전체를 한 번에 읽어 위치를 찾는다. */
function markCumulative_(year, grade, dateKey, name, method) {
  var sh = cumSheet_(year, grade);
  var lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < CUM_NAME_ROW - 1 || lastCol < CUM_DATE_COL - 1) { rebuildCumulative_(year, grade); return; }

  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var names = values.slice(CUM_NAME_ROW - 1).map(function (r) { return String(r[1]).trim(); });
  var idx = names.indexOf(name);
  if (idx < 0) { rebuildCumulative_(year, grade); return; }      // 새로 등록된 학생: 가나다순, 번호를 다시 매긴다

  var head = values[0].map(dateKey_);
  var col = head.indexOf(dateKey) + 1;
  if (!col) {
    var newest = '';
    for (var c = CUM_DATE_COL - 1; c < head.length; c++) if (head[c] > newest) newest = head[c];
    if (dateKey < newest) { rebuildCumulative_(year, grade); return; }   // 지난 날짜는 날짜순으로 다시 그린다
    col = Math.max(lastCol, CUM_DATE_COL - 1) + 1;
    addDateColumns_(sh, col, dateKey);
  }
  sh.getRange(idx + CUM_NAME_ROW, col, 1, 2)
    .setValues([[method === METHODS[0] ? MARK : '', method === METHODS[1] ? MARK : '']]);
}

function addDateColumns_(sh, col, dateKey) {
  ensureSize_(sh, CUM_NAME_ROW, col + 1);
  sh.getRange(1, col, 1, 2).setNumberFormat('@');
  sh.getRange(1, col, 3, 2).setValues([
    [dateKey, ''],
    [METHODS[0], METHODS[1]],
    [countFormula_(col), countFormula_(col + 1)]
  ]);
  sh.getRange(1, col, 1, 2).merge();
  styleCumulative_(sh, col, 2);
}

/** 가나다순 명단, 날짜순으로 누적표 전체를 다시 그린다 (명단 변경, 지난 날짜 입력, 날짜 변경 때). */
function rebuildCumulative_(year, grade) {
  var sh = cumSheet_(year, grade);
  var roster = readRosters_()[grade];
  var rows = readResponses_().filter(function (r) {
    return r.grade === grade && r.date.slice(0, 4) === String(year) && r.method;
  });
  var dates = [], names = roster.slice(), map = {};
  rows.forEach(function (r) {
    if (dates.indexOf(r.date) < 0) dates.push(r.date);
    if (names.indexOf(r.name) < 0) names.push(r.name);   // 명단에서 빠진 학생의 지난 기록은 아래쪽에 남긴다
    map[r.date + '|' + r.name] = r.method;
  });
  dates.sort();

  var first = CUM_DATE_COL;
  var nCols = first - 1 + dates.length * 2, nRows = CUM_NAME_ROW - 1 + names.length;
  var grid = [['번호', '이름'], ['', ''], ['', '합계']];
  dates.forEach(function (d, i) {
    grid[0].push(d, '');
    grid[1].push(METHODS[0], METHODS[1]);
    grid[2].push(countFormula_(first + i * 2), countFormula_(first + 1 + i * 2));
  });
  names.forEach(function (n, i) {
    var line = [i < roster.length ? i + 1 : '', n];
    dates.forEach(function (d) {
      var m = map[d + '|' + n];
      line.push(m === METHODS[0] ? MARK : '', m === METHODS[1] ? MARK : '');
    });
    grid.push(line);
  });

  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  ensureSize_(sh, nRows, nCols);
  sh.getRange(1, 1, 1, nCols).setNumberFormat('@');
  sh.getRange(1, 2, nRows, 1).setNumberFormat('@');
  sh.getRange(1, 1, nRows, nCols).setValues(grid);
  sh.getRange(1, 1, 2, 1).merge();
  sh.getRange(1, 2, 2, 1).merge();
  dates.forEach(function (d, i) { sh.getRange(1, first + i * 2, 1, 2).merge(); });
  sh.getRange(1, 1, 3, 2).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setBackground('#E3EAF5');
  sh.getRange(1, 1, sh.getMaxRows(), 1).setHorizontalAlignment('center');
  if (dates.length) styleCumulative_(sh, first, dates.length * 2);
  sh.setFrozenRows(CUM_NAME_ROW - 1);
  sh.setFrozenColumns(2);
}

function styleCumulative_(sh, col, nCols) {
  sh.getRange(1, col, 3, nCols).setFontWeight('bold').setHorizontalAlignment('center').setBackground('#E3EAF5');
  sh.getRange(CUM_NAME_ROW, col, sh.getMaxRows() - CUM_NAME_ROW + 1, nCols).setHorizontalAlignment('center');
}

function countFormula_(col) {
  var a = colLetter_(col);
  return '=COUNTIF(' + a + CUM_NAME_ROW + ':' + a + ',"' + MARK + '")';
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s;
}

function ensureSize_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}
