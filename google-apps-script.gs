/**
 * 공감지도 만들기 — 구글 시트 자동 저장용 Apps Script
 *
 * 1) 아래 SECRET 값을 아무도 모르는 영어+숫자 조합으로 바꿔 주세요. (예시를 그대로 쓰지 말고 직접 지어 주세요)
 * 2) Render의 Environment에 SHEET_SECRET 으로 똑같은 값을 넣어 주세요.
 * 3) 배포 → 새 배포 → 웹 앱, "실행: 나", "액세스: 모든 사용자" 로 배포하고
 *    나온 웹 앱 URL을 Render의 SHEET_URL 에 넣어 주세요.
 *
 * 시트 안내
 *  - 포스트잇(현재): 지금 공감지도에 붙어 있는 포스트잇 (자동으로 계속 바뀜)
 *  - 기록(모든 활동): 붙이기·고치기·지우기가 모두 차례로 쌓이는 기록 (지운 것도 남음)
 *  - _data, _img: 앱이 쓰는 저장 공간이에요. 지우거나 고치지 마세요.
 */
const SECRET = '여기에-비밀번호를-적어-주세요';

const CHUNK = 40000;   // 한 칸에 넣는 글자 수 (구글 시트 한 칸 최대 5만 자)
const MARK = '~';      // 저장 값이 숫자·날짜·수식으로 바뀌지 않도록 붙이는 표시

function doGet(e) {
  if (!e || !e.parameter || e.parameter.secret !== SECRET) return out_({ ok: false, error: 'secret' });
  const items = {};
  readStore_('_data', items);
  readStore_('_img', items);
  return out_({ ok: true, items: items });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'json' }); }
  if (body.secret !== SECRET) return out_({ ok: false, error: 'secret' });
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const put = body.put || {}, del = body.del || [];
    const dataPut = {}, imgPut = {}, dataDel = [], imgDel = [];
    Object.keys(put).forEach(function (k) { (k.indexOf('img:') === 0 ? imgPut : dataPut)[k] = put[k]; });
    del.forEach(function (k) { (k.indexOf('img:') === 0 ? imgDel : dataDel).push(k); });
    if (Object.keys(dataPut).length || dataDel.length) writeStore_('_data', dataPut, dataDel);
    if (Object.keys(imgPut).length || imgDel.length) writeStore_('_img', imgPut, imgDel);
    if (put.db) writeCurrent_(JSON.parse(put.db));
    if (body.log && body.log.length) appendLog_(body.log);
    return out_({ ok: true });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------- 저장 공간 ----------
function store_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, 3).setValues([['key', 'part', 'value']]);
    sh.setFrozenRows(1);
    if (ss.getSheets().length > 1) sh.hideSheet();
  }
  return sh;
}

function readStore_(name, items) {
  const sh = store_(name);
  const last = sh.getLastRow();
  if (last < 2) return;
  const rows = sh.getRange(2, 1, last - 1, 3).getValues();
  const parts = {};
  rows.forEach(function (r) {
    const k = String(r[0]);
    if (!k) return;
    let v = String(r[2]);
    if (v.charAt(0) === MARK) v = v.slice(1);
    (parts[k] = parts[k] || []).push([Number(r[1]), v]);
  });
  Object.keys(parts).forEach(function (k) {
    items[k] = parts[k].sort(function (a, b) { return a[0] - b[0]; }).map(function (p) { return p[1]; }).join('');
  });
}

function writeStore_(name, put, del) {
  const sh = store_(name);
  const last = sh.getLastRow();
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 3).getValues() : [];
  const drop = {};
  Object.keys(put).concat(del).forEach(function (k) { drop[k] = true; });
  const keep = rows.filter(function (r) { return r[0] && !drop[String(r[0])]; });
  Object.keys(put).forEach(function (k) {
    const v = String(put[k]);
    let p = 0;
    for (let i = 0; i < Math.max(v.length, 1); i += CHUNK) keep.push([k, p++, MARK + v.slice(i, i + CHUNK)]);
  });
  if (last >= 2) sh.getRange(2, 1, last - 1, 3).clearContent();
  if (keep.length) sh.getRange(2, 1, keep.length, 3).setValues(keep);
}

// ---------- 사람이 보는 시트 ----------
const AREA_KO = { think: 'Think & Feel', hear: 'Hear', say: 'Say & Do', pain: 'Pain', gain: 'Gain (Want)' };
const AREA_ORDER = ['think', 'hear', 'say', 'pain', 'gain'];

function safe_(v) {
  v = String(v == null ? '' : v);
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function sheet_(name, header) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function writeCurrent_(data) {
  const header = ['반', '조', '칸', '내용', '작성자', '작성 시각'];
  const sh = sheet_('포스트잇(현재)', header);
  const rows = [];
  const classes = (data && data.classes) || {};
  Object.keys(classes).sort(function (a, b) { return a - b; }).forEach(function (c) {
    const groups = classes[c].groups || {};
    Object.keys(groups).sort(function (a, b) { return a - b; }).forEach(function (g) {
      (groups[g].notes || []).slice().sort(function (x, y) {
        return AREA_ORDER.indexOf(x.area) - AREA_ORDER.indexOf(y.area) || x.createdAt - y.createdAt;
      }).forEach(function (n) {
        rows.push([c + '반', g + '조', AREA_KO[n.area] || n.area, safe_(n.text), safe_(n.author),
          Utilities.formatDate(new Date(n.createdAt), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')]);
      });
    });
  });
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, header.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
}

function appendLog_(rows) {
  const header = ['시각', '반', '조', '동작', '칸', '내용', '작성자'];
  const sh = sheet_('기록(모든 활동)', header);
  const clean = rows.map(function (r) { return header.map(function (_, i) { return safe_(r[i]); }); });
  sh.getRange(sh.getLastRow() + 1, 1, clean.length, header.length).setValues(clean);
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 설정 확인용: Apps Script 편집기에서 이 함수를 한 번 실행하면 권한 승인 창이 뜨고 시트가 만들어져요. */
function setup() {
  store_('_data');
  store_('_img');
  sheet_('포스트잇(현재)', ['반', '조', '칸', '내용', '작성자', '작성 시각']);
  sheet_('기록(모든 활동)', ['시각', '반', '조', '동작', '칸', '내용', '작성자']);
  SpreadsheetApp.getActive().toast('공감지도 저장 시트 준비 완료!');
}
