const $ = id => document.getElementById(id);
const sectors = {
  A: { name: 'Foundry Row', level: 14, temp: 36, humidity: 78, air: 156, water: 4, reports: 24, prior: 8, help: 9, clinic: 19 },
  B: { name: 'Clinic depot', level: 12, temp: 27, humidity: 58, air: 74, water: 1, reports: 6, prior: 5, help: 2, clinic: 4 },
  C: { name: 'East junction', level: 14, temp: 32, humidity: 86, air: 118, water: 38, reports: 15, prior: 7, help: 6, clinic: 15 },
  D: { name: 'Pump House', level: 14, temp: 25, humidity: 55, air: 51, water: 2, reports: 4, prior: 3, help: 1, clinic: 14, capacity: 54 },
  E: { name: 'Spindle Hall', level: 14, temp: 26, humidity: 61, air: 61, water: 3, reports: 5, prior: 4, help: 2, clinic: 16, capacity: 40 }
};
const tunnels = [
  { from: 'A', to: 'C', minutes: 4, name: 'Foundry ramp', style: 'ac' },
  { from: 'C', to: 'D', minutes: 3, name: 'East corridor', style: 'cd', flood: true },
  { from: 'A', to: 'B', minutes: 3, name: 'Service ramp', style: 'ab', vertical: true },
  { from: 'C', to: 'E', minutes: 5, name: 'Lower ramp', style: 'ce', vertical: true },
  { from: 'B', to: 'E', minutes: 2, name: 'Clinic stairs', style: 'be', stairs: true }
];
let closed = false;
let selected = 'A';
let tick = 0;
let displayedAlert = '';
let audio;
let flashTimer;

function condition(id) {
  if (id === 'C') return closed ? ['×', 'Corridor closed', 'danger'] : ['⚠', 'Flood risk', 'risk'];
  if (id === 'A') return ['⚠', 'Heat + poor air', 'risk'];
  return ['✓', 'Stable', ''];
}

function sectorName(id) {
  return `Sector ${id} · ${sectors[id].name}`;
}

function route(start, end, stepFree) {
  const queue = [{ id: start, minutes: 0, path: [start], legs: [] }];
  const visited = new Set();
  while (queue.length) {
    queue.sort((a, b) => a.minutes - b.minutes);
    const next = queue.shift();
    if (visited.has(next.id)) continue;
    if (next.id === end) return next;
    visited.add(next.id);
    for (const tunnel of tunnels) {
      if ((tunnel.flood && closed) || (stepFree && tunnel.stairs)) continue;
      const id = tunnel.from === next.id ? tunnel.to : tunnel.to === next.id ? tunnel.from : null;
      if (id && !visited.has(id)) {
        queue.push({ id, minutes: next.minutes + tunnel.minutes, path: [...next.path, id], legs: [...next.legs, tunnel.name] });
      }
    }
  }
  return null;
}

function allocations(stepFree) {
  return ['D', 'E'].map(id => {
    const clinicRoute = route('B', id, stepFree);
    const areas = Object.entries(sectors).filter(([area, sector]) =>
      sector.reports > sector.prior && sector.clinic >= 12 && route(area, id, true));
    const reports = areas.reduce((total, [, sector]) => total + sector.reports, 0);
    const help = areas.reduce((total, [, sector]) => total + sector.help, 0);
    return { id, clinicRoute, reports, help, coverage: clinicRoute ? Math.min(sectors[id].capacity, reports) : 0 };
  }).sort((a, b) => b.coverage - a.coverage || b.help - a.help || (a.clinicRoute?.minutes ?? Infinity) - (b.clinicRoute?.minutes ?? Infinity));
}

function routeText(trip) {
  if (!trip.legs.length) return 'You are already here.';
  return `${trip.legs.join(' → ')} · ${trip.minutes} min`;
}

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
    const [icon, label, tone] = condition(id);
    button.setAttribute('aria-pressed', String(id === selected));
    button.innerHTML = `<strong>Sector ${id}</strong><small>Level ${sectors[id].level}</small><span class="${tone}"><span aria-hidden="true">${icon}</span> ${label}</span>`;
  }
  for (const tunnel of tunnels) {
    const edge = $('edge-' + tunnel.style);
    const blocked = tunnel.flood && closed;
    edge.classList.toggle('closed', blocked);
    const status = blocked ? 'Closed' : tunnel.stairs ? 'Stairs' : 'Step-free';
    edge.title = `${tunnel.name}, Sector ${tunnel.from} to Sector ${tunnel.to}. ${status}.`;
    edge.textContent = blocked ? '× Closed' : tunnel.stairs ? 'Stairs' : '';
  }
  const sector = sectors[selected];
  $('sector-detail').innerHTML = `<h3>${sectorName(selected)}</h3><p class="sector-meta">${sector.reports} symptom reports in 6h · ${sector.help} need help moving · ${sector.clinic} min to regular clinic</p>`;
}

function renderReadings() {
  $('sample-time').textContent = 'Sample ' + (tick + 1) + ' · updates every 5s';
  $('readings').innerHTML = Object.entries(sectors).map(([id, sector], index) => {
    const [icon, label, tone] = condition(id);
    const drift = (tick + index) % 3 - 1;
    const water = id === 'C' ? closed ? 54 + tick % 3 : sector.water + Math.min(tick, 6) : sector.water;
    return `<tr><th scope="row">L${sector.level} · ${id} · ${sector.name}</th><td class="${tone}"><span aria-hidden="true">${icon}</span> ${label}</td><td>${sector.temp + drift} °C</td><td>${sector.humidity + drift}%</td><td>AQI ${sector.air + drift * 2}</td><td>${water} cm</td><td>${sector.reports} / ${sector.prior}</td><td>${sector.help}</td></tr>`;
  }).join('');
}

