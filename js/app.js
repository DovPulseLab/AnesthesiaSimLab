/* =====================================================================
   Pulse Lab OR — app controller
   ===================================================================== */
(function () {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const { Engine, DRUGS, CLASS_INFO, derive, fmtDose } = Physio;
  const fmtT = t => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const r10 = x => Math.max(10, Math.round(x / 10) * 10), r5 = x => Math.max(5, Math.round(x / 5) * 5);

  const S = {
    eng: null, scen: Scenarios[0], speed: 1, simAcc: 0, last: performance.now(),
    rec: [], trend: [], marks: [], stage: null, pred: null, win: 1800,
    flags: {}, script: [], fired: {}, nibp: { interval: 180, last: -999, pendingUntil: 0, value: null, lastT: null },
    sound: false, audio: null, art: { sys: 0, dia: 0 }, totals: {}, intubatedAt: null, lastUi: 0, ended: false
  };
  const monitor = new MonitorUI.Monitor({ ecg: $('#wECG'), art: $('#wART'), pleth: $('#wPLETH'), co2: $('#wCO2') });

  let lastForecastT = -1;
  /* ================= case setup ================= */
  const FIELDS = [
    ['age', 'Age (y)', 18, 80, 1], ['sex', 'Sex', null], ['height', 'Height (cm)', 145, 200, 1], ['weight', 'Weight (kg)', 40, 140, 1],
    ['sbp', 'Preop SBP (mmHg)', 90, 170, 1], ['dbp', 'Preop DBP (mmHg)', 50, 100, 1], ['hr', 'Preop HR (bpm)', 45, 110, 1],
    ['spo2', 'Room-air SpO₂ (%)', 90, 100, 1], ['hb', 'Hemoglobin (g/dL)', 9, 17, 0.1], ['anxiety', 'Preop anxiety', null], ['asa', 'ASA class', null]
  ];
  let pendingScen = S.scen;
  function openSetup(first) {
    $('#scenGrid').innerHTML = Scenarios.map(s => `<button class="scen ${s.id === pendingScen.id ? 'on' : ''}" data-id="${s.id}"><span class="tag">${s.tag}</span><b>${s.title}</b><span>${s.brief}</span></button>`).join('');
    fillForm(pendingScen.patient);
    $('#cancelSetup').hidden = !!first;
    S.resumeSpeed = S.speed || 1; setSpeed(0);
    $('#setup').hidden = false;
  }
  function fillForm(p) {
    $('#ptForm').innerHTML = FIELDS.map(([k, l, mn, mx, st]) => {
      if (k === 'sex') return `<label>${l}<select id="f_sex"><option value="M" ${p.sex === 'M' ? 'selected' : ''}>Male</option><option value="F" ${p.sex === 'F' ? 'selected' : ''}>Female</option></select></label>`;
      if (k === 'anxiety') return `<label>${l}<select id="f_anxiety"><option value="0.5" ${p.anxiety < 0.8 ? 'selected' : ''}>Calm</option><option value="1" ${p.anxiety >= 0.8 && p.anxiety < 1.3 ? 'selected' : ''}>Usual</option><option value="1.5" ${p.anxiety >= 1.3 ? 'selected' : ''}>Anxious</option></select></label>`;
      if (k === 'asa') return `<label>${l}<select id="f_asa"><option value="1" ${p.asa === 1 ? 'selected' : ''}>I</option><option value="2" ${p.asa === 2 ? 'selected' : ''}>II</option></select></label>`;
      return `<label>${l}<input id="f_${k}" type="number" min="${mn}" max="${mx}" step="${st}" value="${p[k]}"></label>`;
    }).join('') + `<div class="derived" id="derivedLine"></div>`;
    updateDerived();
    $('#ptForm').oninput = updateDerived;
  }
  function readForm() {
    const p = {};
    FIELDS.forEach(([k, , mn, mx]) => {
      const el = $('#f_' + k);
      if (k === 'sex') p.sex = el.value; else if (k === 'anxiety' || k === 'asa') p[k] = +el.value;
      else p[k] = clamp(+el.value || 0, mn, mx);
    });
    if (p.dbp >= p.sbp - 15) p.dbp = p.sbp - 25;
    return p;
  }
  function updateDerived() {
    const p = readForm(), d = derive(p);
    $('#derivedLine').textContent = `BMI ${d.bmi.toFixed(1)} · BSA ${d.bsa.toFixed(2)} m² · LBM ${d.lbm.toFixed(0)} kg · IBW ${d.ibw.toFixed(0)} kg · blood volume ${d.bv.toFixed(1)} L · FRC ${d.frc.toFixed(1)} L (upright) · aortic PWV ${d.pwv} m/s (age norm) · MAP ${d.map0.toFixed(0)} mmHg`;
  }
  $('#scenGrid').addEventListener('click', e => {
    const b = e.target.closest('.scen'); if (!b) return;
    pendingScen = Scenarios.find(s => s.id === b.dataset.id);
    $$('.scen').forEach(x => x.classList.toggle('on', x === b));
    fillForm(pendingScen.patient);
  });
  $('#startCase').addEventListener('click', () => { startCase(pendingScen, readForm()); $('#setup').hidden = true; });
  $('#cancelSetup').addEventListener('click', () => { $('#setup').hidden = true; setSpeed(S.resumeSpeed || 1); });
  $('#newBtn').addEventListener('click', () => { pendingScen = S.scen; openSetup(false); });

  function startCase(scen, patient) {
    S.scen = scen; S.eng = new Engine(patient);
    S.rec = []; S.trend = []; S.marks = []; S.flags = {}; S.fired = {}; S.stage = null; S.pred = null; S.totals = {};
    S.nibp = { interval: 180, last: -999, pendingUntil: 0, value: null, lastT: null };
    S.intubatedAt = null; S.incisionAt = null; S.ended = false; S.simAcc = 0; S.laryngoAt = null; lastForecastT = -1;
    // calibrate the waveform pulse pressure to this patient's own cuff reading
    { const sh = MonitorUI.arterialShape(artState(), S.eng.pt, S.eng.d), br = sh.res.brachial; S.ppK = clamp((patient.sbp - patient.dbp) / (Math.max(...br) - Math.min(...br)), 0.5, 1.6); }
    S.script = (scen.script || []).map((x, i) => Object.assign({ id: i }, x));
    $('#caseName').textContent = `${scen.tag} · ${scen.title}`;
    renderBrief(); renderDrugs(); renderStage(); syncVent(); sample(true); setSpeed(1);
    $('#logList').innerHTML = ''; $('#toasts').innerHTML = '';
    S.eng.log('case', `Case started: ${patient.age} y ${patient.sex}, ${patient.weight} kg, ${patient.height} cm, BP ${patient.sbp}/${patient.dbp}, HR ${patient.hr}`);
    toast(`${scen.title}: ${scen.brief}`, 'info', null, 5000);
  }
  function renderBrief() {
    const s = S.scen, p = S.eng.pt;
    $('#briefPanel').innerHTML = `<span class="tag">${s.tag}</span><h3>${s.title}</h3><p>${s.brief}</p><ul>${s.goals.map(g => `<li>${g}</li>`).join('')}</ul>`;
    $('#ptSummary').textContent = `${p.age} y ${p.sex === 'M' ? 'man' : 'woman'} · ${p.weight} kg · ${p.height} cm · ASA ${p.asa === 2 ? 'II' : 'I'}`;
  }

  /* ================= drugs ================= */
  function dosesFor(k) {
    const W = S.eng.pt.weight;
    switch (k) {
      case 'propofol': return [0.5, 1, 1.5, 2, 2.5].map(x => ({ v: r10(x * W), sub: `${x} mg/kg` }));
      case 'rocuronium': return [0.3, 0.6, 1.0, 1.2].map(x => ({ v: r5(x * W), sub: `${x} mg/kg` }));
      case 'sugammadex': return [2, 4, 16].map(x => ({ v: r10(x * W), sub: `${x} mg/kg` }));
      case 'esmolol': return [0.25, 0.5, 1].map(x => ({ v: r5(x * W), sub: `${x} mg/kg` }));
      case 'remifentanil': return [0.5, 1].map(x => ({ v: r5(x * W), sub: `${x} mcg/kg` }));
      default: return DRUGS[k].bolus.map(v => ({ v }));
    }
  }
  function renderDrugs() {
    const order = ['propofol', 'remifentanil', 'rocuronium', 'sugammadex', 'phenylephrine', 'ephedrine', 'norepinephrine', 'glycopyrrolate', 'esmolol'];
    $('#drugList').innerHTML = order.map(k => {
      const d = DRUGS[k], ci = CLASS_INFO[d.cls];
      const inf = d.inf ? `<div class="pump" data-k="${k}"><span>Infusion</span><button data-inf="-" aria-label="Decrease ${d.name} infusion">−</button><span class="rate" id="rate_${k}">0</span><button data-inf="+" aria-label="Increase ${d.name} infusion">+</button><span>${d.inf.unit}</span><span class="run" id="run_${k}">off</span></div>` : '';
      return `<div class="drug" style="--c:${ci.color}" data-k="${k}"><div class="lab ${ci.stripe ? 'stripe' : ''}"></div><div class="body">
        <div class="top"><span class="nm">${d.name}</span><span class="cl">${ci.label} · ${d.conc}</span><span class="grade ${d.grade}" title="Evidence grade ${d.grade}: ${d.src}">grade ${d.grade}</span></div>
        <div class="doses">${dosesFor(k).map(o => `<button class="dose" data-dose="${o.v}" title="${o.sub || ''}">${fmtDose(o.v)} ${d.unit}</button>`).join('')}
          <span class="custom"><input type="number" min="0" step="any" placeholder="dose" aria-label="Custom ${d.name} dose (${d.unit})" id="cust_${k}"><button class="dose" data-custom="1">${d.unit} ›</button></span></div>
        ${inf}<div class="given" id="given_${k}"></div></div></div>`;
    }).join('');
  }
  $('#drugList').addEventListener('click', e => {
    const card = e.target.closest('.drug'); if (!card) return;
    const k = card.dataset.k;
    const db = e.target.closest('[data-dose]');
    if (db) return stageAction({ type: 'bolus', key: k, dose: +db.dataset.dose });
    if (e.target.closest('[data-custom]')) { const v = +$('#cust_' + k).value; if (v > 0) stageAction({ type: 'bolus', key: k, dose: v }); return; }
    const ib = e.target.closest('[data-inf]');
    if (ib) {
      const steps = DRUGS[k].inf.steps, cur = S.stage && S.stage.type === 'inf' && S.stage.key === k ? S.stage.rate : (S.eng.drug[k].infDisplay || 0);
      let i = steps.findIndex(s => s >= cur - 1e-9); if (i < 0) i = steps.length - 1;
      if (steps[i] !== cur && ib.dataset.inf === '-') i = Math.max(0, i - 1);
      else i = clamp(i + (ib.dataset.inf === '+' ? 1 : -1), 0, steps.length - 1);
      stageAction({ type: 'inf', key: k, rate: steps[i] });
    }
  });
  function describe(a) {
    const d = DRUGS[a.key], W = S.eng.pt.weight;
    if (a.type === 'bolus') {
      const perKg = ['propofol', 'rocuronium', 'sugammadex', 'esmolol'].includes(a.key) ? ` (${(a.dose / W).toFixed(2)} ${d.unit}/kg)` : a.key === 'remifentanil' ? ` (${(a.dose / W).toFixed(2)} mcg/kg)` : '';
      return `Give ${d.name} ${fmtDose(a.dose)} ${d.unit}${perKg}`;
    }
    return a.rate === 0 ? `Stop ${d.name} infusion` : `Set ${d.name} infusion to ${a.rate} ${d.inf.unit}`;
  }
  function applyAction(eng, a) {
    if (a.type === 'bolus') eng.bolus(a.key, a.dose); else eng.setInfusion(a.key, a.rate);
  }
  function stageAction(a) {
    S.stage = a;
    $$('.dose').forEach(b => b.classList.remove('sel'));
    if (a.type === 'bolus') { const b = document.querySelector(`.drug[data-k="${a.key}"] [data-dose="${a.dose}"]`); if (b) b.classList.add('sel'); }
    forecast(); renderStage();
  }
  function renderStage() {
    const old = $('#stage'); if (old) old.remove();
    if (!S.stage) { $('#forecast').hidden = true; $('#predLegend').hidden = true; S.pred = null; return; }
    const host = document.querySelector(`.drug[data-k="${S.stage.key}"] .body`);
    const el = document.createElement('div'); el.className = 'stage'; el.id = 'stage';
    el.innerHTML = `<div class="s-top"><b>${describe(S.stage)}</b><span class="muted">Enter to give · Esc to cancel</span></div>
      <div class="s-fc" id="stageFc">${S.fcShort || ''}</div>
      <div class="s-act"><button class="tbtn primary" id="giveBtn">${S.stage.type === 'bolus' ? 'Give now' : 'Start / change pump'}</button><button class="tbtn" id="cancelStage">Cancel</button></div>`;
    host.appendChild(el);
    $('#giveBtn').onclick = commitStage; $('#cancelStage').onclick = cancelStage;
    const r = el.getBoundingClientRect(); if (r.bottom > innerHeight || r.top < 0) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function commitStage() {
    if (!S.stage) return;
    const a = S.stage; applyAction(S.eng, a);
    S.marks.push({ t: S.eng.t, color: CLASS_INFO[DRUGS[a.key].cls].color });
    S.stage = null; renderStage(); $$('.dose').forEach(b => b.classList.remove('sel'));
    if (a.type === 'bolus') { const c = $('#cust_' + a.key); if (c) c.value = ''; }
    refreshLog();
  }
  function cancelStage() { S.stage = null; renderStage(); $$('.dose').forEach(b => b.classList.remove('sel')); }
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' && e.key !== 'Enter') return;
    if (!$('#setup').hidden || !$('#debrief').hidden) return;
    if (e.key === 'Enter' && S.stage) { e.preventDefault(); commitStage(); }
    if (e.key === 'Escape') cancelStage();
    if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON' && !S.ended) { e.preventDefault(); setSpeed(S.speed === 0 ? (S.prevSpeed || 1) : 0); }
  });

  /* ================= forecast ================= */
  function bpOf(eng) { const o = eng.out; return MonitorUI.pressureRange({ hr: o.hr, sv: o.sv, tpr: o.tpr, tprBase: eng.H.tprBase, map: o.map }, eng.pt, eng.d, S.ppK); }
  function runAhead(eng, secs, every, withBP) {
    const out = [];
    for (let i = 1; i <= secs; i++) {
      eng.step();
      if (i % every === 0) { const o = eng.out, pt = { t: eng.t, map: o.map, hr: o.hr, bis: o.bis, spo2: o.spo2 }; if (withBP) Object.assign(pt, bpOf(eng)); out.push(pt); }
    }
    return out;
  }
  function forecast() {
    if (!S.stage) return;
    const span = 600;
    const a = S.eng.clone(), b = S.eng.clone();
    applyAction(a, S.stage);
    const p = runAhead(a, span, 10, true), base = runAhead(b, span, 10);
    const now = bpOf(S.eng);
    S.pred = { pts: [{ t: S.eng.t, map: S.eng.out.map, hr: S.eng.out.hr, bis: S.eng.out.bis, spo2: S.eng.out.spo2, sys: now.sys, dia: now.dia }].concat(p), base, span };
    const o = S.eng.out;
    const mn = k => Math.min(...p.map(x => x[k])), mx = k => Math.max(...p.map(x => x[k]));
    const mapLo = mn('map'), mapHi = mx('map'), at = k => p.find(x => x.t >= S.eng.t + 180) || p[p.length - 1];
    const tPeak = (() => { let best = p[0], dv = 0; p.forEach(x => { const v = Math.abs(x.map - o.map); if (v > dv) { dv = v; best = x; } }); return best.t - S.eng.t; })();
    const cls = (v, okLo, okHi) => (v < okLo || v > okHi ? 'bad' : 'good');
    const sLo = mn('sys'), sHi = mx('sys'), dLo = mn('dia'), dHi = mx('dia');
    const nadir = p.reduce((a, x) => x.map < a.map ? x : a, p[0]), peak = p.reduce((a, x) => x.map > a.map ? x : a, p[0]);
    const big = Math.abs(nadir.map - o.map) >= Math.abs(peak.map - o.map) ? nadir : peak;
    $('#forecast').innerHTML = [
      [`SBP / DBP, next 10 min`, `${big.sys.toFixed(0)}/${big.dia.toFixed(0)}`, `${big === nadir ? 'lowest' : 'highest'} at ${fmtT(big.t - S.eng.t)} · now ${now.sys.toFixed(0)}/${now.dia.toFixed(0)}<br>SBP ${sLo.toFixed(0)}–${sHi.toFixed(0)} · DBP ${dLo.toFixed(0)}–${dHi.toFixed(0)}`, sLo < 90 || dLo < 45 ? 'bad' : sHi > 160 ? 'warn' : 'good'],
      [`MAP range, next 10 min`, `${mapLo.toFixed(0)}–${mapHi.toFixed(0)}`, `now ${o.map.toFixed(0)} · largest change in ${fmtT(tPeak)}`, mapLo < 65 ? 'bad' : mapHi > 120 ? 'warn' : 'good'],
      [`HR range`, `${mn('hr').toFixed(0)}–${mx('hr').toFixed(0)}`, `now ${o.hr.toFixed(0)} bpm`, cls(mn('hr'), 45, 200) === 'bad' || mx('hr') > 110 ? 'warn' : 'good'],
      [`BIS at +3 min`, `${at().bis.toFixed(0)}`, `range ${mn('bis').toFixed(0)}–${mx('bis').toFixed(0)}`, at().bis > 60 && S.eng.out.ploc > 0.5 ? 'warn' : 'good'],
      [`Lowest SpO₂`, `${mn('spo2').toFixed(0)} %`, `now ${o.spo2.toFixed(0)} %`, mn('spo2') < 90 ? 'bad' : mn('spo2') < 94 ? 'warn' : 'good']
    ].map(([l, v, n, c]) => `<div class="fc ${c}">${l}<b>${v}</b>${n}</div>`).join('');
    $('#forecast').hidden = false; $('#predLegend').hidden = false;
    const bisAt = at().bis, spLo = mn('spo2');
    S.fcShort = `<span class="${sLo < 90 || dLo < 45 ? 'bad' : sHi > 160 ? 'warn' : ''}">BP ${big === nadir ? 'low' : 'peak'} <b>${big.sys.toFixed(0)}/${big.dia.toFixed(0)}</b> at ${fmtT(big.t - S.eng.t)}</span><span class="${mapLo < 65 ? 'bad' : mapHi > 120 ? 'warn' : ''}">MAP <b>${mapLo.toFixed(0)}–${mapHi.toFixed(0)}</b></span><span>HR <b>${mn('hr').toFixed(0)}–${mx('hr').toFixed(0)}</b></span><span>BIS at +3 min <b>${bisAt.toFixed(0)}</b></span><span class="${spLo < 90 ? 'bad' : spLo < 94 ? 'warn' : ''}">lowest SpO₂ <b>${spLo.toFixed(0)} %</b></span>`;
    const sf = $('#stageFc'); if (sf) sf.innerHTML = S.fcShort;
  }

  /* ================= airway / vent / surgery ================= */
  $$('.airway [data-ev], .surgery [data-ev]').forEach(b => b.addEventListener('click', () => {
    const ev = b.dataset.ev;
    if (ev === 'laryngoscopy' && S.eng.out.ploc < 0.5) { toast('The patient is still responsive — laryngoscopy is not possible yet.', 'warn'); }
    S.eng.event(ev);
    if (ev === 'incision' && !S.incisionAt) S.incisionAt = S.eng.t;
    if (ev === 'laryngoscopy') { S.laryngoAt = S.eng.t; S.preLaryngoMap = S.eng.out.map; const a = S.eng.air; if (a.poorConditions && S.eng.out.ploc >= 0.5) toast(`Poor intubating conditions: T1 ${S.eng.out.t1.toFixed(0)} % — vocal cords moving, coughing.`, 'warn'); }
    S.marks.push({ t: S.eng.t, color: '#8fa3bf' });
    syncVent(); refreshLog(); if (S.stage) forecast();
  }));
  function syncVent() {
    const a = S.eng.air, v = a.vent;
    $$('.stp').forEach(s => { const k = s.dataset.k; s.querySelector('b').textContent = k === 'fio2' ? v.fio2.toFixed(2).replace(/0$/, '') : v[k]; });
    const live = a.intubated && a.device === 'ett';
    $('#vent').classList.toggle('live', live); $('#vent').classList.toggle('off', !live);
    $('#ventState').textContent = live ? 'ventilating' : 'standby — connects when the tube is placed';
    $('#bagBtn').classList.toggle('on', a.bagging);
  }
  $('#vent').addEventListener('click', e => {
    const b = e.target.closest('.stp button'); if (!b) return;
    const s = b.parentElement, k = s.dataset.k, st = +s.dataset.step, mn = +s.dataset.min, mx = +s.dataset.max;
    const dir = b === s.querySelectorAll('button')[0] ? -1 : 1;
    const v = clamp(+(S.eng.air.vent[k] + dir * st).toFixed(2), mn, mx);
    S.eng.setVent({ [k]: v }); syncVent(); refreshLog();
  });

  /* ================= speed ================= */
  function setSpeed(v) {
    v = Number(v); if (!isFinite(v) || v < 0) v = S.prevSpeed || 1;   // never let the clock get an invalid speed
    if (v !== 0) S.prevSpeed = v;
    S.speed = v; S.simAcc = 0; S.last = performance.now();
    $$('[data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === v));
    const pb = $('#pauseBtn'); pb.textContent = v === 0 ? '▶' : '❚❚'; pb.title = v === 0 ? 'Resume (space)' : 'Pause (space)';
  }
  // only the speed buttons change speed (the skip buttons share the group styling but not this handler)
  $$('[data-speed]').forEach(b => b.addEventListener('click', () => {
    const v = +b.dataset.speed;
    setSpeed(v === 0 && S.speed === 0 ? (S.prevSpeed || 1) : v);   // pause button toggles pause / resume
  }));

  /* ================= sound ================= */
  function ensureAudio() { if (!S.audio) { try { S.audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { S.audio = null; } } return S.audio; }
  function beep(freq, dur, vol) {
    const ac = S.audio; if (!ac || !S.sound) return;
    const o = ac.createOscillator(), gn = ac.createGain();
    o.frequency.value = freq; o.type = 'sine'; gn.gain.value = 0;
    gn.gain.setTargetAtTime(vol, ac.currentTime, 0.005); gn.gain.setTargetAtTime(0, ac.currentTime + dur, 0.02);
    o.connect(gn).connect(ac.destination); o.start(); o.stop(ac.currentTime + dur + 0.1);
  }
  $('#soundBtn').addEventListener('click', () => {
    S.sound = !S.sound; if (S.sound) { const ac = ensureAudio(); if (ac && ac.state === 'suspended') ac.resume(); }
    $('#soundBtn').textContent = S.sound ? '🔊 Sound on' : '🔇 Sound off';
  });
  monitor.onBeat = () => {
    if (!S.eng) return;
    const sp = S.eng.out.spo2;                       // pulse-oximeter tone falls in pitch as saturation falls
    beep(260 + Math.max(0, sp - 60) * 11, 0.07, 0.05);
  };

  /* ================= NIBP ================= */
  $('#nibpBtn').addEventListener('click', () => startNibp());
  function startNibp() { S.nibp.pendingUntil = S.eng.t + 25; S.nibp.last = S.eng.t; }
  function nibpTick() {
    const n = S.nibp, t = S.eng.t;
    if (t - n.last >= n.interval && n.pendingUntil === 0) startNibp();
    if (n.pendingUntil && t >= n.pendingUntil) {
      const bp = bpOf(S.eng), map = S.eng.out.map;
      n.value = { sys: bp.sys, dia: bp.dia, map };
      n.lastT = t; n.pendingUntil = 0;
    }
  }

  /* ================= per-second bookkeeping ================= */
  function sample(force) {
    const e = S.eng, o = e.out;
    const rec = { t: e.t, map: o.map, hr: o.hr, bis: o.bis, spo2: o.spo2, etco2: o.etco2, ...(e.t % 5 === 0 || force ? bpOf(e) : { sys: S.art.sys || o.map + 20, dia: S.art.dia || o.map - 15 }), t1: o.t1, ploc: o.ploc, intubated: e.air.intubated };
    S.rec.push(rec);
    if (force || e.t % 5 === 0) S.trend.push(rec);
    // infusion totals
    Object.keys(e.drug).forEach(k => { const g = e.drug[k]; if (g.inf) S.totals[k] = (S.totals[k] || 0) + g.inf / 60; });
  }
  function transitions() {
    const e = S.eng, o = e.out, f = S.flags;
    const once = (k, cond, fn) => { if (cond && !f[k]) { f[k] = true; fn(); } else if (!cond && f[k] && k.endsWith('~')) f[k] = false; };
    if (o.ploc > 0.5 && !f.loc) { f.loc = true; e.log('clinical', 'Loss of consciousness — eyelash reflex gone'); toast('Loss of consciousness.', 'info', null, 2500); }
    if (o.ploc < 0.4 && f.loc) { f.loc = false; e.log('clinical', 'Patient responding to voice'); toast('Patient is responding to voice.', 'info', null, 2500); }
    const apneic = o.apnea && !e.air.intubating && !(e.air.intubated && e.air.device === 'ett');
    if (apneic && !f.apnea) { f.apnea = e.t; } if (!apneic) f.apnea = 0;
    if (f.apnea && e.t - f.apnea === 15) { e.log('clinical', 'Apnea — no spontaneous breaths'); toast('Apnea: no spontaneous breaths. Bag-mask ventilate or intubate.', 'warn', { label: 'Bag-mask', fn: () => { e.event('bag'); syncVent(); refreshLog(); } }); }
    if (o.t1 < 10 && !f.tof0 && e.drug.rocuronium.given > 0) { f.tof0 = true; e.log('clinical', 'Train-of-four count 0 — intubating conditions good'); toast('TOF count 0 — good intubating conditions.', 'good', null, 3000); }
    if (o.t1 > 90 && f.tof0) { f.tof0 = false; e.log('clinical', 'Neuromuscular function recovering (T1 > 90 %)'); }
    if (o.t1 < 30 && o.bis > 70 && e.drug.rocuronium.given > 0) { if (!f.aware) { f.aware = true; e.log('clinical', 'Paralysed with BIS > 70 — risk of awareness'); toast('Paralysed with BIS > 70 — risk of awareness. Deepen anesthesia.', 'bad'); } } else if (o.bis < 65) f.aware = false;
    if (e.air.intubated && !S.intubatedAt) { S.intubatedAt = e.t; }
    if (S.intubatedAt && !e.air.intubated) S.intubatedAt = S.intubatedAt;
  }
  function runScript() {
    const e = S.eng;
    S.script.forEach(s => {
      if (S.fired[s.id]) return;
      const ref = s.after === 'start' ? 0 : s.after === 'intubated' ? S.intubatedAt : s.after === 'incision' ? S.incisionAt : null;
      if (ref == null || e.t < ref + s.delay) return;
      S.fired[s.id] = true;
      if (s.kind === 'prompt') toast(s.text, 'info', { label: s.label, fn: () => { e.event(s.action); if (s.action === 'incision' && !S.incisionAt) S.incisionAt = e.t; S.marks.push({ t: e.t, color: '#8fa3bf' }); refreshLog(); } }, 0);
      else toast(s.text, 'info', null, 9000);
    });
  }

  /* ================= alarms ================= */
  function alarms() {
    const e = S.eng, o = e.out, L = [];
    const tile = {};
    if (o.map < 65) { L.push(['high', `MAP LOW ${o.map.toFixed(0)}`]); tile.art = 'high'; }
    else if (o.map < 0.8 * e.d.map0) { L.push(['med', `MAP −${((1 - o.map / e.d.map0) * 100).toFixed(0)} % vs baseline`]); tile.art = 'med'; }
    if (o.map > 120) { L.push(['med', `MAP HIGH ${o.map.toFixed(0)}`]); tile.art = 'med'; }
    if (o.spo2 < 90) { L.push(['high', `SpO₂ LOW ${o.spo2.toFixed(0)}`]); tile.spo2 = 'high'; } else if (o.spo2 < 94) { L.push(['med', `SpO₂ ${o.spo2.toFixed(0)}`]); tile.spo2 = 'med'; }
    if (o.hr < 45) { L.push(['high', `BRADYCARDIA ${o.hr.toFixed(0)}`]); tile.hr = 'high'; } else if (o.hr > 110) { L.push(['med', `TACHYCARDIA ${o.hr.toFixed(0)}`]); tile.hr = 'med'; }
    const apneic = o.apnea && !e.air.intubating;
    if (apneic && S.flags.apnea && e.t - S.flags.apnea > 20) { L.push(['high', `APNEA ${e.t - S.flags.apnea} s`]); tile.co2 = 'high'; }
    if (e.air.intubating > 0) L.push(['info', `INTUBATING · ${Math.ceil(e.air.intubating)} s`]);
    if (o.ploc > 0.5 && o.bis > 60) { L.push(['med', `BIS ${o.bis.toFixed(0)} — light`]); tile.bis = 'med'; }
    if (o.bis < 30) { L.push(['med', `BIS ${o.bis.toFixed(0)} — deep`]); tile.bis = 'med'; }
    if (o.paco2 > 55) L.push(['med', `PaCO₂ ${o.paco2.toFixed(0)}`]);
    if (S.speed === 0) L.unshift(['info', 'PAUSED']);
    $('#alarmBar').innerHTML = L.map(([c, t]) => `<span class="alarm ${c}">${t}</span>`).join('');
    const setT = (sel, lvl) => { const el = $(sel); el.classList.toggle('alarm-high', lvl === 'high'); el.classList.toggle('alarm-med', lvl === 'med'); };
    setT('.tile.art', tile.art); setT('.tile.spo2', tile.spo2); setT('.tile.hr', tile.hr); setT('.tile.co2', tile.co2); setT('.num.bis', tile.bis);
    S.highAlarm = L.some(x => x[0] === 'high');
  }

  /* ================= UI refresh ================= */
  function artState() { const o = S.eng.out; return { hr: o.hr, sv: o.sv, tpr: o.tpr, tprBase: S.eng.H.tprBase, map: o.map }; }
  function refreshNumbers() {
    const e = S.eng, o = e.out;
    $('#clock').textContent = fmtT(e.t);
    $('#nHR').textContent = o.hr.toFixed(0);
    $('#nART').textContent = `${S.art.sys.toFixed(0)}/${S.art.dia.toFixed(0)}`;
    $('#nMAP').textContent = `(${o.map.toFixed(0)})`;
    $('#nSPO2').textContent = o.spo2.toFixed(0);
    $('#nETCO2').textContent = o.etco2.toFixed(0);
    $('#nRR').textContent = `RR ${o.rr.toFixed(0)}`;
    const n = S.nibp;
    if (n.pendingUntil) { $('#nNIBP').textContent = '···'; $('#nNIBPmap').textContent = 'cuff inflating'; }
    else if (n.value) { $('#nNIBP').textContent = `${n.value.sys.toFixed(0)}/${n.value.dia.toFixed(0)}`; $('#nNIBPmap').textContent = `(${n.value.map.toFixed(0)}) · ${fmtT(e.t - n.lastT)} ago`; $('#nibpAge').textContent = 'q3 min'; }
    $('#nBIS').textContent = o.bis.toFixed(0); $('#bisBar').style.width = `${o.bis}%`;
    $('#nTOF').textContent = e.drug.rocuronium.given > 0 || o.t1 < 99 ? `${o.tofCount}/4` : '4/4';
    $('#nT1').textContent = `T1 ${o.t1.toFixed(0)} %`;
    $('#nCO').textContent = `${o.co.toFixed(1)} L/min`; $('#nSV').textContent = `SV ${o.sv.toFixed(0)} mL · SVR ${o.svr.toFixed(0)}`;
    const sh = monitor.lastShape;
    if (sh) { const c = sh.central, k = S.ppK || 1; $('#nCBP').textContent = `${(o.map + k * Math.max(...c)).toFixed(0)}/${(o.map + k * Math.min(...c)).toFixed(0)}`; $('#nAIX').textContent = `AIx ${sh.aix.toFixed(0)} %`; }
    $('#nFIO2').textContent = o.fio2.toFixed(2);
    $('#nPACO2').textContent = `PaCO₂ ${o.paco2.toFixed(0)} · PaO₂ ${o.pao2.toFixed(0)}`;
  }
  function refreshState() {
    const e = S.eng, o = e.out, a = e.air;
    const airway = a.intubating > 0 ? ['Intubating', 'warn'] : a.intubated ? ['Endotracheal tube', 'good'] : a.device === 'mask' ? [a.bagging ? 'Bag-mask ventilation' : `Face mask · FiO₂ ${a.fio2.toFixed(1)}`, 'info'] : ['Room air', ''];
    const breathing = a.intubated && a.device === 'ett' ? [`Ventilated · RR ${a.vent.rr}`, 'good'] : o.apnea ? ['Apneic', 'bad'] : a.bagging ? ['Bag-mask', 'info'] : [`Spontaneous · RR ${o.rr.toFixed(0)}`, 'good'];
    const cons = o.conscious === 'Awake' ? ['Awake', ''] : o.conscious === 'Sedated' ? ['Sedated', 'info'] : ['Unconscious', 'good'];
    const block = o.t1 >= 95 ? ['No block', ''] : [`Block · TOF ${o.tofCount}/4`, o.t1 < 10 ? 'good' : 'warn'];
    const stimNames = Object.keys(e.stim.sources);
    const stim = o.stim > 0.05 ? [`Stimulus: ${stimNames.length ? stimNames.join(', ') : 'surgery'}${o.stimEff < 0.1 ? ' (blunted)' : ''}`, o.stimEff > 0.25 ? 'warn' : 'info'] : ['No stimulus', ''];
    $('#stateChips').innerHTML = [cons, airway, breathing, block, stim].map(([t, c]) => `<span class="chip ${c}"><span class="dot"></span>${t}</span>`).join('');
    const G = [
      ['Propofol Ce', o.ce, 'µg/mL', 8, '#f7d417', `Cp ${o.cp.toFixed(1)}`],
      ['Remifentanil Ce', o.cer, 'ng/mL', 8, '#3aa0ff', ''],
      ['P(unconscious)', o.ploc * 100, '%', 100, '#3ddc84', ''],
      ['Tolerates laryngoscopy', o.tol * 100, '%', 100, '#c38bff', 'TOL'],
      ['Twitch T1', o.t1, '%', 100, '#ff4b3e', `TOF ${o.tofCount}/4`],
      ['Stimulus felt', o.stimEff * 100, '%', 100, '#ff9f45', '']
    ];
    $('#gauges').innerHTML = G.map(([l, v, u, mx, c, sub]) => `<div class="gauge"><div class="gl"><span>${l}</span><span>${sub}</span></div><div class="gv">${v.toFixed(u === '%' ? 0 : 1)}<small>${u}</small></div><div class="gb"><i style="width:${clamp(v / mx * 100, 0, 100)}%;background:${c}"></i></div></div>`).join('');
    $('#airwayState').textContent = airway[0];
    $('#surgState').textContent = e.surgery ? (e.pneumo ? 'in progress · pneumoperitoneum' : 'in progress') : (S.incisionAt ? 'finished' : 'not started');
    Object.keys(DRUGS).forEach(k => {
      const g = e.drug[k] || {}; const el = $('#given_' + k); if (!el) return;
      const tot = (g.given || 0) + (S.totals[k] || 0);
      el.textContent = tot > 0 ? `total ${fmtDose(tot)} ${DRUGS[k].unit}` : '';
      if (DRUGS[k].inf) { const r = g.infDisplay || 0; $('#rate_' + k).textContent = r; const run = $('#run_' + k); run.textContent = r ? 'running' : 'off'; run.classList.toggle('on', !!r); }
    });
    syncVent();
  }
  const typeColor = { drug: '#f7d417', infusion: '#3aa0ff', airway: '#33d6ff', surgery: '#ff9f45', clinical: '#c38bff', vent: '#6c7586', case: '#6c7586' };
  function refreshLog() {
    const ev = S.eng.events.slice().reverse();
    $('#logList').innerHTML = ev.map(x => `<li><span class="lt">${fmtT(x.t)}</span><span class="ld" style="background:${typeColor[x.type] || '#6c7586'}"></span><span>${x.text}</span></li>`).join('');
  }

  /* ================= toasts ================= */
  function toast(text, kind, action, ms = 6000) {
    const el = document.createElement('div'); el.className = `toast ${kind || ''}`;
    el.innerHTML = `<div>${text}</div>${action ? `<div class="ta"><button class="tbtn primary">${action.label}</button><button class="tbtn">Dismiss</button></div>` : ''}`;
    $('#toasts').appendChild(el);
    const close = () => el.remove();
    if (action) { const [b1, b2] = el.querySelectorAll('button'); b1.onclick = () => { action.fn(); close(); }; b2.onclick = close; }
    else el.onclick = close;
    if (ms) setTimeout(close, ms);
    while ($('#toasts').children.length > 3) $('#toasts').firstChild.remove();
  }

  /* ================= trend window ================= */
  $$('.seg button').forEach(b => b.addEventListener('click', () => { S.win = +b.dataset.win; $$('.seg button').forEach(x => x.classList.toggle('on', x === b)); drawTrendNow(); }));
  function drawTrendNow() {
    MonitorUI.drawTrend($('#trend'), S.trend, { tNow: S.eng.t, window: S.win, pred: S.pred ? S.pred.pts : null, base: S.pred ? S.pred.base : null, predSpan: S.pred ? S.pred.span : 0, marks: S.marks });
  }

  function advanceOne() { S.eng.step(); sample(); transitions(); runScript(); nibpTick(); }
  function advance(n) {
    for (let i = 0; i < n; i++) { S.eng.step(); sample(); transitions(); runScript(); nibpTick(); }
    refreshLog();
  }
  S.advance = advance;
  $$('[data-skip]').forEach(b => b.addEventListener('click', () => {
    if (!S.eng || S.ended) return;
    advance(+b.dataset.skip);
    S.simAcc = 0; S.last = performance.now(); lastForecastT = S.eng.t;   // keep running at the same speed from the new time
    refreshNumbers(); refreshState(); drawTrendNow();
    if (S.stage) forecast();
  }));

  /* ================= main loop ================= */
  function loop(now) {
    requestAnimationFrame(loop);
    if (!S.eng) return;
    const dt = Math.min(0.1, (now - S.last) / 1000); S.last = now;
    if (!S.ended) {
      S.simAcc += dt * S.speed;
      let steps = 0;
      while (S.simAcc >= 1 && steps < 40) {
        S.simAcc -= 1; steps++;
        advanceOne();
      }
      if (steps && S.eng.events.length !== S.lastEventCount) { S.lastEventCount = S.eng.events.length; refreshLog(); }
    }
    // waveforms in real time
    const o = S.eng.out, st = Object.assign(artState(), { rr: o.rr, etco2: o.etco2, spo2: o.spo2, pt: S.eng.pt, d: S.eng.d, ppK: S.ppK || 1 });
    monitor.frame(dt, st);
    const sh = monitor.lastShape;
    if (sh) { const k = S.ppK || 1; S.art.sys = o.map + k * Math.max(...sh.radial); S.art.dia = o.map + k * Math.min(...sh.radial); monitor.setArtRange(S.art.sys, S.art.dia); }
    if (now - S.lastUi > 250) {
      S.lastUi = now; refreshNumbers(); refreshState(); alarms(); drawTrendNow();
      if (S.highAlarm && S.sound && Math.floor(now / 1000) % 3 === 0 && Math.floor(now / 250) % 4 === 0) { beep(980, 0.12, 0.08); setTimeout(() => beep(980, 0.12, 0.08), 180); setTimeout(() => beep(980, 0.12, 0.08), 360); }
      if (S.stage && S.speed > 0 && (S.eng.t - lastForecastT >= 15 || S.eng.t < lastForecastT)) { lastForecastT = S.eng.t; forecast(); }
    }
  }

  /* ================= debrief ================= */
  $('#debriefBtn').addEventListener('click', () => { S.prevSpeed = S.speed || S.prevSpeed || 1; setSpeed(0); cancelStage(); S.ended = true; openDebrief(); });
  $('#resumeCase').addEventListener('click', () => { $('#debrief').hidden = true; S.ended = false; setSpeed(S.prevSpeed || 1); });
  $('#closeDebrief').addEventListener('click', () => { $('#debrief').hidden = true; pendingScen = S.scen; openSetup(true); });
  function openDebrief() {
    const e = S.eng, R = S.rec, base = e.d.map0;
    const secs = f => R.filter(f).length;
    const lowMap = secs(r => r.map < 65), low20 = secs(r => r.map < 0.8 * base);
    const minMap = Math.min(...R.map(r => r.map)), maxMap = Math.max(...R.map(r => r.map));
    const afterIntub = R.filter(r => r.intubated);
    const bisHigh = afterIntub.filter(r => r.bis > 60).length, bisLow = afterIntub.filter(r => r.bis < 40).length;
    const spo2Min = Math.min(...R.map(r => r.spo2)), desat = secs(r => r.spo2 < 90);
    const aware = secs(r => r.t1 < 30 && r.bis > 70);
    // time to treat hypotension
    const episodes = []; let inEp = false;
    R.forEach(r => { if (r.map < 65 && !inEp) { inEp = true; episodes.push({ start: r.t }); } if (r.map >= 65 && inEp) { inEp = false; episodes[episodes.length - 1].end = r.t; } });
    const treat = e.events.filter(x => (x.type === 'drug' && /Phenylephrine|Ephedrine|Norepinephrine|Glycopyrrolate/.test(x.text)) || (x.type === 'infusion' && /(Norepinephrine|Phenylephrine)/.test(x.text)) || (x.type === 'infusion' && /Propofol infusion/.test(x.text)));
    episodes.forEach(ep => { const tr = treat.find(x => x.t >= ep.start - 5); ep.treat = tr ? tr.t - ep.start : null; });
    const ttt = episodes.filter(x => x.treat != null).map(x => Math.max(0, x.treat));
    const dur = e.t;
    const larR = S.laryngoAt != null ? R.filter(r => r.t >= S.laryngoAt && r.t <= S.laryngoAt + 180) : [];
    const larPeak = larR.length ? Math.max(...larR.map(r => r.map)) : null;
    const tiles = [
      ['Case length', fmtT(dur), `${(dur / 60).toFixed(0)} min simulated`, ''],
      ['Time MAP < 65', fmtT(lowMap), `lowest MAP ${minMap.toFixed(0)} mmHg`, lowMap === 0 ? 'good' : lowMap < 120 ? 'warn' : 'bad'],
      ['Time MAP > 20 % below baseline', fmtT(low20), `baseline ${base.toFixed(0)} mmHg`, low20 < 60 ? 'good' : low20 < 300 ? 'warn' : 'bad'],
      ['Highest MAP', `${maxMap.toFixed(0)} mmHg`, larPeak ? `after laryngoscopy ${larPeak.toFixed(0)} (from ${S.preLaryngoMap.toFixed(0)})` : '', maxMap > 130 ? 'warn' : 'good'],
      ['Hypotension treated in', ttt.length ? `${(ttt.reduce((a, b) => a + b, 0) / ttt.length).toFixed(0)} s` : episodes.length ? 'not treated' : '—', `${episodes.length} episode(s) of MAP < 65`, !episodes.length ? 'good' : !ttt.length ? 'bad' : Math.max(...ttt) <= 120 ? 'good' : 'warn'],
      ['BIS outside 40–60 (intubated)', fmtT(bisHigh + bisLow), `${fmtT(bisHigh)} above 60 · ${fmtT(bisLow)} below 40`, bisHigh + bisLow < 120 ? 'good' : 'warn'],
      ['Lowest SpO₂', `${spo2Min.toFixed(0)} %`, `${fmtT(desat)} below 90 %`, spo2Min >= 94 ? 'good' : spo2Min >= 90 ? 'warn' : 'bad'],
      ['Awareness risk', aware ? fmtT(aware) : 'none', 'paralysed (T1 < 30 %) with BIS > 70', aware ? 'bad' : 'good']
    ];
    const totals = Object.keys(DRUGS).map(k => { const g = e.drug[k] || {}; const b = g.given || 0, inf = S.totals[k] || 0; return [k, b, inf]; }).filter(x => x[1] + x[2] > 0);
    $('#debriefBody').innerHTML = `<p class="muted">${S.scen.tag} · ${S.scen.title} · ${e.pt.age} y ${e.pt.sex}, ${e.pt.weight} kg. Goals: ${S.scen.goals.join(' · ')}</p>
      <div class="db-grid">${tiles.map(([l, v, n, c]) => `<div class="db ${c}"><div class="dl">${l}</div><div class="dv">${v}</div><div class="dn">${n}</div></div>`).join('')}</div>
      <div class="db-chart"><canvas id="dbChart"></canvas></div>
      <h3>Drugs given</h3>
      <table class="dt"><tr><th>Drug</th><th>Boluses</th><th>By infusion</th><th>Total</th></tr>${totals.map(([k, b, i]) => `<tr><td>${DRUGS[k].name}</td><td class="n">${fmtDose(b)} ${DRUGS[k].unit}</td><td class="n">${fmtDose(i)} ${DRUGS[k].unit}</td><td class="n">${fmtDose(b + i)} ${DRUGS[k].unit} (${((b + i) / e.pt.weight).toFixed(2)}/kg)</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No drugs given</td></tr>'}</table>
      <h3>Timeline</h3>
      <table class="dt"><tr><th>Time</th><th>Event</th></tr>${e.events.map(x => `<tr><td class="n">${fmtT(x.t)}</td><td>${x.text}</td></tr>`).join('')}</table>
      <p class="disclaimer">Educational simulation built on published population models (Schnider, Minto, Bouillon, Kern, Wierda/Masui, Li, Su 2023) plus calibrated assumptions marked grade C. It does not predict any individual patient's response and must not guide clinical care.</p>`;
    $('#debrief').hidden = false;
    requestAnimationFrame(() => MonitorUI.drawTrend($('#dbChart'), S.rec.filter((r, i) => i % 5 === 0), { tNow: e.t, window: 0, marks: S.marks }));
  }

  /* ================= boot ================= */
  startCase(Scenarios[0], Scenarios[0].patient);
  openSetup(true);
  requestAnimationFrame(loop);
  window.__or = S;
})();
