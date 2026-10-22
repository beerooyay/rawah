import { clamp } from './noise.js';

// HUD: compass strip, location card, body meters, prompts and toasts. The map is map.js.

const $ = (id) => document.getElementById(id);
const ft = (m) => Math.round(m * 3.28084).toLocaleString();

export class Hud {
  constructor(world) {
    this.world = world;
    this.compass = $('compass').getContext('2d');
    this.toastQ = [];
  }

  update(s) {
    this.#drawCompass(s.yaw);
    $('loc-name').textContent = s.place;
    $('loc-sub').textContent = s.sub;
    $('elev').textContent = `${ft(s.elev)} ft`;
    $('clock').textContent = s.clock;
    $('temp').textContent = `${Math.round(s.tempC * 9 / 5 + 32)}°F`;
    $('wx').textContent = s.wx;
    setBar('stamina', s.stamina);
    setBar('warmth', s.warmth);
    setBar('grip', s.grip);
    $('bar-grip').classList.toggle('hidden', !s.climbing && s.grip > 99);
    $('hint').textContent = s.hint;
    $('hint').classList.toggle('hidden', !s.hint);
    $('frost').style.opacity = clamp((35 - s.warmth) / 35, 0, 1) * 0.9;
    $('hurt').style.opacity = s.injured ? 0.35 : 0;
    $('status').textContent = s.status;
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 3800);
    setTimeout(() => el.remove(), 4600);
  }

  discovery(title, sub) {
    const el = $('discovery');
    el.querySelector('.d-title').textContent = title;
    el.querySelector('.d-sub').textContent = sub;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  #drawCompass(yaw) {
    const g = this.compass, W = g.canvas.width, H = g.canvas.height;
    g.clearRect(0, 0, W, H);
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
        g.fillStyle = dd === 0 ? '#ffb15a' : '#f4f1ea';
        g.font = `${dd % 90 === 0 ? 700 : 500} ${dd % 90 === 0 ? 15 : 12}px system-ui, sans-serif`;
        g.fillText(lab, x, H / 2 + 2);
      } else if (dd % 15 === 0) {
        g.fillStyle = 'rgba(244,241,234,0.6)';
        g.fillRect(x - 0.5, H / 2 - 4, 1, 8);
      }
    }
    g.fillStyle = '#ffb15a';
    g.beginPath(); g.moveTo(W / 2 - 5, 0); g.lineTo(W / 2 + 5, 0); g.lineTo(W / 2, 6); g.fill();
    $('heading').textContent = `${Math.round(heading)}°`;
  }
}

function setBar(name, v) {
  $(`bar-${name}`).querySelector('i').style.width = `${clamp(v, 0, 100)}%`;
  $(`bar-${name}`).classList.toggle('low', v < 25);
}
