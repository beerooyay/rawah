import { clamp } from './noise.js';

// The map and quick travel. The base is the satellite image with hillshade
// and 40 m contours, plus the lakes, streams and trails; on top go the places,
// your tent and car, you, and a travel cursor. Pick any named place from the
// list or point anywhere on the map, and you fly there (main.js runs the flight).
//
// Mouse: wheel zooms at the pointer, drag pans, click picks, double-click or
// the button travels. Touch: tap picks, drag pans, pinch zooms. Gamepad: the
// left stick drives the cursor, the right stick pans, the triggers zoom, the
// D-pad steps through the list, A travels, Y finds you, and B closes.

const $ = (id) => document.getElementById(id);
const ft = (m) => Math.round(m * 3.28084).toLocaleString();
const SNAP = 22;          // CSS px: how close the pointer must be to a place to pick it
const MAX_ZOOM = 6;

export class GameMap {
  constructor(world) {
    this.world = world;
    this.open = false;
    this.base = null;
    this.zoom = 1;
    this.cx = 0; this.cz = 0;          // world point at the centre of the view
    this.cursor = null;                // [x, z] world point under the pad cursor or last pick
    this.sel = null;                   // the picked destination
    this.list = [];
    this.index = -1;
    this.onTravel = () => {};
    this.state = null;                 // last HUD state (discovered, tent, player)
    this.#bind();
  }

  // ---------------------------------------------------------------- base image
  build(image) {
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
    const path = (pts) => {
      g.beginPath();
      pts.forEach(([x, z], i) => {
        const px = (x / w.cell + w.N / 2) * S, pz = (z / w.cell + w.N / 2) * S;
        if (i) g.lineTo(px, pz); else g.moveTo(px, pz);
      });
      g.stroke();
    };
    g.strokeStyle = '#5d95c4';
    for (const st of w.streams) { g.lineWidth = Math.max(1.2, st.width * S * 0.6); path(st.pts); }
    g.lineJoin = g.lineCap = 'round';
    for (const t of w.trails) { g.strokeStyle = 'rgba(20,16,12,0.6)'; g.lineWidth = t.kind === 'road' ? 8 : 6; g.setLineDash([]); path(t.pts); }
    for (const t of w.trails) {
      g.strokeStyle = t.kind === 'road' ? '#efe3c6' : t.kind === 'track' ? '#d8b98a' : '#ff7b54';
      g.lineWidth = t.kind === 'road' ? 5 : 3.5;
      g.setLineDash(t.kind === 'trail' ? [12, 5] : t.kind === 'track' ? [5, 5] : []);
      path(t.pts);
    }
    g.setLineDash([]);
    this.base = cv;
  }

  // ---------------------------------------------------------------- open / close
  show(s) {
    this.open = true;
    this.state = s;
    this.zoom = 1;
    this.cx = 0; this.cz = 0;
    this.cursor = null;
    this.#buildList(s);
    this.sel = null; this.index = -1;
    $('map').classList.remove('hidden');
    this.#renderInfo();
  }

  hide() {
    this.open = false;
    $('map').classList.add('hidden');
  }

