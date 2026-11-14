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

  var IR_CFG = {
    focus: [3.4, 0.3], deep: [3.2, 0.4], sleep: [4.2, 0.3], rest: [3.4, 0.4], end: [3.0, 0.45],
    study: [2.2, 0.4], solf: [1.0, 0.3]
  };
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

    // Bộ khuếch đại cho những âm mà chunk nào cũng phát giống hệt nhau, cùng pha (âm thuần của
    // Solfeggio, nền và chuông của Sleep). Ở chỗ hai chunk hoà vào nhau phải nhân thêm một lần
    // đường cong crossfade để tổng không đổi (sin² + cos² = 1); nếu không, âm sẽ phồng lên 3 dB
    // ở mỗi mối nối.
    // head, tail: null | 'chunk' (nối hai chunk trong một đoạn) | 'piece' (nối hai đoạn phát ở hai
    // thẻ <audio>, không cùng pha: chuyển nhanh trong 2 giây ở giữa vùng chồng để nếu hai âm có
    // triệt nhau thì cũng chỉ thoáng qua).
    K.xgain = function (peak, head, tail) {
      var env = ctx.createGain(), n = 129, HALF = Math.PI / 2;
      function curve(kind, out) {
        var c = new Float32Array(n);
        for (var i = 0; i < n; i++) {
          var u = i / (n - 1), x = out ? Math.cos(HALF * u) : Math.sin(HALF * u), g = x;   // x: hệ số crossfade mà engine sẽ nhân vào
          if (kind === 'piece') {
            var v = Math.max(0, Math.min(1, (u * 12 - 5) / 2)), w = Math.sin(HALF * v);
            g = (out ? 1 - w * w : w * w) / Math.max(x, 0.2);
          }
          c[i] = g * peak;
        }
        return c;
      }
      if (head && len < s.X) head = null;
      if (tail && len < s.X * (head ? 2 : 1) + 0.05) tail = null;
      if (head) env.gain.setValueCurveAtTime(curve(head, false), 0, s.X); else env.gain.setValueAtTime(peak, 0);
      if (tail) env.gain.setValueCurveAtTime(curve(tail, true), len - s.X, s.X);
      return env;
    };

    K.tone = lazy(function (t, f, peak, head, tail, dest) {
      var os = ctx.createOscillator(), env = K.xgain(peak, head, tail);
      os.frequency.value = f;
      os.connect(env); env.connect(dest);
      os.start(0);
    });

    // một bè của nền Sleep: âm sin giữ suốt chunk, bắt đầu ở pha cho trước (tính bằng chu kỳ),
    // để chunk nào cũng phát đúng cùng một sóng
    K.voice = function (f, phase, amp, dest) {
      var os = ctx.createOscillator(), g = gain(amp), a = TAU * phase;
      if (ctx.createPeriodicWave) {
        os.setPeriodicWave(ctx.createPeriodicWave(
          new Float32Array([0, Math.sin(a)]), new Float32Array([0, Math.cos(a)]), { disableNormalization: true }));
      }
      os.frequency.value = f;
      os.connect(g); g.connect(dest);
      os.start(0);
    };

    K.pan = function (p, dest) {
      var n = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (n.pan) n.pan.value = p;
      n.connect(dest);
      return n;
    };

    // phím đàn ấm (Study): một dao động tam giác ở giữa, hai răng cưa lệch tông hai bên, bộ lọc khép dần
    K.key = lazy(function (t, f, vel, tau, dest) {
      var lp = biquad('lowpass', 0.7), g = ctx.createGain(), stop = t + 0.02 + tau * 6;
      lp.frequency.setValueAtTime(Math.min(5000, f * 6), t);
      lp.frequency.setTargetAtTime(f * 3, t, 0.25);
      decay(g, t, 0.006, vel, tau);
      lp.connect(g); g.connect(dest); done(stop + 0.05, g);
      [[0, 'triangle', 0.7], [-13, 'sawtooth', 0.3], [11, 'sawtooth', 0.3]].forEach(function (v) {
        var os = ctx.createOscillator(), a = gain(v[2]);
        os.type = v[1]; os.frequency.value = f; os.detune.value = v[0];
        os.connect(a); a.connect(lp);
        os.start(t); os.stop(stop);
      });
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

    // trống trầm: âm sin trượt nhanh từ f0 xuống f1
    K.kick = lazy(function (t, vel, f0, f1, tau, dest) {
      var os = ctx.createOscillator(), g = ctx.createGain();
      os.frequency.setValueAtTime(f0, t);
      os.frequency.exponentialRampToValueAtTime(f1, t + 0.09);
      decay(g, t, 0.005, vel, tau);
      os.connect(g); g.connect(dest);
      os.start(t); os.stop(t + tau * 8 + 0.05); done(t + tau * 8 + 0.1, g);
    });

    K.tick = lazy(function (t, vel, f, dest) {
      var src = ctx.createBufferSource(); src.buffer = noiseBuf('white');
      var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 0.8;
      var g = ctx.createGain();
      decay(g, t, 0.001, vel, 0.014);
      src.connect(bp); bp.connect(g); g.connect(dest);
      src.start(t, K.r.f() * 2.5, 0.14); done(t + 0.22, g);
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

  /* ---------- Focus: hợp âm ngân dài, trầm và tối, nhịp đập đều mỗi giây ---------- */

  // Nốt trầm luôn là nốt gốc; chỉ các bè phía trên đổi, mỗi 8 ô nhịp một lần.
  // pad: các bè ngân; mid: ba bè giữa được làm dày thêm; low: nốt cho những tiếng ngân dài nổi lên rồi lặn xuống.
  var FOCUS_CH = {
    IV: { pad: [5, 9, 12, 17, 21, 24], mid: [12, 17, 21], low: 5, next: ['I', 'vi', 'IV'] },
    I:  { pad: [7, 12, 16, 19, 24],    mid: [12, 16, 19], low: 7, next: ['IV', 'vi', 'IV'] },
    vi: { pad: [4, 9, 12, 16, 21, 24], mid: [12, 16, 21], low: 9, next: ['IV', 'I'] }
  };
  var FOCUS_ACC = [1, 0.7, 0.85, 0.7];
  var FOCUS_HI = [33, 36, 38, 40, 43];
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
    var beat = 60 / s.bpm, bar = beat * 4, half = beat / 2;
    var bar0 = ci * s.chunkBars, nBars = Math.ceil(len / bar), g0 = bar0 * bar;
    var r = rng(s.seed + 7919 * (ci + 1)), b, k, t;
    function chordOf(t) { return chordAt(s, FOCUS_CH, 'IV', (bar0 + Math.floor(t / bar)) >> 3); }
    if (spec && spec.chime) chime(K, s, spec.chime, 1.2);

    K.makeDelay(beat * 0.375, 0.4, 1100, 0.5);

    var pad = [K.bus(-0.95, 0.7, 0.5), K.bus(0.95, 0.7, 0.5)];
    var pulseBus = [K.bus(-0.3, 1, 0.1, 0.4), K.bus(0.3, 1, 0.1, 0.4)], subBus = K.bus(0, 1, 0.05), kickBus = K.bus(0, 1, 0.03);
    var soft = [K.bus(-0.7, 0.6, 0.5, 0.3), K.bus(0.7, 0.6, 0.5, 0.3)];
    var swell = [K.bus(-0.5, 0.6, 0.6), K.bus(0.5, 0.6, 0.6)];
    var high = [K.bus(-0.6, 0.35, 0.8, 0.3), K.bus(0.6, 0.35, 0.8, 0.3)];

    for (b = 0; b < nBars; b++) {
      var gb = bar0 + b, t0 = b * bar, tg = g0 + t0;
      var ch = chordAt(s, FOCUS_CH, 'IV', gb >> 3);
      var m1 = 0.5 + 0.5 * Math.sin(TAU * tg / s.per1 + s.ph1);
      var m2 = 0.5 + 0.5 * Math.sin(TAU * tg / s.per2 + s.ph2);
      var rb = rng(s.seed + 104729 * (gb + 1));   // ngẫu nhiên theo ô nhịp của cả phiên, để hai chunk chồng nhau khớp nhau

      if ((gb & 7) === 0) {
        K.pad(t0, bar * 9.5, ch.pad.map(function (o) { return s.root + o; }), {
          type: 'sawtooth', det: 14, a: 5, r: bar * 2, peak: 0.2,
          fc0: 340 + 140 * m2, fc1: 460 + 280 * m2, q: 0.6, dest: pad
        });
        // lớp giữa tròn tiếng hơn, cho phần 250–500 Hz dày lên mà không thêm bồi âm cao
        K.pad(t0, bar * 9.5, ch.mid.map(function (o) { return s.root + o; }), {
          type: 'triangle', det: 9, a: 5, r: bar * 2, peak: 0.17, fc0: 900, fc1: 900, q: 0.5, dest: pad
        });
        K.sine(t0, bar * 9, mtof(s.root), { a: 4, r: bar * 1.5, peak: 0.07, dest: subBus });
        K.sine(t0, bar * 9, mtof(s.root - 12), { a: 4, r: bar * 1.5, peak: 0.05, dest: subBus });
      }

      for (k = 0; k < 4; k++) {
        var tb = t0 + k * beat;
        K.pulse(tb, mtof(s.root), FOCUS_ACC[k] * 0.34, 400 + 700 * m1, pulseBus[k & 1]);
        K.kick(tb, FOCUS_ACC[k] * 0.1, 120, 50, 0.07, kickBus);
        // nốt đệm khẽ ở nửa sau của phách
        if (rb.chance(0.5)) K.ep(tb + half, mtof(s.root + rb.pick(ch.pad)), rb.range(0.04, 0.07), rb.range(0.5, 0.8), soft[rb.int(2)]);
      }
    }

    // thỉnh thoảng một nốt trầm ngân dài nổi lên rồi lặn xuống
    t = r.range(6, 14);
    while (t < len) {
      var ts = Math.round(t / beat) * beat;
      K.sine(ts, r.range(2.2, 3.2), mtof(s.root + chordOf(ts).low + (r.chance(0.5) ? 12 : 0)), {
        a: 0.5, r: 1.2, peak: r.range(0.05, 0.08), dest: swell[r.int(2)]
      });
      t += r.range(7, 13);
    }

    // vài nốt cao, khẽ, thành từng câu ngắn cách xa nhau
    t = r.range(10, 24);
    while (t < len) {
      var n = 2 + r.int(3), th = Math.round(t / half) * half, idx = r.int(FOCUS_HI.length);
      for (k = 0; k < n; k++) {
        K.sine(th, 1.6, mtof(s.root + FOCUS_HI[idx]), { a: 0.008, r: 1.55, peak: r.range(0.1, 0.15), dest: high[r.int(2)] });
        th += half * (1 + r.int(2));
        idx = Math.max(0, Math.min(FOCUS_HI.length - 1, idx + r.pick([-1, -1, 1, 1, 2])));
      }
      t += r.range(5, 11);
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
  var RAIN_HISS = 0.06, RAIN_BODY = 0.24, RAIN_DROP = 0.055, WAVE_FLOOR = 0.08, WAVE_PEAK = 0.3;

  function calmChord(s, i, table) {
    table = table || CALM_CH;
    while (s.chords.length <= i) {
      var n = s.chords.length, c = 0;
      if (n) do { c = s.rT.int(table.length); } while (c === s.chords[n - 1]);
      s.chords.push(c);
    }
    return table[s.chords[i]];
  }

  // Các hợp âm nối tiếp nhau, mỗi hợp âm giữ D giây rồi chuyển sang hợp âm kế bằng crossfade đẳng
  // công suất dài F giây. Không lệch tông giữa hai kênh nên mức âm không nhấp nhô.
  // per: số hợp âm trong một chunk.
  function calmPads(K, s, ci, len, table, per, F, o) {
    var D = s.B / per, c0 = per * ci, i;
    for (i = c0 - 1; (i - c0) * D < len; i++) {
      if (i < 0) continue;
      var t0 = (i - c0) * D, st = Math.max(0, t0);
      K.pad(st, t0 + D + F - st, calmChord(s, i, table).map(function (n) { return s.root + 12 + n; }), {
        type: 'triangle', det: 0, eq: true, a: t0 < 0 ? 0 : F, r: F, peak: o.peak, fc0: o.fc, fc1: o.fc, q: 0.5, dest: o.dest
      });
    }
  }

  // nhạc nghỉ giữa các vòng Pomodoro
  function genCalm(K, s, ci, len, prog, spec) {
    var r = rng(s.seed + 7919 * (ci + 1)), t;
    if (spec && spec.chime) chime(K, s, spec.chime, 1.2);

    // nền: nhiễu hồng rất khẽ và ba nốt trì giữ nguyên suốt
    K.noise(0, len, { kind: 'pink', ftype: 'lowpass', f: [[0, 700]], q: 0.5, g: [[0, 0.08]], dest: K.bus(0, 1, 0.1) });
    var holdBus = K.bus(0, 1, 0.15);
    [[0, 0.03], [12, 0.045], [19, 0.02]].forEach(function (p) {
      K.sine(0, len + 1, mtof(s.root + p[0]), { a: 0.01, r: 0.01, peak: p[1], dest: holdBus });
    });

    // hợp âm đổi mỗi 42 giây
    calmPads(K, s, ci, len, CALM_CH, 2, s.X, { peak: 0.075, fc: 1100, dest: [K.bus(-0.3, 0.6, 0.6), K.bus(0.3, 0.6, 0.6)] });

    var bells = [K.bus(-0.35, 0.3, 0.85), K.bus(0, 0.3, 0.85), K.bus(0.35, 0.3, 0.85)];
    t = r.range(4, 9);
    while (t < len) {
      var d = 2 + r.int(7);
      K.bell(t, mtof(s.root + 24 + MAJ_PENT[d % 5] + 12 * Math.floor(d / 5)), r.range(0.05, 0.08), r.range(2.4, 3.4), bells[r.int(3)]);
      t += r.range(6, 11);
    }
  }

  /* ---------- Sleep: chuông mở đầu, một hợp âm đứng yên, tiếng ồn trầm ---------- */

  // Các nốt của nền, tính bằng nửa cung từ nốt chủ (root + 12): một hợp âm trưởng trải ba quãng tám,
  // không bao giờ đổi. Mỗi nốt gồm vài bè sin lệch tông nhau chia cho hai kênh; các bè cách nhau
  // đủ xa để chỗ chúng giao thoa chỉ là rung nhẹ, nhanh, chứ không thành những đợt phồng xẹp chậm.
  // [nửa cung, biên độ, số bè, độ lệch tối đa (cent), nhóm]
  var SLEEP_NOTES = [
    [-12, 0.035, 1, 0, 'sub'], [0, 0.06, 1, 0, 'low'], [7, 0.036, 4, 12, 'low'],
    [12, 0.078, 6, 19, 'up'], [16, 0.108, 6, 16, 'third'], [19, 0.114, 6, 15, 'up'],
    [24, 0.092, 6, 18, 'up'], [28, 0.023, 2, 6, 'up']
  ];
  // Mỗi nhóm đổi mức rất chậm, tính bằng dB:
  // [từ giây 110 đến phút 3, thêm từ phút 6 đến phút 14, thêm khi hẹn giờ gần hết].
  // Phần trên lặn dần, phần trầm lúc đầu nổi lên một chút rồi cũng nhỏ đi, nên càng về sau càng
  // tối và nhỏ; tới lúc có mưa hoặc sóng thì nền chỉ còn là tiếng ngân trầm, khẽ.
  var SLEEP_TREND = { sub: [3, -3.5, -1], low: [3, -5.5, -1], up: [-3.5, -16.5, -5], third: [-7.5, -13, -6] };
  var SLEEP_PENT = [-5, -3, 0, 2, 4];   // các nốt chuông quanh nốt chủ ở quãng tám cao
  var SLEEP_BELL = 0.1;

  // Khoảng cách giữa các bè kề nhau của một nốt (tổng bằng 1). Các khoảng phải khác nhau rõ:
  // nếu đều nhau thì mọi cặp bè giao thoa cùng một nhịp và nền sẽ đập theo nhịp đó.
  function sleepGaps(r, n) {
    var g, i, j, ok, sum;
    do {
      g = []; sum = 0; ok = true;
      for (i = 0; i < n; i++) { g.push(r.range(0.7, 1.4)); sum += g[i]; }
      for (i = 0; i < n; i++) for (j = 0; j < i; j++) if (Math.abs(g[i] - g[j]) < 0.08) ok = false;
    } while (!ok);
    return g.map(function (x) { return x / sum; });
  }

  function sleepSetup(s, r) {
    var tonic = s.root + 12, i, j;
    s.notes = SLEEP_NOTES.map(function (d) {
      var n = { group: d[4], voices: [], p1: r.range(47, 97), a1: r.range(0, TAU), p2: r.range(23, 41), a2: r.range(0, TAU) };
      var cnt = d[2], flip = r.int(2), gaps = sleepGaps(r, cnt - 1), pos = 0, sq = 0;
      for (j = 0; j < cnt; j++) {
        var cents = cnt > 1 ? d[3] * (2 * pos - 1) : 0;
        pos += gaps[j] || 0;
        // các bè của một nốt to nhỏ khác nhau, để chỗ giao thoa không bao giờ triệt hẳn
        var w = cnt > 1 ? r.range(0.55, 1) : 0.707;
        sq += w * w;
        n.voices.push({
          f: Math.fround(mtof(tonic + d[0] + cents / 100)), ph: r.f(), amp: w,
          side: cnt > 1 ? (j + flip) & 1 : 2                        // 0 trái, 1 phải, 2 giữa
        });
      }
      n.voices.forEach(function (v) { v.amp *= d[1] / (cnt > 1 ? Math.sqrt(sq) : 1); });
      return n;
    });

    // Chuông: một câu 5-6 nốt, mỗi phiên một câu, kết ở nốt chủ. Câu đó lặp lại sáu lần trong
    // khoảng 90 giây đầu, mỗi lần chậm hơn một chút, rồi còn vài nốt lẻ thưa dần và hết hẳn.
    var m, x;
    do {
      m = [r.chance(0.7) ? 0 : -5];
      for (i = 1 + r.int(2); i < 5; i++) {
        do { x = r.pick(SLEEP_PENT); } while (x === m[m.length - 1] || (i === 4 && x === 0));
        m.push(x);
      }
      m.push(0);
    } while (m.join() === '0,-5,-3,2,4,0');
    var pans = m.map(function () { return r.int(4); });
    var starts = [3.5, 18.5, 33.5, 49, 66.5, 84.5], steps = [1, 1, 1, 1.25, 1.45, 1.6], lv = [0.6, 0.8, 1, 1, 1, 0.85];
    s.bells = [];
    for (i = 0; i < starts.length; i++) {
      for (j = 0; j < m.length; j++) {
        var lastN = j === m.length - 1;
        s.bells.push({
          t: starts[i] + j * steps[i] + r.range(-0.03, 0.03), semi: m[j], pan: pans[j], tau: lastN ? 0.85 : 0.55,
          vel: SLEEP_BELL * lv[i] * (lastN ? 1 : j === 0 ? 0.55 : r.range(0.28, 0.4))
        });
      }
    }
    var t = r.range(106, 110), first = true;
    while (t < 200) {
      s.bells.push({ t: t, semi: first ? 0 : r.pick(SLEEP_PENT), pan: r.int(4), tau: 0.85, vel: SLEEP_BELL * 0.6 * (1 - (t - 100) / 200) });
      t += r.range(16, 30); first = false;
    }
  }

  // hệ số biên độ của một nốt nền tại thời điểm tg (giây từ đầu phiên)
  function sleepLevel(n, tg, prog) {
    var u = Math.max(0, Math.min(1, (tg - 110) / 90)), v = Math.max(0, Math.min(1, (tg - 360) / 480)), tr = SLEEP_TREND[n.group];
    var db = tr[0] * u * u * (3 - 2 * u) + tr[1] * v * v * (3 - 2 * v) + tr[2] * prog +
      Math.sin(TAU * tg / n.p1 + n.a1) + 0.6 * Math.sin(TAU * tg / n.p2 + n.a2);
    return Math.pow(10, db / 20);
  }

  // tiếng mưa hoặc sóng vào dần từ phút thứ 14 đến phút thứ 17
  function natureLevel(tg) { return Math.max(0, Math.min(1, (tg - 840) / 180)); }

  function genSleep(K, s, ci, len, prog, spec, at) {
    var ctx = K.ctx, g0 = ci * s.B, r = rng(s.seed + 7919 * (ci + 1)), t, i;
    // nền và chuông giống hệt nhau ở hai chunk kế tiếp, nên chỗ nối trong một đoạn cần đường cong bù
    var head = spec ? null : 'chunk', tail = at.last ? null : 'chunk';

    // tiếng ồn trầm, đều, mỗi kênh một nguồn riêng
    [-0.85, 0.85].forEach(function (pan) {
      K.noise(0, len, { kind: 'pink', ftype: 'lowpass', f: [[0, 480]], q: 0.5, g: [[0, 0.3]], dest: K.bus(pan, 1, 0) });
    });

    var drone = K.xgain(1, head, tail), out = drone;
    drone.connect(K.bus(0, 1, 0.08));
    if (ci === 0) {   // đầu phiên: nền vào dần trong khoảng 20 giây
      out = ctx.createGain();
      out.gain.setValueAtTime(0.15, 0);
      out.gain.linearRampToValueAtTime(1, Math.min(22, len));
      out.connect(drone);
    }
    var sides = [K.pan(-0.95, out), K.pan(0.95, out), out];
    s.notes.forEach(function (n) {
      var gs = [];
      n.voices.forEach(function (v) {
        var g = gs[v.side];
        if (!g) {
          g = gs[v.side] = ctx.createGain();
          g.gain.setValueAtTime(sleepLevel(n, g0, prog), 0);
          for (t = 6; t < len + 6; t += 6) g.gain.linearRampToValueAtTime(sleepLevel(n, g0 + Math.min(t, len), prog), Math.min(t, len));
          g.connect(sides[v.side]);
        }
        var cyc = v.f * g0 + v.ph;
        K.voice(v.f, cyc - Math.floor(cyc), v.amp, g);
      });
    });

    var bellOut = K.xgain(1, head, tail);
    bellOut.connect(K.bus(0, 0.3, 0.85));
    var bells = [-0.45, -0.15, 0.15, 0.45].map(function (p) { return K.pan(p, bellOut); });
    for (i = 0; i < s.bells.length; i++) {
      var b = s.bells[i];
      if (b.t >= g0 && b.t < g0 + len) K.bell(b.t - g0, mtof(s.root + 48 + b.semi), b.vel * (1 - 0.6 * prog), b.tau, bells[b.pan]);
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
      // Sóng: khẽ và đục, dâng nhanh rồi rút chậm, đợt nọ gối lên đợt kia. Mỗi tai một nguồn nhiễu
      // riêng nên tiếng sóng trải rộng; bộ lọc thông cao giữ cho sóng không làm phần trầm phập phồng.
      var surf = ctx.createBiquadFilter();
      surf.type = 'highpass'; surf.frequency.value = 280; surf.Q.value = 0.5;
      surf.connect(K.bus(0, 1, 0.15));
      var shore = [K.pan(-1, surf), K.pan(1, surf)];
      shore.forEach(function (dest) {
        K.noise(0, len, { kind: 'pink', ftype: 'lowpass', f: [[0, 700]], q: 0.5, g: [[0, WAVE_FLOOR * lvAt(0)], [len, WAVE_FLOOR * lvAt(len)]], dest: dest });
      });
      t = r.range(0, 3);
      while (t < len) {
        var up = r.range(1.2, 2.2), down = r.range(3.5, 5.5), pk = r.range(0.5, 1) * WAVE_PEAK * lvAt(t), fpk = r.range(1000, 1750);
        if (pk > 0.002) {
          shore.forEach(function (dest) {
            var lag = r.range(0, 0.35);
            K.noise(t + lag, up + down, {
              kind: 'pink', ftype: 'lowpass', q: 0.6,
              f: [[t + lag, 350], [t + lag + up, fpk], [t + lag + up + down, 350]],
              g: [[t + lag, 0], [t + lag + up, pk], [t + lag + up + down, 0]],
              dest: dest
            });
          });
        }
        t += r.range(3, 6);
      }
    }
  }

  /* ---------- Study: nhịp lo-fi chậm, phím đàn ấm hơi lệch tông ---------- */

  // hợp âm bảy trong giọng thứ tự nhiên, tính từ nốt gốc; mỗi ô nhịp một hợp âm
  var STUDY_CH = {
    i:   { bass: 0, keys: [7, 10, 12, 15], next: ['iv', 'VI', 'v', 'III'] },
    iv:  { bass: 5, keys: [5, 8, 12, 15],  next: ['i', 'v', 'VI'] },
    v:   { bass: 7, keys: [7, 10, 14, 17], next: ['i', 'VI', 'iv'] },
    VI:  { bass: 8, keys: [8, 12, 15, 19], next: ['i', 'iv', 'III'] },
    III: { bass: 3, keys: [7, 10, 14, 15], next: ['VI', 'iv', 'i'] }
  };
  // trống trầm: các bước (nốt móc kép) có tiếng trống trong một vòng hai ô nhịp
  var STUDY_KICK = [[0, 10, 16, 22, 26], [0, 7, 10, 16, 26], [0, 6, 16, 19, 24, 26], [0, 10, 14, 16, 26]];
  var STUDY_HAT = [0.55, 0.12, 1, 0.6];
  var MIN_PENT2 = [0, 3, 5, 7, 10, 12, 15];

  function genStudy(K, s, ci, len, prog, spec) {
    var beat = 60 / s.bpm, bar = beat * 4, st = beat / 4;
    var bar0 = ci * s.chunkBars, nBars = Math.ceil(len / bar);
    var b, k, r;
    if (spec && spec.chime) chime(K, s, spec.chime, 1.2);

    K.makeDelay(beat * 0.75, 0.25, 1600, 0.35);

    var keys = [K.bus(-0.6, 0.7, 0.35, 0.18), K.bus(0.6, 0.7, 0.35, 0.18)];
    var pad = [K.bus(-0.9, 0.7, 0.4), K.bus(0.9, 0.7, 0.4)];
    var lowBus = K.bus(0, 1, 0.1), kickBus = K.bus(0, 1, 0.04);
    var hat = [K.bus(-0.5, 1, 0.12), K.bus(0.5, 1, 0.12)];
    var kicks = STUDY_KICK[s.kick];

    for (b = 0; b < nBars; b++) {
      var gb = bar0 + b, t0 = b * bar, base = (gb & 1) * 16;
      var ch = chordAt(s, STUDY_CH, 'i', gb);
      r = rng(s.seed + 104729 * (gb + 1));   // ngẫu nhiên theo ô nhịp của cả phiên, để hai chunk chồng nhau khớp nhau

      K.pad(t0, bar + 0.9, ch.keys.map(function (o) { return s.root + o; }), {
        type: 'triangle', det: 11, a: 0.5, r: 0.9, peak: 0.08, fc0: 900, fc1: 1100, q: 0.5, dest: pad
      });

      // hai lần bấm hợp âm mỗi ô nhịp; lần sau nhẹ hơn và đôi khi đến sớm
      var hits = [[0, 1], [r.chance(0.25) ? 6 : 8, 0.7]];
      hits.forEach(function (h) {
        var th = t0 + h[0] * st;
        K.key(th, mtof(s.root - 12 + ch.bass), 0.14 * h[1], 0.9, lowBus);
        ch.keys.forEach(function (o, i) {
          K.key(th + i * r.range(0.012, 0.028), mtof(s.root + o), 0.28 * h[1] * r.range(0.85, 1), r.range(0.8, 1.1), keys[i & 1]);
        });
        K.key(th + 0.09, mtof(s.root + 12 + ch.keys[3]), 0.14 * h[1], 0.8, keys[r.int(2)]);
      });

      // một hai nốt lẻ ở giữa, không phải ô nào cũng có
      if (r.chance(0.45)) {
        var n = 1 + r.int(2), step = 10 + 2 * r.int(2), deg = 2 + r.int(5);
        for (k = 0; k < n && step < 16; k++) {
          K.key(t0 + step * st, mtof(s.root + 12 + MIN_PENT2[deg]), r.range(0.14, 0.2), 0.7, keys[r.int(2)]);
          step += 2; deg = Math.max(0, Math.min(6, deg + r.pick([-1, 1, -2])));
        }
      }

      for (k = 0; k < 16; k++) {
        if (kicks.indexOf(base + k) >= 0) K.kick(t0 + k * st, k === 0 ? 0.23 : 0.18, 105, 64, 0.11, kickBus);
        if (k % 2 === 0) K.tick(t0 + k * st + r.range(0, 0.004), STUDY_HAT[(k >> 1) & 3] * r.range(0.8, 1) * 0.8, 2400, hat[(k >> 1) & 1]);
      }
    }
  }

  /* ---------- Solfeggio: chỉ một âm sin thuần, giữ đều ---------- */

  var SOLF_HZ = [174, 285, 396, 417, 528, 639, 741, 852, 963];
  // âm trầm cho to hơn, âm cao cho nhỏ lại, để nghe to gần như nhau
  var SOLF_AMP = { 174: 2.4, 285: 1.8, 396: 1.45, 417: 1.5, 528: 1, 639: 1.05, 741: 0.85, 852: 0.9, 963: 0.8 };

  function genSolf(K, s, ci, len, prog, spec, at) {
    if (spec && spec.chime) chime(K, s, spec.chime, 1.2);
    var head = spec ? (spec.xin ? 'piece' : null) : 'chunk';
    var tail = !at.last ? 'chunk' : at.xout && !at.final ? 'piece' : null;
    if (head && len < s.X) head = null;
    if (tail && len < s.X * (head ? 2 : 1) + 0.05) tail = null;
    K.tone(0, s.hz, s.amp, head, tail, K.bus(0, 1, 0));
  }

  function genEnd(K, s) { chime(K, s, 'end', 0.4); }

  var GEN = { focus: genFocus, deep: genDeep, sleep: genSleep, rest: genCalm, end: genEnd, study: genStudy, solf: genSolf };

  /* ---------- phiên và render ---------- */

  // opts.hz: tần số của chế độ Solfeggio
  function newSession(mode, seed, opts) {
    seed = (seed === undefined ? Math.floor(Math.random() * 0xFFFFFFFF) : seed) >>> 0;
    var r = rng(seed);
    var s = {
      mode: mode, seed: seed, ci: 0, chords: [],
      rT: rng(seed ^ 0x9E3779B9),
      ph1: r.range(0, TAU), ph2: r.range(0, TAU)
    };
    var bar;
    if (mode === 'focus') {
      s.bpm = 60; s.root = r.pick([47, 48, 49, 50]);
      bar = 240 / s.bpm; s.chunkBars = 24; s.B = 24 * bar; s.X = 3 * bar;
      s.per1 = r.range(50, 80); s.per2 = r.range(40, 65);
      s.wet = 0.55; s.trim = 0.95; s.finalFade = 25;
    } else if (mode === 'deep') {
      s.bpm = r.pick([60, 63, 66]); s.root = r.pick([40, 41, 43, 45]);
      bar = 240 / s.bpm; s.chunkBars = 24; s.B = 24 * bar; s.X = 3 * bar;
      s.per1 = r.range(55, 85); s.per2 = r.range(40, 65);
      s.wet = 0.55; s.trim = 1.0; s.finalFade = 25;
    } else if (mode === 'end') {
      s.root = r.pick([48, 50, 53]);
      s.B = 12; s.X = 2; s.wet = 0.7; s.trim = 1.0; s.finalFade = 3;
    } else if (mode === 'study') {
      s.bpm = r.pick([76, 80, 84]); s.root = r.pick([57, 58, 59, 60]);
      bar = 240 / s.bpm; s.chunkBars = 28; s.B = 28 * bar; s.X = 4 * bar;
      s.kick = r.int(STUDY_KICK.length);
      s.wet = 0.4; s.trim = 1.0; s.finalFade = 25;
    } else if (mode === 'solf') {
      // B = 84 giây là bội của chu kỳ mọi tần số ở đây, nên chunk nào cũng bắt đầu đúng pha 0
      s.calm = true; s.seamless = true;
      s.hz = opts && SOLF_HZ.indexOf(opts.hz) >= 0 ? opts.hz : 528;
      s.root = 60;   // chỉ dùng cho chuông báo
      s.amp = 0.045 * SOLF_AMP[s.hz];
      s.B = 84; s.X = 12; s.wet = 0; s.trim = 1.0; s.finalFade = 25;
    } else {
      // sleep và rest: không có nhịp nên hai đoạn kế nhau có thể phát chồng lên nhau để nối liền mạch
      var sleep = mode === 'sleep';
      s.calm = true; s.seamless = true;
      s.root = r.pick(sleep ? [35, 36, 37, 38] : [41, 43, 45]);
      s.B = 84; s.X = 12; s.wet = 0.7; s.trim = sleep ? 1.0 : 1.2; s.finalFade = sleep ? 80 : 15;
      s.nature = sleep ? r.pick(['rain', 'waves']) : null;
      if (sleep) sleepSetup(s, rng(seed ^ 0x2545F491));
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
   *   xout    đuôi đoạn sẽ được đoạn kế phát chồng lên
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
      GEN[s.mode](K, s, ci0 + k, len / SR, prog[0] + (prog[1] - prog[0]) * (n > 1 ? k / (n - 1) : 0), k === 0 ? spec : null,
        { last: last, final: !!spec.final, xout: !!spec.xout });
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

  root.LangEngine = { SR: SR, SOLF_HZ: SOLF_HZ, newSession: newSession, renderPiece: renderPiece, pieceLen: pieceLen, silence: silence };
})(window);
