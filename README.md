# Pulse Lab OR — case rehearsal simulator

Rehearse a general anesthetic on a virtual patient: dose drugs, manage the airway and ventilator,
respond to surgery, and see realistic monitor signals. Built from the
*Anesthesia Simulator Model Specification (Beta)*, model set A.

## Launch on a Mac

```bash
cd ~/Downloads/or-sim
bash start.command
```

Or simply double-click `index.html` (everything runs offline in the browser).

## How to use

1. **Set up a case:** pick a scenario (or free practice) and adjust age, sex, height, weight, preop BP/HR, SpO₂, Hb, anxiety.
2. **Run the clock:** ❚❚ / 1× / 2× / 4× / 8×, or skip +1 / +5 min. Space bar pauses.
3. **Give drugs:** click a dose (or type one) to *stage* it — a dashed **forecast** of MAP, HR, BIS and SpO₂ for the next 10 min appears on the trends with a summary. Press **Give now** (or Enter) to administer, Esc to cancel. Infusions use the − / + pump controls the same way.
4. **Airway:** preoxygenate, bag-mask ventilate, laryngoscopy & intubation (needs an unconscious patient; poor conditions if not paralysed), ventilator VT/RR/PEEP/FiO₂, extubate.
5. **Surgery:** incision, insufflation, end of surgery. Stimulation reaches the circulation in proportion to (1 − TOL).
6. **Debrief:** time hypotensive, time-to-treat, BIS out of range, SpO₂ nadir, awareness risk, drug totals and a timeline.
7. **Sound** (top right) turns on the pulse-oximeter tone, whose pitch falls with saturation, and alarm tones.

## Drugs and evidence grades

| Drug | Model | Grade |
| --- | --- | --- |
| Propofol | Schnider 1999 PK · Bouillon 2004 BIS/TOL · Kern 2004 LOC · Su 2023 hemodynamics | A |
| Remifentanil | Minto 1997 PK · Bouillon 2004 · Su 2023 | A |
| Rocuronium | Wierda 1991 PK · Masui 2018 PD | A |
| Norepinephrine | Li 2024 PK (A) · Li 2025 PD abstract | B |
| Sugammadex | 1:1 encapsulation of rocuronium | B |
| Phenylephrine, ephedrine, glycopyrrolate, esmolol | Calibrated to published effect sizes | C |

Syringe label colours follow ISO 26825 (induction yellow, opioid blue, relaxant red, vasopressor violet, anticholinergic green).

## Files

```
index.html          layout
css/app.css         OR-monitor styling
js/physio.js        physiology engine (PK, PD, Su 2023 hemodynamics, baroreflex, O2/CO2, airway)
js/pwa-model.js     Pulse Lab arterial-wave engine (pulse shape, central pressure, AIx)
js/monitor.js       sweeping waveforms and trend chart
js/scenarios.js     case library — add your own scenarios here
js/app.js           controller: drugs, forecast, alarms, sound, debrief
```

Educational use only. Not a medical device.
