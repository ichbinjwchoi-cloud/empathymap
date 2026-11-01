// 공감지도 만들기 — 실시간 조별 공감지도 서버
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const TEACHER_CODE = process.env.TEACHER_CODE || '9812';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
// 구글 시트 자동 저장 (README의 "구글 시트 자동 저장" 참고)
const SHEET_URL = (process.env.SHEET_URL || '').trim();
const SHEET_SECRET = (process.env.SHEET_SECRET || '').trim();

const CLASS_COUNT = 8;      // 1~8반
const MAX_GROUPS = 10;      // 한 반 최대 조 수
const MAX_NOTES = 300;      // 한 조 최대 포스트잇 수
const MAX_IMAGE = 1500000;  // 사진 최대 크기(바이트)
const AREAS = ['think', 'hear', 'say', 'pain', 'gain'];
const AREA_KO = { think: 'Think & Feel', hear: 'Hear', say: 'Say & Do', pain: 'Pain', gain: 'Gain (Want)' };
const COLORS = ['yellow', 'pink', 'green', 'blue', 'orange', 'purple'];

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 데이터 ----------
// db.classes[반] = { topic, groupCount, locked, image: {id} | null, groups: { [조]: { notes, updatedAt } } }
// db.images[id] = { type, b64 }
let db = { classes: {}, images: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (loaded && loaded.classes) db = { classes: loaded.classes, images: loaded.images || {} };
} catch (e) { /* 처음 실행 */ }

function newClass() { return { topic: '난민', groupCount: 6, locked: false, image: null, groups: {} }; }
function getClass(cls) {
  const k = String(cls);
  if (!db.classes[k]) db.classes[k] = newClass();
  return db.classes[k];
}
function peekGroup(cls, g) { return getClass(cls).groups[String(g)] || { notes: [], updatedAt: 0 }; }
function getGroup(cls, g) {
  const c = getClass(cls), k = String(g);
  if (!c.groups[k]) c.groups[k] = { notes: [], updatedAt: 0 };
  return c.groups[k];
}
function classInfo(cls) {
  const c = getClass(cls);
  return { topic: c.topic, groupCount: c.groupCount, locked: c.locked, image: c.image && db.images[c.image.id] ? c.image.id : null, timer: timerInfo(cls) };
}
// 타이머: { state: 'idle' | 'running' | 'paused', endAt, left(멈췄을 때 남은 ms), total }
function timerInfo(cls) {
  const t = getClass(cls).timer || { state: 'idle' };
  return Object.assign({}, t, { now: Date.now() });
}

// ---------- 저장: 서버 파일 + 구글 시트 ----------
let fileTimer = null;
function saveFile() {
  clearTimeout(fileTimer);
  fileTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), err => { if (err) log('파일 저장 실패', err.message); });
  }, 800);
}
function saveFileNow() {
  clearTimeout(fileTimer);
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { log('파일 저장 실패', e.message); }
}

const remote = {
  enabled: !!(SHEET_URL && SHEET_SECRET),
  loaded: false, busy: false, timer: null, fails: 0,
  dirtyDb: false, dirtyImgs: new Set(), logRows: [],
  lastOk: 0, lastErr: ''
};

function saveStatus() {
  return {
    mode: remote.enabled ? 'sheet' : 'local',
    loaded: remote.loaded,
    ok: remote.enabled ? (remote.loaded && !remote.lastErr) : true,
    lastOk: remote.lastOk,
    err: remote.lastErr,
    pending: remote.dirtyDb || remote.dirtyImgs.size > 0 || remote.logRows.length > 0
  };
}
let lastStatusJson = '';
function pushStatus(force) {
  const s = saveStatus(), j = JSON.stringify([s.mode, s.loaded, s.ok, s.err, s.pending, Math.floor(s.lastOk / 10000)]);
  if (!force && j === lastStatusJson) return;
  lastStatusJson = j;
  if (io) io.to('teachers').emit('save:status', s);
}

