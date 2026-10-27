/* =====================================================================
   Patient-monitor rendering: sweeping waveforms (ECG, ART, pleth, CO2)
   drawn in real time from the current physiological state, plus the
   trend chart.  The arterial pulse shape comes from the Pulse Lab
   transmission-line model, rescaled to the engine's MAP.
   ===================================================================== */
(function (global) {
  'use strict';
  const SPEED = 110;           // px per second sweep (~25 mm/s look)
  const COL = { ecg: '#39f27f', art: '#ff4f5e', spo2: '#33d6ff', co2: '#ffd23d', bis: '#c38bff', grid: '#0e141b' };

  /* ---------- Pulse Lab arterial shape (cached) ---------- */
  let waveCache = { key: '', radial: null, central: null, res: null };
  function arterialShape(st, pt, d) {
    // map engine state onto Pulse Lab inputs
    const svrS = st.tpr * 60;                                   // mmHg·s/mL
    const radius = Math.max(70, Math.min(140, 100 * Math.pow(1.10 / svrS, 0.25)));
    const gamma = Math.max(0.15, Math.min(0.75, 0.45 * Math.pow(st.tpr / st.tprBase, 0.6)));
    const key = [Math.round(st.hr), Math.round(st.sv), radius.toFixed(1), gamma.toFixed(2)].join('|');
    if (key === waveCache.key && waveCache.radial) return waveCache;
    const res = PWA.simulate({ hr: st.hr, sv: st.sv, radius, cAo: d.pwv, height: pt.height, gamma, diam: 2.4 + 0.012 * (pt.age - 20) });
    const meanR = res.radial.reduce((a, b) => a + b, 0) / res.radial.length;
    const meanC = res.p.reduce((a, b) => a + b, 0) / res.p.length;
    waveCache = { key, res, radial: res.radial.map(v => v - meanR), central: res.p.map(v => v - meanC), aix: res.m.AIx };
    return waveCache;
  }

  /* systolic/diastolic for any engine state (used for trends and forecasts; own cache so it never disturbs the live waveform) */
  const ppCache = new Map();
  function pressureRange(st, pt, d, ppK) {
    const svrS = st.tpr * 60;
    const radius = Math.max(70, Math.min(140, 100 * Math.pow(1.10 / svrS, 0.25)));
    const gamma = Math.max(0.15, Math.min(0.75, 0.45 * Math.pow(st.tpr / st.tprBase, 0.6)));
    const key = [Math.round(st.hr), Math.round(st.sv), Math.round(radius), (Math.round(gamma * 50) / 50).toFixed(2)].join('|');
    let r = ppCache.get(key);
    if (!r) {
      const res = PWA.simulate({ hr: Math.round(st.hr), sv: Math.round(st.sv), radius: Math.round(radius), cAo: d.pwv, height: pt.height, gamma: Math.round(gamma * 50) / 50, diam: 2.4 + 0.012 * (pt.age - 20) });
      const mean = res.radial.reduce((a, b) => a + b, 0) / res.radial.length;
      r = { up: Math.max(...res.radial) - mean, down: mean - Math.min(...res.radial) };
      if (ppCache.size > 4000) ppCache.clear();
      ppCache.set(key, r);
    }
    const k = ppK || 1;
    return { sys: st.map + k * r.up, dia: st.map - k * r.down };
  }

  /* ---------- sweep channel ---------- */
  class Channel {
    constructor(canvas, color, range) {
      this.c = canvas; this.color = color; this.range = range; this.x = 0; this.lastY = null; this.resize();
    }
    resize() {
      const r = this.c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      this.w = Math.max(50, r.width); this.h = Math.max(30, r.height);
      this.c.width = this.w * dpr; this.c.height = this.h * dpr;
      this.ctx = this.c.getContext('2d'); this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.ctx.fillStyle = '#020304'; this.ctx.fillRect(0, 0, this.w, this.h);
      this.x = 0; this.lastY = null;
    }
    push(values) {       // values: array of normalized 0..1 samples for the new pixels
      const ctx = this.ctx, h = this.h;
      values.forEach(v => {
        const y = v == null ? null : h - 6 - v * (h - 12);
        // erase ahead
        ctx.fillStyle = '#020304'; ctx.fillRect(this.x, 0, 14, h);
        if (y != null && this.lastY != null) {
          ctx.strokeStyle = this.color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(this.x - 1, this.lastY); ctx.lineTo(this.x, y); ctx.stroke();
        }
        this.lastY = y;
        this.x += 1;
        if (this.x >= this.w) { this.x = 0; this.lastY = null; }
      });
    }
    scale(label) {      // small range label at left top
      const ctx = this.ctx;
      ctx.fillStyle = '#020304'; ctx.fillRect(0, 0, 0, 0);
    }
  }

  /* ---------- waveform synthesis ---------- */
  const g = (x, m, s) => Math.exp(-((x - m) * (x - m)) / (2 * s * s));
  function ecgAt(ph) {      // ph in seconds since R-wave reference, beat length L
    return 0.12 * g(ph, -0.17, 0.025) - 0.08 * g(ph, -0.025, 0.008) + 1.0 * g(ph, 0, 0.011) - 0.22 * g(ph, 0.025, 0.010) + 0.25 * g(ph, 0.24, 0.045);
  }

  class Monitor {
    constructor(els) {
      this.ch = {
        ecg: new Channel(els.ecg, COL.ecg),
        art: new Channel(els.art, COL.art),
        pleth: new Channel(els.pleth, COL.spo2),
        co2: new Channel(els.co2, COL.co2)
      };
      this.beatT = 0; this.breathT = 0; this.carry = 0; this.onBeat = null;
      this.artScale = { lo: 0, hi: 160 };
      this.prevBeatLen = 0.8;
      window.addEventListener('resize', () => Object.values(this.ch).forEach(c => c.resize()));
    }
    frame(dtReal, st) {
      // st: { hr, map, tpr, tprBase, sv, rr, etco2, apnea, spo2, perf, pt, d, ventMode }
      this.carry += dtReal * SPEED;
      const n = Math.floor(this.carry); this.carry -= n;
      if (n <= 0) return;
      const next = arterialShape(st, st.pt, st.d);
      if (!this.shape) this.shape = next;
      const shape = this.shape;                                  // swap shapes only at a beat boundary (no mid-beat jumps)
      const L = 60 / Math.max(st.hr, 20), N = shape.radial.length;
      const ppScale = st.ppK || 1;                               // calibrated to the patient's own cuff pulse pressure
      const rMax = Math.max(...shape.radial), rMin = Math.min(...shape.radial), rSpan = Math.max(1, rMax - rMin);
      const dt = 1 / SPEED;
      const ecgV = [], artV = [], plV = [], coV = [];
      let sys = -Infinity, dia = Infinity;
      for (let i = 0; i < n; i++) {
        this.beatT += dt;
        if (this.beatT >= L) { this.beatT -= L; this.shape = next; if (this.onBeat) this.onBeat(); }
        // ECG: R wave at beatT = 0.2 s into the beat
        let ph = this.beatT - 0.2; if (ph > L / 2) ph -= L;
        ecgV.push(0.32 + 0.6 * ecgAt(ph));
        // arterial: pulse arrives 0.18 s after R wave
        let ap = (this.beatT - 0.2 - 0.18) / L; ap = ap - Math.floor(ap);
        const pa = st.map + shape.radial[Math.min(N - 1, Math.floor(ap * N))] * ppScale;
        sys = Math.max(sys, pa); dia = Math.min(dia, pa);
        artV.push((pa - this.artScale.lo) / (this.artScale.hi - this.artScale.lo));
        // pleth: smoother, later (0.28 s), amplitude falls with vasoconstriction
        let pp = (this.beatT - 0.2 - 0.30) / L; pp = pp - Math.floor(pp);
        const idx = Math.floor(pp * N);
        let sm = 0; for (let k = -24; k <= 24; k += 4) sm += shape.radial[(idx + k + N) % N]; sm /= 13;
        const amp = Math.max(0.15, Math.min(1, 1.2 * Math.pow(st.tprBase / st.tpr, 0.8))) * (st.spo2 < 60 ? 0.5 : 1);
        plV.push(0.5 + 0.42 * amp * (sm - (rMax + rMin) / 2) / rSpan * 2);
        // capnogram
        if (st.rr > 0) {
          const B = 60 / st.rr; this.breathT += dt; if (this.breathT >= B) this.breathT -= B;
          const x = this.breathT / B, ex = 0.35;   // inspiration first 1/3
          let v = 0;
          if (x > ex) { const t = (x - ex) / (1 - ex); v = t < 0.08 ? t / 0.08 : 1 + 0.06 * (t - 0.08); v = Math.min(v, 1.06); if (t > 0.97) v *= (1 - t) / 0.03; }
          coV.push(Math.max(0, v * st.etco2) / 60);
        } else { this.breathT = 0; coV.push(0); }
      }
      this.ch.ecg.push(ecgV);
      this.ch.art.push(artV);
      this.ch.pleth.push(plV);
      this.ch.co2.push(coV);
      this.lastShape = this.shape;
    }
    // auto-range the arterial channel on the current pressures
    setArtRange(sys, dia) {
      const hi = Math.max(120, Math.ceil((sys + 20) / 20) * 20), lo = Math.max(0, Math.floor((dia - 20) / 20) * 20);
      if (hi !== this.artScale.hi || lo !== this.artScale.lo) this.artScale = { lo, hi };
    }
  }

  /* ---------- trend chart ---------- */
  function drawTrend(cv, data, opt) {
    const dpr = window.devicePixelRatio || 1, r = cv.getBoundingClientRect();
    if (!r.width) return;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, pl = 40, pr = 40, pt = 10, pb = 24, pw = W - pl - pr, ph = H - pt - pb;
    ctx.clearRect(0, 0, W, H);
    const tNow = opt.tNow, win = opt.window || Math.max(600, tNow + 60);
    const tEnd = Math.max(tNow + (opt.pred ? opt.predSpan : 60), win * 0.25 + tNow * 0);
    const t1 = Math.max(tNow + (opt.pred ? opt.predSpan : 60), opt.window ? 0 : tNow + 60);
    const tMax = opt.window ? Math.max(tNow, opt.window) + (opt.pred ? opt.predSpan : 0) : tNow + (opt.pred ? opt.predSpan : 60);
    const tMin = opt.window ? Math.max(0, tMax - opt.window - (opt.pred ? opt.predSpan : 0)) : 0;
    const X = t => pl + (t - tMin) / (tMax - tMin) * pw;
    const Y = (v, lo, hi) => pt + (1 - (v - lo) / (hi - lo)) * ph;
    // grid
    ctx.font = '10.5px -apple-system, Arial'; ctx.textBaseline = 'middle';
    for (let v = 0; v <= 200; v += 40) { const y = Y(v, 0, 200); ctx.strokeStyle = '#1a212b'; ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(pl + pw, y); ctx.stroke(); ctx.fillStyle = '#6c7586'; ctx.textAlign = 'right'; ctx.fillText(v, pl - 6, y); }
    ctx.textAlign = 'left'; [0, 25, 50, 75, 100].forEach(v => { ctx.fillStyle = '#7d6a9a'; ctx.fillText(v, pl + pw + 6, Y(v, 0, 100)); });
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = (tMax - tMin) > 2400 ? 600 : (tMax - tMin) > 1200 ? 300 : 120;
    for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) { const x = X(t); ctx.strokeStyle = '#141a22'; ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, pt + ph); ctx.stroke(); ctx.fillStyle = '#6c7586'; ctx.fillText(Math.round(t / 60) + ' min', x, pt + ph + 6); }
    // MAP 65 line and BIS 40–60 band
    ctx.fillStyle = 'rgba(195,139,255,0.07)'; ctx.fillRect(pl, Y(60, 0, 100), pw, Y(40, 0, 100) - Y(60, 0, 100));
    ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,79,94,.55)'; ctx.beginPath(); ctx.moveTo(pl, Y(65, 0, 200)); ctx.lineTo(pl + pw, Y(65, 0, 200)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,79,94,.8)'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('MAP 65', pl + 4, Y(65, 0, 200) - 2);
    // now line
    ctx.strokeStyle = '#3a4556'; ctx.beginPath(); ctx.moveTo(X(tNow), pt); ctx.lineTo(X(tNow), pt + ph); ctx.stroke();
    const series = [['map', COL.art, 0, 200, 2.2], ['hr', COL.ecg, 0, 200, 1.6], ['bis', COL.bis, 0, 100, 1.6], ['spo2', COL.spo2, 0, 100, 1.6]];
    // systolic/diastolic band
    ctx.fillStyle = 'rgba(255,79,94,0.12)'; ctx.beginPath(); let started = false;
    data.forEach(d => { if (d.t < tMin) return; const x = X(d.t), y = Y(d.sys, 0, 200); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
    for (let i = data.length - 1; i >= 0; i--) { const d = data[i]; if (d.t < tMin) break; ctx.lineTo(X(d.t), Y(d.dia, 0, 200)); }
    if (started) { ctx.closePath(); ctx.fill(); }
    series.forEach(([k, c, lo, hi, lw]) => {
      ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.beginPath(); let s = false;
      data.forEach(d => { if (d.t < tMin) return; const x = X(d.t), y = Y(d[k], lo, hi); if (!s) { ctx.moveTo(x, y); s = true; } else ctx.lineTo(x, y); });
      ctx.stroke();
    });
    // forecast
    if (opt.pred) {
      if (opt.pred[0] && opt.pred[0].sys != null) {
        ctx.save(); ctx.fillStyle = 'rgba(255,79,94,0.10)'; ctx.beginPath();
        opt.pred.forEach((d, i) => { const x = X(d.t), y = Y(d.sys, 0, 200); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
        for (let i = opt.pred.length - 1; i >= 0; i--) ctx.lineTo(X(opt.pred[i].t), Y(opt.pred[i].dia, 0, 200));
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = COL.art; ctx.globalAlpha = 0.75; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
        ['sys', 'dia'].forEach(k => { ctx.beginPath(); opt.pred.forEach((d, i) => { const x = X(d.t), y = Y(d[k], 0, 200); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); });
        ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.fillStyle = COL.art; ctx.font = '10px -apple-system, Arial'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        const last = opt.pred[opt.pred.length - 1], xe = X(last.t) - 3;
        ctx.fillText('SBP ' + last.sys.toFixed(0), xe, Y(last.sys, 0, 200) - 8); ctx.fillText('DBP ' + last.dia.toFixed(0), xe, Y(last.dia, 0, 200) + 8);
        ctx.restore();
      }
      [['map', COL.art, 0, 200], ['hr', COL.ecg, 0, 200], ['bis', COL.bis, 0, 100], ['spo2', COL.spo2, 0, 100]].forEach(([k, c, lo, hi]) => {
        ctx.save(); ctx.strokeStyle = c; ctx.globalAlpha = 0.9; ctx.lineWidth = 1.8; ctx.setLineDash([5, 4]); ctx.beginPath();
        opt.pred.forEach((d, i) => { const x = X(d.t), y = Y(d[k], lo, hi); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
        if (opt.base) { ctx.globalAlpha = 0.3; ctx.setLineDash([2, 4]); ctx.beginPath(); opt.base.forEach((d, i) => { const x = X(d.t), y = Y(d[k], lo, hi); if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke(); }
        ctx.restore();
      });
      ctx.fillStyle = 'rgba(77,157,255,0.06)'; ctx.fillRect(X(tNow), pt, X(tNow + opt.predSpan) - X(tNow), ph);
      ctx.fillStyle = '#8fb8ff'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('forecast if given', X(tNow) + 6, pt + 2);
    }
    // drug / event markers
    (opt.marks || []).forEach(m => {
      if (m.t < tMin) return; const x = X(m.t);
      ctx.fillStyle = m.color; ctx.beginPath(); ctx.moveTo(x - 4, pt + ph); ctx.lineTo(x + 4, pt + ph); ctx.lineTo(x, pt + ph - 7); ctx.closePath(); ctx.fill();
    });
    ctx.lineWidth = 1;
  }

  global.MonitorUI = { Monitor, drawTrend, arterialShape, pressureRange, COL };
})(window);
