import { clamp } from './noise.js';

// HUD: compass strip, location card, body meters, prompts and toasts. The map is map.js.
// Prompts are written with keyboard keys in brackets ("[Z] sleep"); `keys()`
// turns them into keycaps, Xbox buttons or touch-button names for whatever
// you're playing with.

const $ = (id) => document.getElementById(id);
const ft = (m) => Math.round(m * 3.28084).toLocaleString();

// keyboard key -> [pad button, style] and touch label
const PAD = { Space: ['A', 'a'], E: ['B', 'b'], C: ['X', 'x'], V: ['R3'], T: ['↑'], H: ['LB'], F: ['RB'], Z: ['LT'], Shift: ['RT'], M: ['View'], Tab: ['View'], B: ['↓'], N: ['←'], U: ['Y', 'y'], Esc: ['Menu'], Enter: ['A', 'a'] };
const TOUCH = { Space: 'Hop', E: 'Grab', C: 'Camp', F: 'Fire', Z: 'Rest', H: 'Together', V: 'Cam', T: 'Tool', B: 'Fish', N: 'Roast', U: 'Ride', M: 'Map', Tab: 'Map', Shift: 'Fast', Esc: 'Pause', Enter: 'Travel' };
const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** HTML for one key in the current input mode. */
export function keyCap(k, mode) {
  if (mode === 'pad' && PAD[k]) return `<span class="key pad ${PAD[k][1] || ''}">${PAD[k][0]}</span>`;
  if (mode === 'touch' && TOUCH[k]) return `<span class="key">${TOUCH[k]}</span>`;
  return `<span class="key">${k}</span>`;
}

/** Text with [Key] markers as HTML keycaps for the current input mode. */
export function keys(text, mode) {
  return esc(text).replace(/\[([A-Za-z]+)\]/g, (_, k) => keyCap(k, mode));
}

// small line icons for the sky
const ICON = {
  Clear: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
  Night: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>',
  Partly: '<path d="M8 4.5v1.5M3.5 9H5M4.8 5.8l1 1M13 9a4.5 4.5 0 0 0-8.4-1.5"/><path d="M7 19h10a3.5 3.5 0 0 0 .4-7A5 5 0 0 0 8 12.5 3.3 3.3 0 0 0 7 19z"/>',
  Cloud: '<path d="M6.5 19h11a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.2A3.4 3.4 0 0 0 6.5 19z"/>',
  Rain: '<path d="M6.5 15h11a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.2A3.4 3.4 0 0 0 6.5 15z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  Snow: '<path d="M6.5 15h11a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.2A3.4 3.4 0 0 0 6.5 15z"/><path d="M8 19h.01M12 21h.01M16 19h.01M10 21.5h.01M14 18.5h.01"/>',
  Storm: '<path d="M6.5 15h11a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.2A3.4 3.4 0 0 0 6.5 15z"/><path d="M12.5 15l-2 3.5h3l-2 3.5"/>',
  Fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
};
const iconFor = (label, night) => ICON[{ Clear: night ? 'Night' : 'Clear', 'Partly cloudy': 'Partly', 'Mostly cloudy': 'Cloud', 'Clouds building': 'Cloud', Overcast: 'Cloud', Rain: 'Rain', Sleet: 'Rain', Snow: 'Snow', Thunderstorm: 'Storm', Fog: 'Fog' }[label] || 'Clear'];
const svg = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export class Hud {
  constructor(world) {
    this.world = world;
    this.compass = $('compass').getContext('2d');
    this.mode = 'kbm';
    this.last = {};
  }

  /** Set text or HTML only when it changed (the HUD updates every frame). */
  #put(id, value, html = false) {
    if (this.last[id] === value) return;
    this.last[id] = value;
    if (html) $(id).innerHTML = value; else $(id).textContent = value;
  }

  update(s) {
    this.#drawCompass(s.yaw);
    this.#put('loc-name', s.place);
    this.#put('loc-sub', s.sub);
    this.#put('elev', `${ft(s.elev)} ft`);
    this.#put('clock', s.clock);
    this.#put('temp', `${Math.round(s.tempC * 9 / 5 + 32)}°F`);
    this.#put('wx', `${svg(iconFor(s.wx, s.night))}${esc(s.wx)}`, true);
    setBar('stamina', s.stamina);
    setBar('warmth', s.warmth);
    setBar('grip', s.grip);
    $('bar-grip').classList.toggle('hidden', !s.climbing && s.grip > 99);
    $('bars').classList.toggle('calm', s.stamina > 96 && s.warmth > 60 && !s.climbing);
    this.#put('hint', s.hint ? keys(s.hint, this.mode) + `<!--${this.mode}-->` : '', true);
    $('hint').classList.toggle('hidden', !s.hint);
    $('frost').style.opacity = clamp((35 - s.warmth) / 35, 0, 1) * 0.9;
    $('hurt').style.opacity = s.injured ? 0.35 : 0;
    this.#put('status', s.status);
    const bar = [['V', 'View'], ['T', 'Tool'], ['M', 'Map'], ['Esc', 'Menu']].map(([k, l]) => `<span>${keyCap(k, this.mode)}${l}</span>`).join('');
    this.#put('keys', bar + (s.tool ? `<span class="tool">${esc(s.tool)}</span>` : '') + `<!--${this.mode}-->`, true);
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = keys(text, this.mode);
    $('toasts').appendChild(el);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
    setTimeout(() => el.classList.add('out'), 3800);
    setTimeout(() => el.remove(), 4600);
  }

  discovery(title, sub, kicker = 'Discovered') {
    const el = $('discovery');
    el.querySelector('.d-kicker').textContent = kicker;
    el.querySelector('.d-title').textContent = title;
    el.querySelector('.d-sub').textContent = sub;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  #drawCompass(yaw) {
    const g = this.compass, W = g.canvas.width, H = g.canvas.height, k = W / 420;
    g.clearRect(0, 0, W, H);
    g.shadowColor = 'rgba(0,0,0,0.55)'; g.shadowBlur = 6 * k;
    // heading in degrees clockwise from north; yaw 0 faces north (-z)
    const heading = ((-yaw * 180 / Math.PI) % 360 + 360) % 360;
    const span = 120;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let d = Math.floor(heading - span / 2); d <= heading + span / 2; d++) {
      const dd = ((d % 360) + 360) % 360;
      const x = W / 2 + ((d - heading) / span) * W;
      if (dd % 45 === 0) {
        const lab = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' }[dd];
        g.fillStyle = dd === 0 ? '#f6d3bd' : '#ffffff';
        g.font = `${dd % 90 === 0 ? 600 : 500} ${(dd % 90 === 0 ? 15 : 12) * k}px Gabarito, system-ui, sans-serif`;
        g.fillText(lab, x, H / 2 + 1 * k);
      } else if (dd % 15 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.6)';
        g.fillRect(x - 0.6 * k, H / 2 - 3 * k, 1.2 * k, 6 * k);
      } else if (dd % 5 === 0) {
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.fillRect(x - 0.5 * k, H / 2 - 1.5 * k, 1 * k, 3 * k);
      }
    }
    g.fillStyle = '#f6d3bd';
    g.beginPath(); g.moveTo(W / 2 - 4 * k, 0); g.lineTo(W / 2 + 4 * k, 0); g.lineTo(W / 2, 5 * k); g.fill();
    this.#put('heading', `${Math.round(heading)}°`);
  }
}

function setBar(name, v) {
  $(`bar-${name}`).querySelector('i').style.width = `${clamp(v, 0, 100)}%`;
  $(`bar-${name}`).classList.toggle('low', v < 25);
}
