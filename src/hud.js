import { clamp } from './noise.js';

// HUD: compass strip, location card, body meters, prompts, toasts and the map.

const $ = (id) => document.getElementById(id);
const ft = (m) => Math.round(m * 3.28084).toLocaleString();

export class Hud {
  constructor(world) {
    this.world = world;
    this.compass = $('compass').getContext('2d');
    this.toastQ = [];
    this.mapOpen = false;
    this.mapBase = null;
  }

  update(s) {
    this.#drawCompass(s.yaw);
    $('loc-name').textContent = s.place;
    $('loc-sub').textContent = s.sub;
    $('elev').textContent = `${ft(s.elev)} ft`;
    $('clock').textContent = s.clock;
    $('temp').textContent = `${Math.round(s.tempC * 9 / 5 + 32)}°F`;
    setBar('stamina', s.stamina);
    setBar('warmth', s.warmth);
    setBar('grip', s.grip);
    $('bar-grip').classList.toggle('hidden', !s.climbing && s.grip > 99);
    $('hint').textContent = s.hint;
    $('hint').classList.toggle('hidden', !s.hint);
    $('frost').style.opacity = clamp((35 - s.warmth) / 35, 0, 1) * 0.9;
    $('hurt').style.opacity = s.injured ? 0.35 : 0;
    $('status').textContent = s.status;
    if (this.mapOpen) this.drawMap(s);
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

  // ---------------------------------------------------------------- map
  buildMap(image) {
    const w = this.world, M = 2048;
    const cv = document.createElement('canvas');
    cv.width = cv.height = M;
    const g = cv.getContext('2d');
    g.drawImage(image, 0, 0, M, M);
    // hillshade and 40 m contours over the satellite image
    const img = g.getImageData(0, 0, M, M);
    const k = w.N / M;
    for (let r = 0; r < M; r++) {
      for (let c = 0; c < M; c++) {
        const sc = Math.floor(c * k), sr = Math.floor(r * k);
        const d = Math.max(1, Math.round(k));
        const gx = (w.gridH(sc + d, sr) - w.gridH(sc - d, sr)) / (2 * d * w.cell);
        const gz = (w.gridH(sc, sr + d) - w.gridH(sc, sr - d)) / (2 * d * w.cell);
        const shade = clamp(0.9 + (-gx * 0.7 - gz * 0.7) * 0.5, 0.6, 1.2);
        const e = w.gridH(sc, sr);
        const contour = Math.floor(e / 40) !== Math.floor(w.gridH(sc + d, sr) / 40) || Math.floor(e / 40) !== Math.floor(w.gridH(sc, sr + d) / 40);
        const m = shade * (contour ? (Math.floor(e / 40) % 5 === 4 ? 0.62 : 0.8) : 1);
        const i = (r * M + c) * 4;
        img.data[i] = clamp(img.data[i] * m * 1.1, 0, 255);
        img.data[i + 1] = clamp(img.data[i + 1] * m * 1.1, 0, 255);
        img.data[i + 2] = clamp(img.data[i + 2] * m * 1.1, 0, 255);
      }
    }
    g.putImageData(img, 0, 0);
    const S = M / w.N;
    g.fillStyle = '#3f6f8f';
    for (const lake of w.lakes) for (const [r, c0, c1] of lake.runs) g.fillRect(c0 * S, r * S, (c1 - c0 + 1) * S, S + 0.5);
    g.strokeStyle = '#5d95c4';
    for (const st of w.streams) {
      g.lineWidth = Math.max(1.2, st.width * S * 0.6);
      g.beginPath();
      st.pts.forEach(([x, z], i) => {
        const px = (x / w.cell + w.N / 2) * S, pz = (z / w.cell + w.N / 2) * S;
        if (i) g.lineTo(px, pz); else g.moveTo(px, pz);
      });
      g.stroke();
    }
    const line = (t) => {
      g.beginPath();
      t.pts.forEach(([x, z], i) => {
        const px = (x / w.cell + w.N / 2) * S, pz = (z / w.cell + w.N / 2) * S;
        if (i) g.lineTo(px, pz); else g.moveTo(px, pz);
      });
      g.stroke();
    };
    g.lineJoin = g.lineCap = 'round';
    for (const t of w.trails) { g.strokeStyle = 'rgba(20,16,12,0.6)'; g.lineWidth = t.kind === 'road' ? 8 : 6; g.setLineDash([]); line(t); }
    for (const t of w.trails) {
      g.strokeStyle = t.kind === 'road' ? '#efe3c6' : t.kind === 'track' ? '#d8b98a' : '#ff7b54';
      g.lineWidth = t.kind === 'road' ? 5 : 3.5;
      g.setLineDash(t.kind === 'trail' ? [12, 5] : t.kind === 'track' ? [5, 5] : []);
      line(t);
    }
    g.setLineDash([]);
    this.mapBase = cv;
  }

  drawMap(s) {
    const cv = $('map-canvas'), g = cv.getContext('2d');
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio;
    const w = this.world, side = Math.min(W, H);
    const ox = (W - side) / 2, oy = (H - side) / 2;
    g.fillStyle = '#14120f';
    g.fillRect(0, 0, W, H);
    g.drawImage(this.mapBase, ox, oy, side, side);
    const P = (x, z) => [ox + (x / w.extent + 0.5) * side, oy + (z / w.extent + 0.5) * side];
    g.font = `${Math.round(11 * devicePixelRatio)}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    for (const p of w.places) {
      const [x, y] = P(p.x, p.z);
      const known = p.kind === 'lake' ? s.discovered.has(p.name) : p.kind === 'peak' ? s.discovered.has(`peak:${p.name}`) : true;
      g.fillStyle = p.kind === 'peak' ? '#fff3c4' : p.kind === 'trailhead' ? '#ffd1a6' : '#e8f2ff';
      if (p.kind === 'peak') { g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 5, y + 4); g.lineTo(x - 5, y + 4); g.fill(); }
      else { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
      g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 3;
      if (p.kind === 'lake' && !known) continue; // undiscovered lakes stay unlabelled dots
      const label = `${known && p.kind !== 'trailhead' ? '✓ ' : ''}${p.name}${p.kind === 'peak' ? ` ${ft(p.elev)}′` : ''}`;
      g.strokeText(label, x + 7, y); g.fillText(label, x + 7, y);
    }
    if (s.tent) {
      const [x, y] = P(s.tent.x, s.tent.z);
      g.fillStyle = '#ff8a3a';
      g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 6, y + 4); g.lineTo(x - 6, y + 4); g.fill();
    }
    const [px, py] = P(s.x, s.z);
    g.save();
    g.translate(px, py);
    g.rotate(-s.yaw);
    g.fillStyle = '#ffb15a'; g.strokeStyle = '#000'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.stroke(); g.fill();
    g.restore();
    $('map-legend').textContent = `${s.lakesFound} / ${s.lakesTotal} lakes · ${s.peaksFound} / ${s.peaksTotal} summits · ${s.km.toFixed(1)} km hiked`;
  }
}

function setBar(name, v) {
  $(`bar-${name}`).querySelector('i').style.width = `${clamp(v, 0, 100)}%`;
  $(`bar-${name}`).classList.toggle('low', v < 25);
}