function changed(kind, extra) {
  if (kind === 'db') remote.dirtyDb = true;
  if (kind === 'img') remote.dirtyImgs.add(extra);
  saveFile();
  scheduleRemote(2500);
}
function addLog(action, cls, group, note) {
  if (!remote.enabled) return;
  remote.logRows.push([
    new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    cls + '반', group + '조', action, AREA_KO[note.area] || note.area, note.text, note.author
  ]);
  if (remote.logRows.length > 5000) remote.logRows.splice(0, remote.logRows.length - 5000);
}

function scheduleRemote(delay) {
  if (!remote.enabled || remote.timer) return;
  remote.timer = setTimeout(flushRemote, delay);
}

async function sheetCall(body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    let res;
    if (body) {
      res = await fetch(SHEET_URL, {
        method: 'POST', redirect: 'follow', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ secret: SHEET_SECRET }, body))
      });
    } else {
      const u = SHEET_URL + (SHEET_URL.includes('?') ? '&' : '?') + 'secret=' + encodeURIComponent(SHEET_SECRET);
      res = await fetch(u, { redirect: 'follow', signal: ctrl.signal });
    }
    const txt = await res.text();
    let j;
    try { j = JSON.parse(txt); } catch (e) {
      throw new Error('구글 시트 응답을 읽지 못했어요 (HTTP ' + res.status + '). 웹 앱 주소와 "모든 사용자" 공개 설정을 확인해 주세요.');
    }
    if (!j.ok) throw new Error(j.error === 'secret' ? '구글 시트 비밀번호(SHEET_SECRET)가 서로 달라요.' : ('구글 시트 오류: ' + (j.error || '알 수 없음')));
    return j;
  } finally { clearTimeout(t); }
}

async function flushRemote() {
  remote.timer = null;
  if (!remote.enabled || !remote.loaded) return;
  if (remote.busy) { scheduleRemote(1000); return; }
  if (!remote.dirtyDb && !remote.dirtyImgs.size && !remote.logRows.length) return;

  const put = {}, del = [];
  const imgs = [...remote.dirtyImgs];
  const sentDb = remote.dirtyDb;
  if (sentDb) put.db = JSON.stringify({ classes: db.classes });
  imgs.forEach(id => { if (db.images[id]) put['img:' + id] = JSON.stringify(db.images[id]); else del.push('img:' + id); });
  const rows = remote.logRows.splice(0);
  remote.dirtyDb = false; remote.dirtyImgs.clear();
  remote.busy = true;
  try {
    await sheetCall({ put, del, log: rows });
    remote.lastOk = Date.now(); remote.lastErr = ''; remote.fails = 0;
  } catch (e) {
    if (sentDb) remote.dirtyDb = true;
    imgs.forEach(id => remote.dirtyImgs.add(id));
    remote.logRows.unshift(...rows);
    remote.fails++;
    remote.lastErr = e.name === 'AbortError' ? '구글 시트 응답이 늦어요. 다시 시도하는 중이에요.' : e.message;
    log('구글 시트 저장 실패:', remote.lastErr);
    scheduleRemote(Math.min(60000, 4000 * remote.fails));
  } finally {
    remote.busy = false;
    pushStatus();
    if (remote.dirtyDb || remote.dirtyImgs.size || remote.logRows.length) scheduleRemote(1500);
  }
}

function mergeClasses(into, from) {
  for (const k in from) {
    if (!into[k]) { into[k] = from[k]; continue; }
    const a = into[k], b = from[k];
    if (!a.image && b.image) a.image = b.image;
    for (const g in (b.groups || {})) {
      if (!a.groups[g]) { a.groups[g] = b.groups[g]; continue; }
      const have = new Set(a.groups[g].notes.map(n => n.id));
      b.groups[g].notes.forEach(n => { if (!have.has(n.id)) a.groups[g].notes.push(n); });
      a.groups[g].updatedAt = Math.max(a.groups[g].updatedAt || 0, b.groups[g].updatedAt || 0);
    }
  }
}

