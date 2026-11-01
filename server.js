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
const CLASS_COUNT = 8;   // 1~8반
const MAX_GROUPS = 10;   // 한 반 최대 조 수
const MAX_NOTES = 300;   // 한 조 최대 포스트잇 수
const AREAS = ['think', 'hear', 'say', 'pain', 'gain'];
const COLORS = ['yellow', 'pink', 'green', 'blue', 'orange', 'purple'];

// ---------- 데이터 ----------
let db = { classes: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (loaded && loaded.classes) db = loaded;
} catch (e) { /* 처음 실행 */ }

function newClass() { return { topic: '난민', groupCount: 6, locked: false, groups: {} }; }
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
  return { topic: c.topic, groupCount: c.groupCount, locked: c.locked };
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), err => { if (err) console.error('저장 실패', err.message); });
  }, 800);
}

const validCls = c => Number.isInteger(Number(c)) && Number(c) >= 1 && Number(c) <= CLASS_COUNT;
const validGroup = g => Number.isInteger(Number(g)) && Number(g) >= 1 && Number(g) <= MAX_GROUPS;
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const cRoom = cls => `c:${cls}`;
const gRoom = (cls, g) => `g:${cls}:${g}`;
const tRoom = cls => `t:${cls}`;

// ---------- 서버 ----------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { pingInterval: 20000, pingTimeout: 25000 });

async function namesIn(cls, g) {
  const sockets = await io.in(gRoom(cls, g)).fetchSockets();
  return [...new Set(sockets.map(s => s.data.name).filter(Boolean))];
}
async function presence(cls, g) {
  const names = await namesIn(cls, g);
  io.to([gRoom(cls, g), tRoom(cls)]).emit('presence', { cls, group: g, names });
}
async function leaveStudent(socket) {
  const { cls, group } = socket.data;
  if (!cls) return;
  socket.leave(cRoom(cls));
  socket.leave(gRoom(cls, group));
  socket.data.cls = null; socket.data.group = null;
  await presence(cls, group);
}

// 학생은 자기 조, 교사는 지정한 반·조를 대상으로 함
function target(socket, p) {
  if (socket.data.teacher && p && validCls(p.cls) && validGroup(p.group)) return { cls: +p.cls, group: +p.group };
  if (socket.data.cls) return { cls: socket.data.cls, group: socket.data.group };
  return null;
}
function emitBoard(t, ev, payload) {
  io.to([gRoom(t.cls, t.group), tRoom(t.cls)]).emit(ev, { cls: t.cls, group: t.group, ...payload });
}
const fn = f => (typeof f === 'function' ? f : () => {});

