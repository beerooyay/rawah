import { clamp } from './noise.js';

// The map and quick travel. The base is the satellite image with hillshade
// and 40 m contours, plus the lakes, streams and trails; on top go the places,
// your tent and car, your friends, you, and a travel cursor. Pick any named
// place from the list (search it, or filter by kind), or point anywhere on the
// map, and you fly there (main.js runs the flight). Each named water appears
// once, however many pools it is made of.
//
// Mouse: wheel zooms at the pointer, drag pans, click picks, double-click or
// the button travels, / searches. Touch: tap picks, drag pans, pinch zooms.
// Gamepad: the left stick drives the cursor, the right stick pans, the
// triggers zoom, the D-pad steps through the list, the bumpers change the
// filter, A travels, Y finds you, and B closes.

const $ = (id) => document.getElementById(id);
const ft = (m) => Math.round(m * 3.28084).toLocaleString();
const SNAP = 22;          // CSS px: how close the pointer must be to a place to pick it
const MAX_ZOOM = 6;
const FONT = (w, px) => `${w} ${Math.round(px)}px Gabarito, system-ui, sans-serif`;
const FILTERS = [['all', 'All'], ['places', 'Places'], ['summit', 'Summits'], ['lake', 'Lakes']];
const GROUP_OF = { tent: 'places', car: 'places', trailhead: 'places', friend: 'places', peak: 'summit', lake: 'lake' };
const KIND = { tent: 'Camp', car: 'Trailhead parking', trailhead: 'Trailhead', peak: 'Summit', lake: 'Lake', friend: 'Friend', point: 'Waypoint' };
const dist = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

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
    this.filter = 'all';
    this.hover = null;
    this.visible = [];
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
    for (const t of w.trails) { g.strokeStyle = 'rgba(20,16,12,0.42)'; g.lineWidth = t.kind === 'road' ? 6.5 : 4.2; g.setLineDash([]); path(t.pts); }
    for (const t of w.trails) {
      g.strokeStyle = t.kind === 'road' ? '#efe3c6' : t.kind === 'track' ? '#d8b98a' : 'rgba(255,150,104,0.92)';
      g.lineWidth = t.kind === 'road' ? 4 : 2.4;
      g.setLineDash(t.kind === 'trail' ? [10, 6] : t.kind === 'track' ? [5, 5] : []);
      path(t.pts);
    }
    g.setLineDash([]);
    this.base = cv;
  }

  // ---------------------------------------------------------------- open / close
  show(s) {
    this.open = true;
    this.openedAt = performance.now();
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
    if (s.tent) out.push({ kind: 'tent', name: 'Your camp', x: s.tent.x, z: s.tent.z, group: 'Places' });
    if (w.carSpot) out.push({ kind: 'car', name: 'Your car', x: w.carSpot.x, z: w.carSpot.z, group: 'Places' });
    for (const f of s.friends || []) out.push({ kind: 'friend', name: f.name, x: f.x, z: f.z, group: 'Places' });
    const by = (k) => w.places.filter((p) => p.kind === k);
    for (const p of by('trailhead')) out.push({ kind: 'trailhead', name: p.name, x: p.x, z: p.z, place: p, group: 'Places' });
    for (const p of by('peak')) out.push({ kind: 'peak', name: p.name, x: p.x, z: p.z, elev: p.elev, place: p, group: 'Summits', known: known(p) });
    // one entry per named water: where a name belongs to several pools (Twin Lakes, Camp Lake) keep the biggest
    const lakes = new Map();
    for (const p of by('lake')) {
      const lake = w.lakeAt(p.x, p.z) || w.lakes.filter((l) => l.name === p.name).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      const d = { kind: 'lake', name: p.name, x: p.x, z: p.z, elev: lake ? lake.level : p.elev, place: p, lake, group: 'Lakes', known: known(p) };
      const prev = lakes.get(p.name);
      if (!prev || (lake?.area || 0) > (prev.lake?.area || 0)) lakes.set(p.name, d);
    }
    out.push(...lakes.values());
    for (const d of out) d.away = Math.hypot(d.x - s.x, d.z - s.z);
    // places first, then summits, then lakes; nearest first within each
    const order = { Places: 0, Summits: 1, Lakes: 2 };
    out.sort((a, b) => order[a.group] - order[b.group] || a.away - b.away);
    this.list = out;

    const el = $('map-list');
    el.innerHTML = '';
    this.groups = new Map();
    out.forEach((d, i) => {
      if (!this.groups.has(d.group)) {
        const h = document.createElement('h4');
        h.textContent = d.group;
        el.appendChild(h);
        this.groups.set(d.group, h);
      }
      const b = document.createElement('button');
      b.className = `dest ${d.kind}${d.known ? ' known' : ''}`;
      b.innerHTML = '<i class="ico"></i><span class="name"></span><small></small>';
      b.firstChild.classList.add(d.kind);
      b.querySelector('.name').textContent = d.name;
      b.querySelector('small').textContent = dist(d.away);
      b.onclick = (e) => { e.stopPropagation(); this.pick(i, true); };
      b.ondblclick = (e) => { e.stopPropagation(); this.pick(i, true); this.travel(); };
      d.el = b;
      el.appendChild(b);
    });
    this.empty = document.createElement('div');
    this.empty.className = 'empty hidden';
    this.empty.textContent = 'Nothing by that name.';
    el.appendChild(this.empty);

    const seg = $('map-filters');
    seg.innerHTML = '';
    for (const [id, label] of FILTERS) {
      const b = document.createElement('button');
      b.textContent = label; b.dataset.f = id; b.setAttribute('role', 'tab');
      b.onclick = () => this.setFilter(id);
      seg.appendChild(b);
    }
    this.filter = 'all';
    $('map-search').value = '';
    this.#applyFilter();
  }

  setFilter(id) {
    this.filter = id;
    this.#applyFilter();
  }

  cycleFilter(dir) {
    const i = FILTERS.findIndex(([id]) => id === this.filter);
    this.setFilter(FILTERS[(i + dir + FILTERS.length) % FILTERS.length][0]);
  }

  #applyFilter() {
    const q = $('map-search').value.trim().toLowerCase();
    this.visible = [];
    const seen = new Set();
    this.list.forEach((d, i) => {
      const show = (this.filter === 'all' || GROUP_OF[d.kind] === this.filter) && (!q || d.name.toLowerCase().includes(q));
      d.el.classList.toggle('hidden', !show);
      if (show) { this.visible.push(i); seen.add(d.group); }
    });
    for (const [g, h] of this.groups) h.classList.toggle('hidden', !seen.has(g));
    this.empty.classList.toggle('hidden', this.visible.length > 0);
    for (const b of $('map-filters').children) b.classList.toggle('on', b.dataset.f === this.filter);
    $('map-count').textContent = this.visible.length === this.list.length ? `${this.list.length} places` : `${this.visible.length} of ${this.list.length}`;
  }

  /** Step the selection through what the list currently shows. */
  step(dir) {
    if (!this.visible.length) return;
    const at = this.visible.indexOf(this.index);
    const next = at < 0 ? (dir > 0 ? 0 : this.visible.length - 1) : (at + dir + this.visible.length) % this.visible.length;
    this.pick(this.visible[next], true);
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
    const sub = lake ? 'Open water' : near.trail && near.d < 20 ? `On the ${near.trail.name}` : e > w.treeline(x, z) + 40 ? 'Alpine tundra' : 'Off trail';
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
    const away = Math.hypot(d.x - this.state.x, d.z - this.state.z);
    info.querySelector('.mi-kind').textContent = KIND[d.kind];
    info.querySelector('.mi-name').textContent = d.name;
    info.querySelector('.mi-sub').textContent = `${d.elev ? `${ft(d.elev)} ft · ` : ''}${dist(away)} away${d.known ? ' · visited' : ''}`;
    $('map-go').textContent = d.kind === 'point' ? 'Travel to this spot' : `Travel to ${d.kind === 'friend' ? d.name : 'here'}`;
  }

  // ---------------------------------------------------------------- view
  #scale() {
    const cv = $('map-canvas');
    const side = Math.min(cv.width, cv.height);
    return (side / this.world.extent) * this.zoom;
  }

  /** Screen x of the view centre: the middle of the part of the screen the list panel leaves free. */
  #mx() {
    const cv = $('map-canvas');
    return cv.width / 2 + (cv.clientWidth > 900 ? 158 : 113) * devicePixelRatio;
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
    return [this.cx + (px - this.#mx()) / k, this.cz + (py - cv.height / 2) / k];
  }

  #zoomAt(f, px, py) {
    const [x0, z0] = this.#toWorld(px, py);
    this.zoom = clamp(this.zoom * f, 1, MAX_ZOOM);
    const cv = $('map-canvas'), k = this.#scale();
    this.cx = x0 - (px - this.#mx()) / k;
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
      if (!pts.has(e.pointerId)) {
        // hovering: light up the place under the pointer
        if (e.pointerType !== 'mouse') return;
        const [wx, wz] = this.#toWorld(...dev(e)), k = this.#scale() / devicePixelRatio;
        let best = null, bd = SNAP;
        for (const d of this.list) { const dd = Math.hypot(d.x - wx, d.z - wz) * k; if (dd < bd) { bd = dd; best = d; } }
        this.hover = best;
        cv.classList.toggle('over', !!best);
        return;
      }
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
        cv.classList.add('drag');
        const k = this.#scale();
        this.cx -= (x - x0) / k; this.cz -= (y - y0) / k;
        this.#clampView();
      }
    });
    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      const [x, y] = pts.get(e.pointerId);
      pts.delete(e.pointerId);
      cv.classList.remove('drag');
      if (pts.size < 2) pinch = 0;
      if (drag <= 8 * devicePixelRatio && pts.size === 0) this.pickAt(...this.#toWorld(x, y));
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => pts.delete(e.pointerId));
    cv.addEventListener('dblclick', (e) => { this.pickAt(...this.#toWorld(...dev(e))); this.travel(); });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); this.#zoomAt(Math.exp(-Math.sign(e.deltaY) * 0.25), ...dev(e)); }, { passive: false });
    // a phone's follow-up click from the tap that opened the map lands on these: ignore it
    const settled = () => performance.now() - this.openedAt > 450;
    $('map-go').onclick = () => { if (settled()) this.travel(); };
    $('map-close').onclick = () => { if (settled()) this.onClose?.(); };
    $('map-zin').onclick = () => this.#zoomAt(1.5, this.#mx(), cv.height / 2);
    $('map-zout').onclick = () => this.#zoomAt(1 / 1.5, this.#mx(), cv.height / 2);
    $('map-find').onclick = () => this.#centerOn(this.state.x, this.state.z, Math.max(this.zoom, 2.5));
    const search = $('map-search');
    search.addEventListener('input', () => this.#applyFilter());
    search.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { search.value = ''; this.#applyFilter(); search.blur(); e.stopPropagation(); return; }
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { e.preventDefault(); this.step(e.code === 'ArrowDown' ? 1 : -1); }
      else if (e.code === 'Enter') { e.preventDefault(); if (this.index < 0) this.step(1); this.travel(); search.blur(); }
      e.stopPropagation();   // typing is typing: none of these are game keys
    });
    addEventListener('keydown', (e) => {
      if (!this.open || e.target === search) return;
      const k = e.code;
      if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); this.step(k === 'ArrowDown' ? 1 : -1); }
      else if (k === 'ArrowRight' || k === 'ArrowLeft') this.cycleFilter(k === 'ArrowRight' ? 1 : -1);
      else if (k === 'Enter' || k === 'KeyF') this.travel();
      else if (k === 'Slash') { e.preventDefault(); search.focus(); }
      else if (k === 'Equal' || k === 'NumpadAdd') this.#zoomAt(1.3, this.#mx(), cv.height / 2);
      else if (k === 'Minus' || k === 'NumpadSubtract') this.#zoomAt(1 / 1.3, this.#mx(), cv.height / 2);
      else if (k === 'KeyY' || k === 'Space') { e.preventDefault(); this.#centerOn(this.state.x, this.state.z, Math.max(this.zoom, 2.5)); }
    });
  }

  /** Gamepad buttons while the map is open. Returns true if it used the press. */
  pad(name, stickOnly) {
    if (stickOnly) return true; // the left stick is the cursor here, not the list
    if (name === 'Down' || name === 'Right') this.step(1);
    else if (name === 'Up' || name === 'Left') this.step(-1);
    else if (name === 'RB') this.cycleFilter(1);
    else if (name === 'LB') this.cycleFilter(-1);
    else if (name === 'A') this.travel();
    else if (name === 'Y') this.#centerOn(this.state.x, this.state.z, Math.max(this.zoom, 2.5));
    else return false;
    return true;
  }

  /** Per-frame analog input: left stick moves the cursor, right stick pans, triggers zoom. */
  analog(dt, move, look, lt, rt) {
    const cv = $('map-canvas'), k = this.#scale();
    if (lt > 0.05 || rt > 0.05) this.#zoomAt(Math.exp((rt - lt) * dt * 2.2), this.#mx(), cv.height / 2);
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
      const mx = (cv.width - this.#mx() - 40 * devicePixelRatio) / k, mz = (cv.height / 2 - 40 * devicePixelRatio) / k;
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
    const P = (x, z) => [this.#mx() + (x - this.cx) * k, H / 2 + (z - this.cz) * k];
    g.fillStyle = '#14120f';
    g.fillRect(0, 0, W, H);
    const [x0, y0] = P(-w.half, -w.half);
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.base, x0, y0, w.extent * k, w.extent * k);

    // a dashed line from you to the pick
    if (this.sel) {
      const [ax, ay] = P(s.x, s.z), [bx, by] = P(this.sel.x, this.sel.z);
      g.strokeStyle = 'rgba(255,177,90,0.8)'; g.lineWidth = 1.6 * dpr; g.setLineDash([6 * dpr, 6 * dpr]);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); g.setLineDash([]);
    }

    // markers, then labels by priority so a crowded map shows the ones that matter and never overlaps
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    const zoomLabels = this.zoom >= 1.7;
    const marks = [];
    for (const d of this.list) {
      const [x, y] = P(d.x, d.z);
      if (x < -60 || y < -60 || x > W + 60 || y > H + 60) continue;
      marks.push({ d, x, y, on: d === this.sel, hot: d === this.hover });
    }
    for (const m of marks) this.#marker(g, m, dpr);

    const placed = [];
    const prio = (m) => (m.on ? 100 : m.hot ? 90 : { tent: 80, car: 78, friend: 76, trailhead: 70, peak: 60, lake: m.d.known ? 40 : 20 }[m.d.kind]);
    for (const m of marks.sort((a, b) => prio(b) - prio(a))) {
      const { d, x, y, on, hot } = m;
      if (d.kind === 'lake' && !d.known && !on && !hot && !zoomLabels) continue;   // the overview stays calm
      const label = d.kind === 'peak' ? `${d.name}  ${ft(d.elev)}′` : d.name;
      const px = (on || hot ? 13 : 11.5) * dpr;
      g.font = FONT(on || hot ? 700 : 600, px / dpr * dpr);
      const tw = g.measureText(label).width, pad = 3 * dpr;
      const rect = [x + 9 * dpr - pad, y - px * 0.7 - pad, tw + pad * 2, px * 1.4 + pad * 2];
      if (!on && !hot && placed.some((r) => rect[0] < r[0] + r[2] && rect[0] + rect[2] > r[0] && rect[1] < r[1] + r[3] && rect[1] + rect[3] > r[1])) continue;
      placed.push(rect);
      g.strokeStyle = 'rgba(8,8,6,0.78)'; g.lineWidth = 3.4 * dpr;
      g.fillStyle = d.kind === 'lake' && !d.known && !on ? 'rgba(226,238,250,0.82)' : '#fbf7ee';
      g.strokeText(label, x + 9 * dpr, y); g.fillText(label, x + 9 * dpr, y);
    }

    // the cursor / pick
    const c = this.cursor;
    if (c) {
      const [x, y] = P(c[0], c[1]);
      const t = (performance.now() % 1600) / 1600;
      g.strokeStyle = '#ffb15a'; g.lineWidth = 2 * dpr;
      g.beginPath(); g.arc(x, y, 12 * dpr, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1 - t; g.lineWidth = 1.4 * dpr;
      g.beginPath(); g.arc(x, y, (12 + t * 14) * dpr, 0, Math.PI * 2); g.stroke();
      g.globalAlpha = 1;
    }

    // you
    const [px, py] = P(s.x, s.z);
    g.save();
    g.translate(px, py);
    g.scale(dpr, dpr);
    g.rotate(-s.yaw);
    g.fillStyle = '#ffb15a'; g.strokeStyle = '#120d07'; g.lineWidth = 2.2;
    g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.stroke(); g.fill();
    g.restore();

    // scale bar
    const km = this.zoom > 3 ? 0.5 : 1, len = km * 1000 * k;
    const sx = (cv.clientWidth > 900 ? 332 : 226) * dpr, sy = H - 24 * dpr;
    g.fillStyle = 'rgba(244,241,234,0.92)'; g.strokeStyle = 'rgba(8,8,6,0.6)'; g.lineWidth = 1 * dpr;
    g.strokeRect(sx, sy, len, 3 * dpr); g.fillRect(sx, sy, len, 3 * dpr);
    g.font = FONT(600, 11 * dpr);
    g.strokeStyle = 'rgba(8,8,6,0.78)'; g.lineWidth = 3 * dpr;
    g.strokeText(`${km} km`, sx + len + 8 * dpr, sy + 2 * dpr); g.fillText(`${km} km`, sx + len + 8 * dpr, sy + 2 * dpr);

    const stats = `${s.lakesFound}/${s.lakesTotal} lakes · ${s.peaksFound}/${s.peaksTotal} summits · ${s.km.toFixed(1)} km hiked`;
    if (stats !== this.lastStats) { this.lastStats = stats; $('map-stats').textContent = stats; }
  }

  /** One place on the map, in the same shape and colour as its row in the list. */
  #marker(g, { d, x, y, on, hot }, dpr) {
    const r = (on || hot ? 6 : 4.4) * dpr;
    g.fillStyle = d.kind === 'peak' ? '#fff3c4' : d.kind === 'trailhead' || d.kind === 'car' ? '#ffd1a6' : d.kind === 'tent' ? '#ff8a3a' : d.kind === 'friend' ? '#a9cf8e' : '#e8f2ff';
    g.strokeStyle = 'rgba(8,8,6,0.85)'; g.lineWidth = 1.8 * dpr;
    g.beginPath();
    if (d.kind === 'peak' || d.kind === 'tent') { g.moveTo(x, y - r * 1.5); g.lineTo(x + r * 1.3, y + r * 1.0); g.lineTo(x - r * 1.3, y + r * 1.0); g.closePath(); }
    else if (d.kind === 'car' || d.kind === 'trailhead') g.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
    else g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke(); g.fill();
    // somewhere you have been
    if (d.known) { g.strokeStyle = '#a9cf8e'; g.lineWidth = 1.6 * dpr; g.beginPath(); g.arc(x, y, r + 3.2 * dpr, 0, Math.PI * 2); g.stroke(); }
  }
}
