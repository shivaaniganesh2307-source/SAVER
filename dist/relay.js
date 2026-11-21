const $ = id => document.getElementById(id);

// ---- Simulation settings -------------------------------------------------
const TICK_MS = 3000;            // real time between simulation steps
const SIM_MIN = 10;              // simulated minutes per step
const START_MIN = 20 * 60;       // simulated clock starts at 20:00
const FLOOD_LIMIT = 60;          // cm of water at which the east corridor closes
const FLOOD_BUFFER = 90;         // min: don't plan routes through a corridor forecast to close sooner
const PUMP_FAILS_AFTER = 6;      // step after which East junction drainage stops keeping up
const HEAT_LIMIT = { temp: 32, air: 120 };  // above either → heat / air hazard
const COOL_SITE = { temp: 28, air: 100 };   // refuge must be at or below both
const SMALL_COUNT = 3;           // counts 1–2 are shown as "<3" so no household can be singled out

// history = symptom reports in each of the previous six 6-hour windows (the sector's normal)
const sectors = {
  A: { name: 'Foundry Row', level: 14, clinic: 19, help: 9, history: [6, 8, 7, 9, 8, 7] },
  B: { name: 'Clinic depot', level: 12, clinic: 4, help: 2, history: [5, 6, 4, 5, 6, 5],
       steady: { temp: 27, humidity: 58, air: 74, water: 1, reports: 6 } },
  C: { name: 'East junction', level: 14, clinic: 15, help: 6, history: [6, 7, 8, 6, 7, 7] },
  D: { name: 'Pump House', level: 14, clinic: 14, help: 1, capacity: 54, history: [3, 4, 3, 2, 3, 4],
       steady: { temp: 25, humidity: 55, air: 51, water: 2, reports: 4 } },
  E: { name: 'Spindle Hall', level: 14, clinic: 16, help: 2, capacity: 40, history: [4, 5, 4, 3, 5, 4],
       steady: { temp: 26, humidity: 61, air: 61, water: 3, reports: 5 } }
};
const REFUGES = ['D', 'E'];   // sites with backup power
const CLINIC = 'B';
const tunnels = [
  { from: 'A', to: 'C', minutes: 4, name: 'Foundry ramp', style: 'ac' },
  { from: 'C', to: 'D', minutes: 3, name: 'East corridor', style: 'cd', flood: true },
  { from: 'A', to: 'B', minutes: 3, name: 'Service ramp', style: 'ab', vertical: true },
  { from: 'C', to: 'E', minutes: 5, name: 'Lower ramp', style: 'ce', vertical: true },
  { from: 'B', to: 'E', minutes: 2, name: 'Clinic stairs', style: 'be', stairs: true }
];
// Demo family for the resident view. `at` = simulation step when each one sends a check-in.
const FAMILY = [
  { who: 'Mom', sector: 'B', at: 9, status: 'safe', note: 'At home' },
  { who: 'Brother', sector: 'C', at: 10, status: 'safe', note: 'Moving to the cooling refuge' },
  { who: 'Grandma', sector: 'D', at: 14, status: 'help', note: 'Needs help moving' }
];
const supplies = [
  ['Inhalers', 42], ['Oxygen concentrators', 3], ['Fever reducer doses', 160],
  ['Oral rehydration packs', 90], ['Cooling packs', 55], ['Water purification tablets', 300]
];

let state;
let selected = 'A';
let displayedAlert = '';
let residentKey = '';
let residentLoc = '';
let audio;
let flashTimer;

function reset() {
  state = { t: 0, closed: false, closedBy: '', closedAt: '', paused: false, waterLog: [], events: [], seen: new Set(), refuge: null,
            network: 'online', heard: {}, queue: [], mine: null,
            family: FAMILY.map(member => ({ ...member, delivered: null, hops: null })),
            extra: Object.fromEntries(Object.keys(sectors).map(id => [id, { reports: 0, help: 0 }])) };
  for (const t of [-2, -1, 0]) state.waterLog.push({ min: t * SIM_MIN, level: waterAt(t) });
  log('Simulation started. Monitoring Levels 12–14.');
  updateLinks();
  evaluate();
}

// ---- Scenario ------------------------------------------------------------
const ramp = (t, start, length) => Math.max(0, Math.min(1, (t - start) / length));