// replace=true: 서버가 막 켜졌을 때 — 구글 시트 내용을 그대로 씀
// replace=false: 늦게 불러왔을 때 — 지금 내용과 합침
async function loadRemote(replace) {
  const j = await sheetCall(null);
  const items = j.items || {};
  const images = {};
  for (const key in items) {
    if (key.startsWith('img:')) { try { images[key.slice(4)] = JSON.parse(items[key]); } catch (e) {} }
  }
  let classes = null;
  if (items.db) { try { classes = JSON.parse(items.db).classes; } catch (e) { log('시트의 db를 읽지 못함'); } }
  if (classes) {
    if (replace) { db.classes = classes; }
    else { mergeClasses(db.classes, classes); remote.dirtyDb = true; }
  } else if (Object.keys(db.classes).length) {
    remote.dirtyDb = true; // 시트가 비어 있으면 지금 내용을 올림
  }
  for (const id in images) if (!db.images[id]) db.images[id] = images[id];
  for (const id in db.images) if (!images[id]) remote.dirtyImgs.add(id);
  remote.loaded = true; remote.lastErr = ''; remote.lastOk = Date.now();
  saveFile();
  log('구글 시트에서 불러옴: 반', Object.keys(db.classes).length, '사진', Object.keys(db.images).length);
}
async function retryLoadLoop() {
  while (!remote.loaded) {
    await sleep(30000);
    try { await loadRemote(false); pushStatus(); scheduleRemote(500); }
    catch (e) { remote.lastErr = e.message; pushStatus(); }
  }
}

function cleanImages() {
  const used = new Set(Object.values(db.classes).map(c => c.image && c.image.id).filter(Boolean));
  for (const id in db.images) if (!used.has(id)) { delete db.images[id]; imgBuf.delete(id); changed('img', id); }
}

// ---------- 서버 ----------
const validCls = c => Number.isInteger(Number(c)) && Number(c) >= 1 && Number(c) <= CLASS_COUNT;
const validGroup = g => Number.isInteger(Number(g)) && Number(g) >= 1 && Number(g) <= MAX_GROUPS;
const validId = s => typeof s === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(s);
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cRoom = cls => `c:${cls}`;
const gRoom = (cls, g) => `g:${cls}:${g}`;
const tRoom = cls => `t:${cls}`;

const app = express();
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/healthz', (req, res) => { res.set('Cache-Control', 'no-store'); res.send('ok'); });

const imgBuf = new Map();
app.get('/img/:id', (req, res) => {
  const im = db.images[req.params.id];
  if (!im) return res.status(404).send('no image');
  let buf = imgBuf.get(req.params.id);
  if (!buf) { buf = Buffer.from(im.b64, 'base64'); imgBuf.set(req.params.id, buf); }
  res.set('Content-Type', im.type);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(buf);
});

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000, maxHttpBufferSize: 4e6 });

async function namesIn(cls, g) {
  const sockets = await io.in(gRoom(cls, g)).fetchSockets();
  return [...new Set(sockets.map(s => s.data.name).filter(Boolean))];
}
async function presence(cls, g) {
  const names = await namesIn(cls, g);
  io.to([gRoom(cls, g), tRoom(cls)]).emit('presence', { cls, group: g, names });
}
function leaveStudent(socket) {
  const { cls, group } = socket.data;
  if (!cls) return;
  socket.leave(cRoom(cls));
  socket.leave(gRoom(cls, group));
  socket.data.cls = null; socket.data.group = null;
  presence(cls, group);
}
// 학생 입장 (방 들어가기는 바로, 접속자 알림은 나중에)
function joinStudent(socket, p) {
  const name = clean(p.name, 12);
  if (!name) return { ok: false, msg: '이름을 입력해 주세요.' };
  if (!validCls(p.cls) || !validGroup(p.group)) return { ok: false, msg: '반과 조를 확인해 주세요.' };
  const cls = +p.cls, group = +p.group;
  if (socket.data.cls && (socket.data.cls !== cls || socket.data.group !== group)) leaveStudent(socket);
  const clientId = clean(p.clientId, 64) || socket.id;
  Object.assign(socket.data, { cls, group, name, clientId, owner: clientId + '|' + name });
  socket.join([cRoom(cls), gRoom(cls, group)]);
  presence(cls, group);
  return { ok: true, info: classInfo(cls), notes: peekGroup(cls, group).notes };
}

