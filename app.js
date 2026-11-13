/* Lặng — điều khiển phát, hẹn giờ và giao diện. */
(function () {
  'use strict';

  var E = window.LangEngine;
  function $(id) { return document.getElementById(id); }
  var audio = $('player'), body = document.body;

  var MODES = {
    focus: { name: 'Focus', desc: 'Nhịp nhẹ và sáng, cho việc thường ngày' },
    deep: { name: 'Deep Focus', desc: 'Trầm, đều, ít biến động, cho việc cần tập trung cao' },
    sleep: { name: 'Sleep', desc: 'Chậm, ấm, lắng dần để dỗ giấc ngủ' }
  };
  var NORMAL_CHUNKS = 4;

  var store = {
    get: function (k, d) {
      try { var v = localStorage.getItem('lang.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; }
    },
    set: function (k, v) { try { localStorage.setItem('lang.' + k, JSON.stringify(v)); } catch (e) {} }
  };

  var st = {
    mode: store.get('mode', 'focus'),
    timers: store.get('timers', { focus: 0, deep: 0, sleep: 60 }),
    vol: store.get('vol', 1),
    active: false,    // đang có một phiên (kể cả khi tạm dừng)
    playing: false,
    starting: false,  // đã bấm phát, đang chờ đoạn đầu
    swapping: false,  // đang đổi src của <audio>
    cur: null, next: null, planId: 0, planning: false,
    total: Infinity, remain: Infinity, endAt: null, startedAt: 0,
    sess: null, prep: null, half: false, rate: 0.02, error: ''
  };
  if (!MODES[st.mode]) st.mode = 'focus';

  var volOk = (function () { var a = document.createElement('audio'); a.volume = 0.5; return a.volume === 0.5; })();
  var silentUrl = E.silence(), unlocked = false, prepId = 0, lastTouch = Date.now();

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
    var min = st.timers[st.mode] || 0;
    st.total = min ? min * 60 : Infinity;
    st.remain = st.total;
    st.endAt = st.playing && min ? Date.now() + st.total * 1000 : null;
  }

  /* ---------- chuẩn bị đoạn mở đầu ---------- */

  function prepare() {
    var id = ++prepId, sess = E.newSession(st.mode);
    var prep = { sess: sess, promise: null };
    prep.promise = E.renderPiece(sess, { chunks: 1, fadeIn: 2.5 }).then(function (piece) {
      if (piece) st.rate = piece.ms / 1000 / piece.duration;
      if (id !== prepId) { dispose(piece); return null; }
      return piece;
    });
    prep.promise.catch(fail);
    st.prep = prep;
  }

  function fail(err) {
    console.error(err);
    st.starting = false;
    st.error = 'Không tạo được âm thanh trên trình duyệt này';
    ui();
  }

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    audio.loop = true; audio.src = silentUrl;
    var p = audio.play(); if (p && p.catch) p.catch(function () {});
  }

  function setPiece(piece) {
    st.swapping = true;
    var old = st.cur;
    st.cur = piece; st.half = false;
    audio.loop = !piece.isFinal;
    audio.src = piece.url;
    if (volOk) audio.volume = st.vol;
    function done(ok) { st.swapping = false; markPlaying(ok); dispose(old); setMeta(); ui(); }
    var p = audio.play();
    if (!p || !p.then) { done(true); return Promise.resolve(); }
    return p.then(function () { done(true); }, function () { done(false); });
  }

  /* ---------- phát / dừng ---------- */

  function begin(prep, piece) {
    st.planId++; dispose(st.next); st.next = null; st.planning = false;
    st.prep = null; st.sess = prep.sess; st.active = true; st.error = '';
    st.startedAt = Date.now();
    resetTimer();
    return setPiece(piece).then(planNext);
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
    if (st.starting) { st.starting = false; audio.pause(); unlocked = false; ui(); return; }
    if (!st.active) return start();
    if (st.playing) audio.pause();
    else { var p = audio.play(); if (p && p.catch) p.catch(function () {}); }
  }

  function finish() {
    st.planId++; st.planning = false;
    st.active = false; st.playing = false; st.starting = false; st.endAt = null;
    try { audio.pause(); } catch (e) {}
    audio.removeAttribute('src'); audio.load();
    unlocked = false;
    dispose(st.next); dispose(st.cur); st.next = null; st.cur = null;
    prepare(); ui();
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

  function setTimer(min) {
    st.timers[st.mode] = min; store.set('timers', st.timers);
    if (st.active) { resetTimer(); planNext(); }
    ui();
  }

  /* ---------- lên kế hoạch cho đoạn kế tiếp ---------- */

  function progAt(sec) {
    if (st.mode !== 'sleep') return 0;
    if (st.total === Infinity) return Math.min(0.6, ((Date.now() - st.startedAt) / 1000 + sec) / 2700 * 0.6);
    return Math.max(0, Math.min(1, 1 - (timeLeft() - sec) / st.total));
  }

  function planNext() {
    var id = ++st.planId;
    st.planning = false;
    if (st.next) { dispose(st.next); st.next = null; }
    if (!st.active || !st.cur) return;
    var d = st.cur.duration, tb = Math.max(0, d - audio.currentTime);
    var TL = timeLeft(), R = TL - tb, L = E.pieceLen(st.sess, NORMAL_CHUNKS), spec;

    if (TL === Infinity) { audio.loop = true; spec = { chunks: NORMAL_CHUNKS }; }
    else if (R >= 20) { audio.loop = true; spec = R <= L * 1.5 ? { final: R } : { chunks: NORMAL_CHUNKS }; }
    else if (R > -3) { audio.loop = false; return; }           // hết giờ đúng lúc đoạn này kết thúc
    else if (TL >= 30) {                                        // hết giờ giữa đoạn: chuyển ngay sang đoạn kết
      spec = { final: TL - Math.min(15, 1 + st.rate * TL * 1.3), immediate: true };
    } else return;

    spec.fadeIn = spec.immediate ? 2.5 : 4;
    var len = spec.final || L, lead = spec.immediate ? 0 : tb;
    spec.prog = [progAt(lead), progAt(lead + len)];

    st.planning = true;
    E.renderPiece(st.sess, spec, function () { return id !== st.planId; }).then(function (piece) {
      if (!piece) return;
      if (id !== st.planId) { dispose(piece); return; }
      st.planning = false;
      st.rate = piece.ms / 1000 / piece.duration;
      piece.immediate = !!spec.immediate;
      if (piece.isFinal && !piece.immediate) {
        var exp = timeLeft() - Math.max(0, st.cur.duration - audio.currentTime);
        if (Math.abs(exp - piece.duration) > 4) { dispose(piece); planNext(); return; }
      }
      st.next = piece;
      tick();
    }, function (err) { console.error(err); if (id === st.planId) st.planning = false; });
  }

  function swapTo(piece) {
    st.next = null;
    setPiece(piece).then(planNext);
  }

  function tick() {
    if (st.active && !st.swapping && st.cur) {
      var t = audio.currentTime, d = st.cur.duration, TL = timeLeft();
      if (st.playing && TL <= 0) { finish(); return; }
      if (volOk) audio.volume = st.vol * (TL < 4 ? Math.max(0, TL / 4) : 1);
      var wrapped = st.half && t < 0.45;
      if (t > d * 0.5) st.half = true;
      var n = st.next;
      if (n && st.playing && (n.immediate || t > d - 0.45 || wrapped)) {
        if (n.isFinal && !n.immediate && Math.abs(TL - n.duration) > 4) planNext();
        else { swapTo(n); return; }
      }
      if (wrapped) { st.half = false; if (!st.next && !st.planning) planNext(); }
    }
    // chỉ làm tối màn hình khi đang phát Sleep và đã lâu không chạm; nhạc dừng thì sáng lại ngay
    body.classList.toggle('dim', st.playing && st.mode === 'sleep' && Date.now() - lastTouch > 20000 && $('sheet').hidden);
    clock();
  }

  audio.addEventListener('timeupdate', tick);
  setInterval(tick, 250);
  audio.addEventListener('pause', function () {
    if (!st.active || st.swapping || audio.ended) return;
    markPlaying(false); ui();
  });
  audio.addEventListener('play', function () {
    if (!st.active || st.swapping) return;
    markPlaying(true); ui();
  });
  audio.addEventListener('ended', function () {
    if (!st.active || st.swapping) return;
    var n = st.next;
    if (n && (!n.isFinal || Math.abs(timeLeft() - n.duration) < 6)) swapTo(n);
    else finish();
  });

  /* ---------- điều khiển từ màn hình khoá ---------- */

  var ms = navigator.mediaSession;
  function setMeta() {
    if (!ms || !window.MediaMetadata) return;
    ms.metadata = new MediaMetadata({
      title: MODES[st.mode].name, artist: 'Lặng', album: 'Âm thanh tự sinh',
      artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
    });
  }
  if (ms) {
    try {
      ms.setActionHandler('play', function () { if (st.active) audio.play(); else start(); });
      ms.setActionHandler('pause', function () { audio.pause(); });
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
    var txt;
    if (st.error) txt = st.error;
    else if (st.starting) txt = 'Đang tạo âm thanh…';
    else if (!st.active) txt = 'Chạm vào quả cầu để phát';
    else if (st.total === Infinity) txt = st.playing ? 'Đang phát · không hẹn giờ' : 'Tạm dừng';
    else txt = (st.playing ? 'Tự tắt sau ' : 'Tạm dừng · còn ') + fmt(timeLeft());
    if ($('status').textContent !== txt) $('status').textContent = txt;
  }

  function ui() {
    body.classList.toggle('playing', st.active && st.playing);
    body.classList.toggle('loading', st.starting);
    $('modeName').textContent = MODES[st.mode].name;
    $('desc').textContent = MODES[st.mode].desc;
    var i, b = $('modes').children;
    for (i = 0; i < b.length; i++) b[i].setAttribute('aria-pressed', b[i].dataset.mode === st.mode);
    b = $('timers').children;
    for (i = 0; i < b.length; i++) b[i].setAttribute('aria-pressed', +b[i].dataset.min === (st.timers[st.mode] || 0));
    clock();
  }

  $('orb').addEventListener('click', toggle);
  $('modes').addEventListener('click', function (e) { var m = e.target.dataset.mode; if (m) setMode(m); });
  $('timers').addEventListener('click', function (e) { var m = e.target.dataset.min; if (m !== undefined) setTimer(+m); });
  $('regen').addEventListener('click', function () { setMode(st.mode, true); });
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
    $('vol').addEventListener('input', function () { st.vol = +this.value; store.set('vol', st.vol); audio.volume = st.vol; });
  }

  /* ---------- hình nền và quả cầu ---------- */

  var PAL = {
    focus: { top: [9, 38, 42], bot: [3, 10, 16], hues: [168, 192, 150, 208] },
    deep: { top: [22, 17, 54], bot: [5, 4, 17], hues: [255, 282, 232, 305] },
    sleep: { top: [12, 16, 40], bot: [2, 3, 10], hues: [28, 44, 12, 348] }
  };
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
    var pal = PAL[st.mode], on = st.active && st.playing;
    ease(vis.top, pal.top, 0.05); ease(vis.bot, pal.bot, 0.05); easeHue(vis.hues, pal.hues, 0.05);

    var target = 0.1;
    if (on && st.cur && !st.swapping) {
      var env = st.cur.env, i = Math.min(env.length - 1, Math.floor(audio.currentTime * 10));
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

  window.__lang = { st: st, audio: audio, planNext: planNext };
})();