function waterAt(t) {
  let level = 36;
  for (let i = 1; i <= t; i++) level += i <= PUMP_FAILS_AFTER || level >= FLOOD_LIMIT ? 0.5 : 3;
  return Math.min(level, 68);
}

function reading(id) {
  const t = state.t;
  const s = sectors[id];
  let r;
  if (id === 'A') {
    const heat = ramp(t, 0, 10);
    r = { temp: 31 + 5 * heat, humidity: 72 + 6 * heat, air: 110 + 46 * heat, water: 4, reports: 8 + Math.round(16 * ramp(t, 3, 9)) };
  } else if (id === 'C') {
    r = { temp: 33, humidity: 86, air: 118, water: waterAt(t), reports: 7 + Math.round(8 * ramp(t, 4, 10)) };
  } else {
    r = { ...s.steady };
  }
  return { ...r, temp: Math.round(r.temp * 10) / 10, air: Math.round(r.air),
           reports: r.reports + state.extra[id].reports, help: s.help + state.extra[id].help };
}

// ---- Network & relay -----------------------------------------------------
// Online: the Directorate network carries everything. Shutdown: phones pass messages to phones
// in neighbouring sectors, so a message only gets through where people can physically walk.
const online = () => state.network === 'online';

function hops(from, to) {
  if (online()) return 0;
  const trip = route(from, to, false);
  return trip ? trip.legs.length : null;
}

const reachable = id => hops(id, CLINIC) !== null;
const hopText = n => (n === 0 ? (online() ? 'network' : 'direct') : `${n} relay hop${n > 1 ? 's' : ''}`);

function updateLinks() {
  for (const id of Object.keys(sectors)) {
    if (reachable(id)) state.heard[id] = { t: state.t, r: reading(id) };
  }
  const ready = state.queue.filter(q => reachable(q.id));
  if (ready.length) {
    for (const q of ready) {
      if (q.report) state.extra[q.id].reports++;
      if (q.help) state.extra[q.id].help++;
    }
    state.queue = state.queue.filter(q => !reachable(q.id));
    const from = [...new Set(ready.map(q => q.id))].join(', ');
    log(`${ready.length} queued report${ready.length > 1 ? 's' : ''} synced from Sector ${from}.`);
  }
  const loc = $('resident-sector').value;
  for (const member of state.family) {
    const h = hops(member.sector, loc);
    if (member.at <= state.t && !member.delivered && h !== null) {
      member.delivered = clock();
      member.hops = h;
    }
  }
  if (state.mine) {
    for (const member of state.family) {
      if (state.mine.pending.includes(member.who) && hops(loc, member.sector) !== null) {
        state.mine.pending = state.mine.pending.filter(name => name !== member.who);
      }
    }
  }
}

// ---- Analysis ------------------------------------------------------------
// Compare this window's reports with the sector's own normal (mean and spread of past windows).
function baseline(id) {
  const history = sectors[id].history;
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const spread = Math.max(1, Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length));
  const current = reading(id).reports;
  const z = (current - mean) / spread;
  return { mean, current, prior: history.at(-1), z, ratio: current / mean, flagged: z >= 2 && current - mean >= 4 };
}

// Flood forecast: rise rate over the last 30 simulated minutes, extrapolated to the closure limit.
function forecast() {
  const samples = state.waterLog.slice(-3);
  const first = samples[0];
  const last = samples.at(-1);
  const window = last.min - first.min;
  const rate = window ? (last.level - first.level) / window : 0;
  const eta = rate > 0.001 ? Math.max(0, (FLOOD_LIMIT - last.level) / rate) : Infinity;
  return { level: last.level, first: first.level, window, rate, eta };
}

function floodPlanningRisk() {
  return !state.closed && forecast().eta <= FLOOD_BUFFER;
}

function hazards(id) {
  const r = reading(id);
  const list = [];
  if (!route(id, CLINIC, false)) list.push(['×', 'Cut off from clinic', 'danger']);
  if (id === 'C') {
    const f = forecast();
    if (state.closed) list.push(['×', 'Corridor closed', 'danger']);
    else if (f.eta <= 180) list.push(['⚠', `Flood in ~${duration(f.eta)}`, 'risk']);
    else if (f.rate > 0.01) list.push(['≈', 'Water rising slowly', '']);
  }
  if (r.temp >= HEAT_LIMIT.temp || r.air >= HEAT_LIMIT.air) list.push(['⚠', 'Heat + poor air', 'risk']);
  const b = baseline(id);
  if (b.flagged) list.push(['!', `Symptoms ${b.ratio.toFixed(1)}× normal`, 'risk']);
  return list;
}

