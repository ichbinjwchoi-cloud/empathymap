(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const socket = io();

  // ---------- 상수 ----------
  // {t} 자리에 "난민들" 처럼 주제+들 이 들어갑니다.
  const AREAS = [
    { key: 'think', title: 'Think & Feel', ko: '생각과 감정', short: '생각·감정', q: ['{t}이 느끼는 감정은 무엇일까요?', '무슨 생각을 할까요?'] },
    { key: 'hear',  title: 'Hear',         ko: '듣는 것',     short: '듣는 것',   q: ['{t}은 어떤 말을 듣나요?', '누가 {t}에게 영향을 주나요?'] },
    { key: 'say',   title: 'Say & Do',     ko: '말과 행동',   short: '말·행동',   q: ['{t}은 무엇을 말하나요?', '어떤 행동을 하나요?'] },
    { key: 'pain',  title: 'Pain',         ko: '어려움',      short: '어려움',    q: ['{t}이 처한 가장 큰 문제와 도전과제는?'] },
    { key: 'gain',  title: 'Gain (Want)',  ko: '바라는 것',   short: '바라는 것', q: ['{t}이 원하는 것은?'] }
  ];
  const COLORS = ['yellow', 'pink', 'green', 'blue', 'orange', 'purple'];
  const COLOR_KO = { yellow: '노랑', pink: '분홍', green: '초록', blue: '하늘', orange: '주황', purple: '보라' };

  // ---------- 저장소 ----------
  const mk = area => ({
    get(k) { try { return JSON.parse(area().getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { area().setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { area().removeItem(k); } catch (e) {} }
  });
  const store = mk(() => localStorage);
  const sess = mk(() => sessionStorage);

  let clientId = store.get('em_cid');
  if (!clientId) {
    clientId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    store.set('em_cid', clientId);
  }

  // ---------- 상태 ----------
  const S = { mode: null, me: null, info: null, notes: [], names: [] };
  const T = { code: null, cls: 1, info: null, groups: {}, open: null, maxGroups: 10 };

  // ---------- 도우미 ----------
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function topicPlural(t) { t = (t || '').trim() || '대상'; return t.endsWith('들') ? t : t + '들'; }
  function questions(area, topic) { const p = topicPlural(topic); return area.q.map(s => s.split('{t}').join(p)); }
  function areaByKey(k) { return AREAS.find(a => a.key === k); }
  function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
  function rel(ts) {
    if (!ts) return '활동 없음';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '방금';
    const m = Math.floor(s / 60);
    if (m < 60) return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '시간 전';
    return Math.floor(h / 24) + '일 전';
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function show(name) {
    ['login', 'student', 'teacher'].forEach(v => { $('#view-' + v).hidden = v !== name; });
    window.scrollTo(0, 0);
  }
  function fillSelect(sel, n, suffix, val) {
    sel.innerHTML = '';
    for (let i = 1; i <= n; i++) { const o = el('option', null, i + suffix); o.value = i; sel.appendChild(o); }
    if (val && +val <= n) sel.value = val;
  }
  function nameChips(box, names, emptyText) {
    box.innerHTML = '';
    if (!names.length) { box.appendChild(el('span', 'muted', emptyText || '')); return; }
    const dot = el('span', 'live-dot'); dot.title = '접속 중';
    box.appendChild(dot);
    names.forEach(n => box.appendChild(el('span', 'chip', n)));
  }

  // ---------- 입장 화면 ----------
  fillSelect($('#inCls'), 8, '반');
  fillSelect($('#inGroup'), 6, '조');
  const last = store.get('em_last') || {};
  $('#inName').value = last.name || '';
  if (last.cls) $('#inCls').value = last.cls;
  if (last.group) $('#inGroup').value = last.group;

  function loadClassInfo() {
    socket.emit('class:info', +$('#inCls').value, info => {
      if (!info) return;
      const cur = $('#inGroup').value || last.group;
      fillSelect($('#inGroup'), info.groupCount, '조', cur);
      $('#loginTopic').textContent = info.topic;
    });
  }
  $('#inCls').addEventListener('change', loadClassInfo);

  function join(me, quiet) {
    socket.emit('student:join', Object.assign({}, me, { clientId }), res => {
      if (!res || !res.ok) {
        if (!quiet) toast((res && res.msg) || '입장하지 못했어요.');
        sess.del('em_session');
        return;
      }
      S.mode = 'student'; S.me = me; S.info = res.info; S.notes = res.notes || [];
      store.set('em_last', me);
      sess.set('em_session', { mode: 'student', me });
      show('student');
      renderStudent();
    });
  }
  $('#btnJoin').addEventListener('click', () => {
    const name = $('#inName').value.trim();
    if (!name) { toast('이름을 입력해 주세요.'); $('#inName').focus(); return; }
    join({ name, cls: +$('#inCls').value, group: +$('#inGroup').value });
  });
  $('#inName').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) $('#btnJoin').click(); });

  $('#btnTeacherToggle').addEventListener('click', () => {
    const f = $('#teacherForm'); f.hidden = !f.hidden;
    if (!f.hidden) $('#inCode').focus();
  });
  $('#btnTeacher').addEventListener('click', () => teacherLogin($('#inCode').value.trim()));
  $('#inCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btnTeacher').click(); });

  $('#btnLeave').addEventListener('click', () => {
    if (!confirm('공감지도에서 나갈까요? 붙인 포스트잇은 그대로 남아요.')) return;
    socket.emit('student:leave');
    S.mode = null; S.me = null;
    sess.del('em_session');
    show('login'); loadClassInfo();
  });

  // ---------- 공감지도 보드 (학생·교사 공용) ----------
  function renderBoard(root, ctx) {
    const scrollY = window.scrollY;
    root.innerHTML = '';
    const board = el('div', 'board');
    const readOnly = ctx.locked && !ctx.teacher;

    AREAS.forEach(a => {
      const notes = ctx.notes.filter(n => n.area === a.key).sort((x, y) => x.createdAt - y.createdAt);
      const cell = el('section', 'area area-' + a.key);
      cell.dataset.area = a.key;

      const head = el('div', 'area-head');
      const ttl = el('div', 'area-title');
      ttl.appendChild(el('h3', null, a.title));
      ttl.appendChild(el('span', 'area-ko', a.ko));
      ttl.appendChild(el('span', 'cnt', String(notes.length)));
      head.appendChild(ttl);
      const add = el('button', 'add', '+ 붙이기');
      add.disabled = readOnly;
      add.addEventListener('click', () => openModal({ mode: 'add', area: a, ctx }));
      head.appendChild(add);
      cell.appendChild(head);

      const qs = el('ul', 'qs');
      questions(a, ctx.topic).forEach(t => qs.appendChild(el('li', null, t)));
      cell.appendChild(qs);

      const wall = el('div', 'wall');
      if (!notes.length) wall.appendChild(el('div', 'empty', readOnly ? '아직 포스트잇이 없어요' : '첫 번째 포스트잇을 붙여 보세요'));
      notes.forEach(n => wall.appendChild(noteEl(n, ctx, readOnly)));
      cell.appendChild(wall);

      if (!readOnly) {
        cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('over'); });
        cell.addEventListener('dragleave', e => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('over'); });
        cell.addEventListener('drop', e => {
          e.preventDefault(); cell.classList.remove('over');
          const id = e.dataTransfer.getData('text/plain');
          const n = ctx.notes.find(x => x.id === id);
          if (n && n.area !== a.key) ctx.emit('note:update', { id, area: a.key });
        });
      }
      board.appendChild(cell);
    });

    const center = el('div', 'center');
    const persona = el('div', 'persona');
    persona.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="44" r="22"/><path d="M20 112c4-26 20-40 40-40s36 14 40 40z"/></svg>';
    center.appendChild(persona);
    center.appendChild(el('div', 'persona-label', '공감 대상'));
    center.appendChild(el('div', 'persona-topic', ctx.topic || ''));
    center.appendChild(el('div', 'persona-total', '포스트잇 ' + ctx.notes.length + '장'));
    board.appendChild(center);

    root.appendChild(board);
    window.scrollTo(0, scrollY);
  }

  function noteEl(n, ctx, readOnly) {
    const d = el('div', 'note c-' + (COLORS.includes(n.color) ? n.color : 'yellow'));
    const mine = !ctx.teacher && n.owner === clientId;
    if (mine) d.classList.add('mine');
    if (n.owner === 'teacher') d.classList.add('by-teacher');
    d.style.setProperty('--r', ((hash(n.id) % 5) - 2) * 0.9 + 'deg');
    if (Date.now() - n.createdAt < 1500) d.classList.add('pop');
    d.appendChild(el('div', 'ntext', n.text));
    d.appendChild(el('div', 'nauthor', n.author + (mine ? ' (나)' : '')));

    if (!readOnly) {
      d.draggable = true;
      d.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', n.id); d.classList.add('dragging'); });
      d.addEventListener('dragend', () => d.classList.remove('dragging'));

      const tools = el('div', 'ntools');
      const canEdit = ctx.teacher || mine;
      const ed = el('button', 'nbtn', canEdit ? '✎' : '⇄');
      ed.title = canEdit ? '고치기' : '다른 칸으로 옮기기';
      ed.addEventListener('click', ev => { ev.stopPropagation(); openModal({ mode: 'edit', note: n, ctx, canEdit }); });
      tools.appendChild(ed);
      if (canEdit) {
        const del = el('button', 'nbtn', '✕');
        del.title = '지우기';
        del.addEventListener('click', ev => {
          ev.stopPropagation();
          if (!confirm('이 포스트잇을 지울까요?')) return;
          ctx.emit('note:delete', { id: n.id });
        });
        tools.appendChild(del);
      }
      d.appendChild(tools);
    }
    return d;
  }

  // ---------- 작성 창 ----------
  let M = null;
  const areaSel = $('#mArea');
  AREAS.forEach(a => { const o = el('option', null, a.title + ' · ' + a.ko); o.value = a.key; areaSel.appendChild(o); });

  function renderColors() {
    const box = $('#mColors'); box.innerHTML = '';
    COLORS.forEach(c => {
      const b = el('button', 'cdot c-' + c);
      b.type = 'button'; b.title = COLOR_KO[c];
      b.setAttribute('aria-label', COLOR_KO[c]);
      if (M.color === c) b.classList.add('on');
      b.disabled = M.mode === 'edit' && !M.canEdit;
      b.addEventListener('click', () => { M.color = c; renderColors(); });
      box.appendChild(b);
    });
    $('#mPreview').className = 'mpreview c-' + M.color;
  }
  function updateCount() { $('#mCount').textContent = $('#mText').value.length + '/200'; }

  function openModal(o) {
    M = Object.assign({}, o);
    const area = o.mode === 'add' ? o.area : areaByKey(o.note.area);
    if (o.mode === 'add') M.canEdit = true;
    $('#mTitle').textContent = (o.mode === 'add' ? '포스트잇 붙이기 · ' : (M.canEdit ? '포스트잇 고치기 · ' : '포스트잇 옮기기 · ')) + area.title;
    $('#mQ').textContent = questions(area, o.ctx.topic).join('  ');
    const tx = $('#mText');
    tx.value = o.mode === 'edit' ? o.note.text : '';
    tx.readOnly = !M.canEdit;
    M.color = o.mode === 'edit' ? o.note.color : (store.get('em_color') || 'yellow');
    renderColors(); updateCount();
    $('#mAreaWrap').hidden = o.mode !== 'edit';
    if (o.mode === 'edit') areaSel.value = o.note.area;
    $('#mOk').textContent = o.mode === 'add' ? '붙이기' : '저장';
    $('#modal').hidden = false;
    const focusEl = M.canEdit ? tx : areaSel;
    setTimeout(() => { if (M) focusEl.focus(); }, 30);
  }
  function closeModal() { $('#modal').hidden = true; M = null; }

  function submitModal() {
    if (!M) return;
    const text = $('#mText').value.trim();
    if (M.canEdit && !text) { toast('내용을 적어 주세요.'); return; }
    const done = res => { if (res && !res.ok && res.msg) toast(res.msg); };
    if (M.mode === 'add') {
      store.set('em_color', M.color);
      M.ctx.emit('note:add', { area: M.area.key, text, color: M.color }, done);
    } else {
      const p = { id: M.note.id, area: areaSel.value };
      if (M.canEdit) { p.text = text; p.color = M.color; }
      M.ctx.emit('note:update', p, done);
    }
    closeModal();
  }
  $('#mText').addEventListener('input', updateCount);
  $('#mText').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitModal(); }
  });
  $('#mOk').addEventListener('click', submitModal);
  $('#mCancel').addEventListener('click', closeModal);
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  // ---------- 학생 화면 ----------
  function studentCtx() {
    return {
      topic: S.info.topic, notes: S.notes, locked: S.info.locked, teacher: false,
      emit: (ev, p, cb) => socket.emit(ev, p, cb)
    };
  }
  function renderStudent() {
    if (S.mode !== 'student') return;
    const w = $('#stWhere'); w.innerHTML = '';
    w.appendChild(el('b', null, S.me.cls + '반 ' + S.me.group + '조'));
    w.appendChild(el('span', null, ' · ' + S.me.name));
    w.appendChild(el('span', 'topic-pill', '주제: ' + S.info.topic));
    nameChips($('#stOnline'), S.names);
    $('#lockBanner').hidden = !S.info.locked;
    if ($('#modal').hidden === false && S.info.locked && M && !M.ctx.teacher) closeModal();
    renderBoard($('#stBoard'), studentCtx());
  }

  // ---------- 교사 화면 ----------
  function teacherLogin(code, silent) {
    if (!code) { toast('교사 코드를 입력해 주세요.'); return; }
    socket.emit('teacher:login', code, res => {
      if (!res || !res.ok) { if (!silent) toast((res && res.msg) || '교사 코드가 맞지 않아요.'); return; }
      T.code = code; T.maxGroups = res.maxGroups || 10;
      S.mode = 'teacher';
      $('#inCode').value = '';
      sess.del('em_session');
      fillSelect($('#tGroupCount'), T.maxGroups, '개 조');
      show('teacher');
      watch(T.cls, true);
    });
  }
  function watch(cls, keepOpen) {
    socket.emit('teacher:watch', cls, res => {
      if (!res || !res.ok) return;
      T.cls = cls; T.info = res.info; T.groups = res.groups || {};
      if (!keepOpen) T.open = null;
      $('#tTopic').value = T.info.topic;
      renderTeacher();
    });
  }
  function tg(g) {
    if (!T.groups[g]) T.groups[g] = { notes: [], names: [], updatedAt: 0 };
    return T.groups[g];
  }
  function teacherCtx(g) {
    return {
      topic: T.info.topic, notes: tg(g).notes, locked: T.info.locked, teacher: true,
      emit: (ev, p, cb) => socket.emit(ev, Object.assign({ cls: T.cls, group: g }, p), cb)
    };
  }

  function renderTeacher() {
    if (S.mode !== 'teacher' || !T.info) return;
    // 반 탭
    const tabs = $('#clsTabs'); tabs.innerHTML = '';
    for (let c = 1; c <= 8; c++) {
      const b = el('button', 'cls-tab' + (c === T.cls ? ' on' : ''), c + '반');
      b.addEventListener('click', () => { if (c !== T.cls) watch(c); });
      tabs.appendChild(b);
    }
    // 컨트롤
    if (document.activeElement !== $('#tTopic')) $('#tTopic').value = T.info.topic;
    $('#tGroupCount').value = T.info.groupCount;
    const lk = $('#tLock');
    lk.textContent = T.info.locked ? '🔒 잠금 풀기' : '🔓 편집 잠그기';
    lk.classList.toggle('locked', T.info.locked);

    // 요약
    let online = 0, total = 0, complete = 0;
    for (let g = 1; g <= T.info.groupCount; g++) {
      const grp = tg(g);
      online += grp.names.length; total += grp.notes.length;
      if (AREAS.every(a => grp.notes.some(n => n.area === a.key))) complete++;
    }
    const sm = $('#tSummary'); sm.innerHTML = '';
    [['접속 학생', online + '명'], ['포스트잇', total + '장'], ['5칸 모두 채운 조', complete + ' / ' + T.info.groupCount], ['상태', T.info.locked ? '🔒 편집 잠금' : '✏️ 작성 중']]
      .forEach(([k, v]) => { const d = el('div', 'stat'); d.appendChild(el('span', 'stat-k', k)); d.appendChild(el('span', 'stat-v', v)); sm.appendChild(d); });

    if (T.open && T.open > T.info.groupCount) T.open = null;
    $('#tDash').hidden = !!T.open;
    $('#tSummary').hidden = !!T.open;
    $('#tDetail').hidden = !T.open;
    if (T.open) renderDetail(); else renderDash();
  }

  function renderDash() {
    const dash = $('#tDash'); dash.innerHTML = '';
    for (let g = 1; g <= T.info.groupCount; g++) {
      const grp = tg(g);
      const counts = {}; AREAS.forEach(a => { counts[a.key] = grp.notes.filter(n => n.area === a.key).length; });
      const filled = AREAS.filter(a => counts[a.key] > 0).length;
      const maxC = Math.max(1, ...Object.values(counts));

      const card = el('button', 'gcard');
      card.type = 'button';
      const head = el('div', 'gc-head');
      head.appendChild(el('h3', null, g + '조'));
      const prog = el('div', 'gc-prog');
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = (filled / 5 * 100) + '%'; bar.appendChild(fill);
      prog.appendChild(bar);
      prog.appendChild(el('span', 'prog-t', filled + '/5칸'));
      head.appendChild(prog);
      card.appendChild(head);

      const on = el('div', 'online gc-online'); nameChips(on, grp.names, '접속자 없음'); card.appendChild(on);

      const mini = el('div', 'mini');
      AREAS.forEach(a => {
        const c = el('div', 'mcell m-' + a.key + (counts[a.key] ? ' on' : ''));
        c.style.setProperty('--heat', (0.12 + 0.3 * counts[a.key] / maxC).toFixed(2));
        c.appendChild(el('span', null, a.short));
        c.appendChild(el('b', null, String(counts[a.key])));
        mini.appendChild(c);
      });
      card.appendChild(mini);

      const latest = grp.notes.slice().sort((x, y) => y.createdAt - x.createdAt)[0];
      const lt = el('div', 'gc-latest');
      if (latest) {
        lt.appendChild(el('span', 'q', '“' + latest.text + '”'));
        lt.appendChild(el('span', 'by', ' — ' + latest.author));
      } else lt.appendChild(el('span', 'muted', '아직 포스트잇이 없어요'));
      card.appendChild(lt);

      const foot = el('div', 'gc-foot');
      foot.appendChild(el('span', null, '포스트잇 ' + grp.notes.length + '장'));
      foot.appendChild(el('span', null, grp.updatedAt ? '최근 활동 ' + rel(grp.updatedAt) : '활동 없음'));
      card.appendChild(foot);

      card.addEventListener('click', () => { T.open = g; renderTeacher(); });
      dash.appendChild(card);
    }
  }

  function renderDetail() {
    const g = T.open, grp = tg(g);
    $('#tDetailTitle').textContent = T.cls + '반 ' + g + '조';
    nameChips($('#tDetailOnline'), grp.names, '접속자 없음');
    $('#tPrev').disabled = g <= 1;
    $('#tNext').disabled = g >= T.info.groupCount;
    renderBoard($('#tBoard'), teacherCtx(g));
  }

  $('#tBack').addEventListener('click', () => { T.open = null; renderTeacher(); });
  $('#tPrev').addEventListener('click', () => { if (T.open > 1) { T.open--; renderTeacher(); } });
  $('#tNext').addEventListener('click', () => { if (T.open < T.info.groupCount) { T.open++; renderTeacher(); } });

  function tSettings(p) {
    socket.emit('teacher:settings', Object.assign({ cls: T.cls }, p), res => { if (!res || !res.ok) toast('바꾸지 못했어요.'); });
  }
  $('#tTopicApply').addEventListener('click', () => {
    const t = $('#tTopic').value.trim();
    if (!t) { toast('주제를 입력해 주세요.'); return; }
    tSettings({ topic: t }); toast(T.cls + '반 주제를 “' + t + '”(으)로 바꿨어요.');
  });
  $('#tTopic').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) $('#tTopicApply').click(); });
  $('#tGroupCount').addEventListener('change', e => tSettings({ groupCount: +e.target.value }));
  $('#tLock').addEventListener('click', () => tSettings({ locked: !T.info.locked }));

  $('#tResetAll').addEventListener('click', () => {
    if (!confirm(T.cls + '반의 모든 조 공감지도를 지울까요?\n지운 포스트잇은 되돌릴 수 없어요. 필요하면 먼저 CSV로 내려받아 두세요.')) return;
    socket.emit('teacher:reset', { cls: T.cls });
  });
  $('#tResetGroup').addEventListener('click', () => {
    if (!confirm(T.cls + '반 ' + T.open + '조 공감지도를 지울까요? 되돌릴 수 없어요.')) return;
    socket.emit('teacher:reset', { cls: T.cls, group: T.open });
  });

  $('#tExport').addEventListener('click', () => {
    const rows = [['반', '조', '영역', '내용', '작성자', '작성 시각']];
    const order = AREAS.map(a => a.key);
    for (let g = 1; g <= T.info.groupCount; g++) {
      tg(g).notes.slice()
        .filter(n => areaByKey(n.area))
        .sort((x, y) => order.indexOf(x.area) - order.indexOf(y.area) || x.createdAt - y.createdAt)
        .forEach(n => rows.push([T.cls, g, areaByKey(n.area).title, n.text, n.author, new Date(n.createdAt).toLocaleString('ko-KR')]));
    }
    if (rows.length === 1) { toast('내려받을 포스트잇이 없어요.'); return; }
    const csv = rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `공감지도_${T.cls}반_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('#btnTLeave').addEventListener('click', () => {
    socket.emit('teacher:logout');
    S.mode = null; T.code = null; T.open = null;
    show('login'); loadClassInfo();
  });

  setInterval(() => { if (S.mode === 'teacher' && !T.open) renderDash(); }, 30000);

  // ---------- 실시간 이벤트 ----------
  function apply(cls, group, fnc) {
    if (S.mode === 'student' && S.me.cls === cls && S.me.group === group) { fnc(S.notes); renderStudent(); }
    if (S.mode === 'teacher' && T.cls === cls) { const g = tg(group); fnc(g.notes); g.updatedAt = Date.now(); renderTeacher(); }
  }
  socket.on('note:added', ({ cls, group, note }) => apply(cls, group, ns => { if (!ns.some(n => n.id === note.id)) ns.push(note); }));
  socket.on('note:updated', ({ cls, group, note }) => apply(cls, group, ns => { const i = ns.findIndex(n => n.id === note.id); if (i >= 0) ns[i] = note; }));
  socket.on('note:deleted', ({ cls, group, id }) => apply(cls, group, ns => { const i = ns.findIndex(n => n.id === id); if (i >= 0) ns.splice(i, 1); }));

  socket.on('presence', ({ cls, group, names }) => {
    if (S.mode === 'student' && S.me.cls === cls && S.me.group === group) { S.names = names; nameChips($('#stOnline'), names); }
    if (S.mode === 'teacher' && T.cls === cls) {
      tg(group).names = names;
      if (T.open) { if (T.open === group) nameChips($('#tDetailOnline'), names, '접속자 없음'); }
      else renderTeacher();
    }
  });

  socket.on('class:settings', ({ cls, info }) => {
    if (S.mode === 'student' && S.me.cls === cls) {
      const wasLocked = S.info.locked;
      S.info = info; renderStudent();
      if (wasLocked !== info.locked) toast(info.locked ? '🔒 선생님이 편집을 잠갔어요.' : '🔓 다시 쓸 수 있어요!');
    }
    if (S.mode === 'teacher' && T.cls === cls) { T.info = info; renderTeacher(); }
    if (!S.mode && +$('#inCls').value === cls) loadClassInfo();
  });

  socket.on('board:reset', ({ cls, group }) => {
    if (S.mode === 'student' && S.me.cls === cls && (group == null || group === S.me.group)) {
      S.notes = []; renderStudent(); toast('선생님이 공감지도를 새로 시작했어요.');
    }
    if (S.mode === 'teacher' && T.cls === cls) {
      for (let g = 1; g <= T.maxGroups; g++) if (group == null || group === g) { tg(g).notes = []; tg(g).updatedAt = 0; }
      renderTeacher(); toast('지웠어요.');
    }
  });

  // ---------- 연결 ----------
  socket.on('connect', () => {
    $('#conn').hidden = true;
    loadClassInfo();
    if (S.mode === 'student' && S.me) join(S.me, true);
    else if (S.mode === 'teacher' && T.code) teacherLogin(T.code, true);
    else if (!S.mode) {
      const ses = sess.get('em_session');
      if (ses && ses.mode === 'student' && ses.me) join(ses.me, true);
    }
  });
  socket.on('disconnect', () => { $('#conn').hidden = false; });
})();