io.on('connection', socket => {
  socket.data.tries = 0;

  socket.on('class:info', (cls, ack) => {
    ack = fn(ack);
    if (!validCls(cls)) return ack(null);
    ack(classInfo(+cls));
  });

  // ----- 학생 -----
  socket.on('student:join', async (p, ack) => {
    ack = fn(ack); p = p || {};
    const name = clean(p.name, 12);
    if (!name) return ack({ ok: false, msg: '이름을 입력해 주세요.' });
    if (!validCls(p.cls) || !validGroup(p.group)) return ack({ ok: false, msg: '반과 조를 확인해 주세요.' });
    await leaveStudent(socket);
    const cls = +p.cls, group = +p.group;
    Object.assign(socket.data, { cls, group, name, clientId: clean(p.clientId, 64) || socket.id });
    socket.join([cRoom(cls), gRoom(cls, group)]);
    ack({ ok: true, info: classInfo(cls), notes: peekGroup(cls, group).notes });
    presence(cls, group);
  });

  socket.on('student:leave', () => leaveStudent(socket));

  // ----- 포스트잇 -----
  const blocked = t => getClass(t.cls).locked && !socket.data.teacher;

  socket.on('note:add', (p, ack) => {
    ack = fn(ack); p = p || {};
    const t = target(socket, p);
    if (!t) return ack({ ok: false, msg: '다시 입장해 주세요.' });
    if (blocked(t)) return ack({ ok: false, msg: '선생님이 지금은 편집을 잠가 두었어요.' });
    if (!AREAS.includes(p.area)) return ack({ ok: false, msg: '칸을 다시 골라 주세요.' });
    const text = clean(p.text, 200);
    if (!text) return ack({ ok: false, msg: '내용을 적어 주세요.' });
    const g = getGroup(t.cls, t.group);
    if (g.notes.length >= MAX_NOTES) return ack({ ok: false, msg: '포스트잇이 너무 많아요.' });
    const note = {
      id: crypto.randomUUID(),
      area: p.area,
      text,
      color: COLORS.includes(p.color) ? p.color : 'yellow',
      author: socket.data.teacher ? '선생님' : socket.data.name,
      owner: socket.data.teacher ? 'teacher' : socket.data.clientId,
      createdAt: Date.now()
    };
    g.notes.push(note); g.updatedAt = Date.now(); save();
    emitBoard(t, 'note:added', { note });
    ack({ ok: true });
  });

  socket.on('note:update', (p, ack) => {
    ack = fn(ack); p = p || {};
    const t = target(socket, p);
    if (!t) return ack({ ok: false });
    if (blocked(t)) return ack({ ok: false, msg: '선생님이 지금은 편집을 잠가 두었어요.' });
    const g = getGroup(t.cls, t.group);
    const note = g.notes.find(n => n.id === p.id);
    if (!note) return ack({ ok: false, msg: '포스트잇을 찾을 수 없어요.' });
    const isOwner = socket.data.teacher || note.owner === socket.data.clientId;
    // 칸 옮기기는 조원 누구나, 내용·색 고치기는 쓴 사람(또는 교사)만
    if (p.area !== undefined && AREAS.includes(p.area)) note.area = p.area;
    if (isOwner) {
      if (p.text !== undefined) { const tx = clean(p.text, 200); if (tx) note.text = tx; }
      if (p.color !== undefined && COLORS.includes(p.color)) note.color = p.color;
    }
    g.updatedAt = Date.now(); save();
    emitBoard(t, 'note:updated', { note });
    ack({ ok: true });
  });

  socket.on('note:delete', (p, ack) => {
    ack = fn(ack); p = p || {};
    const t = target(socket, p);
    if (!t) return ack({ ok: false });
    if (blocked(t)) return ack({ ok: false, msg: '선생님이 지금은 편집을 잠가 두었어요.' });
    const g = getGroup(t.cls, t.group);
    const i = g.notes.findIndex(n => n.id === p.id);
    if (i < 0) return ack({ ok: false });
    if (!socket.data.teacher && g.notes[i].owner !== socket.data.clientId) return ack({ ok: false, msg: '내가 쓴 포스트잇만 지울 수 있어요.' });
    g.notes.splice(i, 1); g.updatedAt = Date.now(); save();
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
    ack({ ok: true, classCount: CLASS_COUNT, maxGroups: MAX_GROUPS });
  });

  socket.on('teacher:logout', () => {
    socket.data.teacher = false;
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
    ack({ ok: true, info: classInfo(cls), groups });
  });

  socket.on('teacher:settings', (p, ack) => {
    ack = fn(ack); p = p || {};
    if (!socket.data.teacher || !validCls(p.cls)) return ack({ ok: false });
    const cls = +p.cls, c = getClass(cls);
    if (p.topic !== undefined) { const tp = clean(p.topic, 20); if (tp) c.topic = tp; }
    if (p.groupCount !== undefined && validGroup(p.groupCount)) c.groupCount = +p.groupCount;
    if (p.locked !== undefined) c.locked = !!p.locked;
    save();
    io.to([cRoom(cls), tRoom(cls)]).emit('class:settings', { cls, info: classInfo(cls) });
    ack({ ok: true });
  });

  socket.on('teacher:reset', (p, ack) => {
    ack = fn(ack); p = p || {};
    if (!socket.data.teacher || !validCls(p.cls)) return ack({ ok: false });
    const cls = +p.cls, c = getClass(cls);
    const group = validGroup(p.group) ? +p.group : null;
    if (group) delete c.groups[String(group)]; else c.groups = {};
    save();
    io.to([cRoom(cls), tRoom(cls)]).emit('board:reset', { cls, group });
    ack({ ok: true });
  });

  socket.on('disconnect', () => {
    const { cls, group } = socket.data;
    if (cls) presence(cls, group);
  });
});

server.listen(PORT, () => console.log(`공감지도 서버 실행 중: http://localhost:${PORT}`));