const urgent = id => hazards(id).filter(h => h[2]);

function route(start, end, stepFree, avoidFloodRisk = false) {
  const queue = [{ id: start, minutes: 0, legs: [] }];
  const visited = new Set();
  while (queue.length) {
    queue.sort((a, b) => a.minutes - b.minutes);
    const next = queue.shift();
    if (visited.has(next.id)) continue;
    if (next.id === end) return next;
    visited.add(next.id);
    for (const tunnel of tunnels) {
      if (tunnel.flood && (state.closed || avoidFloodRisk)) continue;
      if (stepFree && tunnel.stairs) continue;
      const id = tunnel.from === next.id ? tunnel.to : tunnel.to === next.id ? tunnel.from : null;
      if (id && !visited.has(id)) queue.push({ id, minutes: next.minutes + tunnel.minutes, legs: [...next.legs, tunnel.name] });
    }
  }
  return null;
}

// Pick the cooling refuge + mobile clinic site.
function refuges(stepFree) {
  const avoid = floodPlanningRisk();
  const f = forecast();
  const needy = Object.keys(sectors).filter(id => urgent(id).length);
  return REFUGES.map(id => {
    const r = reading(id);
    const clinicRoute = route(CLINIC, id, stepFree, avoid);
    const cool = r.temp <= COOL_SITE.temp && r.air <= COOL_SITE.air;
    const served = needy.filter(s => route(s, id, true, avoid));
    const reports = served.reduce((n, s) => n + reading(s).reports, 0);
    const help = served.reduce((n, s) => n + reading(s).help, 0);
    let reason = '';
    if (!clinicRoute) {
      reason = !route(CLINIC, id, stepFree)
        ? (state.closed ? 'Route closed' : 'No step-free route')
        : `Skipped · corridor floods in ~${duration(f.eta)}`;
    } else if (!cool) reason = 'Too hot for a refuge';
    const eligible = !reason;
    return { id, r, clinicRoute, served, reports, help, eligible, reason,
             coverage: eligible ? Math.min(sectors[id].capacity, reports + help) : 0 };
  }).sort((a, b) => b.eligible - a.eligible || b.coverage - a.coverage || a.r.temp - b.r.temp ||
    (a.clinicRoute?.minutes ?? Infinity) - (b.clinicRoute?.minutes ?? Infinity));
}

function priority() {
  return Object.keys(sectors)
    .filter(id => urgent(id).length && id !== CLINIC)
    .map(id => ({ id, b: baseline(id) }))
    .sort((a, b) => b.b.flagged - a.b.flagged || b.b.z - a.b.z)[0];
}

