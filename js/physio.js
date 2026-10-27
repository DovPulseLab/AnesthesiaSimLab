/* =====================================================================
   Anesthesia physiology engine — implements the Model Specification (Beta),
   model set A.  Internal time step 1 s.  Every constant carries its source
   and evidence grade (A = published adult population model, B = published
   structure/effect size, C = calibrated assumption).
   ===================================================================== */
(function (global) {
  'use strict';
  const MIN = 60;                      // s per min
  const fsig = (x, c50, g) => (x <= 0 ? 0 : Math.pow(x, g) / (Math.pow(c50, g) + Math.pow(x, g)));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  /* ------------------------------------------------------------------ */
  /* Drug catalogue (doses, units, ISO 26825 label colour class, grade)  */
  /* ------------------------------------------------------------------ */
  const DRUGS = {
    propofol: { name: 'Propofol', cls: 'induction', unit: 'mg', conc: '10 mg/mL', bolus: [20, 50, 100, 150, 200], perKg: 'mg/kg', inf: { unit: 'mcg/kg/min', steps: [0, 50, 75, 100, 125, 150, 200] }, grade: 'A', src: 'Schnider 1999 PK · Bouillon 2004 BIS/TOL · Kern 2004 LOC · Su 2023 hemodynamics' },
    remifentanil: { name: 'Remifentanil', cls: 'opioid', unit: 'mcg', conc: '50 mcg/mL', bolus: [10, 20, 50, 100], inf: { unit: 'mcg/kg/min', steps: [0, 0.05, 0.1, 0.15, 0.2, 0.3] }, grade: 'A', src: 'Minto 1997 PK · Bouillon 2004 · Su 2023 hemodynamics' },
    rocuronium: { name: 'Rocuronium', cls: 'nmb', unit: 'mg', conc: '10 mg/mL', bolus: [10, 20, 40, 50, 70], grade: 'A', src: 'Wierda 1991 PK · Masui 2018 PD' },
    sugammadex: { name: 'Sugammadex', cls: 'reversal', unit: 'mg', conc: '100 mg/mL', bolus: [140, 200, 280, 400], grade: 'B', src: '1:1 encapsulation of rocuronium (mass ratio 3.57:1); onset kinetics assumed (grade C)' },
    phenylephrine: { name: 'Phenylephrine', cls: 'vasopressor', unit: 'mcg', conc: '100 mcg/mL', bolus: [40, 80, 100, 160], inf: { unit: 'mcg/min', steps: [0, 20, 40, 60, 80, 100] }, grade: 'C', src: 'Calibrated to published effect sizes; α1 effect on vascular resistance' },
    ephedrine: { name: 'Ephedrine', cls: 'vasopressor', unit: 'mg', conc: '5 mg/mL', bolus: [5, 10, 15], grade: 'C', src: 'Calibrated to published effect sizes; mixed α/β' },
    norepinephrine: { name: 'Norepinephrine', cls: 'vasopressor', unit: 'mcg', conc: '16 mcg/mL', bolus: [4, 8, 16], inf: { unit: 'mcg/kg/min', steps: [0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15] }, grade: 'B', src: 'Li 2024 PK (grade A) · Li 2025 PD abstract (grade B)' },
    glycopyrrolate: { name: 'Glycopyrrolate', cls: 'anticholinergic', unit: 'mg', conc: '0.2 mg/mL', bolus: [0.1, 0.2, 0.4], grade: 'C', src: 'Calibrated: HR rise in 1–2 min, lasting ~30 min' },
    esmolol: { name: 'Esmolol', cls: 'hypotensive', unit: 'mg', conc: '10 mg/mL', bolus: [10, 20, 30, 50], grade: 'C', src: 'Calibrated: HR fall in 1–2 min, t½ ≈ 9 min' }
  };
  // ISO 26825 user-applied syringe label colours
  const CLASS_INFO = {
    induction: { label: 'Induction agent', color: '#f7d417' },
    opioid: { label: 'Opioid', color: '#3aa0ff' },
    nmb: { label: 'Neuromuscular blocker', color: '#ff4b3e' },
    reversal: { label: 'NMB reversal', color: '#ff4b3e', stripe: true },
    vasopressor: { label: 'Vasopressor', color: '#b77cff' },
    anticholinergic: { label: 'Anticholinergic', color: '#3ecf6e' },
    hypotensive: { label: 'Hypotensive / β-blocker', color: '#b77cff', stripe: true }
  };

  /* ------------------------------------------------------------------ */
  /* Patient-derived quantities (Spec §2)                               */
  /* ------------------------------------------------------------------ */
  function derive(pt) {
    const W = pt.weight, Hc = pt.height, H = Hc / 100, M = pt.sex === 'M';
    const bmi = W / (H * H);
    const bsa = Math.sqrt(Hc * W / 3600);                                     // Mosteller
    const lbm = M ? 1.1 * W - 128 * Math.pow(W / Hc, 2) : 1.07 * W - 148 * Math.pow(W / Hc, 2); // James
    const ibw = (M ? 50 : 45.5) + 0.91 * (Hc - 152.4);                        // Devine
    const bv = M ? 0.3669 * H * H * H + 0.03219 * W + 0.6041 : 0.3561 * H * H * H + 0.03308 * W + 0.1833; // Nadler, L
    const frc = M ? 2.34 * H + 0.009 * pt.age - 1.09 : 2.24 * H + 0.001 * pt.age - 1.00; // ERS 1993, L
    const vo2Awake = 10 * Math.pow(W, 0.75);                                  // Brody, mL/min
    const map0 = pt.dbp + (pt.sbp - pt.dbp) / 3;
    const sv0 = 45 * bsa;                                                     // grade B
    const pwvAge = pt.age < 30 ? 6.2 : pt.age < 40 ? 6.5 : pt.age < 50 ? 7.2 : pt.age < 60 ? 8.3 : pt.age < 70 ? 10.3 : 10.9; // RVASC 2010
    return { W, Hc, H, M, bmi, bsa, lbm, ibw, bv, frc, frcGA: 0.8 * 0.9 * frc, vo2Awake, map0, sv0, pwv: pt.pwv || pwvAge, vd: 2.2 * ibw / 1000 };
  }

  /* ------------------------------------------------------------------ */
  /* Pharmacokinetic parameter sets (per minute)                        */
  /* ------------------------------------------------------------------ */
  function pkParams(pt, d) {
    const age = pt.age, W = d.W, lbm = d.lbm, Hc = d.Hc;
    const mk = (v1, v2, v3, cl1, q2, q3, ke0) => ({ v1, k10: cl1 / v1, k12: q2 / v1, k21: v2 ? q2 / v2 : 0, k13: q3 / v1, k31: v3 ? q3 / v3 : 0, ke0 });
    return {
      // Schnider 1999 (grade A); amounts mg, conc mg/L = µg/mL
      propofol: mk(4.27, 18.9 - 0.391 * (age - 53), 238,
        1.89 + 0.0456 * (W - 77) - 0.0681 * (lbm - 59) + 0.0264 * (Hc - 177),
        1.29 - 0.024 * (age - 53), 0.836, 0.456),
      // Minto 1997 (grade A); amounts µg, conc µg/L = ng/mL
      remifentanil: mk(5.1 - 0.0201 * (age - 40) + 0.072 * (lbm - 55),
        9.82 - 0.0811 * (age - 40) + 0.108 * (lbm - 55), 5.42,
        2.6 - 0.0162 * (age - 40) + 0.0191 * (lbm - 55),
        2.05 - 0.0301 * (age - 40), 0.076 - 0.00113 * (age - 40), 0.595 - 0.007 * (age - 40)),
      // Wierda 1991 PK with Masui 2018 ke0 (grade A); amounts mg, conc mg/L = µg/mL
      rocuronium: (() => { const v1 = 0.044 * W, cl2 = 0.21 * v1, cl3 = 0.028 * v1; return mk(v1, cl2 / 0.13, cl3 / 0.01, 0.1 * v1, cl2, cl3, 0.1 - 0.00138 * (age - 50)); })(),
      // Li 2024 healthy volunteers (grade A); amounts µg, conc µg/L = ng/mL; endogenous production
      norepinephrine: Object.assign(mk(2.4 * W / 70, 3.6 * W / 70, 0, 2.1 * Math.exp(-0.00377 * (age - 35)) * Math.pow(W / 70, 0.75), 0.6 * Math.pow(W / 70, 0.75), 0, 0.7), { endo: 0.498 * Math.pow(W / 70, 0.75) }),
      // Grade C one-compartment kinetics with effect-site delay
      phenylephrine: mk(0.5 * W, 0, 0, 0.25 * 0.5 * W, 0, 0, 0.8),   // µg, µg/L; effective t½ ≈ 2.8 min
      ephedrine: mk(3 * W, 0, 0, 0.05 * 3 * W, 0, 0, 0.5),           // mg, mg/L; t½ ≈ 14 min
      glycopyrrolate: mk(0.4 * W, 0, 0, Math.LN2 / 60 * 0.4 * W, 0, 0, 0.3), // mg → µg/L via ×1000 in PD
      esmolol: mk(3.4 * W, 0, 0, Math.LN2 / 9 * 3.4 * W, 0, 0, 0.5)  // mg, mg/L; t½ 9 min
    };
  }

  /* ------------------------------------------------------------------ */
  /* Engine                                                              */
  /* ------------------------------------------------------------------ */
  class Engine {
    constructor(patient) {
      this.pt = Object.assign({ age: 45, sex: 'M', height: 175, weight: 75, sbp: 125, dbp: 78, hr: 72, spo2: 98, hb: 14, anxiety: 1, asa: 1 }, patient);
      this.d = derive(this.pt);
      this.pk = pkParams(this.pt, this.d);
      this.t = 0;
      // drug states: [A1, A2, A3, Ce]; infusion rates (amount/min)
      this.drug = {};
      Object.keys(this.pk).forEach(k => { this.drug[k] = { a: [0, 0, 0], ce: 0, inf: 0, bolusQ: [], given: 0 }; });
      const ne = this.pk.norepinephrine, neCss = ne.endo / (ne.k10 * ne.v1);
      this.drug.norepinephrine.a = [neCss * ne.v1, neCss * ne.v1 * ne.k12 / ne.k21, 0]; this.drug.norepinephrine.ce = neCss;
      this.neBase = neCss;
      this.sugBound = 0;               // rocuronium encapsulated, mg (pending)
      this.sugQueue = 0;
      // Su 2023 hemodynamics (grade A), baselines from the patient (as in PAS)
      const H = { kout: 0.072, fb: -0.661, hrsv: 0.312, kltde: 0.067, ltdeSv: 0.0899 * this.pt.anxiety, ltdeHr: 0.121 * this.pt.anxiety };
      H.hrBase = this.pt.hr / (1 + H.ltdeHr);
      H.svBase = this.d.sv0 / (1 + H.ltdeSv);
      H.tprBase = this.d.map0 / (this.pt.hr * this.d.sv0);
      H.abaseHr = this.pt.hr; H.abaseSv = this.d.sv0; H.baseMap = this.d.map0;
      this.H = H;
      this.hx = { tpr: H.tprBase, sv: H.svBase, hr: H.hrBase, lsv: H.svBase * H.ltdeSv, lhr: H.hrBase * H.ltdeHr };
      this.anesStarted = false;
      this.mapSlow = this.d.map0;   // baroreflex set point (low-pass)
      this.lastMap = this.d.map0;
      // stimulation
      this.stim = { level: 0, sources: {} }; this.pneumo = 0; this.surgery = false;
      // airway / ventilation
      this.air = { device: 'none', fio2: 0.21, bagging: false, vent: { vt: 500, rr: 12, peep: 5, fio2: 1.0 }, intubating: 0, intubated: false, poorConditions: false };
      this.resp = { paco2: 40, etco2: 36, rr: 14, va: 0, apnea: false, fio2: 0.21 };
      this.o2init();
      this.out = {};
      this.events = [];
      this.compute(true);
    }

    /* --------------- oxygen (Spec §6) --------------- */
    sat(p) { p = Math.max(p, 0.1); return 1 / (23400 / (p * p * p + 150 * p) + 1); }   // Severinghaus 1979
    aaGrad() {                                                                       // Mellemgaard + preop calibration + atelectasis (C)
      const ga = this.anesStarted ? (this.air.device === 'ett' ? Math.max(0, 10 - 1.25 * this.air.vent.peep) : 8) : 0;
      return this.aaBase + ga;
    }
    o2init() {
      // choose A–a gradient so that room air reproduces the preop SpO2 (keeps Mellemgaard as the floor)
      const target = clamp(this.pt.spo2 / 100, 0.85, 0.995);
      let lo = 0, hi = 60;
      const pa = 0.21 * 713 - 40 / 0.8;
      for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (this.sat(pa - m) > target) lo = m; else hi = m; }
      this.aaBase = Math.max(2.5 + 0.21 * this.pt.age, lo);
      this.fao2 = 0.21 - (this.d.vo2Awake / 1000) / (0.863 * this.d.vo2Awake * 0.8 / 40);   // steady state on air
      this.o2store = this.storeFromF(this.fao2);
      this.spo2Lag = this.sat(this.fao2 * 713 - this.aaBase);
    }
    storeFromF(f) {
      const pao2 = Math.max(f * 713 - this.aaGradSafe(), 5);
      const s = this.sat(pao2);
      return this.frcNow() * 1000 * f + this.d.bv * 10 * (1.34 * this.pt.hb * s + 0.003 * pao2);
    }
    aaGradSafe() { return this.aaBase === undefined ? 10 : this.aaGrad(); }
    frcNow() { return this.anesStarted ? this.d.frcGA : this.d.frc * 0.9; }   // supine awake −10 %; GA a further −20 % (Hedenstierna, grade B)
    fFromStore(store) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (this.storeFromF(m) < store) lo = m; else hi = m; }
      return (lo + hi) / 2;
    }

    /* --------------- actions --------------- */
    bolus(key, amount, over = 10) {
      if (key === 'sugammadex') { this.sugQueue += amount; this.drug.sugammadex = this.drug.sugammadex || { given: 0 }; this.drug.sugammadex.given = (this.drug.sugammadex.given || 0) + amount; this.log('drug', `Sugammadex ${amount} mg`); return; }
      const dg = this.drug[key];
      dg.bolusQ.push({ rate: amount / over, left: over });
      dg.given += amount;
      this.log('drug', `${DRUGS[key].name} ${fmtDose(amount)} ${DRUGS[key].unit}`);
    }
    setInfusion(key, rate) {   // rate in display units
      const dg = this.drug[key], W = this.d.W;
      const u = DRUGS[key].inf.unit;
      let perMin = rate;
      if (u === 'mcg/kg/min') perMin = rate * W;                       // µg/min
      if (key === 'propofol') perMin = rate * W / 1000;                 // mg/min
      dg.inf = perMin; dg.infDisplay = rate;
      this.log('infusion', `${DRUGS[key].name} infusion ${rate} ${u}`);
    }
    event(kind) {
      const a = this.air;
      const o = this.out;
      switch (kind) {
        case 'preox': a.device = 'mask'; a.fio2 = 1.0; this.log('airway', 'Face mask, FiO₂ 1.0 (preoxygenation)'); break;
        case 'roomair': a.device = 'none'; a.fio2 = 0.21; a.bagging = false; this.log('airway', 'Mask off, room air'); break;
        case 'bag': if (a.device === 'none') { a.device = 'mask'; a.fio2 = 1.0; } a.bagging = !a.bagging; this.log('airway', a.bagging ? 'Bag-mask ventilation started' : 'Bag-mask ventilation stopped'); break;
        case 'laryngoscopy':
          if (a.intubated) return 'Already intubated';
          a.intubating = 40; a.bagging = false;
          a.poorConditions = o.t1 > 25 || o.ploc < 0.5;
          this.addStim('laryngoscopy', 1.0, 60, 150);
          this.log('airway', a.poorConditions ? (o.ploc < 0.5 ? 'Laryngoscopy attempted in a responsive patient — gagging, unable to intubate' : `Laryngoscopy: patient not fully paralysed (T1 ${o.t1.toFixed(0)} %) — cords moving, coughing`) : 'Laryngoscopy and intubation');
          if (o.ploc < 0.5) { a.intubating = 0; }
          else if (a.poorConditions) { a.intubating = 75; this.addStim('cough', 1.0, 75, 180); }
          return null;
        case 'extubate': a.intubated = false; a.device = 'mask'; a.fio2 = 1.0; this.addStim('extubation', 0.7, 30, 90); this.log('airway', 'Extubated to face mask'); break;
        case 'incision': this.surgery = true; this.addStim('incision', 0.9, 90, 300); this.log('surgery', 'Skin incision'); break;
        case 'pneumo_on': this.pneumo = 1; this.log('surgery', 'Pneumoperitoneum insufflated'); break;
        case 'pneumo_off': this.pneumo = 0; this.log('surgery', 'Pneumoperitoneum released'); break;
        case 'surgery_end': this.surgery = false; this.pneumo = 0; this.log('surgery', 'End of surgery, dressings'); break;
      }
      return null;
    }
    setVent(v) { Object.assign(this.air.vent, v); this.log('vent', `Ventilator VT ${this.air.vent.vt} mL, RR ${this.air.vent.rr}, PEEP ${this.air.vent.peep}, FiO₂ ${this.air.vent.fio2}`); }
    addStim(name, amp, holdS, decayS) { this.stim.sources[name] = { amp, hold: holdS, decay: decayS, t: 0 }; }
    log(type, text) { this.events.push({ t: this.t, type, text }); }

    /* --------------- one 1-s step --------------- */
    step() {
      const dt = 1, P = this.pk;
      // --- PK, RK-free exact-enough sub-stepping (rates ≤ 2/min → dt/60 small)
      Object.keys(P).forEach(k => {
        const p = P[k], g = this.drug[k];
        let u = g.inf;
        g.bolusQ = g.bolusQ.filter(b => { u += b.rate * MIN; b.left -= dt; return b.left > 0; });
        if (k === 'norepinephrine') u += p.endo;
        const h = dt / MIN / 4;
        for (let s = 0; s < 4; s++) {
          const [a1, a2, a3] = g.a;
          const d1 = u - (p.k10 + p.k12 + p.k13) * a1 + p.k21 * a2 + p.k31 * a3;
          g.a[0] = Math.max(0, a1 + h * d1);
          g.a[1] = Math.max(0, a2 + h * (p.k12 * a1 - p.k21 * a2));
          g.a[2] = Math.max(0, a3 + h * (p.k13 * a1 - p.k31 * a3));
          const cp = g.a[0] / p.v1;
          g.ce += h * p.ke0 * (cp - g.ce);
        }
      });
      // --- sugammadex: encapsulates rocuronium (1:1 molar, 3.57 mg per mg roc), τ ≈ 40 s (grade C onset)
      if (this.sugQueue > 0) {
        const roc = this.drug.rocuronium, p = P.rocuronium;
        const capacity = this.sugQueue / 3.57;
        const totalRoc = roc.a[0] + roc.a[1] + roc.a[2] + roc.ce * p.v1 * 0.05;
        const bind = Math.min(capacity, totalRoc) * (dt / 40);
        if (totalRoc > 1e-6 && bind > 0) {
          const f = Math.max(0, 1 - bind / totalRoc);
          roc.a = roc.a.map(x => x * f); roc.ce *= f;
          this.sugQueue -= bind * 3.57;
        }
        if (totalRoc < 1e-4 || this.sugQueue < 1e-3) this.sugQueue = Math.max(0, this.sugQueue - 0.5);
      }
      // --- stimulation sources
      let lvl = 0;
      Object.entries(this.stim.sources).forEach(([k, s]) => {
        s.t += dt;
        const v = s.t <= s.hold ? s.amp : s.amp * Math.exp(-(s.t - s.hold) / s.decay);
        if (v < 0.01 && s.t > s.hold) delete this.stim.sources[k]; else lvl = Math.max(lvl, v);
      });
      if (this.surgery) lvl = Math.max(lvl, 0.45);
      this.stim.level = lvl;
      // --- airway timers
      if (this.air.intubating > 0) {
        this.air.intubating -= dt;
        if (this.air.intubating <= 0) {
          if (this.out.ploc >= 0.5) { this.air.intubated = true; this.air.device = 'ett'; this.log('airway', 'Endotracheal tube placed — ventilator connected'); }
          else this.log('airway', 'Intubation abandoned — patient responsive');
        }
      }
      if (!this.anesStarted && this.drug.propofol.a[0] > 0.5) { this.anesStarted = true; }
      this.hemoStep(dt);
      this.respStep(dt);
      this.t += dt;
      this.compute(false);
    }

    /* --------------- hemodynamics (Spec §5) --------------- */
    concs() {
      const P = this.pk, g = this.drug;
      const c = {};
      Object.keys(P).forEach(k => { c[k] = { cp: g[k].a[0] / P[k].v1, ce: g[k].ce }; });
      return c;
    }
    hemoStep(dt) {
      const H = this.H, x = this.hx, c = this.concs();
      const cp = c.propofol.cp, cr = c.remifentanil.cp;
      const eP_tpr = clamp((-0.778 + fsig(cr, 4.59, 1)) * fsig(cp, 3.21, 1.83), -0.999, 0.999);
      const eP_sv = clamp(-0.154 * Math.exp(0.0333 * (this.pt.age - 35)) * fsig(cp, 0.44, 1), -0.999, 0.999);
      const eR_tpr = clamp(-fsig(cr, 4.59, 1), -0.999, 0.999);
      const eR_sv = clamp((0.0581 - 0.212 * fsig(cp, 0.44, 1)) * cr, -0.999, 0.999);
      const eR_hr = clamp((0.0327 - 0.119 * fsig(cp, 0.20, 1)) * cr, -0.999, 0.999);
      const rmap = Math.max(0.2, this.lastMap / H.baseMap);
      const fb = Math.pow(rmap, H.fb);
      const kout = H.kout / MIN, kin = { tpr: kout * H.tprBase, sv: kout * H.svBase, hr: kout * H.hrBase };
      x.tpr += dt * (kin.tpr * fb * (1 + eP_tpr) - kout * x.tpr * (1 - eR_tpr));
      x.sv += dt * (kin.sv * fb * (1 + eP_sv) - kout * x.sv * (1 - eR_sv));
      x.hr += dt * (kin.hr * fb - kout * x.hr * (1 - eR_hr));
      if (this.anesStarted) { const k = H.kltde / MIN; x.lsv -= dt * k * x.lsv; x.lhr -= dt * k * x.lhr; }
    }
    directEffects(c) {
      const ne = Math.max(0, (c.norepinephrine.ce - this.neBase) / 0.169);           // nmol/L above baseline
      const s = this.stim.level * (1 - (this.out.tol || 0));
      const pe = 1.0 * fsig(c.phenylephrine.ce, 6, 1);                              // grade C
      const eph = c.ephedrine.ce * 1000;                                            // µg/L
      const gly = c.glycopyrrolate.ce * 1000;                                       // µg/L
      const esm = c.esmolol.ce;                                                     // mg/L
      return {
        tpr: (1 + 0.0161 * ne) * (1 + pe) * (1 + 0.10 * fsig(eph, 60, 1)) * (1 + 0.30 * s) * (1 + 0.15 * this.pneumo) * (1 - 0.05 * fsig(esm, 0.3, 1)),
        sv: (1 + 0.0161 * ne) * (1 + 0.20 * fsig(eph, 60, 1)) * (1 - 0.12 * fsig(esm, 0.15, 1)) * (1 - 0.06 * this.pneumo),
        hr: (1 + 0.0052 * ne) * (1 + 0.30 * fsig(eph, 60, 1)) * (1 + 0.45 * fsig(gly, 5, 1)) * (1 - 0.35 * fsig(esm, 0.15, 1)) * (1 + 0.30 * s),
        stim: s
      };
    }

    /* --------------- respiration (Spec §6) --------------- */
    respStep(dt) {
      const a = this.air, o = this.out, d = this.d;
      const vo2 = d.vo2Awake * (this.anesStarted && o.ploc > 0.5 ? 0.85 : 1) * (1 + 0.15 * this.stim.level);
      const vco2 = 0.8 * vo2;
      // alveolar ventilation (L/min)
      let va = 0, fio2 = a.device === 'ett' ? a.vent.fio2 : a.fio2, rr = 0, apnea = false;
      const va0 = 0.863 * vco2 / 40;    // L/min alveolar ventilation that gives PaCO2 40 (alveolar ventilation equation)
      if (a.device === 'ett' && a.intubated) { rr = a.vent.rr; va = Math.max(0, rr * (a.vent.vt / 1000 - d.vd)); }
      else if (a.intubating > 0) { va = 0; apnea = true; }
      else {
        const paralysed = o.t1 < 30;
        const drive = paralysed ? 0 : (1 - o.ploc) * 1 / (1 + Math.pow(o.cr / 1.5, 2)) * clamp(Math.pow(this.resp.paco2 / 40, 2), 0.5, 3);   // grade C
        const spont = drive > 0.12 ? va0 * drive : 0;
        const bag = a.bagging && a.device === 'mask' ? (paralysed || o.ploc > 0.5 ? 4.5 : 3.5) : 0;
        va = Math.max(spont, bag);
        rr = bag > spont ? 12 : spont > 0 ? clamp(14 * Math.sqrt(drive), 4, 30) : 0;
        apnea = va === 0;
        if (a.device === 'none') fio2 = 0.21;
      }
      // CO2 (grade B): ventilated → relaxes to 0.863·VCO2/VA with τ ≈ 3 min;
      // apnea → ~+8–10 mmHg in the first minute, then ≈ 3 mmHg/min
      if (va > 0.05) {
        this.apneaT = 0;
        const pss = clamp(0.863 * vco2 / va, 15, 120);
        this.resp.paco2 += dt / (3 * MIN) * (pss - this.resp.paco2);
      } else {
        this.apneaT = (this.apneaT || 0) + dt;
        this.resp.paco2 += dt / MIN * (3 + 7 * Math.exp(-this.apneaT / 30) * 2);
      }
      this.resp.paco2 = clamp(this.resp.paco2, 15, 120);
      // O2 store
      const frc = this.frcNow();
      if (this.lastFrc !== undefined && Math.abs(frc - this.lastFrc) > 1e-6) this.o2store = this.storeFromF(this.fao2);
      this.lastFrc = frc;
      this.o2store += dt / MIN * (va * 1000 * (fio2 - this.fao2) - vo2);
      this.o2store = Math.max(this.o2store, 50);
      this.fao2 = this.fFromStore(this.o2store);
      this.resp.va = va; this.resp.rr = rr; this.resp.apnea = apnea; this.resp.fio2 = fio2; this.resp.vo2 = vo2;
      this.resp.etco2 = apnea ? 0 : Math.max(0, this.resp.paco2 - 4);
    }

    /* --------------- outputs --------------- */
    compute(init) {
      const c = this.concs(), H = this.H, x = this.hx, o = this.out;
      const cep = c.propofol.ce, cer = c.remifentanil.ce;
      // BIS — Bouillon 2004 response surface (grade A) + arousal from unblunted stimulation (grade C)
      const U = cep / 4.47 + cer / 19.3;
      let tol = (() => { const post = 1.05 * (1 - fsig(cer, 1.07 * 1.05, 0.97)); return fsig(cep, 8.04 * post, 5.1); })();
      o.tol = tol;
      const de = this.directEffects(c);
      let bis = 97.4 * (1 - Math.pow(U, 1.43) / (1 + Math.pow(U, 1.43)));
      bis = Math.min(98, bis + 20 * de.stim * (bis < 90 ? 1 : 0.2));
      o.bis = bis;
      const Up = cep / 1.80, Ur = cer / 12.5, Ul = Up + Ur + 5.1 * Up * Ur;
      o.ploc = Math.pow(Ul, 3.76) / (1 + Math.pow(Ul, 3.76));
      // TOF — Masui 2018 (grade A)
      const c50 = 1.08 - 0.00605 * (this.pt.age - 50), gam = 6.41 - 0.0494 * (this.pt.age - 50) - 1.24 * (this.d.M ? 1 : 0);
      const ceroc = c.rocuronium.ce;
      o.t1 = Math.min(100, 106 * Math.pow(c50, gam) / (Math.pow(c50, gam) + Math.pow(Math.max(ceroc, 0), gam)));
      o.tofCount = o.t1 < 10 ? 0 : o.t1 < 20 ? 1 : o.t1 < 25 ? 2 : o.t1 < 35 ? 3 : 4;            // grade C mapping
      o.tofRatio = o.t1 >= 99 ? 100 : o.t1 > 35 ? clamp((o.t1 - 35) / 65 * 100, 0, 100) : 0;     // display only (C)
      // hemodynamics apparent values
      const hrCore = x.hr + x.lhr, svCore = x.sv + x.lsv;
      // fast baroreflex (grade C): HR change opposite to deviation from slow set point
      const blunt = (1 - 0.6 * (o.ploc || 0)) * clamp(1 - 0.012 * (this.pt.age - 30), 0.4, 1);
      const baro = clamp(1 - 0.8 * blunt * (this.lastMap - this.mapSlow) / this.mapSlow, 0.6, 1.4);
      let hr = clamp(hrCore * de.hr * baro, 25, 190);
      let sv = svCore * (1 - H.hrsv * Math.log(hr / H.abaseHr)) * de.sv;
      sv = Math.max(sv, 15);
      const tpr = x.tpr * de.tpr;
      const map = hr * sv * tpr;
      o.hr = hr; o.sv = sv; o.tpr = tpr; o.map = map; o.co = hr * sv / 1000;
      o.svr = tpr * 79993;
      o.cp = c.propofol.cp; o.ce = cep; o.cr = c.remifentanil.cp; o.cer = cer; o.croc = ceroc;
      o.ne = c.norepinephrine.ce;
      o.stim = this.stim.level; o.stimEff = de.stim;
      o.paco2 = this.resp.paco2; o.etco2 = this.resp.etco2; o.rr = this.resp.rr; o.apnea = this.resp.apnea; o.fio2 = this.resp.fio2;
      const pao2 = Math.max(this.fao2 * 713 - this.aaGrad(), 5);
      o.pao2 = pao2;
      o.sao2 = this.sat(pao2) * 100;
      if (!init) { this.spo2Lag += (o.sao2 / 100 - this.spo2Lag) / 20; this.mapSlow += (map - this.mapSlow) / 180; }
      o.spo2 = this.spo2Lag * 100;
      o.conscious = o.ploc < 0.5 ? (bis > 80 ? 'Awake' : 'Sedated') : 'Unconscious';
      this.lastMap = map;
    }

    snapshot() { return { t: this.t, map: this.out.map, hr: this.out.hr, bis: this.out.bis, spo2: this.out.spo2, etco2: this.out.etco2, sv: this.out.sv, co: this.out.co }; }
    clone() {
      const e = Object.create(Engine.prototype);
      const copy = JSON.parse(JSON.stringify(this, (k, v) => (k === 'events' ? [] : v)));
      Object.assign(e, copy);
      e.pk = this.pk; e.d = this.d;
      return e;
    }
  }

  function fmtDose(x) { return x >= 10 || Number.isInteger(x) ? String(+x.toFixed(1)) : String(+x.toFixed(2)); }

  global.Physio = { Engine, DRUGS, CLASS_INFO, derive, fmtDose };
  if (typeof module !== 'undefined') module.exports = global.Physio;
})(typeof window !== 'undefined' ? window : globalThis);