function target(socket, p) {
  if (socket.data.teacher && p && validCls(p.cls) && validGroup(p.group)) return { cls: +p.cls, group: +p.group };
  if (socket.data.cls) return { cls: socket.data.cls, group: socket.data.group };
  return null;
}
function emitBoard(t, ev, payload) {
  io.to([gRoom(t.cls, t.group), tRoom(t.cls)]).emit(ev, { cls: t.cls, group: t.group, ...payload });
}
function emitClass(cls) {
  io.to([cRoom(cls), tRoom(cls)]).emit('class:settings', { cls, info: classInfo(cls) });
}
const fn = f => (typeof f === 'function' ? f : () => {});
const isOwner = (socket, note) => socket.data.teacher || note.owner === socket.data.owner || note.owner === socket.data.clientId;

io.on('connection', socket => {
  socket.data.tries = 0;
  // 다시 연결될 때 자동으로 원래 자리로 (끊긴 동안 쓴 포스트잇이 사라지지 않게)
  const auth = socket.handshake.auth || {};
  if (auth.student && typeof auth.student === 'object') joinStudent(socket, auth.student);
  if (auth.teacher != null && String(auth.teacher) === TEACHER_CODE) {
    socket.data.teacher = true;
    socket.join('teachers');
    if (validCls(auth.watch)) socket.join(tRoom(+auth.watch));
  }

  socket.on('class:info', (cls, ack) => {
    ack = fn(ack);
    if (!validCls(cls)) return ack(null);
    ack(classInfo(+cls));
  });

  // ----- 학생 -----
  socket.on('student:join', (p, ack) => { ack = fn(ack); ack(joinStudent(socket, p || {})); });
  socket.on('student:leave', () => leaveStudent(socket));

  // ----- 포스트잇 -----
  const blocked = t => getClass(t.cls).locked && !socket.data.teacher;
  const LOCK_MSG = '선생님이 지금은 편집을 잠가 두었어요.';

  socket.on('note:add', (p, ack) => {
    ack = fn(ack); p = p || {};
    const t = target(socket, p);
    if (!t) return ack({ ok: false, msg: '다시 입장해 주세요.' });
    const g = getGroup(t.cls, t.group);
    if (validId(p.id) && g.notes.some(n => n.id === p.id)) return ack({ ok: true }); // 같은 포스트잇 두 번 방지
    if (blocked(t)) return ack({ ok: false, msg: LOCK_MSG });
    if (!AREAS.includes(p.area)) return ack({ ok: false, msg: '칸을 다시 골라 주세요.' });
    const text = clean(p.text, 200);
    if (!text) return ack({ ok: false, msg: '내용을 적어 주세요.' });
    if (g.notes.length >= MAX_NOTES) return ack({ ok: false, msg: '포스트잇이 너무 많아요.' });
    const note = {
      id: validId(p.id) ? p.id : crypto.randomUUID(),
      area: p.area,
      text,
      color: COLORS.includes(p.color) ? p.color : 'yellow',
      author: socket.data.teacher ? '선생님' : socket.data.name,
      owner: socket.data.teacher ? 'teacher' : socket.data.owner,
      createdAt: Date.now()
    };
    g.notes.push(note); g.updatedAt = Date.now();
    addLog('붙임', t.cls, t.group, note);
    changed('db');
    emitBoard(t, 'note:added', { note });
    ack({ ok: true });
  });

  socket.on('note:update', (p, ack) => {
    ack = fn(ack); p = p || {};
    const t = target(socket, p);
    if (!t) return ack({ ok: false, msg: '다시 입장해 주세요.' });
    if (blocked(t)) return ack({ ok: false, msg: LOCK_MSG });
    const g = getGroup(t.cls, t.group);
    const note = g.notes.find(n => n.id === p.id);
    if (!note) return ack({ ok: false, msg: '포스트잇을 찾을 수 없어요. 이미 지워졌을 수 있어요.' });
    const owner = isOwner(socket, note);
    const before = note.text;
    // 칸 옮기기는 조원 누구나, 내용·색 고치기는 쓴 사람(또는 교사)만
    if (p.area !== undefined && AREAS.includes(p.area)) note.area = p.area;
    if (owner) {
      if (p.text !== undefined) { const tx = clean(p.text, 200); if (tx) note.text = tx; }
      if (p.color !== undefined && COLORS.includes(p.color)) note.color = p.color;
    }
    g.updatedAt = Date.now();
    if (note.text !== before) addLog('고침', t.cls, t.group, note);
    changed('db');
    emitBoard(t, 'note:updated', { note });
    ack({ ok: true });
  });

  socket.on('note:delete', (p, ack) => {
    ack = fn(ack); p = p || {};
    const t = target(socket, p);
    if (!t) return ack({ ok: false, msg: '다시 입장해 주세요.' });
    if (blocked(t)) return ack({ ok: false, msg: LOCK_MSG });
    const g = getGroup(t.cls, t.group);
    const i = g.notes.findIndex(n => n.id === p.id);
    if (i < 0) return ack({ ok: true });
    if (!isOwner(socket, g.notes[i])) return ack({ ok: false, msg: '내가 쓴 포스트잇만 지울 수 있어요.' });
    addLog('지움', t.cls, t.group, g.notes[i]);
    g.notes.splice(i, 1); g.updatedAt = Date.now();
    changed('db');
    emitBoard(t, 'note:deleted', { id: p.id });
    ack({ ok: true });
  });

  // ----- 교사 -----
  socket.on('teacher:login', (code, ack) => {
    ack = fn(ack);
    if (socket.data.tries >= 10) return ack({ ok: false, msg: '시도 횟수를 넘었어요. 새로고침 후 다시 해 주세요.' });
    socket.data.tries++;
    if (String(code) !== TEACHER_CODE) return ack({ ok: false, msg: '교사 코드가 맞지 않아요.' });
    socket.data.teacher = true; socket.data.tries = 0;
    socket.join('teachers');
    ack({ ok: true, classCount: CLASS_COUNT, maxGroups: MAX_GROUPS, status: saveStatus() });
  });

  socket.on('teacher:logout', () => {
    socket.data.teacher = false;
    socket.leave('teachers');
    for (const r of socket.rooms) if (r.startsWith('t:')) socket.leave(r);
  });

  socket.on('teacher:watch', async (cls, ack) => {
    ack = fn(ack);
    if (!socket.data.teacher || !validCls(cls)) return ack({ ok: false });
    cls = +cls;
    for (const r of socket.rooms) if (r.startsWith('t:')) socket.leave(r);
    socket.join(tRoom(cls));
    const groups = {};
    for (let g = 1; g <= MAX_GROUPS; g++) {
      const grp = peekGroup(cls, g);
      groups[g] = { notes: grp.notes, updatedAt: grp.updatedAt, names: await namesIn(cls, g) };
    }
    ack({ ok: true, info: classInfo(cls), groups, status: saveStatus() });
  });

  socket.on('teacher:settings', (p, ack) => {
    ack = fn(ack); p = p || {};
    if (!socket.data.teacher || !validCls(p.cls)) return ack({ ok: false });
    const cls = +p.cls;
    const list = p.all ? Array.from({ length: CLASS_COUNT }, (_, i) => i + 1) : [cls];
    if (p.topic !== undefined) {
      const tp = clean(p.topic, 20);
      if (tp) list.forEach(c => { getClass(c).topic = tp; });
    }
    const c = getClass(cls);
    if (p.groupCount !== undefined && validGroup(p.groupCount)) c.groupCount = +p.groupCount;
    if (p.locked !== undefined) c.locked = !!p.locked;
    changed('db');
    new Set([...list, cls]).forEach(emitClass);
    ack({ ok: true });
  });

  socket.on('teacher:image', (p, ack) => {
    ack = fn(ack); p = p || {};
    if (!socket.data.teacher || !validCls(p.cls)) return ack({ ok: false, msg: '교사 모드로 다시 들어와 주세요.' });
    const list = p.all ? Array.from({ length: CLASS_COUNT }, (_, i) => i + 1) : [+p.cls];
    let image = null;
    if (p.dataUrl) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(p.dataUrl));
      if (!m) return ack({ ok: false, msg: '사진 형식을 읽지 못했어요. JPG나 PNG 사진을 올려 주세요.' });
      const bytes = Math.floor(m[2].length * 3 / 4);
      if (bytes > MAX_IMAGE) return ack({ ok: false, msg: '사진이 너무 커요.' });
      const id = crypto.createHash('sha1').update(m[2]).digest('hex').slice(0, 20);
      if (!db.images[id]) { db.images[id] = { type: m[1], b64: m[2] }; changed('img', id); }
      image = { id };
    }
    list.forEach(c => { getClass(c).image = image; });
    cleanImages();
    changed('db');
    list.forEach(emitClass);
    ack({ ok: true });
  });

  socket.on('teacher:timer', (p, ack) => {
    ack = fn(ack); p = p || {};
    if (!socket.data.teacher || !validCls(p.cls)) return ack({ ok: false, msg: '교사 모드로 다시 들어와 주세요.' });
    const cls = +p.cls, c = getClass(cls), now = Date.now();
    const t = c.timer || { state: 'idle' };
    const left = () => t.state === 'running' ? Math.max(0, t.endAt - now) : (t.left || 0);
    if (p.action === 'start') {
      const min = Math.round(Number(p.minutes));
      if (!(min >= 1 && min <= 180)) return ack({ ok: false, msg: '1분에서 180분 사이로 적어 주세요.' });
      c.timer = { state: 'running', endAt: now + min * 60000, total: min * 60000 };
    } else if (p.action === 'add') {
      if (t.state === 'idle') return ack({ ok: false, msg: '먼저 타이머를 시작해 주세요.' });
      const l = left() + 60000;
      c.timer = t.state === 'paused' ? Object.assign(t, { left: l, total: t.total + 60000 })
        : { state: 'running', endAt: now + l, total: (t.total || 0) + 60000 };
    } else if (p.action === 'pause') {
      if (t.state !== 'running') return ack({ ok: true });
      c.timer = { state: 'paused', left: left(), total: t.total };
    } else if (p.action === 'resume') {
      if (t.state !== 'paused') return ack({ ok: true });
      c.timer = { state: 'running', endAt: now + (t.left || 0), total: t.total };
    } else if (p.action === 'reset') {
      c.timer = { state: 'idle' };
    } else return ack({ ok: false });
    changed('db');
    io.to([cRoom(cls), tRoom(cls)]).emit('timer', { cls, timer: timerInfo(cls) });
    ack({ ok: true });
  });

  socket.on('teacher:reset', (p, ack) => {
    ack = fn(ack); p = p || {};
    if (!socket.data.teacher || !validCls(p.cls)) return ack({ ok: false });
    const cls = +p.cls, c = getClass(cls);
    const group = validGroup(p.group) ? +p.group : null;
    if (group) delete c.groups[String(group)]; else c.groups = {};
    changed('db');
    io.to([cRoom(cls), tRoom(cls)]).emit('board:reset', { cls, group });
    ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const { cls, group } = socket.data;
    if (cls) presence(cls, group);
  });
});