// ---- Events --------------------------------------------------------------
function clock(t = state.t) {
  const m = START_MIN + t * SIM_MIN;
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function duration(min) {
  if (!isFinite(min)) return '—';
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function log(text) {
  state.events.push({ time: clock(), text });
}

function once(key, condition, text) {
  if (condition && !state.seen.has(key)) {
    state.seen.add(key);
    log(text);
  }
}

function evaluate() {
  const f = forecast();
  for (const id of Object.keys(sectors)) {
    const r = reading(id);
    const b = baseline(id);
    once('heat' + id, r.temp >= HEAT_LIMIT.temp || r.air >= HEAT_LIMIT.air,
      `Sector ${id} over heat/air limits (${r.temp} °C, AQI ${r.air}).`);
    once('spike' + id, b.flagged,
      `Sector ${id}: ${b.current} symptom reports in 6h vs a normal of ${b.mean.toFixed(1)}. Flagged for the care team to investigate.`);
  }
  once('fast', f.rate >= 0.2, `East junction water rising ${f.rate.toFixed(2)} cm/min. Drainage is no longer keeping up.`);
  once('buffer', floodPlanningRisk(), `Forecast: east corridor closes in ~${duration(f.eta)}. Refuge planning now avoids it.`);
  const best = refuges(true)[0];
  const site = best.eligible ? best.id : null;
  if (state.refuge !== null && site !== state.refuge) {
    log(site ? `Cooling refuge + mobile clinic moved to Sector ${site} · ${sectors[site].name}.` : 'No eligible refuge site. Dispatch teams directly.');
  }
  state.refuge = site;
}

function step() {
  state.t++;
  state.waterLog = [...state.waterLog, { min: state.t * SIM_MIN, level: waterAt(state.t) }].slice(-6);
  if (!state.closed && waterAt(state.t) >= FLOOD_LIMIT) closeCorridor('water sensor');
  updateLinks();
  evaluate();
  render();
}

function closeCorridor(by) {
  state.closed = true;
  state.closedBy = by;
  state.closedAt = clock();
  log(`East corridor closed (${by}). Pump House is cut off from the clinic.`);
}

// ---- Rendering -----------------------------------------------------------
const count = n => (n > 0 && n < SMALL_COUNT ? '<3' : String(n));
const sectorName = id => `Sector ${id} · ${sectors[id].name}`;
const conditions = id => (hazards(id).length ? hazards(id) : [['✓', 'Stable', '']]);
const routeText = trip => (trip.legs.length ? `${trip.legs.join(' → ')} · ${trip.minutes} min` : 'You are already here.');

function renderMap() {
  const map = $('map');
  if (!map.childElementCount) {
    map.innerHTML = Object.keys(sectors).map(id =>
      `<button class="node node-${id.toLowerCase()}" data-sector="${id}" aria-controls="sector-detail"></button>`
    ).join('') + tunnels.map(tunnel =>
      `<span id="edge-${tunnel.style}" class="edge edge-${tunnel.style} ${tunnel.vertical ? 'vertical' : ''} ${tunnel.stairs ? 'stairs' : ''}"></span>`
    ).join('');
  }
  for (const button of map.querySelectorAll('[data-sector]')) {
    const id = button.dataset.sector;
    button.setAttribute('aria-pressed', String(id === selected));
    button.innerHTML = `<strong>Sector ${id}</strong><small>Level ${sectors[id].level}</small>` +
      conditions(id).slice(0, 2).map(([icon, label, tone]) => `<span class="${tone}"><span aria-hidden="true">${icon}</span> ${label}</span>`).join('');
  }
  const risky = floodPlanningRisk();
  for (const tunnel of tunnels) {
    const edge = $('edge-' + tunnel.style);
    const blocked = tunnel.flood && state.closed;
    const atRisk = tunnel.flood && risky;
    edge.classList.toggle('closed', blocked || atRisk);
    const status = blocked ? 'Closed' : atRisk ? 'Flood risk' : tunnel.stairs ? 'Stairs' : 'Step-free';
    const visible = blocked ? '× Closed' : atRisk ? '⚠ Risk' : tunnel.stairs ? 'Stairs' : '';
    edge.title = `${tunnel.name}, Sector ${tunnel.from} to Sector ${tunnel.to}. ${status}.`;
    edge.innerHTML = `<span aria-hidden="true">${visible}</span><span class="sr-only">${edge.title}</span>`;
  }
  const live = reachable(selected);
  const r = live ? reading(selected) : state.heard[selected].r;
  const b = baseline(selected);
  const stale = live ? '' : ` · <span class="danger">no relay path, last heard ${clock(state.heard[selected].t)}</span>`;
  $('sector-detail').innerHTML = `<h3>${sectorName(selected)}</h3><p class="sector-meta">${count(r.reports)} symptom reports in 6h (normal ≈ ${b.mean.toFixed(1)}) · ${count(r.help)} need help moving · ${sectors[selected].clinic} min to regular clinic${stale}</p>`;
}

function renderReadings() {
  $('sample-time').textContent = `Updated ${clock()} · 1 step = ${SIM_MIN} simulated min`;
  $('readings').innerHTML = Object.entries(sectors).map(([id, sector], index) => {
    const live = reachable(id);
    const r = live ? reading(id) : state.heard[id].r;
    const link = live ? (online() ? 'Network' : (hops(id, CLINIC) === 0 ? 'Relay · direct' : hopText(hops(id, CLINIC))))
      : `<span class="danger">No path</span><br><small>last heard ${clock(state.heard[id].t)}</small>`;
    const b = baseline(id);
    const drift = ((state.t + index) % 3 - 1) * 0.3;   // sensor noise, display only
    const cond = conditions(id).map(([icon, label, tone]) => `<span class="${tone}"><span aria-hidden="true">${icon}</span> ${label}</span>`).join('<br>');
    return `<tr><th scope="row">L${sector.level} · ${id} · ${sector.name}</th><td>${cond}</td><td>${(r.temp + drift).toFixed(1)} °C</td><td>${Math.round(r.humidity + drift * 3)}%</td><td>AQI ${Math.round(r.air + drift * 6)}</td><td>${r.water.toFixed(1)} cm</td><td>${count(r.reports)} / ${count(b.prior)}${b.flagged ? ' <span class="risk">▲</span>' : ''}</td><td>${count(r.help)}</td><td>${link}</td></tr>`;
  }).join('');
}

function renderDispatch() {
  const all = Object.keys(sectors).map(reading);
  $('total-reports').textContent = all.reduce((sum, r) => sum + r.reports, 0);
  $('total-help').textContent = all.reduce((sum, r) => sum + r.help, 0);
  const f = forecast();
  $('flood-metric').innerHTML = state.closed ? '<span class="danger">Closed</span>' : isFinite(f.eta) ? `~${duration(f.eta)}` : 'Stable';
  $('flood-sub').textContent = `Water ${f.level.toFixed(1)} cm · closes at ${FLOOD_LIMIT} cm`;

  const top = priority();
  let priorityHtml = '<p class="dispatch-site">No sector needs priority</p><p class="muted">All sectors are within normal ranges.</p>';
  if (top) {
    const r = reading(top.id);
    const why = top.b.flagged
      ? `${top.b.current} symptom reports in the last 6 hours, up from ${count(top.b.prior)} (normal ≈ ${top.b.mean.toFixed(1)}). Worth investigating: reports are self-submitted, not diagnoses.`
      : `${urgent(top.id).map(h => h[1]).join(', ')} · ${r.temp} °C, AQI ${r.air}.`;
    priorityHtml = `<p class="dispatch-site">Prioritize Level ${sectors[top.id].level} · ${sectorName(top.id)}</p><p class="muted">${why}</p>`;
  }

  const options = refuges($('dispatch-access').checked);
  const best = options[0];
  const refugeHtml = best.eligible
    ? `<p class="dispatch-site">Set up in ${sectorName(best.id)}</p>
       <p class="muted">Coolest eligible site (${best.r.temp} °C, AQI ${best.r.air}) with backup power. Step-free from ${best.served.length ? (best.served.length > 1 ? 'Sectors ' : 'Sector ') + best.served.join(', ') : 'no hazard sectors'}: ${count(best.reports)} recent symptom reports, ${count(best.help)} need help moving. Room for ${sectors[best.id].capacity}.${best.reports + best.help > sectors[best.id].capacity ? ` <span class="risk">Demand may exceed space by ~${best.reports + best.help - sectors[best.id].capacity}: plan an overflow site.</span>` : ''}</p>
       <p class="route">From clinic depot · ${routeText(best.clinicRoute)}</p>`
    : '<p class="dispatch-site">No eligible refuge</p><p class="muted">Every powered site is cut off or too hot. Send teams directly to the priority sector.</p>';

  $('recommendation').innerHTML = `
    <div class="priority"><span class="chip risk"><span aria-hidden="true">!</span> Priority sector</span>${priorityHtml}</div>
    <span class="chip"><span aria-hidden="true">ϟ</span> Cooling refuge + mobile clinic</span>${refugeHtml}
    <div class="allocation">
      ${options.map(o => `<div><span>${sectors[o.id].name}</span><strong class="${o.eligible ? '' : 'danger'}">${o.eligible ? (o.id === best.id ? '✓ Selected' : 'Backup') : '× ' + o.reason}</strong></div>`).join('')}
      <p class="muted"><small>Refuge rule: has backup power, ≤ ${COOL_SITE.temp} °C and AQI ≤ ${COOL_SITE.air}, reachable from the clinic without a corridor forecast to flood within ${FLOOD_BUFFER} min. Then most people served, then coolest.</small></p>
    </div>`;

  const math = state.closed
    ? `Closed at ${state.closedAt} by ${state.closedBy}.\nWater now ${f.level.toFixed(1)} cm (limit ${FLOOD_LIMIT} cm).`
    : `Water at East junction: ${f.level.toFixed(1)} cm (limit ${FLOOD_LIMIT} cm)\n` +
      `Rise: ${f.first.toFixed(1)} → ${f.level.toFixed(1)} cm over ${f.window} min = ${f.rate.toFixed(2)} cm/min\n` +
      (isFinite(f.eta) ? `At this rate: limit reached in ~${duration(f.eta)} (≈ ${clock(state.t + f.eta / SIM_MIN)})` : 'Not rising: no closure forecast');
  $('forecast').textContent = math;
  $('incident-copy').textContent = state.closed
    ? 'The east corridor is blocked. Pump House can only be reached by a team on foot once the water drops.'
    : 'The corridor closes automatically when the water sensor hits the limit. A dispatcher can close it early.';
  $('incident-button').disabled = state.closed;
  $('pause-button').textContent = state.paused ? 'Resume' : 'Pause';
  $('sim-clock').innerHTML = `<span aria-hidden="true">◉</span> ${state.paused ? 'Paused' : 'Simulated'} · ${clock()}`;
}

function renderEvents() {
  $('events').innerHTML = state.events.slice(-8).reverse()
    .map(e => `<li><time>${e.time}</time><span>${e.text}</span></li>`).join('');
}

function explanation(loc, list) {
  const f = forecast();
  const r = reading(loc);
  return list.map(([, label]) => {
    if (label.startsWith('Cut off')) return 'The flooded east corridor is the only way out of this sector.';
    if (label === 'Corridor closed') return 'East corridor is closed between Sectors C and D.';
    if (label.startsWith('Flood')) return `Water is rising ${f.rate.toFixed(2)} cm/min. At this rate the east corridor closes in about ${duration(f.eta)}.`;
    if (label.startsWith('Heat')) return `Your sector is ${r.temp} °C with air quality index ${r.air}.`;
    return 'Symptom reports here are well above normal. A mobile clinic is being set up at the refuge.';
  }).join(' ');
}

function residentAlert(allowSignal = true) {
  const loc = $('resident-sector').value;
  const best = refuges(true)[0];
  const target = best.eligible ? best.id : null;
  const trip = target ? route(loc, target, $('resident-access').checked) : null;
  const list = urgent(loc);
  let status, tone, action, detail, why;
  if (!list.length) {
    status = 'All clear'; tone = '';
    action = 'No action needed.';
    detail = trip ? `Nearest cooling refuge: ${sectorName(target)} · ${routeText(trip)}` : 'No cooling refuge reachable right now.';
    why = 'Readings in your sector are within safe limits.';
  } else {
    status = list[0][1]; tone = list[0][2];
    action = !trip ? 'Request help moving.' : trip.legs.length ? `Move to ${sectorName(target)}.` : `Stay at ${sectors[target].name}.`;
    detail = trip ? routeText(trip) : 'No open route to the cooling refuge. Use the form to request help.';
    why = explanation(loc, list);
  }
  displayedAlert = `${status}. ${action} ${detail}`;
  const h = hops(CLINIC, loc);
  const source = online() ? `Via Hollow network · ${clock()}`
    : h === null ? 'Local sensors only · no relay path to dispatch. Your phone keeps your reports until one opens.'
    : `Via ${hopText(h)} from dispatch · ${clock()}`;
  $('resident-alert').innerHTML = `<span class="chip ${tone}"><span aria-hidden="true">${tone ? '⚠' : '✓'}</span> ${status}</span><h2 id="alert-title">${action}</h2><p class="action-line">${detail}</p><p class="muted">${why}</p><p class="source ${online() ? '' : 'relay'}">${source}</p><button class="secondary" id="speak">Read directions aloud</button>`;
  $('resident-alert').classList.toggle('clear', !tone);
  $('speak').addEventListener('click', speak);
  const key = `${status}|${action}|${detail}`;
  if (allowSignal && loc === residentLoc && key !== residentKey && tone) {
    $('announcement').textContent = displayedAlert;
    void signalAlert();
  }
  residentKey = key;
  residentLoc = loc;
}

function renderNetwork() {
  const queued = state.queue.length + state.family.filter(m => m.at <= state.t && !m.delivered).length + (state.mine?.pending.length ?? 0);
  $('net-banner').hidden = online();
  $('net-banner').innerHTML = `<strong><span aria-hidden="true">⚠</span> Directorate network down.</strong> Relay mode: messages hop phone to phone through the tunnels.${queued ? ` ${queued} message${queued > 1 ? 's' : ''} waiting for a path.` : ''}`;
  $('network-button').textContent = online() ? 'Simulate network shutdown' : 'Restore network';
  $('network-copy').textContent = online()
    ? 'Alerts, readings and reports travel over the Directorate network, which it can shut off at any time.'
    : `Relay mode. Each phone passes messages to phones in the next sector. ${Object.keys(sectors).filter(reachable).length} of 5 sectors can reach dispatch. Anything without a path is queued, not lost.`;
}

function renderFamily() {
  const loc = $('resident-sector').value;
  $('family').innerHTML = state.family.map(member => {
    const h = hops(member.sector, loc);
    let line;
    if (member.delivered) {
      const icon = member.status === 'safe' ? '✓' : '⚠';
      line = `<span class="${member.status === 'safe' ? 'ok' : 'risk'}"><span aria-hidden="true">${icon}</span> ${member.note}</span><small>${member.delivered} · via ${hopText(member.hops)}</small>`;
    } else if (h === null) {
      line = `<span class="danger"><span aria-hidden="true">×</span> No word yet</span><small>No relay path to Sector ${member.sector}. Their phone will send when one opens.</small>`;
    } else {
      line = '<span class="muted">No check-in yet</span><small>Path open · will arrive when they send</small>';
    }
    return `<li><div><strong>${member.who}</strong><small>Level ${sectors[member.sector].level} · ${sectorName(member.sector)}</small></div><div class="family-status">${line}</div></li>`;
  }).join('');
  if (state.mine) {
    const sent = state.family.length - state.mine.pending.length;
    $('safe-status').textContent = `You checked in at ${state.mine.time}. Delivered to ${sent} of ${state.family.length}` +
      (state.mine.pending.length ? `. ${state.mine.pending.join(', ')}: no path yet, retrying automatically.` : '.');
  } else {
    $('safe-status').textContent = 'One tap tells your family you are okay.';
  }
}

function renderToday() {
  const loc = $('resident-sector').value;
  const r = reading(loc);
  const minutesToMidnight = 24 * 60 - ((START_MIN + state.t * SIM_MIN) % (24 * 60));
  const best = refuges(true)[0];
  const refugeTrip = best.eligible ? route(loc, best.id, $('resident-access').checked) : null;
  const clinicTrip = route(loc, CLINIC, $('resident-access').checked);
  const safe = r.temp < HEAT_LIMIT.temp && r.air < HEAT_LIMIT.air;
  $('today').innerHTML = [
    ['◐', 'Your sector', `${r.temp} °C · AQI ${r.air} · ${safe ? 'within safe limits' : '<span class="risk">over heat/air limits</span>'}`],
    ['≈', 'Water ration', `Resets at 00:00 · in ${duration(minutesToMidnight)}`],
    ['ϟ', 'Cooling refuge', refugeTrip ? `${sectorName(best.id)} · open all night · ${refugeTrip.minutes} min away` : 'None reachable right now'],
    ['✚', 'Clinic depot', clinicTrip ? `Open · ${clinicTrip.minutes ? clinicTrip.minutes + ' min away' : 'you are here'}` : '<span class="danger">No route · use the help form</span>']
  ].map(([icon, label, value]) => `<li><span class="today-icon" aria-hidden="true">${icon}</span><div><strong>${label}</strong><span>${value}</span></div></li>`).join('');
}

function render() {
  renderNetwork();
  renderDispatch();
  renderMap();
  renderReadings();
  renderEvents();
  residentAlert();
  renderFamily();
  renderToday();
}

// ---- Alert signals -------------------------------------------------------
function speak() {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance !== 'function') {
    $('signal-status').textContent = 'Spoken directions are unavailable in this browser.';
    return;
  }
  window.speechSynthesis.cancel();
  const spoken = new SpeechSynthesisUtterance(displayedAlert.replaceAll('→', ', then ').replaceAll('·', ', '));
  spoken.onerror = event => {
    if (event.error !== 'interrupted' && event.error !== 'canceled') $('signal-status').textContent = 'This browser could not play spoken directions.';
  };
  window.speechSynthesis.speak(spoken);
}

async function signalAlert(test = false) {
  const results = [];
  if ($('vibration').checked) {
    results.push(navigator.vibrate?.([180, 100, 180]) ? 'Vibration requested' : 'Vibration unavailable');
  }
  if ($('flash').checked) {
    const surface = $('resident').hidden ? $('incident-button') : $('resident-alert');
    document.querySelector('.flash')?.classList.remove('flash');
    void surface.offsetWidth;
    surface.classList.add('flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => surface.classList.remove('flash'), 900);
    results.push('Visual signal shown');
  }
  if ($('sound').checked) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      audio ??= new AudioCtx();
      await audio.resume();
      for (const delay of [0, 0.24]) {
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime + delay;
        tone.frequency.value = 740;
        gain.gain.value = 0.12;
        gain.gain.setTargetAtTime(0.001, start + 0.13, 0.015);
        tone.connect(gain).connect(audio.destination);
        tone.start(start);
        tone.stop(start + 0.19);
      }
      results.push('Two warning beeps played');
    } catch {
      results.push('Sound unavailable');
    }
  }
  $('signal-status').textContent = results.length ? results.join(' · ') : test ? 'Choose an alert signal to test.' : '';
}