function renderDispatch() {
  $('total-reports').textContent = Object.values(sectors).reduce((sum, sector) => sum + sector.reports, 0);
  $('total-help').textContent = Object.values(sectors).reduce((sum, sector) => sum + sector.help, 0);
  const options = allocations($('dispatch-access').checked);
  const best = options[0];
  $('recommendation').innerHTML = `
    <span class="chip"><span aria-hidden="true">ϟ</span> Power and mobile clinic</span>
    <p class="dispatch-site">${sectorName(best.id)}</p>
    <p class="muted">A step-free route reaches this refuge from sectors with ${best.reports} recent symptom reports and ${best.help} requests for help moving. The refuge has ${sectors[best.id].capacity} spaces.</p>
    <p class="route">From clinic depot · ${routeText(best.clinicRoute)}</p>
    <div class="allocation">
      ${options.map(option => `<div><span>${sectors[option.id].name}</span><strong>${option.clinicRoute ? option.coverage + ' priority places' : '× Route closed'}</strong></div>`).join('')}
      <p class="muted"><small>Priority goes to the site with room for the most reports from step-free sectors with rising symptoms and a longer trip to regular care. Help requests break ties.</small></p>
    </div>`;
  $('incident-button').textContent = closed ? 'Reset flood drill' : 'Close east corridor';
  $('incident-copy').textContent = closed
    ? 'Water reached the closure threshold. The east corridor is blocked and Pump House is cut off.'
    : 'Water is rising at East Junction. Close the corridor to see where the clinic and backup power move.';
  renderMap();
  renderReadings();
}

function residentAlert(signal = false) {
  const location = $('resident-sector').value;
  const target = allocations(true)[0].id;
  const trip = route(location, target, $('resident-access').checked);
  const status = closed ? 'Flood closure' : 'Flood risk';
  const action = !trip ? 'Request help moving.' : trip.legs.length ? `Move to Sector ${target} · ${sectors[target].name}.` : `Stay at ${sectors[target].name}.`;
  const detail = !trip ? 'No open route to the powered refuge. Use the form to request help.' : routeText(trip);
  const explanation = closed
    ? 'East corridor is closed between Sectors C and D.'
    : 'Rising water could close the east corridor in about 2 hours if the current rate holds.';
  displayedAlert = `${status}. ${action} ${detail}`;
  $('resident-alert').innerHTML = `<span class="chip ${closed ? 'danger' : 'risk'}"><span aria-hidden="true">⚠</span> ${status}</span><h2 id="alert-title">${action}</h2><p class="action-line">${detail}</p><p class="muted">${explanation}</p><button class="secondary" id="speak">Read directions aloud</button>`;
  $('speak').addEventListener('click', speak);
  if (signal) {
    $('announcement').textContent = displayedAlert;
    void signalAlert();
  }
}

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
      const Audio = window.AudioContext || window.webkitAudioContext;
      audio ??= new Audio();
      await audio.resume();
      for (const delay of [0, .24]) {
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime + delay;
        tone.frequency.value = 740;
        gain.gain.value = .12;
        gain.gain.setTargetAtTime(.001, start + .13, .015);
        tone.connect(gain).connect(audio.destination);
        tone.start(start);
        tone.stop(start + .19);
      }
      results.push('Two warning beeps played');
    } catch {
      results.push('Sound unavailable');
    }
  }
  $('signal-status').textContent = results.length ? results.join(' · ') : test ? 'Choose an alert signal to test.' : '';
}

function showView(resident) {
  $('resident').hidden = !resident;
  $('dispatcher').hidden = resident;
  $('resident-tab').setAttribute('aria-pressed', String(resident));
  $('dispatcher-tab').setAttribute('aria-pressed', String(!resident));
  $('page-title').textContent = resident ? 'Resident alerts' : 'Deep-level response';
  $('page-description').textContent = resident ? 'Check your route to the powered refuge, or request help moving.' : 'Coordinate cooling, safe passage, and mobile care across the deep levels.';
  if (resident) residentAlert();
}

$('resident-sector').innerHTML = Object.keys(sectors).map(id => `<option value="${id}">L${sectors[id].level} · ${sectorName(id)}</option>`).join('');
$('resident-tab').addEventListener('click', () => showView(true));
$('dispatcher-tab').addEventListener('click', () => showView(false));
$('display').addEventListener('change', event => {
  document.documentElement.dataset.display = event.target.value;
});
$('dispatch-access').addEventListener('change', renderDispatch);
$('resident-access').addEventListener('change', () => residentAlert());
$('resident-sector').addEventListener('change', () => {
  $('report-status').textContent = '';
  residentAlert();
});
$('map').addEventListener('click', event => {
  const node = event.target.closest('[data-sector]');
  if (!node) return;
  selected = node.dataset.sector;
  renderMap();
});
$('incident-button').addEventListener('click', () => {
  closed = !closed;
  tick = 0;
  renderDispatch();
  residentAlert(closed);
});
$('test-alert').addEventListener('click', () => void signalAlert(true));
$('report-form').addEventListener('submit', event => {
  event.preventDefault();
  const id = $('resident-sector').value;
  const sector = sectors[id];
  if (!$('symptom').value && !$('needs-help').checked) {
    $('report-status').textContent = 'Choose a symptom or request help moving.';
    return;
  }
  if ($('symptom').value) sector.reports++;
  if ($('needs-help').checked) sector.help++;
  $('report-form').reset();
  $('report-status').textContent = `Report added to the Sector ${id} totals.`;
  renderDispatch();
});
renderDispatch();
residentAlert();
setInterval(() => {
  tick++;
  if (!$('dispatcher').hidden) renderReadings();
}, 5000);