// ---------- 시작 · 종료 ----------
async function start() {
  if (remote.enabled) {
    for (let i = 0; i < 3 && !remote.loaded; i++) {
      try { await loadRemote(true); }
      catch (e) { remote.lastErr = e.message; log('구글 시트 불러오기 실패:', e.message); if (i < 2) await sleep(3000); }
    }
    if (!remote.loaded) retryLoadLoop();
    else scheduleRemote(1000);
  } else {
    log('⚠️ 구글 시트 자동 저장이 설정되지 않았어요 (SHEET_URL, SHEET_SECRET). 서버 파일에만 저장해요.');
  }
  server.listen(PORT, () => log(`공감지도 서버 실행 중: http://localhost:${PORT}`));
}

let stopping = false;
async function shutdown(sig) {
  if (stopping) return;
  stopping = true;
  log(sig, '받음 — 저장 후 종료');
  saveFileNow();
  if (remote.enabled && remote.loaded) {
    clearTimeout(remote.timer); remote.timer = null;
    const until = Date.now() + 20000;
    while (Date.now() < until && (remote.busy || remote.dirtyDb || remote.dirtyImgs.size || remote.logRows.length)) {
      if (!remote.busy) await flushRemote();
      else await sleep(200);
      if (remote.lastErr) break;
    }
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
