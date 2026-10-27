/* =====================================================================
   PWA / PWV Hemodynamic Engine
   ---------------------------------------------------------------------
   Model: the left ventricle is a flow source Q(t) ejecting into a
   uniform aortic "tube" (characteristic impedance Zc, wave speed c)
   that ends at an effective reflection site Lp away.  The site is a
   3-element Windkessel load (Zt + R || C).  Solved exactly in the
   frequency domain for a periodic beat:

     Pf(w) = Zc Q(w) / (1 - G(w) E(w))        forward wave
     Pb(w) = G(w) E(w) Pf(w)                  reflected wave
     P(w)  = Pf + Pb ,   Zin = Zc (1+GE)/(1-GE)
     E(w)  = exp(-i w dtp) * damping,  dtp = 2 Lp / c   (Nichols)
     G(w)  = (ZL - Zc)/(ZL + Zc)

   At w = 0, Zin = SVR exactly, so MAP = CO x SVR always holds.
   The arm (brachial/radial) pressure is obtained with a second
   transmission-line transfer function (pressure amplification).
   Units inside: pressure mmHg, flow mL/s, time s, impedance mmHg·s/mL.
   ===================================================================== */
(function (global) {
  'use strict';
  const RHO = 1060;          // blood density kg/m^3
  const MMHG = 133.322;      // Pa per mmHg
  const DYN = 1333.22;       // dyn/cm^2 per mmHg
  const N = 1024;            // samples per beat

  /* ---------- default physiology (healthy ~45 y man) ---------- */
  const DEFAULTS = {
    hr: 70,            // bpm
    sv: 72,            // mL
    etScale: 1.0,      // x Weissler LVET
    radius: 100,       // arteriolar radius, % of normal  -> SVR
    svrRef: 1.10,      // mmHg·s/mL at radius 100 %  (~1470 dyn·s·cm^-5)
    cAo: 7.5,          // intrinsic aortic (elastic) PWV, m/s at MAP 93
    cMus: 9.0,         // muscular-artery PWV, m/s
    gamma: 0.45,       // peripheral reflection coefficient (0-0.95)
    diam: 2.8,         // ascending aortic diameter, cm
    height: 175,       // cm
    lpScale: 1.0,      // reflection-site distance scale (proximal <-> distal)
    vEff: 450,         // effective arterial volume for compliance, mL
    lvedp: 8           // mmHg, for SEVR
  };

  /* ---------------- FFT (iterative radix-2) ---------------- */
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = 2 * Math.PI / len * (inverse ? 1 : -1);
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }

  /* ---------------- tiny complex helpers ---------------- */
  const C = (r, i) => ({ r, i });
  const add = (a, b) => C(a.r + b.r, a.i + b.i);
  const sub = (a, b) => C(a.r - b.r, a.i - b.i);
  const mul = (a, b) => C(a.r * b.r - a.i * b.i, a.r * b.i + a.i * b.r);
  const div = (a, b) => { const d = b.r * b.r + b.i * b.i; return C((a.r * b.r + a.i * b.i) / d, (a.i * b.r - a.r * b.i) / d); };
  const expi = (th, mag) => C(mag * Math.cos(th), mag * Math.sin(th));
  const abs = a => Math.hypot(a.r, a.i);

  /* ------------- derive operating parameters ------------- */
  function derive(p) {
    const T = 60 / p.hr;
    const etW = (413 - 1.7 * p.hr) / 1000;               // Weissler LVET (s)
    const ET = Math.min(Math.max(etW * p.etScale, 0.15), 0.6 * T);
    const svr = p.svrRef / Math.pow(p.radius / 100, 4);  // Poiseuille r^-4
    const qMean = p.sv / T;                              // mL/s
    const map = svr * qMean;                             // MAP = CO x SVR
    // passive pressure dependence of elastic-artery PWV (Nichols: passive changes)
    const cAoOp = Math.max(3, p.cAo * (1 + 0.006 * (map - 93)));
    const cMusOp = Math.max(4, p.cMus * (1 + 0.004 * (map - 93)));
    const A = Math.PI * Math.pow(p.diam / 2, 2);         // cm^2
    const zc = RHO * cAoOp / (A * 1e-4) / MMHG / 1e6;    // mmHg·s/mL
    const lp = 0.27 * p.height * p.lpScale;              // cm, effective reflection distance
    const fAo = 0.65;                                    // fraction of path that is elastic aorta
    const cPath = 1 / (fAo / cAoOp + (1 - fAo) / cMusOp);
    const dtp = 2 * (lp / 100) / cPath;                  // round-trip time (s)
    const rhoc2 = RHO * cAoOp * cAoOp / MMHG;            // mmHg
    const cTot = p.vEff * Math.pow(p.diam / 2.8, 2) / rhoc2;   // compliance ~ volume / (rho c^2)  (Bramwell-Hill)                         // total compliance mL/mmHg
    const cTube = A * lp / (RHO * cPath * cPath / MMHG);
    const cTerm = Math.max(0.15 * cTot, cTot - cTube);
    const g = Math.min(Math.max(p.gamma, 0.01), 0.95);
    // terminal load: nominal impedance step Zt = 2.6 Zc (high-frequency mismatch), then the
    // whole reflection coefficient is scaled by kRefl = Γ / 0.5 at every harmonic (w > 0).
    // Γ therefore behaves as "reflection magnitude" (muscular tone / impedance mismatch).
    let zt = 2.6 * zc;
    if (zt > 0.8 * svr) zt = 0.8 * svr;
    const kRefl = g / 0.5;
    const rTerm = svr - zt;
    // arm path for brachial / radial
    const armLen = 0.42 * p.height;                      // cm aortic root -> radial
    const brachX = 0.62 * armLen;
    const gArm = 0.45;                                   // fixed upper-limb reflection, like a generalized transfer function   // upper-limb terminal reflection (mostly fixed, like a generalized transfer function)
    const ep = 2 * rhoc2;                                // Peterson modulus ~ 2 rho c^2 (mmHg)
    return { T, ET, svr, qMean, map, cAoOp, cMusOp, A, zc, lp, cPath, dtp, cTot, cTube, cTerm, g, kRefl, zt, rTerm, armLen, brachX, gArm, ep };
  }

  /* ------------- ejection flow waveform ------------- */
  function flowWave(p, d) {
    const dt = d.T / N, q = new Float64Array(N);
    let s = 0;
    for (let k = 0; k < N; k++) {
      const t = k * dt;
      if (t < d.ET) { const x = t / d.ET; q[k] = Math.pow(x, 0.75) * Math.pow(1 - x, 1.55); s += q[k] * dt; }
    }
    for (let k = 0; k < N; k++) q[k] *= p.sv / s;
    return q;
  }

  /* ---------------- main solver ---------------- */
  function simulate(input) {
    const p = Object.assign({}, DEFAULTS, input);
    const d = derive(p);
    const dt = d.T / N;
    const q = flowWave(p, d);
    const qr = Float64Array.from(q), qi = new Float64Array(N);
    fft(qr, qi, false);

    const Pr = new Float64Array(N), Pi = new Float64Array(N);
    const Fr = new Float64Array(N), Fi = new Float64Array(N);
    const Br = new Float64Array(N), Bi = new Float64Array(N);
    const Rr = new Float64Array(N), Ri = new Float64Array(N);   // radial
    const Hr = new Float64Array(N), Hi = new Float64Array(N);   // brachial
    const zin = [];
    const damp = 0.055;   // attenuation per Hz per round trip (viscoelastic loss)
    const tArm = (d.armLen / 100) / d.cMusOp, tBr = (d.brachX / 100) / d.cMusOp;

    for (let k = 0; k <= N / 2; k++) {
      const f = k / d.T, w = 2 * Math.PI * f;
      const Q = C(qr[k], qi[k]);
      const ZL = add(C(d.zt, 0), div(C(d.rTerm, 0), C(1, w * d.rTerm * d.cTerm)));
      let G = div(sub(ZL, C(d.zc, 0)), add(ZL, C(d.zc, 0)));
      G = C(G.r * d.kRefl, G.i * d.kRefl);
      const gm = abs(G); if (gm > 0.97) G = C(G.r * 0.97 / gm, G.i * 0.97 / gm);
      const E = expi(-w * d.dtp, Math.exp(-damp * f));
      const GE = mul(G, E);
      const one = C(1, 0);
      const Pf = div(mul(C(d.zc, 0), Q), sub(one, GE));
      const Pb = mul(GE, Pf);
      const P = add(Pf, Pb);
      zin.push({ f, mod: abs(div(mul(C(d.zc, 0), add(one, GE)), sub(one, GE))) });
      // arm transmission line: P(x)/P(0) = (e^{-iwx/c} + G e^{-iw(2L-x)/c}) / (1 + G e^{-2iwL/c})
      const att = Math.exp(-0.035 * f);
      const den = add(one, mul(C(d.gArm, 0), expi(-2 * w * tArm, att)));
      const HR = div(add(expi(-w * tArm, Math.sqrt(att)), mul(C(d.gArm, 0), expi(-w * tArm, Math.sqrt(att)))), den);
      const HB = div(add(expi(-w * tBr, Math.pow(att, tBr / tArm / 2)), mul(C(d.gArm, 0), expi(-w * (2 * tArm - tBr), Math.pow(att, (2 * tArm - tBr) / tArm / 2)))), den);
      const PR = mul(HR, P), PB = mul(HB, P);
      const put = (ar, ai, z) => { ar[k] = z.r; ai[k] = z.i; if (k > 0 && k < N / 2) { ar[N - k] = z.r; ai[N - k] = -z.i; } };
      put(Pr, Pi, P); put(Fr, Fi, Pf); put(Br, Bi, Pb); put(Rr, Ri, PR); put(Hr, Hi, PB);
    }
    // mean terms: MAP = SVR x Qmean exactly; split evenly into forward/backward
    Pr[0] = d.map * N; Fr[0] = d.map * N / 2; Br[0] = d.map * N / 2; Rr[0] = d.map * N; Hr[0] = d.map * N;
    Pi[0] = Fi[0] = Bi[0] = Ri[0] = Hi[0] = 0;
    [[Pr, Pi], [Fr, Fi], [Br, Bi], [Rr, Ri], [Hr, Hi]].forEach(([a, b]) => fft(a, b, true));

    const res = { params: p, d, N, dt, t: Array.from({ length: N }, (_, k) => k * dt),
      q: Array.from(q), p: Array.from(Pr), pf: Array.from(Fr), pb: Array.from(Br),
      radial: Array.from(Rr), brachial: Array.from(Hr), zin };
    res.m = indices(res);
    return res;
  }

  /* ---------------- clinical indices ---------------- */
  function indices(r) {
    const { d, dt, p, pf, pb, q, brachial, radial, params } = r;
    const n = p.length, iET = Math.min(n - 1, Math.round(d.ET / dt));
    const max = a => Math.max.apply(null, a), min = a => Math.min.apply(null, a);
    let iPk = 0; for (let k = 0; k <= iET + 5; k++) if (p[k] > p[iPk]) iPk = k;
    const Ps = p[iPk], Pd = min(p), PP = Ps - Pd;
    const map = p.reduce((a, b) => a + b, 0) / n;
    const iTi = Math.min(n - 1, Math.round(d.dtp / dt));
    // P1 = highest pressure reached before the reflected wave arrives (first shoulder / inflection)
    // P2 = highest pressure after it arrives (reflected peak).  AIx = (P2 - P1)/PP is continuous
    // across the Type C -> A transition (equivalent to Ps - Pi when the inflection precedes the peak).
    let i1 = 0; for (let k = 0; k <= iTi; k++) if (p[k] > p[i1]) i1 = k;
    const iEnd = Math.min(n - 1, Math.max(iET, iTi + Math.round(0.08 / dt)));
    let i2 = iTi; for (let k = iTi; k <= iEnd; k++) if (p[k] > p[i2]) i2 = k;
    const P1 = p[i1], P2 = p[i2];
    const AP = P2 - P1;
    const type = AP <= 0 ? 'C' : AP / PP > 0.12 ? 'A' : 'B';
    const Pi = AP > 0 ? P1 : P2;
    const iInf = AP > 0 ? Math.max(i1, Math.min(iTi, i1)) : i2;
    const AIx = 100 * AP / PP;
    const AIx75 = AIx + 0.39 * (params.hr - 75);
    const dtr = AP > 0 ? Math.max(0, d.ET - d.dtp) : 0;
    const Ew = dtr * Math.max(AP, 0) * Math.PI / 2 * DYN;     // dyne·s/cm^2
    const rm = 100 * (max(pb) - min(pb)) / (max(pf) - min(pf));
    // systolic thirds
    const third = iET / 3; let a1 = 0, a2 = 0, a3 = 0;
    for (let k = 0; k < iET; k++) { const v = p[k] * dt; if (k < third) a1 += v; else if (k < 2 * third) a2 += v; else a3 += v; }
    const lsEs = a3 / (a1 + a2);
    let tti = 0, dpti = 0;
    for (let k = 0; k < n; k++) { if (k < iET) tti += p[k] * dt; else dpti += (p[k] - params.lvedp) * dt; }
    const sevr = 100 * dpti / tti;
    // stroke volume split (Eq. 13): SVm = SVf - SVr
    let svf = 0, svr2 = 0;
    for (let k = 0; k < iET; k++) { svf += (pf[k] - pf[0]) / d.zc * dt; svr2 += (pb[k] - pb[0]) / d.zc * dt; }
    const bS = max(brachial), bD = min(brachial), rS = max(radial), rD = min(radial);
    const ppa = (bS - bD) / PP;
    const co = params.sv * params.hr / 1000;     // L/min
    return {
      Ps, Pd, PP, map, Pi, P1, P2, i1, i2, AP, AIx, AIx75, type, iPk, iInf, iET, iTi,
      dtp: d.dtp * 1000, dtr: dtr * 1000, Ew, rm, lsEs, tti, dpti, sevr,
      svf, svrefl: svr2, bSBP: bS, bDBP: bD, bPP: bS - bD, rSBP: rS, rDBP: rD,
      ppa, co, svrDyn: d.svr * DYN, svrWU: d.svr * 60, zcDyn: d.zc * DYN,
      ctot: d.cTot, svpp: params.sv / PP, tau: d.svr * d.cTot, lp: d.lp,
      cAoOp: d.cAoOp, cMusOp: d.cMusOp, cPath: d.cPath, ep: d.ep, et: d.ET * 1000,
      peakQ: max(q), fwdAmp: max(pf) - min(pf), bwdAmp: max(pb) - min(pb), cMAP: d.map
    };
  }

  /* ---------------- presets ---------------- */
  const PRESETS = {
    'Default adult (45 y)': {},
    'Young adult (20 y)':  { hr: 64, sv: 78, cAo: 5.2, cMus: 9.0, gamma: 0.42, diam: 2.4, lpScale: 1.3, radius: 102 },
    'Middle-aged (45 y)':  { hr: 70, sv: 72, cAo: 7.5, cMus: 9.0, gamma: 0.45, diam: 2.8, lpScale: 1.0 },
    'Older adult (70 y)':  { hr: 68, sv: 70, cAo: 9.5, cMus: 9.0, gamma: 0.58, diam: 3.4, lpScale: 0.95, radius: 97 },
    'Isolated systolic HTN (80 y)': { hr: 66, sv: 70, cAo: 11.5, cMus: 9.0, gamma: 0.62, diam: 3.8, lpScale: 0.9, radius: 95 },
    'Essential HTN (55 y)': { hr: 74, sv: 74, cAo: 8.8, cMus: 9.5, gamma: 0.55, diam: 3.0, lpScale: 0.95, radius: 97 },
    'Short stature (155 cm)': { height: 155 },
    'Tall stature (195 cm)':  { height: 195 }
  };

  /* -------- drug effects (multiplicative / additive on physiology) --------
     Based on Nichols & Singh 2002 and Townsend et al. 2015 (Table 1):
     vasodilators act on muscular arteries (lower muscular PWV & reflection),
     arteriolar dilators raise arteriolar radius (lower SVR), beta-blockers
     slow HR (lengthening ejection, raising AIx) with little vasodilation.   */
  const DRUGS = {
    acei:   { label: 'ACE inhibitor', short: 'ACEi', fx: { radius: 1.025, cMus: 0.88, gamma: 0.82, cAo: 0.97 } },
    arb:    { label: 'Angiotensin receptor blocker', short: 'ARB', fx: { radius: 1.025, cMus: 0.89, gamma: 0.83, cAo: 0.97 } },
    ccb:    { label: 'Calcium-channel blocker (DHP)', short: 'CCB', fx: { radius: 1.03, cMus: 0.90, gamma: 0.85, hrAdd: 3 } },
    bb:     { label: 'Beta-blocker (atenolol)', short: 'β-blocker', fx: { hrAdd: -14, svAdd: 6, radius: 0.99 } },
    diur:   { label: 'Thiazide diuretic', short: 'Diuretic', fx: { svAdd: -2, radius: 1.006, gamma: 0.95 } },
    nitrate:{ label: 'Organic nitrate', short: 'Nitrate', fx: { cMus: 0.76, gamma: 0.55, radius: 1.004, svAdd: -2 } },
    pe:     { label: 'Vasoconstrictor (phenylephrine)', short: 'Vasoconstrictor', fx: { radius: 0.96, cMus: 1.10, gamma: 1.18 } }
  };

  function applyDrugs(base, active) {
    const p = Object.assign({}, base);
    (active || []).forEach(key => {
      const fx = DRUGS[key].fx;
      if (fx.radius) p.radius *= fx.radius;
      if (fx.cMus) p.cMus *= fx.cMus;
      if (fx.cAo) p.cAo *= fx.cAo;
      if (fx.gamma) p.gamma *= fx.gamma;
      if (fx.hrAdd) p.hr += fx.hrAdd;
      if (fx.svAdd) p.sv += fx.svAdd;
    });
    p.gamma = Math.min(0.95, p.gamma);
    return p;
  }

  global.PWA = { simulate, DEFAULTS, PRESETS, DRUGS, applyDrugs, DYN };
  if (typeof module !== 'undefined') module.exports = global.PWA;
})(typeof window !== 'undefined' ? window : globalThis);
