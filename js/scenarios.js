/* =====================================================================
   Case library: patient presets, briefs, goals and scripted prompts.
   ===================================================================== */
(function (global) {
  'use strict';
  const SCENARIOS = [
    {
      id: 'free', title: 'Free practice', tag: 'Open case',
      patient: { age: 45, sex: 'M', height: 175, weight: 75, sbp: 126, dbp: 78, hr: 72, spo2: 98, hb: 14, anxiety: 1, asa: 1 },
      brief: 'Healthy adult, elective laparoscopic cholecystectomy. Plan your own induction and maintenance.',
      goals: ['MAP within 20 % of baseline and above 65 mmHg', 'BIS 40–60 after intubation', 'SpO₂ ≥ 94 % throughout'],
      script: []
    },
    {
      id: 'routine', title: 'Routine induction', tag: 'Scenario 1',
      patient: { age: 40, sex: 'M', height: 178, weight: 70, sbp: 122, dbp: 76, hr: 70, spo2: 99, hb: 14.5, anxiety: 1, asa: 1 },
      brief: '40-year-old man, ASA I, for laparoscopic cholecystectomy. No allergies, fasted, Mallampati I.',
      goals: ['Preoxygenate before induction', 'Smooth induction: MAP within 20 % of baseline', 'BIS 40–60 once intubated', 'Respond to incision without hypertension'],
      script: [
        { after: 'intubated', delay: 300, kind: 'prompt', text: 'Surgeon: “Ready for incision.”', action: 'incision', label: 'Incise' },
        { after: 'incision', delay: 240, kind: 'prompt', text: 'Surgeon: “Insufflating.”', action: 'pneumo_on', label: 'Insufflate' }
      ]
    },
    {
      id: 'hypotension', title: 'Post-induction hypotension', tag: 'Scenario 2',
      patient: { age: 72, sex: 'F', height: 160, weight: 62, sbp: 148, dbp: 82, hr: 66, spo2: 96, hb: 12.5, anxiety: 1.2, asa: 2 },
      brief: '72-year-old woman, ASA II (treated hypertension, medication taken this morning), for laparoscopic hernia repair.',
      goals: ['Anticipate the larger propofol effect with age', 'Detect MAP < 65 mmHg and treat within 2 min', 'Avoid MAP more than 20 % below baseline for > 5 min'],
      script: [
        { after: 'intubated', delay: 600, kind: 'prompt', text: 'Surgeon: “Ready for incision.”', action: 'incision', label: 'Incise' }
      ]
    },
    {
      id: 'light', title: 'Light anesthesia at intubation', tag: 'Scenario 3',
      patient: { age: 35, sex: 'M', height: 182, weight: 85, sbp: 132, dbp: 84, hr: 82, spo2: 98, hb: 15, anxiety: 1.5, asa: 1 },
      brief: '35-year-old man, anxious, for elective shoulder arthroscopy. Try intubating with propofol alone, then repeat with remifentanil.',
      goals: ['Observe the pressor response to laryngoscopy', 'Use TOL and effect-site levels to time intubation', 'Prevent the response on the second attempt'],
      script: []
    },
    {
      id: 'apnea', title: 'Apnea and desaturation', tag: 'Scenario 4',
      patient: { age: 50, sex: 'F', height: 163, weight: 92, sbp: 136, dbp: 84, hr: 78, spo2: 96, hb: 13, anxiety: 1, asa: 2 },
      brief: '50-year-old woman, BMI 35, for elective surgery. Explore how preoxygenation, FRC and apnea time interact.',
      goals: ['Compare apnea tolerance with and without preoxygenation', 'Recognize falling SpO₂ before it reaches 90 %', 'Rescue with bag-mask ventilation'],
      script: [
        { after: 'start', delay: 5, kind: 'note', text: 'Hint: try one induction without preoxygenation, then restart and preoxygenate for 3 min.' }
      ]
    }
  ];
  global.Scenarios = SCENARIOS;
})(window);