// ---- Wiring --------------------------------------------------------------
function showView(resident) {
  $('resident').hidden = !resident;
  $('dispatcher').hidden = resident;
  $('resident-tab').setAttribute('aria-pressed', String(resident));
  $('dispatcher-tab').setAttribute('aria-pressed', String(!resident));
  $('page-title').textContent = resident ? 'Resident alerts' : 'Deep-level response';
  $('page-description').textContent = resident ? 'Check your route to the cooling refuge, or request help moving.' : 'Coordinate cooling, safe passage, and mobile care across the deep levels.';
  residentAlert(false);
}

$('resident-sector').innerHTML = Object.keys(sectors).map(id => `<option value="${id}">L${sectors[id].level} · ${sectorName(id)}</option>`).join('');
$('supplies').innerHTML = supplies.map(([name, qty], i) =>
  `<label class="toggle"><input type="checkbox" data-supply="${i}"> ${name} <span class="muted">· ${qty} available</span></label>`).join('');
$('supplies').addEventListener('change', () => {
  const packed = [...$('supplies').querySelectorAll('input:checked')].map(box => supplies[box.dataset.supply][0]);
  $('pack-status').textContent = packed.length ? `Packed: ${packed.join(', ')}` : 'The clinic team chooses what to bring.';
});
$('resident-tab').addEventListener('click', () => showView(true));
$('dispatcher-tab').addEventListener('click', () => showView(false));
$('display').addEventListener('change', event => { document.documentElement.dataset.display = event.target.value; });
$('dispatch-access').addEventListener('change', renderDispatch);
$('resident-access').addEventListener('change', () => { residentAlert(false); renderToday(); });
$('resident-sector').addEventListener('change', () => {
  $('report-status').textContent = '';
  updateLinks();
  residentAlert(false);
  renderFamily();
  renderToday();
});
$('network-button').addEventListener('click', () => {
  state.network = online() ? 'shutdown' : 'online';
  log(online() ? 'Directorate network restored. Queued messages syncing.' : 'Directorate network shut down. Switched to phone-to-phone relay.');
  updateLinks();
  evaluate();
  render();
});
$('safe-button').addEventListener('click', () => {
  const loc = $('resident-sector').value;
  state.mine = { time: clock(), pending: state.family.filter(member => hops(loc, member.sector) === null).map(member => member.who) };
  renderFamily();
  renderNetwork();
});
$('map').addEventListener('click', event => {
  const node = event.target.closest('[data-sector]');
  if (!node) return;
  selected = node.dataset.sector;
  renderMap();
});
$('incident-button').addEventListener('click', () => {
  closeCorridor('dispatcher');
  evaluate();
  render();
});
$('pause-button').addEventListener('click', () => {
  state.paused = !state.paused;
  renderDispatch();
});
$('restart-button').addEventListener('click', () => {
  reset();
  residentKey = '';
  render();
});
$('test-alert').addEventListener('click', () => void signalAlert(true));
$('report-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = $('resident-sector').value;
  if (!$('symptom').value && !$('needs-help').checked) {
    $('report-status').textContent = 'Choose a symptom or request help moving.';
    return;
  }
  const report = Boolean($('symptom').value);
  const help = $('needs-help').checked;
  const h = hops(id, CLINIC);
  if (h === null) {
    state.queue.push({ id, report, help });
    $('report-status').textContent = 'No relay path to dispatch. Saved on your phone; it sends automatically when a path opens.';
  } else {
    if (report) state.extra[id].reports++;
    if (help) state.extra[id].help++;
    $('report-status').textContent = `Sent${online() ? '' : ` via ${hopText(h)}`}. Added to the Sector ${id} totals. Only sector counts are shared.`;
  }
  $('report-form').reset();
  evaluate();
  render();
});

reset();
render();
setInterval(() => { if (!state.paused) step(); }, TICK_MS);
