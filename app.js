/* Lặng — điều khiển phát, hẹn giờ, Pomodoro và giao diện. */
(function () {
  'use strict';

  var E = window.LangEngine;
  function $(id) { return document.getElementById(id); }
  var els = [$('p0'), $('p1')], body = document.body;

  var MODES = {
    focus: { name: 'Focus', desc: 'Trầm và ấm, nhịp đập chậm, đều' },
    deep: { name: 'Deep Focus', desc: 'Trầm, đều, ít biến động, cho việc cần tập trung cao' },
    study: { name: 'Study', desc: 'Nhịp lo-fi chậm, phím đàn ấm, cho lúc đọc và học' },
    solf: { name: 'Solfeggio', desc: 'Một âm thuần duy nhất, giữ đều' },
    sleep: { name: 'Sleep', desc: 'Chuông chậm mở đầu, nền đều, rồi sóng biển khẽ' },
    rest: { name: 'Nghỉ', desc: 'Rời mắt khỏi màn hình, thả lỏng một lát' },
    end: { name: 'Xong', desc: 'Đã hoàn thành các vòng tập trung' }
  };
  var STEPS = { focus: [5, 120, 5], rest: [1, 30, 1], rounds: [1, 12, 1] }; // [nhỏ nhất, lớn nhất, bước]
  var NORMAL_CHUNKS = 4;
  var POMO_MODES = { focus: 1, study: 1 };   // các chế độ dùng được Pomodoro
  var HZ = E.SOLF_HZ;

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('lang.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('lang.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  var st = {
    mode: store.get('mode', 'focus'),
    timers: store.get('timers', { focus: 0, deep: 0, sleep: 60 }),
    pomo: store.get('pomo', { on: false, focus: 25, rest: 5, rounds: 4 }),
    vol: store.get('vol', 1),
    hz: store.get('hz', 528),   // tần số của chế độ Solfeggio
    active: false,       // đang có một phiên (kể cả khi tạm dừng)
    playing: false,
    starting: false,     // đã bấm phát, đang chờ đoạn đầu
    swapping: false,     // đang đổi src của thẻ <audio> chính
    overlapping: false,  // đang khởi động đoạn kế ở thẻ <audio> thứ hai
    advancing: false,    // đang chuyển sang pha kế (Pomodoro)
    overlapOk: true,     // máy cho hai thẻ <audio> phát cùng lúc
    phases: [], pi: 0,   // các pha của phiên và pha hiện tại
    ei: 0,               // thẻ <audio> đang là thẻ chính
    cur: null, next: null, out: null, planId: 0, planning: false,
    total: Infinity, remain: Infinity, endAt: null, startedAt: 0,
    sess: null, prep: null, nextPrep: null, half: false, rate: 0.03, error: ''
  };
  if (!MODES[st.mode] || st.mode === 'rest' || st.mode === 'end') st.mode = 'focus';
  if (HZ.indexOf(st.hz) < 0) st.hz = 528;

  var volOk = (function () { var a = document.createElement('audio'); a.volume = 0.5; return a.volume === 0.5; })();
  var silentUrl = E.silence(), unlocked = false, lastTouch = Date.now(), replanTimer = 0;

  function P() { return els[st.ei]; }
  function Q() { return els[1 - st.ei]; }
  function playEl(el) { var p = el.play(); if (p && p.catch) p.catch(function () {}); return p; }

  function dispose(piece) {
    if (piece && piece.url) { var u = piece.url; piece.url = null; setTimeout(function () { URL.revokeObjectURL(u); }, 1500); }
  }

  function timeLeft() {
    if (st.total === Infinity) return Infinity;
    return st.playing && st.endAt ? (st.endAt - Date.now()) / 1000 : st.remain;
  }

  function markPlaying(on) {
    if (on === st.playing) return;
    if (on) { st.playing = true; if (st.total !== Infinity) st.endAt = Date.now() + st.remain * 1000; }
    else { st.remain = timeLeft(); st.playing = false; st.endAt = null; }
  }

  function resetTimer() {
    st.total = st.phases[st.pi].dur;
    st.remain = st.total;
    st.endAt = st.playing && st.total !== Infinity ? Date.now() + st.total * 1000 : null;
  }

  /* ---------- các pha của một phiên ---------- */

  // Bình thường phiên chỉ có một pha. Bật Pomodoro (ở Focus hoặc Study) thì thành chuỗi
  // tập trung → nghỉ → … → chuông kết thúc.
  function buildPlan() {
    var ph = [], p = st.pomo, i;
    if (POMO_MODES[st.mode] && p.on) {
      for (i = 1; i <= p.rounds; i++) {
        ph.push({ mode: st.mode, kind: 'focus', dur: p.focus * 60, round: i, chime: 'focus' });
        if (i < p.rounds) ph.push({ mode: 'rest', kind: 'rest', dur: p.rest * 60, round: i, chime: 'rest' });
      }
      ph.push({ mode: 'end', kind: 'end', dur: 12 });
    } else {
      var min = st.timers[st.mode] || 0;
      ph.push({ mode: st.mode, kind: 'plain', dur: min ? min * 60 : Infinity });
    }
    return ph;
  }

  // render sẵn đoạn mở đầu của một pha
  function prepPhase(ph, pi) {
    var sess = E.newSession(ph.mode, undefined, { hz: st.hz }), L1 = E.pieceLen(sess, 1);
    var spec = ph.dur <= L1 + 30 ? { final: ph.dur } : { chunks: 1 };
    spec.chime = ph.chime || null;
    spec.xout = !!sess.seamless && st.overlapOk;
    spec.fadeIn = ph.kind === 'end' ? 0.3 : ph.chime ? 1.0 : 2.5;
    if (ph.mode === 'sleep' && ph.dur !== Infinity) spec.prog = [0, Math.min(1, L1 / ph.dur)];
    var prep = { ph: ph, pi: pi, sess: sess, cancelled: false, phases: null, promise: null };
    prep.promise = E.renderPiece(sess, spec).then(function (piece) {
      if (piece) st.rate = piece.ms / 1000 / piece.duration;
      if (prep.cancelled) { dispose(piece); return null; }
      return piece;
    });
    prep.promise.catch(fail);
    return prep;
  }

  function cancelPrep(prep) {
    if (!prep) return;
    prep.cancelled = true;
    prep.promise.then(dispose, function () {});
  }

  function prepare() {
    var phases = buildPlan();
    cancelPrep(st.prep);
    st.prep = prepPhase(phases[0], 0);
    st.prep.phases = phases;
  }

  function fail(err) {
    console.error(err);
    st.starting = false;
    st.error = 'Không tạo được âm thanh trên trình duyệt này';
    ui();
  }

  /* ---------- hai thẻ <audio> ---------- */

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    var a = P(), b = Q();
    a.loop = true; a.src = silentUrl; playEl(a);
    b.loop = false; b.src = silentUrl; playEl(b);
  }

  function setPiece(piece) {
    st.swapping = true;
    var a = P(), old = st.cur;
    st.cur = piece; st.half = false;
    a.loop = !piece.isFinal;
    a.src = piece.url;
    if (volOk) a.volume = st.vol;
    function done(ok) { st.swapping = false; markPlaying(ok); dispose(old); setMeta(); ui(); }
    var p = a.play();
    if (!p || !p.then) { done(true); return Promise.resolve(); }
    return p.then(function () { done(true); }, function () { done(false); });
  }

  function cleanupOut() {
    var o = st.out;
    if (!o) return;
    st.out = null;
    try { o.el.pause(); } catch (e) {}
    o.el.src = silentUrl;
    dispose(o.piece);
  }

  // Nối liền mạch: phát đoạn kế ở thẻ thứ hai, chồng lên đuôi đang tắt dần của đoạn hiện tại.
  // Nếu thẻ thứ hai không phát được thì quay về cách cũ (đổi đoạn ở chỗ lặng giữa hai đoạn).
  function startOverlap(n) {
    var a = P(), b = Q(), old = st.cur;
    st.next = null; st.overlapping = true;
    b.loop = !n.isFinal; b.src = n.url;
    if (volOk) b.volume = st.vol;
    function ok() {
      st.overlapping = false;
      if (!st.active || st.cur !== old) { b.pause(); b.src = silentUrl; dispose(n); return; }
      a.loop = false;
      st.out = { el: a, piece: old };
      st.ei = 1 - st.ei; st.cur = n; st.half = false;
      if (a.paused && !a.ended) { st.overlapOk = false; cleanupOut(); }   // máy chỉ cho một thẻ phát
      if (!b.paused) markPlaying(true);
      setMeta(); ui(); planNext();
    }
    function bad() {
      st.overlapping = false; st.overlapOk = false;
      b.src = silentUrl;
      if (st.active && st.cur === old) st.next = n; else dispose(n);
    }
    var p = b.play();
    if (!p || !p.then) ok(); else p.then(ok, bad);
  }

  /* ---------- phát / dừng ---------- */

  function begin(prep, piece) {
    st.planId++; st.planning = false; st.advancing = false;
    dispose(st.next); st.next = null;
    cleanupOut();
    if (st.nextPrep !== prep) cancelPrep(st.nextPrep);
    st.nextPrep = null;
    if (prep === st.prep) st.prep = null;
    if (prep.phases) st.phases = prep.phases;
    st.pi = prep.pi; st.sess = prep.sess; st.active = true; st.error = '';
    st.startedAt = Date.now();
    resetTimer();
    return setPiece(piece).then(function () {
      if (!st.active || st.cur !== piece) return;
      planNext();
      prepNextPhase();
    });
  }

  function prepNextPhase() {
    cancelPrep(st.nextPrep); st.nextPrep = null;
    if (st.pi + 1 < st.phases.length) st.nextPrep = prepPhase(st.phases[st.pi + 1], st.pi + 1);
  }

  function start() {
    if (st.starting) return;
    st.starting = true; st.error = ''; ui();
    unlock();
    if (!st.prep) prepare();
    (function wait() {
      var prep = st.prep;
      prep.promise.then(function (piece) {
        if (!st.starting) return;
        if (prep !== st.prep || !piece) return wait();
        st.starting = false;
        begin(prep, piece);
      }, function () {});
    })();
  }

  function toggle() {
    if (st.starting) { st.starting = false; P().pause(); unlocked = false; ui(); return; }
    if (!st.active) return start();
    if (st.playing) { P().pause(); if (st.out) st.out.el.pause(); }
    else playEl(P());
  }

  function finish() {
    st.planId++; st.planning = false; st.advancing = false; st.overlapping = false;
    st.active = false; st.playing = false; st.starting = false; st.endAt = null;
    cleanupOut();
    cancelPrep(st.nextPrep); st.nextPrep = null;
    var a = P();
    try { a.pause(); } catch (e) {}
    a.src = silentUrl;
    unlocked = false;
    dispose(st.next); dispose(st.cur); st.next = null; st.cur = null;
    prepare(); ui();
  }

  // hết pha hiện tại: sang pha kế, hoặc kết thúc phiên
  function advance() {
    if (st.advancing) return;
    if (st.pi + 1 >= st.phases.length) { finish(); return; }
    st.advancing = true;
    if (!st.nextPrep) st.nextPrep = prepPhase(st.phases[st.pi + 1], st.pi + 1);
    var prep = st.nextPrep;
    prep.promise.then(function (piece) {
      if (!st.active || prep !== st.nextPrep || !piece) return;
      begin(prep, piece);
    }, function () {});
  }

  // đang phát mà đổi chế độ hoặc xin bản mới: chờ đoạn đầu của phiên mới rồi chuyển sang
  function switchSession() {
    var prep = st.prep;
    prep.promise.then(function (piece) {
      if (prep !== st.prep || !piece || !st.active) return;
      if (!st.playing) { finish(); return; }
      begin(prep, piece);
    }, function () {});
  }

  function setMode(mode, force) {
    if (mode === st.mode && !force) return;
    st.mode = mode; store.set('mode', mode);
    if (st.active && !st.playing) finish();
    else { prepare(); if (st.active) switchSession(); }
    ui();
  }

  // hẹn giờ hoặc thiết lập Pomodoro thay đổi
  function replan() {
    var ph = buildPlan();
    if (!st.active) {
      var p = st.prep;
      if (p && p.ph.mode === ph[0].mode && (p.ph.chime || null) === (ph[0].chime || null)) { p.phases = ph; p.ph = ph[0]; }
      else prepare();
    } else if (st.sess.mode === ph[0].mode) {
      // nhạc đang phát đúng loại của pha đầu: giữ nguyên nhạc, tính lại giờ từ bây giờ
      st.phases = ph; st.pi = 0; st.advancing = false;
      resetTimer(); planNext(); prepNextPhase();
    } else if (st.playing) { prepare(); switchSession(); }
    else finish();
    ui();
  }

  function setTimer(min) {
    st.timers[st.mode] = min; store.set('timers', st.timers);
    replan();
  }

  function setHz(hz) {
    st.hz = hz; store.set('hz', hz);
    setMode(st.mode, true);
  }

  function setPomo(key, val) {
    st.pomo[key] = val; store.set('pomo', st.pomo);
    ui();
    clearTimeout(replanTimer);
    if (key === 'on' || !st.active) replan();
    else replanTimer = setTimeout(replan, 600);   // bấm +/− liên tiếp thì chỉ tính lại một lần
  }

  /* ---------- lên kế hoạch cho đoạn kế tiếp ---------- */

  // đoạn kế bắt đầu sớm bao nhiêu giây so với lúc đoạn hiện tại hết (0 nếu không phát chồng được)
  function ovLead() { return st.sess && st.sess.seamless && st.overlapOk ? st.sess.X + 1 : 0; }

  function progAt(sec) {
    if (!st.sess || st.sess.mode !== 'sleep') return 0;
    if (st.total === Infinity) return Math.min(0.6, ((Date.now() - st.startedAt) / 1000 + sec) / 2700 * 0.6);
    return Math.max(0, Math.min(1, 1 - (timeLeft() - sec) / st.total));
  }

  function planNext() {
    var id = ++st.planId;
    st.planning = false;
    if (st.next) { dispose(st.next); st.next = null; }
    if (!st.active || !st.cur) return;
    var a = P(), e = Math.max(0, st.cur.duration - a.currentTime), ov = ovLead();
    var tb = Math.max(0, e - ov);   // còn bao lâu nữa thì đoạn kế bắt đầu
    var TL = timeLeft(), L = E.pieceLen(st.sess, NORMAL_CHUNKS), spec;

    if (TL === Infinity) { a.loop = true; spec = { chunks: NORMAL_CHUNKS }; }
    else if (TL - e >= 20) { a.loop = true; spec = TL - tb <= L * 1.5 ? { final: TL - tb } : { chunks: NORMAL_CHUNKS }; }
    else if (TL - e > -3) { a.loop = false; return; }           // hết giờ đúng lúc đoạn này kết thúc
    else if (TL >= 30) {                                         // hết giờ giữa đoạn: chuyển ngay sang đoạn kết
      spec = { final: TL - Math.min(15, 1 + st.rate * TL * 1.3), immediate: true };
    } else return;

    spec.xin = ov > 0 && !spec.immediate;
    spec.xout = ov > 0;
    spec.fadeIn = spec.immediate ? 2.5 : 4;
    var len = spec.final || L, lead = spec.immediate ? 0 : tb;
    spec.prog = [progAt(lead), progAt(lead + len)];

    st.planning = true;
    E.renderPiece(st.sess, spec, function () { return id !== st.planId; }).then(function (piece) {
      if (!piece) return;
      if (id !== st.planId) { dispose(piece); return; }
      st.planning = false;
      st.rate = piece.ms / 1000 / piece.duration;
      piece.immediate = !!spec.immediate; piece.xin = spec.xin;
      if (piece.isFinal && !piece.immediate) {
        var exp = timeLeft() - Math.max(0, st.cur.duration - P().currentTime - (piece.xin ? ovLead() : 0));
        if (Math.abs(exp - piece.duration) > 4) { dispose(piece); planNext(); return; }
      }
      st.next = piece;
      tick();
    }, function (err) { console.error(err); if (id === st.planId) st.planning = false; });
  }

  function swapTo(piece) {
    st.next = null;
    setPiece(piece).then(function () { if (st.active && st.cur === piece) planNext(); });
  }

  function tick() {
    if (st.active && !st.swapping && !st.overlapping && !st.advancing && st.cur) {
      var a = P(), t = a.currentTime, d = st.cur.duration, TL = timeLeft();
      var more = st.pi + 1 < st.phases.length;
      if (st.playing && TL <= (more ? 0.7 : 0)) { advance(); clock(); return; }
      if (volOk) a.volume = st.vol * (TL < 4 ? Math.max(0, TL / 4) : 1);
      var wrapped = st.half && t < 0.45;
      if (t > d * 0.5) st.half = true;
      var n = st.next, ov = ovLead();
      if (n && st.playing) {
        var stale = n.isFinal && !n.immediate && Math.abs(TL - n.duration) > 4;
        if (n.immediate) { swapTo(n); return; }
        if (ov && n.xin && !st.out && t >= d - ov && t < d - 1.5) {
          if (stale) planNext(); else { startOverlap(n); return; }
        } else if (t > d - 0.45 || wrapped) {
          if (stale) planNext(); else { swapTo(n); return; }
        }
      }
      if (wrapped) { st.half = false; if (!st.next && !st.planning) planNext(); }
    }
    // chỉ làm tối màn hình khi đang phát Sleep và đã lâu không chạm; nhạc dừng thì sáng lại ngay
    body.classList.toggle('dim', st.playing && st.mode === 'sleep' && Date.now() - lastTouch > 20000 && $('sheet').hidden);
    clock();
  }

  els.forEach(function (el) {
    el.addEventListener('timeupdate', tick);
    el.addEventListener('pause', function () {
      if (!st.active || el.ended) return;
      if (el === P()) {
        if (st.swapping) return;
        markPlaying(false);
        if (st.out) st.out.el.pause();
        ui();
      } else if (st.out && el === st.out.el && st.playing && !P().paused) {
        st.overlapOk = false; cleanupOut();   // hệ thống tự dừng thẻ cũ khi thẻ mới phát
      }
    });
    el.addEventListener('play', function () {
      if (!st.active || st.swapping || el !== P()) return;
      markPlaying(true);
      if (st.out && st.out.el.paused && !st.out.el.ended) playEl(st.out.el);
      ui();
    });
    el.addEventListener('ended', function () {
      if (!st.active) return;
      if (el !== P()) { if (st.out && el === st.out.el) cleanupOut(); return; }
      if (st.swapping || st.overlapping) return;
      var n = st.next;
      if (n && (!n.isFinal || Math.abs(timeLeft() - n.duration) < 6)) swapTo(n);
      else advance();
    });
  });
  setInterval(tick, 250);

  /* ---------- điều khiển từ màn hình khoá ---------- */

  var ms = navigator.mediaSession;
  function shownMode() { return st.active && st.phases[st.pi] ? st.phases[st.pi].mode : st.mode; }
  function setMeta() {
    if (!ms || !window.MediaMetadata) return;
    ms.metadata = new MediaMetadata({
      title: MODES[shownMode()].name, artist: 'Lặng', album: 'Âm thanh tự sinh',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  }
  if (ms) {
    try {
      ms.setActionHandler('play', function () { if (st.active) playEl(P()); else start(); });
      ms.setActionHandler('pause', function () { P().pause(); if (st.out) st.out.el.pause(); });
      ms.setActionHandler('stop', finish);
    } catch (e) {}
  }

  /* ---------- giao diện ---------- */

  function fmt(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function clock() {
    var txt, ph = st.active ? st.phases[st.pi] : null;
    if (st.error) txt = st.error;
    else if (st.starting) txt = 'Đang tạo âm thanh…';
    else if (!ph) txt = 'Chạm vào quả cầu để phát';
    else if (ph.kind === 'end') txt = 'Hoàn thành ' + st.pomo.rounds + ' vòng';
    else if (ph.kind !== 'plain') {
      var rounds = st.phases.filter(function (p) { return p.kind === 'focus'; }).length;
      txt = 'Vòng ' + ph.round + '/' + rounds + ' · ' + (st.playing ? 'còn ' : 'tạm dừng, còn ') + fmt(timeLeft());
    }
    else if (st.total === Infinity) txt = st.playing ? 'Đang phát · không hẹn giờ' : 'Tạm dừng';
    else txt = (st.playing ? 'Tự tắt sau ' : 'Tạm dừng · còn ') + fmt(timeLeft());
    if ($('status').textContent !== txt) $('status').textContent = txt;
  }

  function ui() {
    var shown = shownMode(), pomoMode = !!POMO_MODES[st.mode], i, b;
    body.classList.toggle('playing', st.active && st.playing);
    body.classList.toggle('loading', st.starting);
    $('modeName').textContent = st.active && st.phases[st.pi].kind === 'focus' ? 'Tập trung' : MODES[shown].name;
    $('desc').textContent = MODES[shown].desc;
    $('hz').hidden = st.mode !== 'solf';
    $('hzOut').textContent = st.hz + ' Hz';
    b = $('modes').children;
    for (i = 0; i < b.length; i++) b[i].setAttribute('aria-pressed', b[i].dataset.mode === st.mode);
    b = $('timers').children;
    for (i = 0; i < b.length; i++) b[i].setAttribute('aria-pressed', +b[i].dataset.min === (st.timers[st.mode] || 0));
    $('pomo').hidden = !pomoMode;
    $('pomo').setAttribute('aria-pressed', !!st.pomo.on);
    $('pomoBlock').hidden = !(pomoMode && st.pomo.on);
    $('timerBlock').hidden = pomoMode && st.pomo.on;
    b = $('pomoBlock').querySelectorAll('.step');
    for (i = 0; i < b.length; i++) {
      var key = b[i].dataset.key;
      b[i].querySelector('output').textContent = st.pomo[key] + (key === 'rounds' ? '' : '′');
    }
    clock();
  }

  $('orb').addEventListener('click', toggle);
  $('modes').addEventListener('click', function (e) { var m = e.target.dataset.mode; if (m) setMode(m); });
  $('timers').addEventListener('click', function (e) { var m = e.target.dataset.min; if (m !== undefined) setTimer(+m); });
  $('regen').addEventListener('click', function () { setMode(st.mode, true); });
  $('pomo').addEventListener('click', function () { setPomo('on', !st.pomo.on); });
  $('hz').addEventListener('click', function (e) {
    var d = +e.target.dataset.d;
    if (d) setHz(HZ[(HZ.indexOf(st.hz) + d + HZ.length) % HZ.length]);
  });
  $('pomoBlock').addEventListener('click', function (e) {
    var d = e.target.dataset.d, step = e.target.closest && e.target.closest('.step');
    if (!d || !step) return;
    var key = step.dataset.key, cfg = STEPS[key];
    var v = Math.max(cfg[0], Math.min(cfg[1], st.pomo[key] + (+d) * cfg[2]));
    if (v !== st.pomo[key]) setPomo(key, v);
  });
  $('info').addEventListener('click', function () { $('sheet').hidden = false; });
  $('sheet').addEventListener('click', function (e) { if (e.target.id === 'sheet' || e.target.id === 'sheetClose') $('sheet').hidden = true; });
  $('veil').addEventListener('click', function () { lastTouch = Date.now(); body.classList.remove('dim'); });
  window.addEventListener('pointerdown', function () { lastTouch = Date.now(); }, true);
  window.addEventListener('keydown', function (e) {
    lastTouch = Date.now(); body.classList.remove('dim');
    if (e.code === 'Space' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'INPUT') { e.preventDefault(); toggle(); }
  });

  if (volOk) {
    $('volWrap').hidden = false;
    $('vol').value = st.vol;
    $('vol').addEventListener('input', function () {
      st.vol = +this.value; store.set('vol', st.vol);
      els[0].volume = st.vol; els[1].volume = st.vol;
    });
  }

  /* ---------- hình nền và quả cầu ---------- */

  var PAL = {
    focus: { top: [9, 38, 42], bot: [3, 10, 16], hues: [168, 192, 150, 208] },
    deep: { top: [22, 17, 54], bot: [5, 4, 17], hues: [255, 282, 232, 305] },
    study: { top: [40, 24, 16], bot: [12, 6, 5], hues: [22, 40, 8, 54] },
    solf: { top: [10, 30, 22], bot: [3, 9, 8], hues: [128, 150, 100, 172] },
    sleep: { top: [12, 16, 40], bot: [2, 3, 10], hues: [28, 44, 12, 348] },
    rest: { top: [36, 30, 14], bot: [10, 8, 4], hues: [48, 80, 30, 110] }
  };
  PAL.end = PAL.rest;
  var cv = $('bg'), g2 = cv.getContext('2d');
  var W = 0, H = 0, SCALE = 0.6;
  var vis = { top: PAL[st.mode].top.slice(), bot: PAL[st.mode].bot.slice(), hues: PAL[st.mode].hues.slice(), lvl: 0.1, energy: 0, dim: 1, tt: Math.random() * 100, last: 0 };

  function resize() {
    W = Math.max(1, Math.round(window.innerWidth * SCALE)); H = Math.max(1, Math.round(window.innerHeight * SCALE));
    cv.width = W; cv.height = H;
  }
  window.addEventListener('resize', resize);
  resize();

  function ease(a, b, k) { for (var i = 0; i < a.length; i++) a[i] += (b[i] - a[i]) * k; }
  function easeHue(a, b, k) {
    for (var i = 0; i < a.length; i++) { var d = ((b[i] - a[i] + 540) % 360) - 180; a[i] = (a[i] + d * k + 360) % 360; }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || now - vis.last < 30) return;
    var dt = Math.min(0.1, (now - vis.last) / 1000); vis.last = now;
    var pal = PAL[shownMode()], on = st.active && st.playing;
    ease(vis.top, pal.top, 0.05); ease(vis.bot, pal.bot, 0.05); easeHue(vis.hues, pal.hues, 0.05);

    var target = 0.1;
    if (on && st.cur && !st.swapping) {
      var env = st.cur.env, i = Math.min(env.length - 1, Math.floor(P().currentTime * 10));
      target = Math.pow(Math.min(1, env[i] / st.cur.envMax), 0.7);
    }
    vis.lvl += (target - vis.lvl) * 0.2;
    vis.energy += ((on ? 1 : 0) - vis.energy) * 0.04;
    vis.dim += ((body.classList.contains('dim') ? 0.16 : 1) - vis.dim) * 0.04;
    vis.tt += dt * (0.25 + 0.75 * vis.energy);

    var bgk = 0.35 + 0.65 * vis.dim;
    var lg = g2.createLinearGradient(0, 0, 0, H);
    lg.addColorStop(0, 'rgb(' + vis.top.map(function (v) { return Math.round(v * bgk); }).join(',') + ')');
    lg.addColorStop(1, 'rgb(' + vis.bot.map(function (v) { return Math.round(v * bgk); }).join(',') + ')');
    g2.globalCompositeOperation = 'source-over';
    g2.fillStyle = lg; g2.fillRect(0, 0, W, H);

    var rect = $('orb').getBoundingClientRect();
    var cx = (rect.left + rect.width / 2) * SCALE, cy = (rect.top + rect.height / 2) * SCALE, R = rect.width / 2 * SCALE;
    var alpha = (0.5 + 0.5 * vis.energy) * vis.dim, tt = vis.tt;
    g2.globalCompositeOperation = 'lighter';
    for (var k = 0; k < 4; k++) {
      var ang = tt * (0.31 + k * 0.07) + k * 1.7;
      var sp = R * 0.3 * (0.35 + 0.65 * vis.energy);
      var x = cx + Math.cos(ang) * sp, y = cy + Math.sin(ang * 1.27 + k) * sp;
      var rad = R * (1.05 + 0.14 * Math.sin(tt * 0.4 + k * 2.1) + 0.3 * vis.lvl * vis.energy);
      var h = vis.hues[k].toFixed(0), rg = g2.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, 'hsla(' + h + ',75%,62%,' + (0.36 * alpha).toFixed(3) + ')');
      rg.addColorStop(0.5, 'hsla(' + h + ',75%,55%,' + (0.13 * alpha).toFixed(3) + ')');
      rg.addColorStop(1, 'hsla(' + h + ',75%,50%,0)');
      g2.fillStyle = rg; g2.beginPath(); g2.arc(x, y, rad, 0, 6.2832); g2.fill();
    }
    var core = g2.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
    core.addColorStop(0, 'rgba(255,255,255,' + ((0.08 + 0.2 * vis.lvl * vis.energy) * alpha).toFixed(3) + ')');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g2.fillStyle = core; g2.beginPath(); g2.arc(cx, cy, R * 0.6, 0, 6.2832); g2.fill();
  }
  requestAnimationFrame(frame);

  /* ---------- khởi động ---------- */

  ui();
  prepare();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  window.__lang = { st: st, els: els, P: P, planNext: planNext };
})();
