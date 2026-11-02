(() => {
  'use strict';
  const $ = s => document.querySelector(s);

  // ---------- 상수 ----------
  // {t} 자리에 "난민들" 처럼 주제+들 이 들어갑니다.
  const AREAS = [
    { key: 'think', title: 'Think & Feel', ko: '생각과 감정', short: '생각·감정', q: ['{t}이 느끼는 감정은 무엇일까요?', '무슨 생각을 할까요?'] },
    { key: 'hear',  title: 'Hear',         ko: '듣는 것',     short: '듣는 것',   q: ['{t}은 어떤 말을 듣나요?', '누가 {t}에게 영향을 주나요?'] },
    { key: 'say',   title: 'Say & Do',     ko: '말과 행동',   short: '말·행동',   q: ['{t}은 무엇을 말하나요?', '어떤 행동을 하나요?'] },
    { key: 'pain',  title: 'Pain',         ko: '어려움',      short: '어려움',    q: ['{t}이 처한 가장 큰 문제와 도전과제는?'] },
    { key: 'gain',  title: 'Gain (Want)',  ko: '바라는 것',   short: '바라는 것', q: ['{t}이 원하는 것은?'] }
  ];
  const MIN_PER_STUDENT = 2;   // 한 사람당 최소 포스트잇 수
  const COLORS = ['yellow', 'pink', 'green', 'blue', 'orange', 'purple'];
  const COLOR_KO = { yellow: '노랑', pink: '분홍', green: '초록', blue: '하늘', orange: '주황', purple: '보라' };
  // 발표 시간 스티커
  const REACTIONS = [
    { key: 'heart', emoji: '❤️', ko: '하트' },
    { key: 'best', emoji: '👍', ko: '최고' },
    { key: 'laugh', emoji: '😂', ko: '웃음' },
    { key: 'cry', emoji: '😢', ko: '눈물' },
    { key: 'angry', emoji: '😡', ko: '화남' }
  ];
  const ZOOMS = [1, 1.2, 1.4, 1.65, 1.9];
  // 손가락으로 쓰는 기기(갤럭시탭 등)인지
  const TOUCH = window.matchMedia('(hover: none), (pointer: coarse)').matches;
  if (TOUCH) document.documentElement.classList.add('touch');

  // ---------- 저장소 ----------
  const mk = area => ({
    get(k) { try { return JSON.parse(area().getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { area().setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { area().removeItem(k); } catch (e) {} }
  });
  const store = mk(() => localStorage);
  const sess = mk(() => sessionStorage);

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'n' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  let clientId = store.get('em_cid');
  if (!clientId) { clientId = uuid(); store.set('em_cid', clientId); }

  // ---------- 상태 ----------
  const S = { mode: null, me: null, info: null, notes: [], names: [], presentNotes: [] };
  const T = { code: null, cls: Number(sess.get('em_tcls')) || 1, info: null, groups: {}, open: null, maxGroups: 10, status: null };

  // ---------- 연결 ----------
  // 다시 연결될 때 서버가 자동으로 원래 반·조에 넣어 주도록 정보를 함께 보냄
  const socket = io({
    auth: cb => {
      if (S.mode === 'student' && S.me) cb({ student: Object.assign({ clientId }, S.me) });
      else if (S.mode === 'teacher' && T.code) cb({ teacher: T.code, watch: T.cls });
      else cb({});
    }
  });
  function send(ev, data, cb, ms) {
    if (cb) socket.timeout(ms || 8000).emit(ev, data, cb);
    else socket.emit(ev, data);
  }

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
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '방금';
    const m = Math.floor(s / 60);
    if (m < 60) return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '시간 전';
    return Math.floor(h / 24) + '일 전';
  }
  let toastTimer;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }
  function show(name) {
    ['login', 'student', 'teacher'].forEach(v => { $('#view-' + v).hidden = v !== name; });
    document.body.dataset.view = name;
    applyZoom();
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
  // 학생별 포스트잇 수 (선생님 제외)
  function authorCounts(notes) {
    const m = {};
    notes.forEach(n => { if (n.owner !== 'teacher') m[n.author] = (m[n.author] || 0) + 1; });
    return m;
  }
  function imgUrl(id) { return '/img/' + encodeURIComponent(id); }

  // 수업 중 무료 서버가 잠들지 않도록 가끔 신호를 보냄
  setInterval(() => { if (S.mode) fetch('/healthz', { cache: 'no-store' }).catch(() => {}); }, 4 * 60 * 1000);

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
    send('student:join', Object.assign({}, me, { clientId }), (err, res) => {
      if (err) { if (!quiet) toast('서버와 연결이 느려요. 잠시 후 다시 눌러 주세요.'); return; }
      if (!res || !res.ok) {
        if (!quiet) toast((res && res.msg) || '입장하지 못했어요.');
        sess.del('em_session');
        return;
      }
      S.mode = 'student'; S.me = me; S.info = res.info; S.notes = res.notes || []; S.presentNotes = res.presentNotes || [];
      setTimer(res.info.timer, true);
      store.set('em_last', me);
      sess.set('em_session', { mode: 'student', me });
      if ($('#view-student').hidden) show('student');
      renderStudent();
    }, 10000);
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
    board.classList.toggle('reacting', !!ctx.react);

    AREAS.forEach(a => {
      const notes = ctx.notes.filter(n => n.area === a.key).sort((x, y) => x.createdAt - y.createdAt);
      const cell = el('section', 'area area-' + a.key + (notes.length ? '' : ' needs'));
      cell.dataset.area = a.key;

      const head = el('div', 'area-head');
      const ttl = el('div', 'area-title');
      ttl.appendChild(el('h3', null, a.title));
      ttl.appendChild(el('span', 'area-ko', a.ko));
      ttl.appendChild(el('span', 'cnt' + (notes.length ? ' done' : ''), notes.length ? '✓ ' + notes.length : '0'));
      head.appendChild(ttl);
      const add = el('button', 'add', '+ 붙이기');
      add.disabled = readOnly;
      add.hidden = !!ctx.react;
      add.addEventListener('click', () => openModal({ mode: 'add', area: a, ctx }));
      head.appendChild(add);
      cell.appendChild(head);

      const qs = el('ul', 'qs');
      questions(a, ctx.topic).forEach(t => qs.appendChild(el('li', null, t)));
      cell.appendChild(qs);

      const wall = el('div', 'wall');
      if (!notes.length) {
        const empty = el('button', 'empty', readOnly ? '아직 포스트잇이 없어요' : '아직 비어 있어요 · 눌러서 첫 포스트잇 붙이기');
        empty.type = 'button';
        empty.disabled = readOnly;
        empty.addEventListener('click', () => openModal({ mode: 'add', area: a, ctx }));
        wall.appendChild(empty);
      }
      notes.forEach(n => wall.appendChild(noteEl(n, ctx, readOnly)));
      cell.appendChild(wall);

      // 끌어서 옮기기는 교사 노트북(마우스)에서만 — 태블릿에서 길게 누르다 실수로 옮겨지는 것을 막음
      if (!readOnly && ctx.teacher && !TOUCH) {
        cell.addEventListener('dragover', e => { e.preventDefault(); cell.classList.add('over'); });
        cell.addEventListener('dragleave', e => { if (!cell.contains(e.relatedTarget)) cell.classList.remove('over'); });
        cell.addEventListener('drop', e => {
          e.preventDefault(); cell.classList.remove('over');
          const id = e.dataTransfer.getData('text/plain');
          const n = ctx.notes.find(x => x.id === id);
          if (n && n.area !== a.key) ctx.emit('note:update', { id, area: a.key, fromArea: n.area }, (err, res) => {
            if (err) toast('연결이 불안정해요. 다시 옮겨 주세요.');
            else if (res && res.msg) toast(res.msg);
          });
        });
      }
      board.appendChild(cell);
    });

    const center = el('div', 'center');
    const persona = el(ctx.image ? 'button' : 'div', 'persona' + (ctx.image ? ' has-img' : ''));
    if (ctx.image) {
      persona.type = 'button';
      persona.title = '사진 크게 보기';
      const img = el('img'); img.src = imgUrl(ctx.image); img.alt = ctx.topic + ' 사진';
      persona.appendChild(img);
      persona.addEventListener('click', () => openImage(ctx.image, ctx.topic));
    } else {
      persona.innerHTML = '<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="44" r="22"/><path d="M20 112c4-26 20-40 40-40s36 14 40 40z"/></svg>';
    }
    center.appendChild(persona);
    center.appendChild(el('div', 'persona-label', ctx.react ? '📺 ' + ctx.react.group + '조 공감지도' : '공감 대상'));
    center.appendChild(el('div', 'persona-topic', ctx.topic || ''));
    center.appendChild(el('div', 'persona-total', '포스트잇 ' + ctx.notes.length + '장' + (ctx.image ? ' · 사진을 누르면 크게 보여요' : '')));
    board.appendChild(center);

    root.appendChild(board);
    window.scrollTo(0, scrollY);
  }

  function noteEl(n, ctx, readOnly) {
    const d = el('div', 'note c-' + (COLORS.includes(n.color) ? n.color : 'yellow') + (ctx.react ? ' reactable' : ''));
    d.dataset.id = n.id;
    d.tabIndex = 0;
    d.setAttribute('role', 'button');
    const mine = !ctx.teacher && isMine(n);
    if (mine) d.classList.add('mine');
    if (n.owner === 'teacher') d.classList.add('by-teacher');
    d.style.setProperty('--r', ((hash(n.id) % 5) - 2) * 0.9 + 'deg');
    if (Date.now() - n.createdAt < 1500) d.classList.add('pop');
    d.appendChild(el('span', 'ntext', n.text));
    d.appendChild(el('span', 'nauthor', n.author + (mine ? ' (나)' : '')));
    const canEdit = !readOnly && (ctx.teacher || mine);
    d.title = readOnly ? '눌러서 크게 보기' : canEdit ? '눌러서 고치기·옮기기·지우기' : '눌러서 크게 보기 · 다른 칸으로 옮기기';
    const open = () => openModal({ mode: 'edit', note: n, ctx, canEdit, readOnly });
    d.addEventListener('click', open);
    d.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === d) open(); });
    d.appendChild(reactionsEl(n, ctx));
    if (!readOnly && ctx.teacher && !TOUCH) {
      d.draggable = true;
      d.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', n.id); d.classList.add('dragging'); });
      d.addEventListener('dragend', () => d.classList.remove('dragging'));
    }
    return d;
  }
  function isMine(n) {
    return S.me && (n.owner === clientId + '|' + S.me.name || n.owner === clientId);
  }
  function myKey() { return S.mode === 'teacher' ? 'teacher' : (S.me ? clientId + '|' + S.me.name : ''); }
  // 스티커: 발표 시간에는 누를 수 있는 버튼, 평소에는 붙은 스티커만 작게
  function reactionsEl(n, ctx) {
    const r = n.reactions || {};
    if (ctx.react) {
      const bar = el('div', 'rxbar');
      REACTIONS.forEach(x => {
        const list = r[x.key] || [];
        const b = el('button', 'rx' + (list.includes(myKey()) ? ' on' : ''));
        b.type = 'button';
        b.title = x.ko + (list.includes(myKey()) ? ' (다시 누르면 떼기)' : ' 스티커 붙이기');
        b.setAttribute('aria-label', x.ko + ' ' + list.length);
        b.appendChild(el('span', 'rx-e', x.emoji));
        b.appendChild(el('b', null, list.length ? String(list.length) : ''));
        b.addEventListener('click', ev => {
          ev.stopPropagation();
          b.classList.toggle('on'); b.classList.add('pulse');
          send('note:react', { cls: ctx.react.cls, group: ctx.react.group, id: n.id, type: x.key }, (err, res) => {
            if (err) toast('연결이 불안정해요. 다시 눌러 주세요.');
            else if (res && !res.ok && res.msg) toast(res.msg);
          });
        });
        bar.appendChild(b);
      });
      return bar;
    }
    const sum = el('div', 'rxsum');
    REACTIONS.forEach(x => { const c = (r[x.key] || []).length; if (c) sum.appendChild(el('span', null, x.emoji + c)); });
    return sum;
  }
  function reactionText(n) {
    const r = n.reactions || {};
    return REACTIONS.map(x => (r[x.key] || []).length ? x.emoji + (r[x.key] || []).length : '').filter(Boolean).join(' ');
  }

  // ---------- 사진 크게 보기 ----------
  function openImage(id, topic) {
    $('#imgViewImg').src = imgUrl(id);
    $('#imgViewImg').alt = topic + ' 사진';
    $('#imgViewCap').textContent = '공감 대상: ' + topic + ' · 아무 곳이나 누르면 닫혀요';
    $('#imgView').hidden = false;
  }
  $('#imgView').addEventListener('click', () => { $('#imgView').hidden = true; });

  // ---------- 포스트잇 창 ----------
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
      b.addEventListener('click', () => { M.color = c; renderColors(); });
      box.appendChild(b);
    });
    $('#mPreview').className = 'mpreview c-' + M.color;
  }
  function updateCount() { $('#mCount').textContent = $('#mText').value.length + '/200'; }

  function openModal(o) {
    M = Object.assign({ token: uuid() }, o);
    const add = o.mode === 'add';
    const area = add ? o.area : areaByKey(o.note.area);
    if (add) { M.canEdit = true; M.newId = uuid(); }
    const canMove = !add && !o.readOnly;
    M.canMove = canMove;
    $('#mTitle').textContent = add ? '포스트잇 붙이기 · ' + area.title
      : M.canEdit ? '내 포스트잇 · ' + area.title
      : canMove ? '포스트잇 옮기기 · ' + area.title : '포스트잇 · ' + area.title;
    $('#mQ').textContent = questions(area, o.ctx.topic).join('  ');
    const tx = $('#mText');
    tx.value = add ? '' : o.note.text;
    tx.readOnly = !M.canEdit;
    $('#mAuthor').textContent = '— ' + (add ? (o.ctx.teacher ? '선생님' : (S.me ? S.me.name : '')) : o.note.author);
    M.color = add ? (store.get('em_color') || 'yellow') : o.note.color;
    renderColors(); updateCount();
    $('#mColors').hidden = !M.canEdit;
    $('#mCount').hidden = !M.canEdit;
    $('#mAreaWrap').hidden = !canMove;
    if (!add) { areaSel.value = o.note.area; M.origArea = o.note.area; }
    $('#mDelete').hidden = !(!add && M.canEdit);
    $('#mOk').hidden = !(M.canEdit || canMove);
    $('#mOk').textContent = add ? '붙이기' : M.canEdit ? '저장' : '옮기기';
    $('#mCancel').textContent = (M.canEdit || canMove) ? '취소' : '닫기';
    setBusy(false);
    updateMoveBtn();
    $('#modal').hidden = false;
    document.body.classList.add('modal-open');
    // 태블릿에서 키보드가 바로 올라오도록 새 포스트잇은 곧바로 입력칸에 커서
    if (M.canEdit) { tx.focus({ preventScroll: true }); if (!add) tx.setSelectionRange(tx.value.length, tx.value.length); }
  }
  // 친구 포스트잇: 칸을 실제로 바꿨을 때만 [옮기기]를 누를 수 있음
  function updateMoveBtn() {
    if (!M || M.mode === 'add' || M.canEdit || !M.canMove) return;
    $('#mOk').disabled = areaSel.value === M.origArea;
  }
  areaSel.addEventListener('change', updateMoveBtn);
  function closeModal() {
    $('#modal').hidden = true; M = null;
    document.body.classList.remove('modal-open');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  function setBusy(b) {
    if (M) M.busy = b;
    $('#mOk').disabled = b; $('#mDelete').disabled = b;
    $('#mOk').classList.toggle('busy', b);
  }

  function submitModal() {
    if (!M || M.busy || $('#mOk').hidden) return;
    const text = $('#mText').value.trim();
    if (M.canEdit && !text) { toast('내용을 적어 주세요.'); $('#mText').focus(); return; }
    const token = M.token;
    let ev, p;
    if (M.mode === 'add') {
      store.set('em_color', M.color);
      ev = 'note:add'; p = { id: M.newId, area: M.area.key, text, color: M.color };
    } else {
      ev = 'note:update'; p = { id: M.note.id };
      // 칸을 바꿨을 때만 옮기기 정보를 보냄 (창을 연 사이 친구가 옮긴 포스트잇을 되돌리지 않도록)
      if (areaSel.value !== M.origArea) { p.area = areaSel.value; p.fromArea = M.origArea; }
      if (M.canEdit) { p.text = text; p.color = M.color; }
      if (!M.canEdit && !p.area) { closeModal(); return; }
    }
    setBusy(true);
    M.ctx.emit(ev, p, (err, res) => {
      if (!M || M.token !== token) return;
      setBusy(false);
      if (err) { toast('인터넷 연결이 불안정해요. 잠시 후 다시 눌러 주세요. (쓴 내용은 그대로 있어요)', 3500); return; }
      if (!res || !res.ok) { toast((res && res.msg) || '저장하지 못했어요. 다시 눌러 주세요.'); return; }
      if (res.msg) toast(res.msg, 3500);
      else if (M.mode === 'add') toast('포스트잇을 붙였어요!', 1500);
      closeModal();
    });
  }
  // Enter는 줄바꿈 — 붙이기는 버튼으로만
  $('#mText').addEventListener('input', updateCount);
  $('#mOk').addEventListener('click', submitModal);
  $('#mCancel').addEventListener('click', () => {
    if (M && M.mode === 'add' && $('#mText').value.trim() && !confirm('쓰던 내용이 사라져요. 닫을까요?')) return;
    closeModal();
  });
  $('#mDelete').addEventListener('click', () => {
    if (!M || M.busy || !confirm('이 포스트잇을 지울까요?')) return;
    const token = M.token;
    setBusy(true);
    M.ctx.emit('note:delete', { id: M.note.id }, (err, res) => {
      if (!M || M.token !== token) return;
      setBusy(false);
      if (err) { toast('인터넷 연결이 불안정해요. 다시 눌러 주세요.'); return; }
      if (res && !res.ok) { toast(res.msg || '지우지 못했어요.'); return; }
      closeModal();
    });
  });
  $('#modal').addEventListener('click', e => {
    if (e.target.id !== 'modal' || !M) return;
    if (M.mode === 'add' && $('#mText').value.trim()) return; // 쓰던 내용이 있으면 바깥을 눌러도 안 닫힘
    closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!$('#imgView').hidden) { $('#imgView').hidden = true; return; }
      if (!$('#modal').hidden && !(M && M.mode === 'add' && $('#mText').value.trim())) closeModal();
    }
  });

  // ---------- 학생 화면 ----------
  function presentCtx(g) {
    return {
      topic: S.info.topic, image: S.info.image, notes: S.presentNotes, locked: true, teacher: false,
      react: { cls: S.me.cls, group: g },
      emit: (ev, p, cb) => send(ev, p, cb)
    };
  }
  function studentCtx() {
    return {
      topic: S.info.topic, image: S.info.image, notes: S.notes, locked: S.info.locked, teacher: false,
      emit: (ev, p, cb) => send(ev, p, cb)
    };
  }
  function renderMission() {
    const box = $('#mission'); box.innerHTML = '';
    const filled = AREAS.filter(a => S.notes.some(n => n.area === a.key));
    const empty = AREAS.filter(a => !filled.includes(a));
    const mine = S.notes.filter(isMine).length;
    const okAreas = !empty.length, okMine = mine >= MIN_PER_STUDENT;

    const head = el('div', 'mission-head');
    head.appendChild(el('b', null, okAreas && okMine ? '🎉 미션 완료!' : '📌 오늘의 미션'));
    head.appendChild(el('span', null, okAreas && okMine
      ? '잘했어요! 친구의 포스트잇도 읽어 보고, 더 떠오르는 생각을 붙여 보세요.'
      : '조원과 함께 공감지도를 완성해요.'));
    box.appendChild(head);

    const list = el('div', 'mission-items');
    const item = (ok, title, detail) => {
      const d = el('div', 'mitem' + (ok ? ' ok' : ''));
      d.appendChild(el('span', 'mcheck', ok ? '✓' : ''));
      const t = el('div', 'mtext');
      t.appendChild(el('b', null, title));
      t.appendChild(el('span', null, detail));
      d.appendChild(t);
      return d;
    };
    list.appendChild(item(okAreas, '모든 칸에 포스트잇을 붙여요',
      '우리 조 ' + filled.length + ' / ' + AREAS.length + '칸' + (empty.length ? ' · 아직 빈 칸: ' + empty.map(a => a.title).join(', ') : ' 완성!')));
    list.appendChild(item(okMine, '한 사람당 ' + MIN_PER_STUDENT + '장 이상 써요',
      '내 포스트잇 ' + mine + '장' + (okMine ? '' : ' · ' + (MIN_PER_STUDENT - mine) + '장 더!')));
    box.appendChild(list);
  }
  function renderStudent() {
    if (S.mode !== 'student') return;
    const w = $('#stWhere'); w.innerHTML = '';
    w.appendChild(el('b', null, S.me.cls + '반 ' + S.me.group + '조'));
    w.appendChild(el('span', null, ' · ' + S.me.name));
    w.appendChild(el('span', 'topic-pill', '주제: ' + S.info.topic));
    nameChips($('#stOnline'), S.names);
    const pres = S.info.present;
    document.body.classList.toggle('presenting', !!pres);
    $('#lockBanner').hidden = !S.info.locked || !!pres;
    $('#mission').hidden = !!pres;
    const pb = $('#presentBanner'); pb.hidden = !pres;
    if (pres) {
      pb.innerHTML = '';
      pb.appendChild(el('b', null, '📺 다 함께 보기 · ' + pres + '조 공감지도' + (pres === S.me.group ? ' (우리 조!)' : '')));
      pb.appendChild(el('span', null, '공감되는 포스트잇에 ❤️ 👍 😂 😢 😡 스티커를 붙여 보세요. 다시 누르면 떼져요.'));
    }
    if (!$('#modal').hidden && S.info.locked && M && !M.ctx.teacher && (M.canEdit || M.canMove)) closeModal();
    renderMission();
    renderBoard($('#stBoard'), pres ? presentCtx(pres) : studentCtx());
  }

  // ---------- 교사 화면 ----------
  function teacherLogin(code, silent) {
    if (!code) { toast('교사 코드를 입력해 주세요.'); return; }
    send('teacher:login', code, (err, res) => {
      if (err) { if (!silent) toast('서버와 연결이 느려요. 잠시 후 다시 눌러 주세요.'); return; }
      if (!res || !res.ok) { if (!silent) toast((res && res.msg) || '교사 코드가 맞지 않아요.'); sess.del('em_teacher'); return; }
      T.code = code; T.maxGroups = res.maxGroups || 10; T.status = res.status;
      S.mode = 'teacher';
      $('#inCode').value = '';
      sess.del('em_session');
      sess.set('em_teacher', code);
      fillSelect($('#tGroupCount'), T.maxGroups, '개 조');
      if ($('#view-teacher').hidden) show('teacher');
      renderStatus();
      watch(T.cls, true);
    }, 10000);
  }
  function watch(cls, keepOpen) {
    send('teacher:watch', cls, (err, res) => {
      if (err || !res || !res.ok) return;
      T.cls = cls; T.info = res.info; T.groups = res.groups || {};
      setTimer(res.info.timer, true);
      sess.set('em_tcls', cls);
      if (res.status) T.status = res.status;
      if (!keepOpen) T.open = null;
      $('#tTopic').value = T.info.topic;
      renderStatus();
      renderTeacher();
    }, 10000);
  }
  function tg(g) {
    if (!T.groups[g]) T.groups[g] = { notes: [], names: [], updatedAt: 0 };
    return T.groups[g];
  }
  function teacherCtx(g) {
    return {
      topic: T.info.topic, image: T.info.image, notes: tg(g).notes, locked: T.info.locked, teacher: true,
      emit: (ev, p, cb) => send(ev, Object.assign({ cls: T.cls, group: g }, p), cb)
    };
  }

  function renderStatus() {
    const box = $('#saveStatus'), s = T.status;
    box.className = 'save-status';
    if (!s) { box.textContent = ''; return; }
    if (s.mode === 'local') {
      box.classList.add('warn');
      box.textContent = '⚠️ 구글 시트 저장 꺼짐';
      box.title = '구글 시트 자동 저장이 설정되지 않았어요. 서버가 다시 시작되면 포스트잇이 지워질 수 있어요. README의 "구글 시트 자동 저장"을 따라 설정해 주세요.';
    } else if (!s.loaded || !s.ok) {
      box.classList.add('bad');
      box.textContent = '⚠️ 저장 오류 — 다시 시도 중';
      box.title = s.err || '';
    } else {
      box.classList.add('ok');
      box.textContent = s.pending ? '☁️ 구글 시트에 저장 중…' : '☁️ 자동 저장됨' + (s.lastOk ? ' · ' + rel(s.lastOk) : '');
      box.title = '포스트잇이 선생님의 구글 시트에 자동으로 저장되고 있어요.';
    }
  }

  function renderTeacher() {
    if (S.mode !== 'teacher' || !T.info) return;
    const tabs = $('#clsTabs'); tabs.innerHTML = '';
    for (let c = 1; c <= 8; c++) {
      const b = el('button', 'cls-tab' + (c === T.cls ? ' on' : ''), c + '반');
      b.addEventListener('click', () => {
        if (c === T.cls) return;
        if (T.info && T.info.present) send('teacher:present', { cls: T.cls, group: null });
        watch(c);
      });
      tabs.appendChild(b);
    }
    if (document.activeElement !== $('#tTopic')) $('#tTopic').value = T.info.topic;
    $('#tGroupCount').value = T.info.groupCount;
    const lk = $('#tLock');
    lk.textContent = T.info.locked ? '🔒 잠금 풀기' : '🔓 편집 잠그기';
    lk.classList.toggle('locked', T.info.locked);
    const th = $('#tImgThumb'); th.innerHTML = '';
    if (T.info.image) { const im = el('img'); im.src = imgUrl(T.info.image); im.alt = ''; th.appendChild(im); }
    else th.textContent = '📷';
    $('#tImgRemove').hidden = !T.info.image;
    $('#tImgPick').textContent = T.info.image ? '📷 사진 바꾸기' : '📷 사진 올리기';

    // 요약
    let online = 0, total = 0, complete = 0, writers = 0, enough = 0;
    for (let g = 1; g <= T.info.groupCount; g++) {
      const grp = tg(g);
      online += grp.names.length; total += grp.notes.length;
      if (AREAS.every(a => grp.notes.some(n => n.area === a.key))) complete++;
      const counts = authorCounts(grp.notes);
      const people = new Set([...Object.keys(counts), ...grp.names]);
      writers += people.size;
      people.forEach(p => { if ((counts[p] || 0) >= MIN_PER_STUDENT) enough++; });
    }
    const sm = $('#tSummary'); sm.innerHTML = '';
    [['접속 학생', online + '명'], ['포스트잇', total + '장'], ['5칸 모두 채운 조', complete + ' / ' + T.info.groupCount],
     [MIN_PER_STUDENT + '장 이상 쓴 학생', enough + ' / ' + writers + '명'], ['상태', T.info.locked ? '🔒 편집 잠금' : '✏️ 작성 중']]
      .forEach(([k, v]) => { const d = el('div', 'stat'); d.appendChild(el('span', 'stat-k', k)); d.appendChild(el('span', 'stat-v', v)); sm.appendChild(d); });

    if (T.open && T.open > T.info.groupCount) T.open = null;
    document.body.classList.toggle('t-detail', !!T.open);
    $('#tDash').hidden = !!T.open;
    $('#tSummary').hidden = !!T.open;
    $('#tControls').hidden = !!T.open;
    $('#tDetail').hidden = !T.open;
    if (T.open) renderDetail(); else renderDash();
  }

  // 조원별 장수 (접속 중이면 초록 점, 2장 미만이면 주황)
  function members(box, grp) {
    box.innerHTML = '';
    const counts = authorCounts(grp.notes);
    const people = [...new Set([...grp.names, ...Object.keys(counts)])];
    if (!people.length) { box.appendChild(el('span', 'muted', '아직 아무도 없어요')); return; }
    people.forEach(p => {
      const c = counts[p] || 0;
      const chip = el('span', 'mchip' + (c >= MIN_PER_STUDENT ? ' ok' : ' low') + (grp.names.includes(p) ? ' on' : ''));
      chip.title = (grp.names.includes(p) ? '접속 중 · ' : '접속 안 함 · ') + c + '장';
      chip.appendChild(el('span', 'mname', p));
      chip.appendChild(el('b', null, String(c)));
      box.appendChild(chip);
    });
  }

  function renderDash() {
    const dash = $('#tDash'); dash.innerHTML = '';
    for (let g = 1; g <= T.info.groupCount; g++) {
      const grp = tg(g);
      const counts = {}; AREAS.forEach(a => { counts[a.key] = grp.notes.filter(n => n.area === a.key).length; });
      const filled = AREAS.filter(a => counts[a.key] > 0).length;
      const maxC = Math.max(1, ...Object.values(counts));

      const card = el('button', 'gcard' + (filled === AREAS.length ? ' complete' : ''));
      card.type = 'button';
      const head = el('div', 'gc-head');
      head.appendChild(el('h3', null, g + '조'));
      const prog = el('div', 'gc-prog');
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = (filled / AREAS.length * 100) + '%'; bar.appendChild(fill);
      prog.appendChild(bar);
      prog.appendChild(el('span', 'prog-t', filled + '/' + AREAS.length + '칸'));
      head.appendChild(prog);
      card.appendChild(head);

      const mem = el('div', 'members'); members(mem, grp); card.appendChild(mem);

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

      card.addEventListener('click', () => { T.open = g; renderTeacher(); presentSync(); window.scrollTo(0, 0); });
      dash.appendChild(card);
    }
  }

  function renderDetail() {
    const g = T.open, grp = tg(g);
    $('#tDetailTitle').textContent = T.cls + '반 ' + g + '조';
    members($('#tDetailMembers'), grp);
    $('#tPrev').disabled = g <= 1;
    $('#tNext').disabled = g >= T.info.groupCount;
    const tag = $('#tPresentTag');
    const live = T.info.locked && T.info.present === g;
    tag.className = 'present-tag' + (live ? ' live' : '');
    tag.textContent = live ? '📺 학생 화면에 함께 띄우는 중 · 스티커 받는 중' : '';
    const pbtn = $('#tPresentBtn');
    pbtn.textContent = T.info.locked ? '🔓 잠금 풀고 각자 화면으로' : '🔒 잠그고 학생 화면에 띄우기';
    pbtn.classList.toggle('locked', !!T.info.locked);
    renderBoard($('#tBoard'), teacherCtx(g));
  }

  const goGroup = d => {
    if (!T.open) return;
    const n = T.open + d;
    if (n >= 1 && n <= T.info.groupCount) { T.open = n; renderTeacher(); presentSync(); }
  };
  // 발표 모드: 편집 잠금 + 조 크게 보기 → 그 조를 반 전체 학생 화면에 띄움
  function presentSync() {
    if (!T.info) return;
    const want = T.info.locked && T.open ? T.open : null;
    if ((T.info.present || null) === want) return;
    send('teacher:present', { cls: T.cls, group: want }, (err) => { if (err) toast('학생 화면을 바꾸지 못했어요. 다시 눌러 주세요.'); });
  }
  $('#tBack').addEventListener('click', () => { T.open = null; renderTeacher(); presentSync(); });
  $('#tPrev').addEventListener('click', () => goGroup(-1));
  $('#tNext').addEventListener('click', () => goGroup(1));
  document.addEventListener('keydown', e => {
    if (S.mode !== 'teacher' || !T.open || !$('#modal').hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowLeft') goGroup(-1);
    if (e.key === 'ArrowRight') goGroup(1);
    if (e.key === 'Escape' && $('#timerBig').hidden && $('#imgView').hidden) { T.open = null; renderTeacher(); presentSync(); }
  });

  function tSettings(p, okMsg) {
    send('teacher:settings', Object.assign({ cls: T.cls }, p), (err, res) => {
      if (err || !res || !res.ok) toast('바꾸지 못했어요. 다시 눌러 주세요.');
      else if (okMsg) toast(okMsg);
    });
  }
  $('#tTopicApply').addEventListener('click', () => {
    const t = $('#tTopic').value.trim();
    if (!t) { toast('주제를 입력해 주세요.'); return; }
    const all = $('#tAll').checked;
    tSettings({ topic: t, all }, (all ? '1~8반' : T.cls + '반') + ' 주제를 “' + t + '”(으)로 바꿨어요.');
  });
  $('#tTopic').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) $('#tTopicApply').click(); });
  $('#tGroupCount').addEventListener('change', e => tSettings({ groupCount: +e.target.value }));
  $('#tPresentBtn').addEventListener('click', () => $('#tLock').click());
  $('#tLock').addEventListener('click', () => {
    const lock = !T.info.locked;
    send('teacher:settings', { cls: T.cls, locked: lock }, (err, res) => {
      if (err || !res || !res.ok) { toast('바꾸지 못했어요. 다시 눌러 주세요.'); return; }
      if (lock && T.open) send('teacher:present', { cls: T.cls, group: T.open });
      if (lock && T.open) toast('📺 ' + T.open + '조 공감지도를 학생 화면에 띄웠어요.');
    });
  });

  // 주제 사진: 노트북에서 고른 사진을 알맞은 크기로 줄여서 올림
  const pickImage = () => $('#tImgFile').click();
  $('#tImgPick').addEventListener('click', pickImage);
  $('#tImgBtn').addEventListener('click', () => { if (T.info && T.info.image) openImage(T.info.image, T.info.topic); else pickImage(); });
  $('#tImgFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) { toast('사진 파일만 올릴 수 있어요.'); return; }
    let dataUrl;
    try { dataUrl = await shrinkImage(f, 900, 0.85); }
    catch (err) { toast('이 사진은 열 수 없어요. JPG나 PNG 사진으로 올려 주세요.', 3500); return; }
    const all = $('#tAll').checked;
    toast('사진을 올리는 중…', 8000);
    send('teacher:image', { cls: T.cls, all, dataUrl }, (err, res) => {
      if (err) { toast('사진을 올리지 못했어요. 인터넷 연결을 확인하고 다시 해 주세요.', 3500); return; }
      if (!res || !res.ok) { toast((res && res.msg) || '사진을 올리지 못했어요.', 3500); return; }
      toast((all ? '1~8반' : T.cls + '반') + ' 공감지도 가운데에 사진을 넣었어요!');
    }, 30000);
  });
  $('#tImgRemove').addEventListener('click', () => {
    const all = $('#tAll').checked;
    if (!confirm((all ? '1~8반 모두' : T.cls + '반') + '에서 주제 사진을 뺄까요?')) return;
    send('teacher:image', { cls: T.cls, all, dataUrl: null }, (err, res) => {
      if (err || !res || !res.ok) toast('사진을 빼지 못했어요. 다시 눌러 주세요.');
    }, 15000);
  });
  function shrinkImage(file, max, quality) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
        cx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  $('#tResetAll').addEventListener('click', () => {
    if (!confirm(T.cls + '반의 모든 조 공감지도를 지울까요?\n화면에서는 지워지지만, 구글 시트의 "기록(모든 활동)"에는 남아 있어요.')) return;
    send('teacher:reset', { cls: T.cls });
  });
  $('#tResetGroup').addEventListener('click', () => {
    if (!confirm(T.cls + '반 ' + T.open + '조 공감지도를 지울까요?')) return;
    send('teacher:reset', { cls: T.cls, group: T.open });
  });

  $('#tExport').addEventListener('click', () => {
    const rows = [['반', '조', '영역', '내용', '작성자', '작성 시각', '스티커']];
    const order = AREAS.map(a => a.key);
    for (let g = 1; g <= T.info.groupCount; g++) {
      tg(g).notes.slice()
        .filter(n => areaByKey(n.area))
        .sort((x, y) => order.indexOf(x.area) - order.indexOf(y.area) || x.createdAt - y.createdAt)
        .forEach(n => rows.push([T.cls, g, areaByKey(n.area).title, n.text, n.author, new Date(n.createdAt).toLocaleString('ko-KR'), reactionText(n)]));
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

  // 노트북·TV: 글자 크기 단계와 전체 화면
  let zoomIdx = Math.min(ZOOMS.length - 1, Math.max(0, store.get('em_zoom') || 0));
  function applyZoom() {
    const z = S.mode === 'teacher' && !$('#view-teacher').hidden ? ZOOMS[zoomIdx] : 1;
    document.documentElement.style.setProperty('--z', z);
    document.documentElement.classList.toggle('zoomed', z !== 1);
    $('#tZoomOut').disabled = zoomIdx === 0;
    $('#tZoomIn').disabled = zoomIdx === ZOOMS.length - 1;
  }
  $('#tZoomIn').addEventListener('click', () => { zoomIdx = Math.min(ZOOMS.length - 1, zoomIdx + 1); store.set('em_zoom', zoomIdx); applyZoom(); });
  $('#tZoomOut').addEventListener('click', () => { zoomIdx = Math.max(0, zoomIdx - 1); store.set('em_zoom', zoomIdx); applyZoom(); });
  $('#tFull').addEventListener('click', () => {
    const d = document;
    if (d.fullscreenElement) d.exitFullscreen && d.exitFullscreen();
    else if (d.documentElement.requestFullscreen) d.documentElement.requestFullscreen().catch(() => toast('이 브라우저에서는 전체 화면을 쓸 수 없어요. F11 키를 눌러 보세요.'));
  });

  $('#btnTLeave').addEventListener('click', () => {
    socket.emit('teacher:logout');
    S.mode = null; T.code = null; T.open = null;
    sess.del('em_teacher');
    document.body.classList.remove('t-detail');
    show('login'); loadClassInfo();
  });

  setInterval(() => { if (S.mode === 'teacher') { renderStatus(); if (!T.open) renderDash(); } }, 30000);

  // ---------- 실시간 이벤트 ----------
  function apply(cls, group, fnc) {
    if (S.mode === 'student' && S.me.cls === cls) {
      let hit = false;
      if (S.me.group === group) { fnc(S.notes); hit = true; }
      if (S.info.present === group) { fnc(S.presentNotes); hit = true; }
      if (hit) renderStudent();
    }
    if (S.mode === 'teacher' && T.cls === cls) { const g = tg(group); fnc(g.notes); g.updatedAt = Date.now(); renderTeacher(); }
  }
  socket.on('note:added', ({ cls, group, note }) => apply(cls, group, ns => { if (!ns.some(n => n.id === note.id)) ns.push(note); }));
  socket.on('note:updated', ({ cls, group, note }) => {
    if (patchReactions(cls, group, note)) return;
    apply(cls, group, ns => { const i = ns.findIndex(n => n.id === note.id); if (i >= 0) ns[i] = note; });
  });
  // 스티커만 바뀐 경우: 화면 전체를 다시 그리지 않고 숫자만 바꿈 (여럿이 동시에 눌러도 터치가 씹히지 않게)
  function patchReactions(cls, group, note) {
    const lists = [];
    if (S.mode === 'student' && S.me.cls === cls) {
      if (S.me.group === group) lists.push(S.notes);
      if (S.info.present === group) lists.push(S.presentNotes);
    }
    if (S.mode === 'teacher' && T.cls === cls) lists.push(tg(group).notes);
    if (!lists.length) return false;
    for (const ns of lists) {
      const old = ns.find(n => n.id === note.id);
      if (!old || old.text !== note.text || old.area !== note.area || old.color !== note.color) return false;
    }
    lists.forEach(ns => { const i = ns.findIndex(n => n.id === note.id); ns[i] = note; });
    const r = note.reactions || {};
    document.querySelectorAll('.note[data-id="' + CSS.escape(note.id) + '"]').forEach(d => {
      const bar = d.querySelector('.rxbar');
      if (bar) {
        bar.querySelectorAll('.rx').forEach((b, i) => {
          const list = r[REACTIONS[i].key] || [];
          b.classList.toggle('on', list.includes(myKey()));
          b.querySelector('b').textContent = list.length ? String(list.length) : '';
        });
      } else {
        const sum = d.querySelector('.rxsum');
        if (sum) sum.replaceWith(reactionsEl(note, {}));
      }
    });
    return true;
  }
  socket.on('note:deleted', ({ cls, group, id }) => apply(cls, group, ns => { const i = ns.findIndex(n => n.id === id); if (i >= 0) ns.splice(i, 1); }));

  socket.on('presence', ({ cls, group, names }) => {
    if (S.mode === 'student' && S.me.cls === cls && S.me.group === group) { S.names = names; nameChips($('#stOnline'), names); }
    if (S.mode === 'teacher' && T.cls === cls) { tg(group).names = names; renderTeacher(); }
  });

  socket.on('class:settings', ({ cls, info }) => {
    if (S.mode === 'student' && S.me.cls === cls) {
      const was = S.info;
      S.info = info; setTimer(info.timer); renderStudent();
      if (was.locked !== info.locked) toast(info.locked ? '🔒 선생님이 편집을 잠갔어요.' : '🔓 다시 쓸 수 있어요!');
      else if (was.image !== info.image && info.image) toast('📷 선생님이 주제 사진을 올렸어요. 가운데 사진을 눌러 보세요!', 3500);
    }
    if (S.mode === 'teacher' && T.cls === cls) { T.info = info; setTimer(info.timer); renderTeacher(); }
    if (!S.mode && +$('#inCls').value === cls) loadClassInfo();
  });

  socket.on('board:reset', ({ cls, group }) => {
    if (S.mode === 'student' && S.me.cls === cls && S.info.present && (group == null || group === S.info.present)) S.presentNotes = [];
    if (S.mode === 'student' && S.me.cls === cls && (group == null || group === S.me.group)) {
      S.notes = []; renderStudent(); toast('선생님이 공감지도를 새로 시작했어요.');
    }
    if (S.mode === 'teacher' && T.cls === cls) {
      for (let g = 1; g <= T.maxGroups; g++) if (group == null || group === g) { tg(g).notes = []; tg(g).updatedAt = 0; }
      renderTeacher(); toast('지웠어요.');
    }
  });

  socket.on('save:status', s => { T.status = s; renderStatus(); });

  socket.on('present', ({ cls, group, notes }) => {
    if (S.mode === 'student' && S.me.cls === cls) {
      const was = S.info.present;
      S.info.present = group; S.presentNotes = notes || [];
      if (!$('#modal').hidden) closeModal();
      renderStudent();
      window.scrollTo(0, 0);
      if (group && group !== was) toast('📺 ' + group + '조 공감지도를 함께 봐요! 공감되는 포스트잇에 스티커를 붙여 보세요.', 4000);
      else if (!group && was) toast('발표가 끝났어요. 우리 조 공감지도로 돌아왔어요.', 3000);
    }
    if (S.mode === 'teacher' && T.cls === cls) { T.info.present = group; renderTeacher(); }
  });

  // ---------- 타이머 ----------
  // 서버 시계를 기준으로 남은 시간을 계산 (학생 태블릿과 TV가 같은 시간을 보여 줌)
  const TM = { info: { state: 'idle' }, offset: 0, key: '', ended: false };
  function setTimer(info, quiet) {
    if (!info) return;
    if (info.now) TM.offset = info.now - Date.now();
    const key = [info.state, info.endAt, info.left, info.total].join('|');
    if (key === TM.key) return;
    TM.key = key; TM.info = info;
    // 이미 끝난 타이머를 새로 받으면 소리·알림은 다시 내지 않음
    TM.ended = quiet ? timeLeft() === 0 : false;
    renderTimerControls();
    tickTimer();
  }
  function timeLeft() {
    const t = TM.info;
    if (!t || t.state === 'idle') return null;
    if (t.state === 'paused') return t.left || 0;
    return Math.max(0, t.endAt - (Date.now() + TM.offset));
  }
  function fmtTime(ms) {
    const s = Math.ceil(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }
  function renderTimerControls() {
    const t = TM.info, active = t.state !== 'idle';
    $('#ttIdle').hidden = active;
    $('#ttRun').hidden = !active;
    const paused = t.state === 'paused';
    $('#ttPause').textContent = paused ? '계속' : '멈춤';
    $('#ttPause').title = paused ? '다시 시작' : '잠깐 멈춤';
    $('#tbPause').textContent = paused ? '계속' : '멈춤';
    if (!active) $('#timerBig').hidden = true;
    $('#stTimer').hidden = !active;
  }
  function tickTimer() {
    const ms = timeLeft();
    if (ms == null) return;
    const txt = ms === 0 ? '시간 끝!' : fmtTime(ms);
    const paused = TM.info.state === 'paused';
    const warn = ms > 0 && ms <= 60000, done = ms === 0;
    [['#ttTime'], ['#timerBigText'], ['#stTimerText']].forEach(([id]) => { $(id).textContent = txt; });
    [$('#ttTime'), $('#timerBig'), $('#stTimer')].forEach(e => {
      e.classList.toggle('warn', warn); e.classList.toggle('done', done); e.classList.toggle('paused', paused);
    });
    $('#timerBigLabel').textContent = done ? '⏰ 시간이 끝났어요' : paused ? '⏸ 잠깐 멈춤' : '남은 시간';
    const total = TM.info.total || 1;
    $('#timerBigBar').style.width = Math.max(0, Math.min(100, ms / total * 100)) + '%';
    if (done && !TM.ended) {
      TM.ended = true;
      if (S.mode === 'teacher') { beep(); toast('⏰ 시간이 끝났어요!', 4000); }
      if (S.mode === 'student') toast('⏰ 시간이 끝났어요! 선생님 말씀을 들어 주세요.', 4000);
    }
  }
  setInterval(tickTimer, 250);

  let audio = null;
  function unlockAudio() {
    try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch (e) {}
  }
  function beep() {
    if (!audio) return;
    try {
      [0, 0.45, 0.9].forEach(at => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, audio.currentTime + at);
        g.gain.exponentialRampToValueAtTime(0.35, audio.currentTime + at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + 0.35);
        o.connect(g).connect(audio.destination);
        o.start(audio.currentTime + at); o.stop(audio.currentTime + at + 0.4);
      });
    } catch (e) {}
  }

  function timerAction(action, extra) {
    unlockAudio();
    send('teacher:timer', Object.assign({ cls: T.cls, action }, extra || {}), (err, res) => {
      if (err) toast('연결이 불안정해요. 다시 눌러 주세요.');
      else if (res && !res.ok) toast(res.msg || '타이머를 바꾸지 못했어요.');
    });
  }
  const savedMin = store.get('em_tmin');
  if (savedMin) $('#ttMin').value = savedMin;
  $('#ttStart').addEventListener('click', () => {
    const m = Math.round(Number($('#ttMin').value));
    if (!(m >= 1 && m <= 180)) { toast('1분에서 180분 사이로 적어 주세요.'); $('#ttMin').focus(); return; }
    store.set('em_tmin', m);
    timerAction('start', { minutes: m });
  });
  $('#ttMin').addEventListener('keydown', e => { if (e.key === 'Enter') $('#ttStart').click(); });
  const addMin = () => timerAction('add');
  const togglePause = () => timerAction(TM.info.state === 'paused' ? 'resume' : 'pause');
  const stopTimer = () => { if (confirm('타이머를 끝낼까요?')) timerAction('reset'); };
  $('#ttAdd').addEventListener('click', addMin); $('#tbAdd').addEventListener('click', addMin);
  $('#ttPause').addEventListener('click', togglePause); $('#tbPause').addEventListener('click', togglePause);
  $('#ttStop').addEventListener('click', stopTimer); $('#tbStop').addEventListener('click', stopTimer);
  const openBig = () => { unlockAudio(); $('#timerBig').hidden = false; tickTimer(); };
  $('#ttTime').addEventListener('click', openBig); $('#ttBig').addEventListener('click', openBig);
  $('#tbClose').addEventListener('click', () => { $('#timerBig').hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#timerBig').hidden) $('#timerBig').hidden = true; });

  socket.on('timer', ({ cls, timer }) => {
    if ((S.mode === 'student' && S.me && S.me.cls === cls) || (S.mode === 'teacher' && T.cls === cls)) setTimer(timer);
  });

  // 연결이 끊겼다 다시 붙으면 최신 내용으로 다시 맞춤
  let wasDown = false, downTimer = null;
  socket.on('connect', () => {
    clearTimeout(downTimer);
    $('#conn').hidden = true;
    if (wasDown && S.mode) toast('다시 연결됐어요!', 1500);
    wasDown = false;
    loadClassInfo();
    if (S.mode === 'student' && S.me) join(S.me, true);
    else if (S.mode === 'teacher' && T.code) teacherLogin(T.code, true);
    else if (!S.mode) {
      const ses = sess.get('em_session');
      const tcode = sess.get('em_teacher');
      if (ses && ses.mode === 'student' && ses.me) join(ses.me, true);
      else if (tcode) teacherLogin(tcode, true);
    }
  });
  socket.on('disconnect', () => {
    wasDown = true;
    // 아주 잠깐 끊긴 건 알리지 않음
    downTimer = setTimeout(() => { $('#conn').hidden = false; }, 1500);
  });

  applyZoom();
})();
