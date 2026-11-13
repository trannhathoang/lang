/* Lặng — engine sinh âm thanh.
 *
 * Nhạc được sinh ngẫu nhiên (có seed) rồi render bằng OfflineAudioContext thành
 * từng "đoạn" WAV. Mỗi đoạn tự mở dần và tắt dần nên có thể lặp lại hoặc nối sang
 * đoạn mới mà không nghe thấy mối nối. Phát bằng thẻ <audio> thường để iOS cho
 * chạy tiếp khi khoá màn hình.
 */
(function (root) {
  'use strict';

  var SR = 32000;
  var PAD = 0.5; // giây im lặng ở đầu và cuối mỗi đoạn
  var WIN = 2, LEAD = 0.06; // render theo cửa sổ 2 giây, tạo nốt sớm hơn một chút
  var TAU = Math.PI * 2;
  var OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;

  function rng(seed) {
    var a = seed >>> 0;
    function f() {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      f: f,
      range: function (lo, hi) { return lo + (hi - lo) * f(); },
      int: function (n) { return Math.floor(f() * n); },
      pick: function (arr) { return arr[Math.floor(f() * arr.length)]; },
      chance: function (p) { return f() < p; }
    };
  }

  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  /* ---------- dữ liệu dùng chung: nhiễu và đáp ứng xung của reverb ---------- */

  var noiseCache = {};
  function noiseData(kind) {
    if (noiseCache[kind]) return noiseCache[kind];
    var n = SR * 13, xf = SR >> 1, tot = n + xf;
    var raw = new Float32Array(tot);
    var r = rng(kind === 'white' ? 11 : kind === 'pink' ? 22 : 33);
    var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0, i, w;
    for (i = 0; i < tot; i++) {
      w = r.f() * 2 - 1;
      if (kind === 'white') raw[i] = w;
      else if (kind === 'pink') {
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else {
        last = (last + 0.02 * w) / 1.02;
        raw[i] = last * 3.5;
      }
    }
    // hoà phần đuôi vào phần đầu để buffer lặp không bị "tách"
    var out = new Float32Array(n);
    out.set(raw.subarray(0, n));
    for (i = 0; i < xf; i++) {
      var u = i / xf;
      out[i] = raw[i] * Math.sqrt(u) + raw[n + i] * Math.sqrt(1 - u);
    }
    return (noiseCache[kind] = out);
  }

  var IR_CFG = { focus: [2.4, 0.55], deep: [3.2, 0.4], sleep: [4.2, 0.3], rest: [3.4, 0.4], end: [3.0, 0.45] };
  // đường cong vào/ra đẳng công suất cho các hợp âm chuyển tiếp nhau
  var EQ_IN = new Float32Array(33), EQ_OUT = new Float32Array(33);
  for (var q = 0; q < 33; q++) { EQ_IN[q] = Math.sin(Math.PI / 2 * q / 32); EQ_OUT[q] = Math.cos(Math.PI / 2 * q / 32); }
  var irCache = {};
  function irData(mode) {
    if (irCache[mode]) return irCache[mode];
    var cfg = IR_CFG[mode], n = Math.floor(cfg[0] * SR), pre = Math.floor(0.015 * SR), rise = 0.01 * SR;
    var chans = [];
    for (var ch = 0; ch < 2; ch++) {
      var d = new Float32Array(n + pre), r = rng(101 + ch * 17 + mode.length * 5), lp = 0;
      for (var i = 0; i < n; i++) {
        var u = i / n, a = 0.04 + cfg[1] * (1 - u) * (1 - u);
        lp += a * ((r.f() * 2 - 1) - lp);
        d[pre + i] = lp / Math.sqrt(a / (2 - a)) * Math.exp(-6.9 * u) * Math.min(1, i / rise);
      }
      chans.push(d);
    }
    return (irCache[mode] = chans);
  }

  /* ---------- bộ nhạc cụ trên một AudioContext ---------- */

  function makeKit(ctx, s, ci, len) {
    var K = { ctx: ctx, len: len, r: rng(s.seed * 31 + ci * 977 + 5), delayIn: null };

    var master = ctx.createGain();
    var hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 28; hp.Q.value = 0.5;
    master.connect(hp); hp.connect(ctx.destination);

    var ir = irData(s.mode), irBuf = ctx.createBuffer(2, ir[0].length, SR);
    irBuf.getChannelData(0).set(ir[0]); irBuf.getChannelData(1).set(ir[1]);
    var conv = ctx.createConvolver(); conv.buffer = irBuf;
    var wetIn = ctx.createGain(), wet = ctx.createGain();
    wet.gain.value = s.wet;
    wetIn.connect(conv); conv.connect(wet); wet.connect(master);

    function gain(v) { var g = ctx.createGain(); g.gain.value = v; return g; }
    function auto(param, pts) {
      param.setValueAtTime(pts[0][1], pts[0][0]);
      for (var i = 1; i < pts.length; i++) param.linearRampToValueAtTime(pts[i][1], pts[i][0]);
    }
    K.gain = gain;
    // bộ lọc có tần số cắt cập nhật theo khối 128 mẫu; tự động hoá từng mẫu làm render chậm gấp mấy lần
    function biquad(type, q) {
      var f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
      try { f.frequency.automationRate = 'k-rate'; } catch (e) {}
      return f;
    }

    // Các nốt được xếp hàng theo thời điểm bắt đầu và chỉ tạo node ngay trước khi cần,
    // để đồ thị âm thanh luôn nhỏ (tạo hết từ đầu thì render chậm hơn nhiều lần).
    var queue = [], qi = 0;
    function lazy(fn) {
      return function (t) {
        if (t >= len) return;
        var args = arguments;
        queue.push({ t: t, run: function () { fn.apply(null, args); } });
      };
    }
    K.sort = function () { queue.sort(function (a, b) { return a.t - b.t; }); };
    // now: thời điểm hiện tại của context; nốt nào đã tắt hẳn thì gỡ khỏi đồ thị,
    // nếu không trình duyệt vẫn duyệt qua chúng ở mọi khối cho tới khi dọn rác
    var live = [];
    function done(end, node) { live.push({ end: end, node: node }); }
    K.flush = function (until, now) {
      if (now) {
        var keep = [];
        for (var i = 0; i < live.length; i++) {
          if (live[i].end <= now) live[i].node.disconnect(); else keep.push(live[i]);
        }
        live = keep;
      }
      while (qi < queue.length && queue[qi].t < until) { queue[qi].run(); queue[qi++] = null; }
    };

    var buses = {};
    K.bus = function (pan, dry, wetAmt, dly) {
      var key = [pan, dry, wetAmt, dly || 0].join('|');
      if (buses[key]) return buses[key];
      var g = ctx.createGain(), n = g;
      if (pan && ctx.createStereoPanner) {
        var p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); n = p;
      }
      if (dry) { var d = gain(dry); n.connect(d); d.connect(master); }
      if (wetAmt) { var w = gain(wetAmt); n.connect(w); w.connect(wetIn); }
      if (dly && K.delayIn) { var e = gain(dly); g.connect(e); e.connect(K.delayIn); }
      return (buses[key] = g);
    };

    K.makeDelay = function (time, fb, tone, level) {
      var input = gain(1), dL = ctx.createDelay(2), dR = ctx.createDelay(2), f = gain(fb);
      var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = tone;
      dL.delayTime.value = time; dR.delayTime.value = time;
      input.connect(dL); dL.connect(lp); lp.connect(dR); dR.connect(f); f.connect(dL);
      dL.connect(K.bus(-0.5, level, level * 0.6));
      dR.connect(K.bus(0.5, level, level * 0.6));
      K.delayIn = input;
    };

    var nbufs = {};
    function noiseBuf(kind) {
      if (nbufs[kind]) return nbufs[kind];
      var d = noiseData(kind), b = ctx.createBuffer(1, d.length, SR);
      b.getChannelData(0).set(d);
      return (nbufs[kind] = b);
    }

    // nhiễu qua bộ lọc; o.f và o.g là các điểm [thời gian, giá trị]
    K.noise = lazy(function (t, dur, o) {
      var src = ctx.createBufferSource(); src.buffer = noiseBuf(o.kind); src.loop = true;
      var fl = biquad(o.ftype, o.q || 0.5);
      auto(fl.frequency, o.f);
      var g = ctx.createGain(); auto(g.gain, o.g);
      src.connect(fl); fl.connect(g); g.connect(o.dest);
      src.start(t, K.r.f() * (src.buffer.duration - 1)); src.stop(t + dur + 0.05);
      done(t + dur + 0.1, g);
    });

    // pad: mỗi nốt hai dao động lệch tông, một bên trái một bên phải
    K.pad = lazy(function (t, dur, midis, o) {
      var n = midis.length, end = t + dur, amp = o.peak / Math.sqrt(n);
      for (var side = 0; side < 2; side++) {
        var lp = biquad('lowpass', o.q || 0.6);
        auto(lp.frequency, [[t, o.fc0], [t + dur * 0.5, o.fc1], [end, o.fc0]]);
        var env = ctx.createGain();
        if (o.eq) {
          if (o.a > 0) env.gain.setValueCurveAtTime(EQ_IN, t, o.a);
          env.gain.setValueCurveAtTime(EQ_OUT, end - o.r, o.r);
        } else auto(env.gain, [[t, 0], [t + o.a, 1], [Math.max(t + o.a, end - o.r), 1], [end, 0]]);
        lp.connect(env); env.connect(o.dest[side]); done(end + 0.1, env);
        for (var i = 0; i < n; i++) {
          var os = ctx.createOscillator(); os.type = o.type;
          os.frequency.value = mtof(midis[i]);
          os.detune.value = (side ? 1 : -1) * o.det * (0.7 + 0.6 * K.r.f());
          var g = gain(amp); os.connect(g); g.connect(lp);
          os.start(t); os.stop(end + 0.05);
        }
      }
    });

    K.sine = lazy(function (t, dur, f, o) {
      var end = t + dur, os = ctx.createOscillator(), env = ctx.createGain();
      os.frequency.value = f;
      auto(env.gain, [[t, 0], [t + o.a, o.peak], [Math.max(t + o.a, end - o.r), o.peak], [end, 0]]);
      os.connect(env); env.connect(o.dest); done(end + 0.1, env);
      os.start(t); os.stop(end + 0.05);
    });

    function decay(node, t, a, peak, tau) {
      node.gain.setValueAtTime(0, t);
      node.gain.linearRampToValueAtTime(peak, t + a);
      node.gain.setTargetAtTime(0, t + a, tau);
    }

    // chuông ngân: âm cơ bản kéo dài, các bồi âm tắt nhanh hơn
    K.bell = lazy(function (t, f, vel, tau, dest) {
      var parts = [[1, 1, tau], [2, 0.3, tau * 0.55], [3, 0.1, tau * 0.35], [4.16, 0.04, tau * 0.2]];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i], os = ctx.createOscillator(), g = ctx.createGain();
        os.frequency.value = f * p[0];
        decay(g, t, 0.03, vel * p[1], p[2]);
        os.connect(g); g.connect(dest);
        os.start(t); os.stop(t + 0.04 + p[2] * 7); done(t + 0.1 + p[2] * 7, g);
      }
    });

    // piano điện FM (Deep Focus)
    K.ep = lazy(function (t, f, vel, tau, dest) {
      var car = ctx.createOscillator(), mod = ctx.createOscillator(), mg = ctx.createGain(), g = ctx.createGain();
      car.frequency.value = f; mod.frequency.value = f;
      mg.gain.setValueAtTime(f * (0.6 + 1.6 * vel), t);
      mg.gain.setTargetAtTime(f * 0.12, t, 0.3);
      mod.connect(mg); mg.connect(car.frequency);
      decay(g, t, 0.006, vel, tau);
      car.connect(g); g.connect(dest);
      var stop = t + 0.01 + tau * 7;
      car.start(t); mod.start(t); car.stop(stop); mod.stop(stop); done(stop + 0.05, g);
    });

    // tiếng gảy mềm (Focus)
    K.pluck = lazy(function (t, f, vel, o) {
      var os = ctx.createOscillator(), lp = biquad('lowpass', 0.9), g = ctx.createGain();
      os.type = 'sawtooth'; os.frequency.value = f;
      lp.frequency.setValueAtTime(Math.min(SR * 0.42, f * (2 + 6 * o.bright)), t);
      lp.frequency.setTargetAtTime(f * 1.1, t, 0.08);
      decay(g, t, 0.004, vel, o.tau);
      os.connect(lp); lp.connect(g); g.connect(o.dest);
      os.start(t); os.stop(t + 0.01 + o.tau * 8); done(t + 0.06 + o.tau * 8, g);
    });

    K.bass = lazy(function (t, f, vel, tau, dest) {
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), h = gain(0.6), g = ctx.createGain();
      o1.frequency.value = f; o2.type = 'triangle'; o2.frequency.value = f * 2;
      decay(g, t, 0.012, vel, tau);
      o1.connect(g); o2.connect(h); h.connect(g); g.connect(dest);
      var stop = t + 0.02 + tau * 7;
      o1.start(t); o2.start(t); o1.stop(stop); o2.stop(stop); done(stop + 0.05, g);
    });

    // nhịp trầm đều (Deep Focus)
    K.pulse = lazy(function (t, f, vel, fc, dest) {
      var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), h = gain(0.7);
      var lp = biquad('lowpass', 1.1), g = ctx.createGain();
      o1.type = 'sawtooth'; o1.frequency.value = f;
      o2.type = 'sawtooth'; o2.frequency.value = f * 2.003;
      lp.frequency.setValueAtTime(fc, t); lp.frequency.setTargetAtTime(f * 1.2, t, 0.09);
      decay(g, t, 0.008, vel, 0.15);
      o1.connect(lp); o2.connect(h); h.connect(lp); lp.connect(g); g.connect(dest);
      o1.start(t); o2.start(t); o1.stop(t + 1.2); o2.stop(t + 1.2); done(t + 1.25, g);
    });

    K.thump = lazy(function (t, vel, dest) {
      var os = ctx.createOscillator(), g = ctx.createGain();
      os.frequency.setValueAtTime(120, t);
      os.frequency.exponentialRampToValueAtTime(50, t + 0.09);
      decay(g, t, 0.005, vel, 0.07);
      os.connect(g); g.connect(dest);
      os.start(t); os.stop(t + 0.6); done(t + 0.65, g);
    });

    K.tick = lazy(function (t, vel, dest) {
      var src = ctx.createBufferSource(); src.buffer = noiseBuf('white');
      var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 5200; bp.Q.value = 1.2;
      var g = ctx.createGain();
      decay(g, t, 0.001, vel, 0.012);
      src.connect(bp); bp.connect(g); g.connect(dest);
      src.start(t, K.r.f() * 2.5, 0.12); done(t + 0.2, g);
    });

    // một giọt mưa: tiếng lách tách rất ngắn
    K.drop = lazy(function (t, vel, f, dest) {
      var src = ctx.createBufferSource(); src.buffer = noiseBuf('white');
      var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 2.5;
      var g = ctx.createGain();
      decay(g, t, 0.001, vel, 0.008);
      src.connect(bp); bp.connect(g); g.connect(dest);
      src.start(t, K.r.f() * 12, 0.08); done(t + 0.15, g);
    });

    return K;
  }

  /* ---------- Focus ---------- */

  var FOCUS_CH = {
    I:  { bass: 0,  pad: [0, 7, 14, 16],      arp: [0, 2, 4, 7, 9, 12],    next: ['vi', 'IV', 'V', 'IV'] },
    vi: { bass: -3, pad: [-3, 7, 12, 16],     arp: [-3, 0, 4, 7, 9, 12],   next: ['IV', 'I', 'ii'] },
    IV: { bass: -7, pad: [-7, 5, 9, 12, 16],  arp: [0, 5, 7, 9, 12, 16],   next: ['I', 'V', 'vi'] },
    V:  { bass: -5, pad: [-5, 2, 7, 12, 14],  arp: [-5, 0, 2, 7, 9, 14],   next: ['I', 'vi', 'IV'] },
    ii: { bass: 2,  pad: [2, 9, 12, 17],      arp: [2, 5, 9, 12, 14, 17],  next: ['V', 'IV'] }
  };
  var DEEP_CH = {
    i:   { bass: 0,  pad: [0, 7, 14, 15],   next: ['VI', 'iv', 'VII', 'i', 'VI'] },
    VI:  { bass: -4, pad: [-4, 8, 12, 15],  next: ['i', 'VII', 'iv'] },
    iv:  { bass: -7, pad: [-7, 5, 12, 15],  next: ['i', 'VI', 'i'] },
    VII: { bass: -2, pad: [-2, 10, 14, 17], next: ['i', 'i', 'VI'] }
  };

  // tiến trình hợp âm của cả phiên, sinh dần theo chỉ số để các chunk khớp nhau
  function chordAt(s, table, first, i) {
    while (s.chords.length <= i) {
      var n = s.chords.length;
      s.chords.push(n ? s.rT.pick(table[s.chords[n - 1]].next) : first);
    }
    return table[s.chords[i]];
  }

  function patternAt(s, i) {
    var r = s.rP;
    function step(k) { return { on: k === 0 || r.chance(0.62), idx: r.int(6), oct: r.chance(0.2) ? 1 : 0 }; }
    while (s.patterns.length <= i) {
      var p = [], k, n = s.patterns.length;
      if (!n) for (k = 0; k < 8; k++) p.push(step(k));
      else {
        p = s.patterns[n - 1].slice();
        for (k = 0; k < 2; k++) { var j = r.int(8); p[j] = step(j); }
      }
      s.patterns.push(p);
    }
    return s.patterns[i];
  }

  // chuông báo chuyển pha Pomodoro: vào tập trung (đi lên), vào nghỉ (đi xuống), kết thúc buổi
  var CHIMES = {
    focus: [[7, 0], [12, 0.42]],
    rest: [[12, 0], [7, 0.5], [4, 1.0]],
    end: [[0, 0], [4, 0.6], [7, 1.2], [12, 1.8]]
  };
  function chime(K, s, kind, t0) {
    var base = s.root + 24; while (base < 67) base += 12; while (base > 78) base -= 12;
    var bus = K.bus(0, 0.5, 0.7);
    CHIMES[kind].forEach(function (n) { K.bell(t0 + n[1], mtof(base + n[0]), 0.2, kind === 'end' ? 2.4 : 1.6, bus); });
  }

  function genFocus(K, s, ci, len, prog, spec) {
    var beat = 60 / s.bpm, bar = beat * 4, st = beat / 2;
    var bar0 = ci * s.chunkBars, nBars = Math.ceil(len / bar), g0 = bar0 * bar;
    var r = rng(s.seed + 7919 * (ci + 1));
    var ctx = K.ctx, b, k;
    if (spec && spec.chime) chime(K, s, spec.chime, 1.2);

    K.makeDelay(beat * 0.75, 0.38, 2200, 0.5);

    [-0.45, 0.45].forEach(function (pan) {
      K.noise(0, len, { kind: 'pink', ftype: 'bandpass', f: [[0, 2600]], q: 0.4, g: [[0, 0.022]], dest: K.bus(pan, 1, 0.3) });
    });

    // pad "thở" theo nhịp
    var padL = K.gain(1), padR = K.gain(1);
    padL.connect(K.bus(-0.35, 0.7, 0.45)); padR.connect(K.bus(0.35, 0.7, 0.45));
    var lfo = ctx.createOscillator(), lg = K.gain(0.13);
    lfo.frequency.value = 1 / beat;
    lfo.connect(lg); lg.connect(padL.gain); lg.connect(padR.gain);
    lfo.start(beat * 0.25);

    var plk = [K.bus(-0.3, 0.55, 0.3, 0.32), K.bus(0.3, 0.55, 0.3, 0.32)];
    var bassBus = K.bus(0, 1, 0.08), thBus = K.bus(0, 1, 0.03);
    var tickBus = [K.bus(-0.45, 1, 0.2), K.bus(0.45, 1, 0.2)];

    for (b = 0; b < nBars; b++) {
      var gb = bar0 + b, t0 = b * bar, tg = g0 + t0;
      var ch = chordAt(s, FOCUS_CH, 'I', gb >> 2);
      var bright = 0.5 + 0.5 * Math.sin(TAU * tg / s.per2 + s.ph2);
      var arpLv = 0.5 + 0.5 * Math.sin(TAU * tg / s.per1 + s.ph1);

      if ((gb & 3) === 0) {
        K.pad(t0, bar * 4.8, ch.pad.map(function (o) { return s.root + o; }), {
          type: 'sawtooth', det: 7, a: 1.6, r: bar * 1.2, peak: 0.2,
          fc0: 650 + 550 * bright, fc1: 1000 + 1000 * bright, q: 0.6, dest: [padL, padR]
        });
      }

      var bm = s.root - 12 + ch.bass; while (bm < 38) bm += 12;
      K.bass(t0, mtof(bm), 0.15, 0.7, bassBus);
      if (r.chance(0.45)) K.bass(t0 + st * 5, mtof(bm), 0.09, 0.4, bassBus);

      for (k = 0; k < 4; k++) K.thump(t0 + k * beat, k % 2 ? 0.07 : 0.1, thBus);

      if (s.ticks) {
        for (k = 0; k < 8; k++) {
          if (r.chance(k % 2 ? 0.8 : 0.1)) K.tick(t0 + k * st + r.range(0, 0.004), r.range(0.3, 1) * 0.035, tickBus[(k >> 1) & 1]);
        }
      }

      var pat = patternAt(s, gb >> 3);
      for (k = 0; k < 8; k++) {
        var p = pat[k];
        if (!p.on) continue;
        if (arpLv < 0.25 && k % 2 && r.chance(0.5)) continue;
        var m = s.root + 24 + ch.arp[p.idx] + 12 * p.oct; while (m > 86) m -= 12;
        var acc = k === 0 ? 1 : k % 2 === 0 ? 0.8 : 0.6;
        K.pluck(t0 + k * st + r.range(0, 0.006), mtof(m), acc * r.range(0.8, 1) * (0.35 + 0.65 * arpLv) * 0.36, {
          tau: 0.16 + 0.1 * bright, bright: 0.4 + 0.6 * bright, dest: plk[k & 1]
        });
      }
    }
  }

  /* ---------- Deep Focus ---------- */

  var DEEP_ACC = [1, 0.45, 0.7, 0.45, 0.85, 0.45, 0.7, 0.5];
  var MIN_PENT = [0, 3, 5, 7, 10];

  function genDeep(K, s, ci, len) {
    var beat = 60 / s.bpm, bar = beat * 4, st = beat / 2;
    var bar0 = ci * s.chunkBars, nBars = Math.ceil(len / bar), g0 = bar0 * bar;
    var r = rng(s.seed + 7919 * (ci + 1)), b, k, t;

    K.makeDelay(beat * 0.75, 0.45, 1800, 0.55);

    [-0.6, 0.6].forEach(function (pan) {
      K.noise(0, len, { kind: 'brown', ftype: 'lowpass', f: [[0, 520]], q: 0.5, g: [[0, 0.24]], dest: K.bus(pan, 1, 0.1) });
      K.noise(0, len, { kind: 'pink', ftype: 'lowpass', f: [[0, 900]], q: 0.5, g: [[0, 0.16]], dest: K.bus(pan, 1, 0.1) });
    });

    var pad = [K.bus(-0.4, 0.7, 0.55), K.bus(0.4, 0.7, 0.55)];
    var pulseBus = K.bus(0, 1, 0.12), subBus = K.bus(0, 1, 0.05), shim = [K.bus(-0.3, 0.3, 0.9), K.bus(0.3, 0.3, 0.9)];
    var epBus = [K.bus(-0.25, 0.5, 0.5, 0.45), K.bus(0.25, 0.5, 0.5, 0.45)];

    for (b = 0; b < nBars; b++) {
      var gb = bar0 + b, t0 = b * bar, tg = g0 + t0;
      var ch = chordAt(s, DEEP_CH, 'i', gb >> 3);
      var m1 = 0.5 + 0.5 * Math.sin(TAU * tg / s.per1 + s.ph1);
      var m2 = 0.5 + 0.5 * Math.sin(TAU * tg / s.per2 + s.ph2);
      var bm = s.root + ch.bass; while (bm < 40) bm += 12;

      if ((gb & 7) === 0) {
        K.pad(t0, bar * 9.5, ch.pad.map(function (o) { return s.root + 12 + o; }), {
          type: 'sawtooth', det: 9, a: 5, r: bar * 2, peak: 0.2,
          fc0: 400 + 260 * m2, fc1: 600 + 560 * m2, q: 0.7, dest: pad
        });
        K.sine(t0, bar * 9, mtof(bm), { a: 4, r: bar * 1.5, peak: 0.05, dest: subBus });
      }

      for (k = 0; k < 8; k++) {
        K.pulse(t0 + k * st, mtof(bm), DEEP_ACC[k] * 0.24, 280 + 700 * m1, pulseBus);
        if (r.chance(0.07)) {
          var m = s.root + 24 + r.pick(MIN_PENT) + (r.chance(0.3) ? 12 : 0);
          K.ep(t0 + k * st, mtof(m), r.range(0.08, 0.15), r.range(0.5, 0.9), epBus[r.int(2)]);
        }
      }
    }

    t = r.range(10, 30);
    while (t < len) {
      K.pad(t, 22, [s.root + 36, s.root + 43, s.root + 48], {
        type: 'sine', det: 4, a: 8, r: 10, peak: 0.035, fc0: 3000, fc1: 3000, q: 0.5, dest: shim
      });
      t += r.range(35, 60);
    }
  }

  /* ---------- Sleep và nhạc nghỉ: nền đều, không nhịp ---------- */

  var MAJ_PENT = [0, 2, 4, 7, 9];
  // các bè trên, tính từ quãng tám phía trên nốt trì
  var CALM_CH = [[7, 12, 16, 19], [5, 9, 12, 17], [4, 9, 12, 16], [7, 12, 14, 19], [5, 12, 14, 21], [7, 11, 14, 16]];
  var RAIN_HISS = 0.1, RAIN_BODY = 0.4, RAIN_DROP = 0.09, WAVE_FLOOR = 0.25, WAVE_PEAK = 0.75;

  function calmChord(s, i) {
    while (s.chords.length <= i) {
      var n = s.chords.length, c = 0;
      if (n) do { c = s.rT.int(CALM_CH.length); } while (c === s.chords[n - 1]);
      s.chords.push(c);
    }
    return CALM_CH[s.chords[i]];
  }

  // Chuông của Sleep theo thời gian tính từ đầu phiên: khoảng 100 giây đầu gõ chậm, đều,
  // thành từng câu đi xuống để báo hiệu giờ ngủ; sau đó thưa dần rồi chỉ còn lác đác.
  function bellsUntil(s, T) {
    var r = s.rB;
    while (s.bellT < T) {
      var t = s.bellT, n, step = 0, gap, vel, deg, i;
      if (t < 100) { n = 3 + r.int(2); step = r.range(3.0, 3.8); gap = r.range(4.5, 6.5); vel = 0.13; deg = 5 + r.int(4); }
      else if (t < 300) { n = 1 + r.int(2); step = r.range(3.4, 4.2); gap = r.range(9, 15); vel = 0.09; deg = 3 + r.int(6); }
      else { n = 1; gap = r.range(22, 40); vel = 0.06; deg = 3 + r.int(6); }
      for (i = 0; i < n; i++) {
        s.bells.push({ t: t + i * step, deg: deg, vel: vel * r.range(0.85, 1), tau: r.range(3.6, 5), pan: r.int(3) });
        deg = Math.max(0, deg - 1 - (r.chance(0.3) ? 1 : 0));
      }
      s.bellT = t + (n - 1) * step + gap;
    }
  }

  // tiếng mưa hoặc sóng vào dần từ phút thứ 4 đến phút thứ 7
  function natureLevel(tg) { return Math.max(0, Math.min(1, (tg - 240) / 180)); }

  function genCalm(K, s, ci, len, prog, spec) {
    var sleep = s.mode === 'sleep', g0 = ci * s.B, D = s.B / 2, F = s.X;
    var r = rng(s.seed + 7919 * (ci + 1)), t, i;
    if (spec && spec.chime) chime(K, s, spec.chime, 1.2);

    // nền: nhiễu hồng rất khẽ và ba nốt trì giữ nguyên suốt
    K.noise(0, len, { kind: 'pink', ftype: 'lowpass', f: [[0, sleep ? 420 : 700]], q: 0.5, g: [[0, sleep ? 0.12 : 0.08]], dest: K.bus(0, 1, 0.1) });
    var holdBus = K.bus(0, 1, 0.15);
    [[0, 0.03], [12, 0.045], [19, 0.02]].forEach(function (p) {
      K.sine(0, len + 1, mtof(s.root + p[0]), { a: 0.01, r: 0.01, peak: p[1], dest: holdBus });
    });

    // hợp âm: mỗi hợp âm giữ D giây rồi chuyển sang hợp âm kế bằng crossfade đẳng công suất,
    // không lệch tông giữa hai kênh, nên mức âm không nhấp nhô
    var pad = [K.bus(-0.3, 0.6, 0.6), K.bus(0.3, 0.6, 0.6)], c0 = 2 * ci;
    var fc = (sleep ? 700 : 1100) * (1 - 0.25 * prog);
    for (i = c0 - 1; (i - c0) * D < len; i++) {
      if (i < 0) continue;
      var t0 = (i - c0) * D, st = Math.max(0, t0);
      K.pad(st, t0 + D + F - st, calmChord(s, i).map(function (o) { return s.root + 12 + o; }), {
        type: 'triangle', det: 0, eq: true, a: t0 < 0 ? 0 : F, r: F, peak: 0.075, fc0: fc, fc1: fc, q: 0.5, dest: pad
      });
    }

    var bells = [K.bus(-0.35, 0.3, 0.85), K.bus(0, 0.3, 0.85), K.bus(0.35, 0.3, 0.85)];
    function note(t, deg, vel, tau, pan) {
      var d = Math.max(0, Math.min(9, deg));
      K.bell(t, mtof(s.root + 24 + MAJ_PENT[d % 5] + 12 * Math.floor(d / 5)), vel, tau, bells[pan]);
    }
    if (!sleep) {
      t = r.range(4, 9);
      while (t < len) { note(t, 2 + r.int(7), r.range(0.05, 0.08), r.range(2.4, 3.4), r.int(3)); t += r.range(6, 11); }
      return;
    }
    bellsUntil(s, g0 + len);
    for (i = 0; i < s.bells.length; i++) {
      var b = s.bells[i];
      if (b.t >= g0 && b.t < g0 + len) note(b.t - g0, b.deg, b.vel * (1 - 0.6 * prog), b.tau, b.pan);
    }

    var lv0 = natureLevel(g0), lv1 = natureLevel(g0 + len), calm = 1 - 0.35 * prog;
    if (lv1 <= 0) return;
    function lvAt(t) { return (lv0 + (lv1 - lv0) * t / len) * calm; }
    if (s.nature === 'rain') {
      [-0.6, 0.6].forEach(function (pan) {
        var dest = K.bus(pan, 1, 0.15);
        K.noise(0, len, { kind: 'white', ftype: 'bandpass', f: [[0, 2600]], q: 0.35, g: [[0, RAIN_HISS * lvAt(0)], [len, RAIN_HISS * lvAt(len)]], dest: dest });
        K.noise(0, len, { kind: 'pink', ftype: 'lowpass', f: [[0, 1100]], q: 0.5, g: [[0, RAIN_BODY * lvAt(0)], [len, RAIN_BODY * lvAt(len)]], dest: dest });
      });
      var drops = [K.bus(-0.7, 1, 0.1), K.bus(-0.25, 1, 0.1), K.bus(0.25, 1, 0.1), K.bus(0.7, 1, 0.1)];
      t = 0;
      while (t < len) {
        if (lvAt(t) > 0.05) K.drop(t, r.range(0.2, 1) * RAIN_DROP * lvAt(t), r.range(2500, 7000), drops[r.int(4)]);
        t += r.range(0.03, 0.3);
      }
    } else {
      // sóng: luôn có một lớp nền, các con sóng dâng lên trên lớp đó chứ không tắt hẳn
      K.noise(0, len, { kind: 'pink', ftype: 'lowpass', f: [[0, 600]], q: 0.5, g: [[0, WAVE_FLOOR * lvAt(0)], [len, WAVE_FLOOR * lvAt(len)]], dest: K.bus(0, 1, 0.15) });
      t = r.range(0, 3);
      while (t < len) {
        var up = r.range(3, 4.5), down = r.range(6, 9), pk = r.range(0.6, 1) * WAVE_PEAK * lvAt(t);
        if (pk > 0.002) {
          K.noise(t, up + down, {
            kind: 'pink', ftype: 'lowpass', q: 0.6,
            f: [[t, 350], [t + up, r.range(1100, 1900)], [t + up + down, 350]],
            g: [[t, 0], [t + up, pk], [t + up + down, 0]],
            dest: K.bus(r.pick([-0.5, -0.2, 0.2, 0.5]), 1, 0.2)
          });
        }
        t += (up + down) * r.range(0.7, 0.85);
      }
    }
  }

  function genEnd(K, s) { chime(K, s, 'end', 0.4); }

  var GEN = { focus: genFocus, deep: genDeep, sleep: genCalm, rest: genCalm, end: genEnd };

  /* ---------- phiên và render ---------- */

  function newSession(mode, seed) {
    seed = (seed === undefined ? Math.floor(Math.random() * 0xFFFFFFFF) : seed) >>> 0;
    var r = rng(seed);
    var s = {
      mode: mode, seed: seed, ci: 0, chords: [], patterns: [],
      rT: rng(seed ^ 0x9E3779B9), rP: rng(seed ^ 0x51ED270B),
      ph1: r.range(0, TAU), ph2: r.range(0, TAU)
    };
    var bar;
    if (mode === 'focus') {
      s.bpm = r.pick([84, 88, 92, 96]); s.root = r.pick([45, 46, 48, 50]);
      bar = 240 / s.bpm; s.chunkBars = 32; s.B = 32 * bar; s.X = 4 * bar;
      s.per1 = r.range(45, 70); s.per2 = r.range(30, 50);
      s.ticks = r.chance(0.65); s.wet = 0.5; s.trim = 1.15; s.finalFade = 25;
    } else if (mode === 'deep') {
      s.bpm = r.pick([60, 63, 66]); s.root = r.pick([40, 41, 43, 45]);
      bar = 240 / s.bpm; s.chunkBars = 24; s.B = 24 * bar; s.X = 3 * bar;
      s.per1 = r.range(55, 85); s.per2 = r.range(40, 65);
      s.wet = 0.55; s.trim = 1.0; s.finalFade = 25;
    } else if (mode === 'end') {
      s.root = r.pick([48, 50, 53]);
      s.B = 12; s.X = 2; s.wet = 0.7; s.trim = 1.0; s.finalFade = 3;
    } else {
      // sleep và rest: không có nhịp nên hai đoạn kế nhau có thể phát chồng lên nhau để nối liền mạch
      var sleep = mode === 'sleep';
      s.calm = true; s.seamless = true;
      s.root = r.pick(sleep ? [36, 38, 39, 41] : [41, 43, 45]);
      s.B = 84; s.X = 12; s.wet = 0.7; s.trim = sleep ? 1.0 : 1.2; s.finalFade = sleep ? 80 : 15;
      s.nature = sleep ? r.pick(['rain', 'waves']) : null;
      s.bells = []; s.bellT = 2.5; s.rB = rng(seed ^ 0x2545F491);
    }
    return s;
  }

  function pieceLen(s, chunks) { return chunks * s.B + s.X + 2 * PAD; }

  function limit(x) {
    var a = x < 0 ? -x : x;
    if (a <= 0.75) return x;
    var y = 0.75 + 0.24 * Math.tanh((a - 0.75) / 0.24);
    return x < 0 ? -y : y;
  }

  function wavHeader(view, frames) {
    function str(o, t) { for (var i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); }
    var bytes = frames * 4;
    str(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
    str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
    view.setUint32(24, SR, true); view.setUint32(28, SR * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true);
    str(36, 'data'); view.setUint32(40, bytes, true);
  }

  /* spec: { chunks: n } hoặc { final: giây }, kèm:
   *   fadeIn  giây mở dần ở đầu đoạn
   *   xin     đầu đoạn dùng đường cong crossfade dài X giây, để phát chồng lên đuôi đoạn trước
   *   chime   'focus' | 'rest': chuông báo ở đầu đoạn
   *   prog    [đầu, cuối] tiến độ hẹn giờ của Sleep
   * Trả về null nếu aborted() báo huỷ giữa chừng. */
  function renderPiece(s, spec, aborted) {
    if (!OAC) return Promise.reject(new Error('Trình duyệt không hỗ trợ OfflineAudioContext'));
    var t0 = Date.now();
    var Bf = Math.round(s.B * SR), Xf = Math.round(s.X * SR), padF = Math.round(PAD * SR);
    var n, Af, lens = [], k;
    if (spec.final) {
      Af = Math.max(Math.round(8 * SR), Math.round((spec.final - 2 * PAD) * SR));
      n = 1;
      if (Af > Bf + Xf) {
        n = Math.ceil((Af - Xf) / Bf);
        if (Af - (n - 1) * Bf < Xf + 12 * SR) n--;
      }
      for (k = 0; k < n - 1; k++) lens.push(Bf + Xf);
      lens.push(Af - (n - 1) * Bf);
    } else {
      n = spec.chunks; Af = n * Bf + Xf;
      for (k = 0; k < n; k++) lens.push(Bf + Xf);
    }
    var N = Af + 2 * padF;
    var buf = new ArrayBuffer(44 + N * 4);
    wavHeader(new DataView(buf), N);
    var pcm = new Int16Array(buf, 44, N * 2);
    var envStep = SR / 10, env = new Float32Array(Math.ceil(N / envStep) + 1), envMax = 1e-6;
    var fadeInF = Math.round((spec.fadeIn || 4) * SR);
    var finF = spec.final ? Math.round(Math.min(Af * 0.6, s.finalFade * SR)) : 0;
    var prog = spec.prog || [0, 0], trim = s.trim, ci0 = s.ci, carry = null;
    var HALF = Math.PI / 2, xpow = s.calm ? 1 : 1.5;
    var tailPow = s.seamless && !spec.final ? xpow : 2;

    function chunk(k) {
      if (aborted && aborted()) return Promise.resolve(null);
      var len = lens[k], last = k === n - 1;
      var ctx = new OAC(2, len, SR);
      var K = makeKit(ctx, s, ci0 + k, len / SR);
      GEN[s.mode](K, s, ci0 + k, len / SR, prog[0] + (prog[1] - prog[0]) * (n > 1 ? k / (n - 1) : 0), k === 0 ? spec : null);
      K.sort();
      var lazyOk = typeof ctx.suspend === 'function' && typeof ctx.resume === 'function';
      K.flush(lazyOk ? WIN + LEAD : Infinity);
      if (lazyOk) {
        for (var w = WIN; w < len / SR - 0.05; w += WIN) {
          (function (w) {
            ctx.suspend(w).then(function () { K.flush(w + WIN + LEAD, w); ctx.resume(); });
          })(w);
        }
      }
      return ctx.startRendering().then(function (ab) {
        var L = ab.getChannelData(0), R = ab.getChannelData(1);
        var tail = len - Xf, nc = last ? null : [new Float32Array(Xf), new Float32Array(Xf)];
        var base = k * Bf, acc = 0, accN = 0, u, g, l, r, gi, o, e;
        for (var i = 0; i < len; i++) {
          g = 1;
          if (k === 0) {
            if (spec.xin) { if (i < Xf) g = Math.pow(Math.sin(HALF * i / Xf), xpow); }
            else if (i < fadeInF) { u = i / fadeInF; g = u * u * (3 - 2 * u); }
          }
          else if (i < Xf) g = Math.pow(Math.sin(HALF * i / Xf), xpow);
          if (i >= tail) {
            u = (i - tail) / Xf;
            g *= Math.pow(Math.cos(HALF * u), last ? tailPow : xpow);
          }
          l = L[i] * g; r = R[i] * g;
          if (carry && i < Xf) { l += carry[0][i]; r += carry[1][i]; }
          if (!last && i >= Bf) { nc[0][i - Bf] = l; nc[1][i - Bf] = r; continue; }
          gi = base + i;
          if (finF && gi > Af - finF) { u = (Af - gi) / finF; u *= u; l *= u; r *= u; }
          l = limit(l * trim); r = limit(r * trim);
          o = (padF + gi) * 2;
          pcm[o] = Math.round(l * 32767 + Math.random() - Math.random());
          pcm[o + 1] = Math.round(r * 32767 + Math.random() - Math.random());
          acc += l * l + r * r;
          if (++accN === envStep) {
            e = Math.sqrt(acc / (2 * envStep));
            env[Math.floor((padF + gi) / envStep)] = e;
            if (e > envMax) envMax = e;
            acc = 0; accN = 0;
          }
        }
        carry = nc;
        if (last) return true;
        return new Promise(function (res) { setTimeout(res, 0); }).then(function () { return chunk(k + 1); });
      });
    }

    return chunk(0).then(function (ok) {
      if (!ok) return null;
      s.ci = ci0 + n;
      return {
        url: URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })),
        duration: N / SR, env: env, envMax: envMax, isFinal: !!spec.final,
        ms: Date.now() - t0, pcm: spec.keepPcm ? pcm : null
      };
    });
  }

  function silence() {
    var n = SR >> 1, buf = new ArrayBuffer(44 + n * 4);
    wavHeader(new DataView(buf), n);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  root.LangEngine = { SR: SR, newSession: newSession, renderPiece: renderPiece, pieceLen: pieceLen, silence: silence };
})(window);