  // ---------------------------------------------------------------- destinations
  #buildList(s) {
    const w = this.world, out = [];
    const known = (p) => (p.kind === 'lake' ? s.discovered.has(p.name) : p.kind === 'peak' ? s.discovered.has(`peak:${p.name}`) : false);
    if (s.tent) out.push({ kind: 'tent', name: 'Your camp', x: s.tent.x, z: s.tent.z, group: 'Camp' });
    if (w.carSpot) out.push({ kind: 'car', name: 'Your car', x: w.carSpot.x, z: w.carSpot.z, group: 'Camp' });
    const by = (k) => w.places.filter((p) => p.kind === k);
    for (const p of by('trailhead')) out.push({ kind: 'trailhead', name: p.name, x: p.x, z: p.z, place: p, group: 'Trailheads' });
    for (const p of [...by('peak')].sort((a, b) => b.elev - a.elev)) out.push({ kind: 'peak', name: p.name, x: p.x, z: p.z, elev: p.elev, place: p, group: 'Summits', known: known(p) });
    for (const p of [...by('lake')].sort((a, b) => a.name.localeCompare(b.name) || a.x - b.x)) {
      const lake = w.lakeAt(p.x, p.z) || w.lakes.filter((l) => l.name === p.name).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      out.push({ kind: 'lake', name: p.name, x: p.x, z: p.z, elev: lake ? lake.level : p.elev, place: p, lake, group: 'Lakes', known: known(p) });
    }
    this.list = out;
    const el = $('map-list');
    el.innerHTML = '';
    let group = '';
    out.forEach((d, i) => {
      if (d.group !== group) {
        group = d.group;
        const h = document.createElement('h4');
        h.textContent = group;
        el.appendChild(h);
      }
      const b = document.createElement('button');
      b.className = `dest ${d.kind}${d.known ? ' known' : ''}`;
      b.innerHTML = `<span>${d.known ? '✓ ' : ''}${d.name}</span><small>${d.elev ? `${ft(d.elev)} ft` : ''}</small>`;
      b.onclick = (e) => { e.stopPropagation(); this.pick(i, true); };
      b.ondblclick = (e) => { e.stopPropagation(); this.pick(i, true); this.travel(); };
      d.el = b;
      el.appendChild(b);
    });
  }

  /** Select list entry i (and optionally centre the view on it). */
  pick(i, center = false) {
    this.index = (i + this.list.length) % this.list.length;
    const d = this.list[this.index];
    this.sel = d;
    this.cursor = [d.x, d.z];
    if (center) this.#centerOn(d.x, d.z, Math.max(this.zoom, 2.2));
    for (const o of this.list) o.el.classList.toggle('on', o === d);
    d.el.scrollIntoView({ block: 'nearest' });
    this.#renderInfo();
  }

  /** Pick whatever is under a world point: a place nearby on screen, a lake, or open ground. */
  pickAt(x, z) {
    const k = this.#scale() / devicePixelRatio;
    let best = -1, bd = SNAP;
    this.list.forEach((d, i) => {
      const dd = Math.hypot(d.x - x, d.z - z) * k;
      if (dd < bd) { bd = dd; best = i; }
    });
    this.cursor = [x, z];
    if (best >= 0) { this.pick(best); this.cursor = [x, z]; return; }
    const w = this.world;
    const lake = w.lakeAt(x, z);
    if (lake && lake.name) {
      const i = this.list.findIndex((d) => d.lake === lake);
      if (i >= 0) { this.pick(i); this.cursor = [x, z]; return; }
    }
    this.index = -1;
    for (const o of this.list) o.el.classList.remove('on');
    const e = w.height(x, z);
    const near = w.nearestTrail(x, z);
    const sub = lake ? 'Lake' : near.trail && near.d < 20 ? `On the ${near.trail.name}` : e > w.treeline(x, z) + 40 ? 'Alpine tundra' : 'Off trail';
    this.sel = { kind: 'point', name: sub, x, z, elev: lake ? lake.level : e, lake };
    this.#renderInfo();
  }

  travel() {
    if (!this.sel) return;
    const d = this.sel, lim = this.world.half - 60;
    d.x = clamp(d.x, -lim, lim); d.z = clamp(d.z, -lim, lim);
    this.hide();
    this.onTravel(d);
  }

  #renderInfo() {
    const d = this.sel, info = $('map-info');
    info.classList.toggle('hidden', !d);
    if (!d) return;
    const s = this.state;
    const dist = Math.hypot(d.x - s.x, d.z - s.z);
    const kind = { tent: 'Camp', car: 'Trailhead parking', trailhead: 'Trailhead', peak: 'Summit', lake: 'Lake', point: 'Waypoint' }[d.kind];
    info.querySelector('.mi-name').textContent = d.name;
    info.querySelector('.mi-sub').textContent = `${kind}${d.elev ? ` · ${ft(d.elev)} ft` : ''} · ${(dist / 1000).toFixed(1)} km away`;
  }

  // ---------------------------------------------------------------- view
  #scale() {
    const cv = $('map-canvas');
    const side = Math.min(cv.width, cv.height);
    return (side / this.world.extent) * this.zoom;
  }

  #centerOn(x, z, zoom = this.zoom) {
    this.zoom = clamp(zoom, 1, MAX_ZOOM);
    this.cx = x; this.cz = z;
    this.#clampView();
  }

  #clampView() {
    const lim = (this.world.extent / 2) * (1 - 1 / this.zoom);
    this.cx = clamp(this.cx, -lim, lim);
    this.cz = clamp(this.cz, -lim, lim);
  }

  /** Screen (device px) to world. */
  #toWorld(px, py) {
    const cv = $('map-canvas'), k = this.#scale();
    return [this.cx + (px - cv.width / 2) / k, this.cz + (py - cv.height / 2) / k];
  }

  #zoomAt(f, px, py) {
    const [x0, z0] = this.#toWorld(px, py);
    this.zoom = clamp(this.zoom * f, 1, MAX_ZOOM);
    const cv = $('map-canvas'), k = this.#scale();
    this.cx = x0 - (px - cv.width / 2) / k;
    this.cz = z0 - (py - cv.height / 2) / k;
    this.#clampView();
  }

  // ---------------------------------------------------------------- input
  #bind() {
    const cv = $('map-canvas');
    const pts = new Map();
    let drag = 0, pinch = 0;
    const dev = (e) => [e.offsetX * devicePixelRatio, e.offsetY * devicePixelRatio];
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, dev(e));
      drag = 0;
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const [x, y] = dev(e), [x0, y0] = pts.get(e.pointerId);
      pts.set(e.pointerId, [x, y]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) this.#zoomAt(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinch = d; drag = 99;
        return;
      }
      drag += Math.hypot(x - x0, y - y0);
      if (drag > 8 * devicePixelRatio) {
        const k = this.#scale();
        this.cx -= (x - x0) / k; this.cz -= (y - y0) / k;
        this.#clampView();
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const [x, y] = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = 0;
      if (drag <= 8 * devicePixelRatio && pts.size === 0) this.pickAt(...this.#toWorld(x, y));
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => pts.delete(e.pointerId));
    cv.addEventListener('dblclick', (e) => { this.pickAt(...this.#toWorld(...dev(e))); this.travel(); });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.#zoomAt(Math.exp(-Math.sign(e.deltaY) * 0.25), ...dev(e)); }, { passive: false });
    $('map-go').onclick = () => this.travel();
    $('map-close').onclick = () => this.onClose?.();
    addEventListener('keydown', (e) => {
      if (!this.open) return;
      const k = e.code;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); this.pick(this.index + (k === 'ArrowDown' ? 1 : -1), true); }
      else if (k === 'Enter' || k === 'KeyF') this.travel();
      else if (k === 'Equal' || k === 'NumpadAdd') this.#zoomAt(1.3, cv.width / 2, cv.height / 2);
      else if (k === 'Minus' || k === 'NumpadSubtract') this.#zoomAt(1 / 1.3, cv.width / 2, cv.height / 2);
      else if (k === 'KeyY' || k === 'Space') { e.preventDefault(); this.#centerOn(this.state.x, this.state.z, Math.max(this.zoom, 2.5)); }
    });
  }

  /** Gamepad buttons while the map is open. Returns true if it used the press. */
  pad(name, stickOnly) {
    if (stickOnly) return true; // the left stick is the cursor here, not the list
    if (name === 'Down' || name === 'Right') this.pick(this.index + 1, true);
    else if (name === 'Up' || name === 'Left') this.pick(this.index - 1, true);
    else if (name === 'A') this.travel();
    else if (name === 'Y') this.#centerOn(this.state.x, this.state.z, Math.max(this.zoom, 2.5));
    else return false;
    return true;
  }

  /** Per-frame analog input: left stick moves the cursor, right stick pans, triggers zoom. */
  analog(dt, move, look, lt, rt) {
    const cv = $('map-canvas'), k = this.#scale();
    if (lt > 0.05 || rt > 0.05) this.#zoomAt(Math.exp((rt - lt) * dt * 2.2), cv.width / 2, cv.height / 2);
    if (Math.hypot(...look) > 0) {
      this.cx += look[0] * dt * 900 / k * devicePixelRatio;
      this.cz += look[1] * dt * 900 / k * devicePixelRatio;
      this.#clampView();
    }
    if (Math.hypot(...move) > 0) {
      const c = this.cursor || [this.cx, this.cz];
      const speed = 520 / k * devicePixelRatio;
      const x = clamp(c[0] + move[0] * dt * speed, -this.world.half, this.world.half);
      const z = clamp(c[1] + move[1] * dt * speed, -this.world.half, this.world.half);
      // keep the cursor on screen by pushing the view
      const mx = (cv.width / 2 - 40 * devicePixelRatio) / k, mz = (cv.height / 2 - 40 * devicePixelRatio) / k;
      if (x < this.cx - mx) this.cx = x + mx; else if (x > this.cx + mx) this.cx = x - mx;
      if (z < this.cz - mz) this.cz = z + mz; else if (z > this.cz + mz) this.cz = z - mz;
      this.#clampView();
      this.pickAt(x, z);
    }
  }

  // ---------------------------------------------------------------- draw
  draw(s) {
    this.state = s;
    const cv = $('map-canvas'), g = cv.getContext('2d');
    const W = cv.width = cv.clientWidth * devicePixelRatio, H = cv.height = cv.clientHeight * devicePixelRatio;
    const w = this.world, k = this.#scale(), dpr = devicePixelRatio;
    const P = (x, z) => [W / 2 + (x - this.cx) * k, H / 2 + (z - this.cz) * k];
    g.fillStyle = '#14120f';
    g.fillRect(0, 0, W, H);
    const [x0, y0] = P(-w.half, -w.half);
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.base, x0, y0, w.extent * k, w.extent * k);

    // a dashed line from you to the pick
    if (this.sel) {
      const [ax, ay] = P(s.x, s.z), [bx, by] = P(this.sel.x, this.sel.z);
      g.strokeStyle = 'rgba(255,177,90,0.85)'; g.lineWidth = 2 * dpr; g.setLineDash([6 * dpr, 6 * dpr]);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); g.setLineDash([]);
    }

    g.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`;
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const labelAll = this.zoom >= 1.8;
    for (const d of this.list) {
      const [x, y] = P(d.x, d.z);
      if (x < -50 || y < -50 || x > W + 50 || y > H + 50) continue;
      const on = d === this.sel;
      g.fillStyle = d.kind === 'peak' ? '#fff3c4' : d.kind === 'trailhead' || d.kind === 'car' ? '#ffd1a6' : d.kind === 'tent' ? '#ff8a3a' : '#e8f2ff';
      const r = (on ? 5 : 3.2) * dpr;
      g.beginPath();
      if (d.kind === 'peak' || d.kind === 'tent') { g.moveTo(x, y - r * 1.8); g.lineTo(x + r * 1.5, y + r * 1.2); g.lineTo(x - r * 1.5, y + r * 1.2); }
      else if (d.kind === 'car' || d.kind === 'trailhead') g.rect(x - r, y - r, r * 2, r * 2);
      else g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      if (!labelAll && d.kind === 'lake' && !d.known && !on) continue; // keep the overview uncluttered
      const label = `${d.known ? '✓ ' : ''}${d.name}${d.kind === 'peak' ? ` ${ft(d.elev)}′` : ''}`;
      g.strokeStyle = 'rgba(0,0,0,0.7)'; g.lineWidth = 3 * dpr;
      g.font = `${on ? 600 : 400} ${Math.round((on ? 13 : 11) * dpr)}px system-ui, sans-serif`;
      g.globalAlpha = d.kind === 'lake' && !d.known && !on ? 0.75 : 1;
      g.strokeText(label, x + 8 * dpr, y); g.fillText(label, x + 8 * dpr, y);
      g.globalAlpha = 1;
    }

    // the cursor / pick
    const c = this.cursor;
    if (c) {
      const [x, y] = P(c[0], c[1]);
      g.strokeStyle = '#ffb15a'; g.lineWidth = 2 * dpr;
      g.beginPath(); g.arc(x, y, 12 * dpr, 0, Math.PI * 2); g.stroke();
      g.beginPath();
      g.moveTo(x - 18 * dpr, y); g.lineTo(x - 7 * dpr, y); g.moveTo(x + 7 * dpr, y); g.lineTo(x + 18 * dpr, y);
      g.moveTo(x, y - 18 * dpr); g.lineTo(x, y - 7 * dpr); g.moveTo(x, y + 7 * dpr); g.lineTo(x, y + 18 * dpr);
      g.stroke();
    }

    // you
    const [px, py] = P(s.x, s.z);
    g.save();
    g.translate(px, py);
    g.scale(dpr, dpr);
    g.rotate(-s.yaw);
    g.fillStyle = '#ffb15a'; g.strokeStyle = '#000'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.stroke(); g.fill();
    g.restore();

    // scale bar
    const km = this.zoom > 3 ? 0.5 : 1, len = km * 1000 * k;
    g.fillStyle = 'rgba(244,241,234,0.9)';
    g.fillRect(24 * dpr, H - 30 * dpr, len, 3 * dpr);
    g.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`;
    g.fillText(`${km} km`, 24 * dpr + len + 8 * dpr, H - 28 * dpr);

    $('map-legend').textContent = `${s.lakesFound} / ${s.lakesTotal} lakes · ${s.peaksFound} / ${s.peaksTotal} summits · ${s.km.toFixed(1)} km hiked`;
  }
}
