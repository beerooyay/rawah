import { clamp } from './noise.js';

// The map and the field guide, one window. The map is the satellite image of
// the Rawah with hillshade and contours, tinted to the brand (navy land, peach
// trails), with the places you can travel to as markers. Click or tap one and
// a card shows it with a Travel button; the list and search are only there when
// you ask for them. The field guide (the other tab) shows what you have found:
// lakes and summits from the journal, wildlife and plants from guide.js, and
// the easter eggs. Mouse, touch, keyboard and gamepad all drive the same state.

const $ = (id) => document.getElementById(id);
const ft = (m) => Math.round(m * 3.28084).toLocaleString();
const dist = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const KIND = { tent: 'Your camp', car: 'Your car', trailhead: 'Trailhead', peak: 'Summit', lake: 'Lake', friend: 'Friend' };
const FILTERS = [['all', 'All'], ['places', 'Places'], ['summits', 'Summits'], ['lakes', 'Lakes']];
const GROUP_OF = { tent: 'places', car: 'places', trailhead: 'places', friend: 'places', peak: 'summits', lake: 'lakes' };
const MAX_ZOOM = 12;
// brand: peach #f6d3bd, navy #37587b, black and white neutrals
const C = { land: '#0d1117', peach: '#f6d3bd', navy: '#37587b', navyLight: '#8fb1d6', white: '#ffffff', ink: '#0a0d12' };
const MARK = { tent: C.peach, car: C.peach, trailhead: C.peach, friend: C.white, peak: C.white, lake: C.navyLight };

export class GameMap {
  constructor(world, guide) {
    this.world = world;
    this.guide = guide;
    this.open = false;
    this.mode = 'map';            // 'map' | 'guide'
    this.base = null;
    this.view = { cx: 0, cz: 0, zoom: 1 };
    this.list = [];               // every place you can travel to
    this.sel = null;              // the picked place
    this.hover = null;
    this.filter = 'all';
    this.query = '';
    this.state = null;
    this.vel = { x: 0, z: 0 };      // pan inertia, world metres a second
    this.ease = null;               // the view is gliding here after a pick
    this.zoomTo = null;             // eased wheel zoom, anchored on the cursor
    this.lastT = 0;
    this.onTravel = () => {};
    this.onClose = () => {};
    this.#bind();
  }

  // ---------------------------------------------------------------- base image
  /** The satellite picture, tinted to the brand, with hillshade, 40 m contours, lakes, streams and trails. */
  build(image) {
    const w = this.world, M = 2048;
    const cv = document.createElement('canvas');
    cv.width = cv.height = M;
    const g = cv.getContext('2d');
    g.drawImage(image, 0, 0, M, M);
    const img = g.getImageData(0, 0, M, M);
    const k = w.N / M;
    for (let r = 0; r < M; r++) {
      for (let c = 0; c < M; c++) {
        const sc = Math.floor(c * k), sr = Math.floor(r * k);
        const d = Math.max(1, Math.round(k));
        const gx = (w.gridH(sc + d, sr) - w.gridH(sc - d, sr)) / (2 * d * w.cell);
        const gz = (w.gridH(sc, sr + d) - w.gridH(sc, sr - d)) / (2 * d * w.cell);
        const shade = clamp(0.92 + (-gx * 0.7 - gz * 0.7) * 0.5, 0.65, 1.15);
        const e = w.gridH(sc, sr);
        const contour = Math.floor(e / 40) !== Math.floor(w.gridH(sc + d, sr) / 40) || Math.floor(e / 40) !== Math.floor(w.gridH(sc, sr + d) / 40);
        const m = shade * (contour ? (Math.floor(e / 40) % 5 === 4 ? 0.55 : 0.75) : 1);
        const i = (r * M + c) * 4;
        // desaturate toward the land colour, so the map reads as one navy-black surface with the terrain showing through
        const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2], L = R * 0.3 + G * 0.55 + B * 0.15;
        const mix = (v, t) => v + (t - v) * 0.6;
        const Q = mix(R, L) * 0.85 + mix(R, L) * 0.15;
        img.data[i] = clamp(mix(R, L) * m * 0.42 + 5, 0, 255);
        img.data[i + 1] = clamp(mix(G, L) * m * 0.54 + 12, 0, 255);
        img.data[i + 2] = clamp(mix(B, L) * m * 0.78 + 28, 0, 255);
      }
    }
    g.putImageData(img, 0, 0);
    const S = M / w.N;
    g.fillStyle = C.navy;
    for (const lake of w.lakes) for (const [r, c0, c1] of lake.runs) g.fillRect(c0 * S, r * S, (c1 - c0 + 1) * S, S + 0.5);
    const path = (pts) => {
      g.beginPath();
      pts.forEach(([x, z], i) => {
        const px = (x / w.cell + w.N / 2) * S, pz = (z / w.cell + w.N / 2) * S;
        if (i) g.lineTo(px, pz); else g.moveTo(px, pz);
      });
      g.stroke();
    };
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = C.navyLight; g.globalAlpha = 0.7;
    for (const st of w.streams) { g.lineWidth = Math.max(1.4, st.width * S * 0.6); path(st.pts); }
    g.globalAlpha = 1;
    for (const t of w.trails) { g.strokeStyle = 'rgba(10,13,18,0.7)'; g.lineWidth = t.kind === 'road' ? 7 : 5; g.setLineDash([]); path(t.pts); }
    for (const t of w.trails) {
      g.strokeStyle = t.kind === 'road' ? 'rgba(255,255,255,0.85)' : t.kind === 'track' ? 'rgba(246,211,189,0.7)' : C.peach;
      g.lineWidth = t.kind === 'road' ? 4 : 3;
      g.setLineDash(t.kind === 'trail' ? [9, 6] : t.kind === 'track' ? [5, 5] : []);
      path(t.pts);
    }
    g.setLineDash([]);
    this.base = cv;
  }

  // ---------------------------------------------------------------- open / close
  show(s) {
    this.open = true;
    this.state = s;
    this.mode = 'map';
    this.view = { cx: s.x ?? 0, cz: s.z ?? 0, zoom: 1.4 };
    this.sel = null; this.hover = null;
    this.query = ''; this.filter = 'all';
    this.vel = { x: 0, z: 0 }; this.ease = null; this.zoomTo = null; this.lastT = 0;
    $('map-search').value = '';
    this.#buildList(s);
    $('map').classList.remove('hidden');
    this.#setMode('map');
    this.#renderCard();
    this.#renderFilters();
    this.#renderResults();
  }

  /** Open straight onto the field guide tab. */
  guideTab() { this.#setMode('guide'); }

  hide() {
    this.open = false;
    $('map').classList.add('hidden');
    $('tip').classList.add('hidden');
  }

  // ---------------------------------------------------------------- destinations
  #buildList(s) {
    const w = this.world, out = [];
    const known = (p) => (p.kind === 'lake' ? s.discovered.has(p.name) : p.kind === 'peak' ? s.discovered.has(`peak:${p.name}`) : false);
    if (s.tent) out.push({ kind: 'tent', name: 'Your camp', x: s.tent.x, z: s.tent.z, group: 'places' });
    if (w.carSpot) out.push({ kind: 'car', name: 'Your car', x: w.carSpot.x, z: w.carSpot.z, group: 'places' });
    for (const f of s.friends || []) out.push({ kind: 'friend', name: f.name, x: f.x, z: f.z, group: 'places' });
    for (const p of w.places.filter((q) => q.kind === 'trailhead')) out.push({ kind: 'trailhead', name: p.name, x: p.x, z: p.z, group: 'places' });
    for (const p of w.places.filter((q) => q.kind === 'peak')) out.push({ kind: 'peak', name: p.name, x: p.x, z: p.z, elev: p.elev, group: 'summits', known: known(p) });
    // one entry per named water: where a name belongs to several pools (Twin Lakes, Camp Lake) keep the biggest
    const lakes = new Map();
    for (const p of w.places.filter((q) => q.kind === 'lake')) {
      const lake = w.lakeAt(p.x, p.z) || w.lakes.filter((l) => l.name === p.name).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      const d = { kind: 'lake', name: p.name, x: p.x, z: p.z, elev: lake ? lake.level : p.elev, lake, group: 'lakes', known: known(p) };
      const prev = lakes.get(p.name);
      if (!prev || (lake?.area || 0) > (prev.lake?.area || 0)) lakes.set(p.name, d);
    }
    out.push(...lakes.values());
    for (const d of out) d.away = Math.hypot(d.x - s.x, d.z - s.z);
    this.list = out.filter((d) => d.name);
  }

  #visible() {
    const q = this.query.trim().toLowerCase();
    return this.list
      .filter((d) => this.filter === 'all' || GROUP_OF[d.kind] === this.filter || (this.filter === 'places' && GROUP_OF[d.kind] === 'places'))
      .filter((d) => !q || d.name.toLowerCase().includes(q))
      .sort((a, b) => a.away - b.away);
  }

  /** Pick a destination by its index in the list, optionally centring the view on it. */
  pick(i, center = false) {
    const d = this.list[i];
    if (!d) return;
    this.sel = d;
    if (center) this.#centerOn(d.x, d.z, Math.max(this.view.zoom, 2.4));
    this.#renderCard();
    this.#renderResults();
  }

  travel() {
    if (!this.sel) return;
    const d = this.sel, lim = this.world.half - 60;
    d.x = clamp(d.x, -lim, lim); d.z = clamp(d.z, -lim, lim);
    this.hide();
    this.onTravel(d);
  }

  #renderCard() {
    const d = this.sel, card = $('map-card');
    card.classList.toggle('hidden', !d);
    if (!d) return;
    const s = this.state;
    $('mc-kind').textContent = KIND[d.kind] || 'Place';
    $('mc-name').textContent = d.name;
    const sub = [d.elev ? `${ft(d.elev)} ft` : '', `${dist(Math.hypot(d.x - s.x, d.z - s.z))} away`].filter(Boolean).join(' · ');
    $('mc-sub').textContent = sub;
    $('mc-go').disabled = d.kind === 'car';
    $('mc-go').textContent = d.kind === 'friend' ? 'Meet up' : 'Travel here';
  }

  // ---------------------------------------------------------------- DOM: filters, results, mode
  #renderFilters() {
    const seg = $('map-filters');
    seg.innerHTML = '';
    for (const [id, label] of FILTERS) {
      const b = document.createElement('button');
      b.textContent = label; b.dataset.f = id;
      b.classList.toggle('on', id === this.filter);
      b.onclick = () => { this.filter = id; this.#renderFilters(); this.#renderResults(); };
      seg.appendChild(b);
    }
  }

  #renderResults() {
    const el = $('map-results');
    const active = this.query.trim() || this.filter !== 'all';
    el.classList.toggle('hidden', !active);
    if (!active) return;
    const rows = this.#visible();
    el.innerHTML = '';
    if (!rows.length) { el.innerHTML = '<div class="empty">Nothing by that name.</div>'; return; }
    for (const d of rows.slice(0, 40)) {
      const b = document.createElement('button');
      b.className = `row${this.sel === d ? ' on' : ''}`;
      b.innerHTML = `<i class="dot ${d.kind}"></i><span><span class="nm"></span><small></small></span>`;
      b.querySelector('.nm').textContent = d.name;
      b.querySelector('small').textContent = `${KIND[d.kind] || 'Place'} · ${dist(d.away)}`;
      b.onclick = () => { this.sel = d; this.#renderCard(); this.#renderResults(); this.#centerOn(d.x, d.z, Math.max(this.view.zoom, 2.4)); };
      b.ondblclick = () => { this.sel = d; this.travel(); };
      el.appendChild(b);
    }
  }

  #setMode(mode) {
    this.mode = mode;
    $('map-canvas').classList.toggle('hidden', mode !== 'map');
    $('map-tools').classList.toggle('hidden', mode !== 'map');
    $('map-stats').classList.toggle('hidden', mode !== 'map');
    $('map-top').classList.toggle('guide-on', mode === 'guide');
    for (const b of $('map-modes').querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
    $('guide').classList.toggle('hidden', mode !== 'guide');
    if (mode === 'guide') this.#renderGuide();
    $('map-card').classList.toggle('hidden', mode !== 'map' || !this.sel);
    if (mode === 'map') this.#renderCard();
  }

  // ---------------------------------------------------------------- the field guide
  #renderGuide() {
    const s = this.state, g = this.guide, el = $('guide');
    const lakes = this.list.filter((d) => d.kind === 'lake'), peaks = this.list.filter((d) => d.kind === 'peak');
    const cats = [
      { name: 'Summits', items: peaks.map((p) => ({ name: p.name, note: `${ft(p.elev)} ft · the summit`, found: !!p.known })) },
      { name: 'Lakes', items: lakes.map((p) => ({ name: p.name, note: `${ft(p.elev)} ft · a tarn or lake of the Rawah`, found: !!p.known })) },
    ];
    for (const grp of ['Wildlife', 'Flora', 'Checkpoints', 'Easter eggs']) {
      cats.push({ name: grp, items: g.entries.filter((e) => e.group === grp).map((e) => ({ name: e.name, note: e.note, hint: e.hint, found: g.found.has(e.id) })) });
    }
    this.cat = this.cat && cats.some((c) => c.name === this.cat) ? this.cat : cats[0].name;
    const total = cats.reduce((n, c) => n + c.items.length, 0), got = cats.reduce((n, c) => n + c.items.filter((i) => i.found).length, 0);
    const cur = cats.find((c) => c.name === this.cat);
    el.innerHTML = `
      <div class="gd-head"><div><div class="kicker">Field guide</div><div class="gd-total">${got} of ${total} found</div></div>
        <div class="gd-bar"><i style="width:${Math.round(got / total * 100)}%"></i></div></div>
      <div class="gd-cats">${cats.map((c) => `<button data-cat="${c.name}" class="${c.name === this.cat ? 'on' : ''}">${c.name}<small>${c.items.filter((i) => i.found).length}/${c.items.length}</small></button>`).join('')}</div>
      <div class="gd-grid">${cur.items.map((i) => `<article class="gd-card${i.found ? '' : ' locked'}">
          <div class="gd-name">${i.found ? esc(i.name) : '???'}</div>
          <div class="gd-note">${i.found ? esc(i.note) : (i.hint ? `To find: ${esc(i.hint)}` : 'Not seen yet. Keep your eyes open.')}</div>
        </article>`).join('')}</div>`;
    for (const b of el.querySelectorAll('[data-cat]')) b.onclick = () => { this.cat = b.dataset.cat; this.#renderGuide(); };
  }

  // ---------------------------------------------------------------- view
  /** Pixels per metre at zoom 1 for the current canvas: the whole Rawah fits its short side. */
  #fit(cv) { return Math.min(cv.clientWidth, cv.clientHeight) / (this.world.extent * 1.02); }
  #scale(cv) { return this.#fit(cv) * this.view.zoom; }   // CSS px per metre

  /** Glide the view onto a point instead of snapping: picks and find-me feel like a map, not a jump cut. */
  #centerOn(x, z, zoom = this.view.zoom) {
    this.ease = { x: clamp(x, -this.world.half, this.world.half), z: clamp(z, -this.world.half, this.world.half), zoom: clamp(zoom, 1, MAX_ZOOM) };
    this.vel.x = this.vel.z = 0;
  }

  #clampView() {
    const h = this.world.half;
    this.view.cx = clamp(this.view.cx, -h, h);
    this.view.cz = clamp(this.view.cz, -h, h);
  }

  /** Zoom keeping the world point under (px, py) put; eased when `glide` so wheels and buttons feel soft. */
  #zoomAt(f, px, py, glide = false) {
    const cv = $('map-canvas'), w = this.#toWorld(px, py);
    const z = clamp(this.view.zoom * f, 1, MAX_ZOOM);
    if (glide) { this.zoomTo = { zoom: z, wx: w[0], wy: w[1], px, py }; this.ease = null; return; }
    this.view.zoom = z;
    const k2 = this.#scale(cv);
    // keep the point under the pointer where it was
    this.view.cx = w[0] - (px - cv.clientWidth / 2) / k2;
    this.view.cz = w[1] - (py - cv.clientHeight / 2) / k2;
    this.zoomTo = null;
    this.#clampView();
  }

  /** Per-frame view physics: inertia after a throw, the eased zoom, and the pick glide. Runs inside #draw. */
  #physics(dt) {
    const v = this.view;
    if (Math.abs(this.vel.x) + Math.abs(this.vel.z) > 1) {
      v.cx -= this.vel.x * dt; v.cz -= this.vel.z * dt;
      const d = Math.exp(-4 * dt);
      this.vel.x *= d; this.vel.z *= d;
      this.#clampView();
    } else this.vel.x = this.vel.z = 0;
    if (this.zoomTo) {
      const z = this.zoomTo, t = 1 - Math.exp(-14 * dt);
      const nz = v.zoom + (z.zoom - v.zoom) * t;
      const cv = $('map-canvas'), k = this.#fit(cv);
      v.cx = z.wx - (z.px - cv.clientWidth / 2) / (k * nz);
      v.cz = z.wy - (z.py - cv.clientHeight / 2) / (k * nz);
      v.zoom = nz;
      if (Math.abs(z.zoom - nz) < 0.002) { v.zoom = z.zoom; this.zoomTo = null; }
      this.#clampView();
    }
    if (this.ease) {
      const e = this.ease, t = 1 - Math.exp(-8 * dt);
      v.cx += (e.x - v.cx) * t; v.cz += (e.z - v.cz) * t; v.zoom += (e.zoom - v.zoom) * t;
      if (Math.hypot(e.x - v.cx, e.z - v.cz) < 1.5 && Math.abs(e.zoom - v.zoom) < 0.005) {
        v.cx = e.x; v.cz = e.z; v.zoom = e.zoom; this.ease = null;
      }
      this.#clampView();
    }
  }

  /** CSS pixel on the canvas to world metres. */
  #toWorld(px, py) {
    const cv = $('map-canvas'), k = this.#scale(cv);
    return [this.view.cx + (px - cv.clientWidth / 2) / k, this.view.cz + (py - cv.clientHeight / 2) / k];
  }

  /** The nearest place to a canvas point, within `snap` CSS pixels. */
  #placeAt(px, py, snap = 18) {
    const cv = $('map-canvas'), k = this.#scale(cv);
    let best = null, bd = snap;
    for (const d of this.#visible()) {
      const x = cv.clientWidth / 2 + (d.x - this.view.cx) * k, y = cv.clientHeight / 2 + (d.z - this.view.cz) * k;
      const dd = Math.hypot(x - px, y - py);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }

  // ---------------------------------------------------------------- input
  #bind() {
    const cv = $('map-canvas');
    const pts = new Map();
    let drag = null, pinch = 0, moved = 0;
    const at = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, at(e));
      drag = at(e); moved = 0;
      this.vel.x = this.vel.z = 0; this.ease = null; this.zoomTo = null;   // a hand on the map owns it now
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = Math.hypot(a[0] - b[0], a[1] - b[1]); }
    });
    cv.addEventListener('pointermove', (e) => {
      const [px, py] = at(e);
      if (!pts.has(e.pointerId)) {
        if (e.pointerType !== 'mouse') return;
        this.#hover(px, py, e);
        return;
      }
      pts.set(e.pointerId, [px, py]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) this.#zoomAt(d / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        pinch = d; moved = 99;
        this.#draw();
        return;
      }
      const k = this.#scale(cv), dx = px - drag[0], dy = py - drag[1];
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 4) {
        this.view.cx -= dx / k; this.view.cz -= dy / k;
        this.#clampView();
        const now = performance.now();   // remember the flick, so letting go throws the view
        if (this.mvT) {
          const dms = now - this.mvT;
          if (dms > 0 && dms < 200) {
            this.vel.x = this.vel.x * 0.7 + ((dx / dms) * 1000 / k) * 0.3;
            this.vel.z = this.vel.z * 0.7 + ((dy / dms) * 1000 / k) * 0.3;
          }
        }
        this.mvT = now;
        drag = [px, py];
        cv.classList.add('drag');
        this.#draw();
      }
    });
    const up = (e) => {
      const was = pts.size;
      pts.delete(e.pointerId);
      if (pts.size === 0) {
        cv.classList.remove('drag');
        this.mvT = 0;
        // a click without a drag picks what is under the pointer
        if (was === 1 && moved <= 4) {
          const [px, py] = at(e), d = this.#placeAt(px, py, 22);
          if (d) { this.sel = d; this.#renderCard(); this.#renderResults(); }
          else { this.sel = null; this.#renderCard(); }
          this.#draw();
        }
        pinch = 0;
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { $('tip').classList.add('hidden'); this.hover = null; this.#draw(); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [px, py] = at(e);
      this.#zoomAt(Math.exp(-e.deltaY * 0.0015), px, py, true);
      this.#draw();
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      const [px, py] = at(e), d = this.#placeAt(px, py, 22);
      if (d) { this.sel = d; this.travel(); }
    });

    $('map-zin').onclick = () => { this.#zoomAt(1.6, cv.clientWidth / 2, cv.clientHeight / 2, true); this.#draw(); };
    $('map-zout').onclick = () => { this.#zoomAt(1 / 1.6, cv.clientWidth / 2, cv.clientHeight / 2, true); this.#draw(); };
    $('map-find').onclick = () => { if (this.state) { this.#centerOn(this.state.x, this.state.z, Math.max(this.view.zoom, 2.4)); this.#draw(); } };
    $('map-close').onclick = () => this.onClose();
    $('mc-go').onclick = () => this.travel();
    $('mc-clear').onclick = () => { this.sel = null; this.#renderCard(); this.#renderResults(); this.#draw(); };
    $('map-modes').querySelectorAll('button').forEach((b) => { b.onclick = () => { this.#setMode(b.dataset.mode); this.#draw(); }; });
    const search = $('map-search');
    search.addEventListener('input', () => { this.query = search.value; this.#renderResults(); });
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const first = this.#visible()[0]; if (first) { this.sel = first; this.#renderCard(); this.#centerOn(first.x, first.z, Math.max(this.view.zoom, 2.4)); } } if (e.key === 'Escape') search.blur(); });
    addEventListener('keydown', (e) => {
      if (!this.open || search === document.activeElement) return;
      if (e.key === '/') { e.preventDefault(); search.focus(); return; }
      if (e.key === '+' || e.key === '=') this.#zoomAt(1.4, cv.clientWidth / 2, cv.clientHeight / 2, true);
      else if (e.key === '-') this.#zoomAt(1 / 1.4, cv.clientWidth / 2, cv.clientHeight / 2, true);
      else if (e.key === 'Enter') this.travel();
      else if (/^Arrow/.test(e.key)) {
        const s = e.shiftKey ? 500 : 160 / this.view.zoom;
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        this.view.cx += d[0] * s; this.view.cz += d[1] * s; this.#clampView();
      } else return;
      e.preventDefault();
      this.#draw();
    });
  }

  #hover(px, py, e) {
    const d = this.#placeAt(px, py, 16);
    this.hover = d;
    const cv = $('map-canvas');
    cv.classList.toggle('over', !!d);
    const tip = $('tip');
    if (!d) { tip.classList.add('hidden'); this.#draw(); return; }
    tip.textContent = `${d.name}${d.elev ? ` · ${ft(d.elev)} ft` : ''}`;
    tip.style.left = `${px + 14}px`; tip.style.top = `${py + 14}px`;
    tip.classList.remove('hidden');
    this.#draw();
  }

  /** Gamepad: D-pad or left stick steps through what is shown; A travels; B closes; LB/RB change the filter. */
  pad(name, stickOnly) {
    if (stickOnly) return true;
    if (this.mode === 'guide') { if (name === 'B') this.#setMode('map'); return true; }
    if (name === 'Down' || name === 'Right') this.#step(1);
    else if (name === 'Up' || name === 'Left') this.#step(-1);
    else if (name === 'RB') this.#cycleFilter(1);
    else if (name === 'LB') this.#cycleFilter(-1);
    else if (name === 'A') this.travel();
    else if (name === 'Y') this.#centerOn(this.state.x, this.state.z, Math.max(this.view.zoom, 2.4));
    else if (name === 'X') this.#setMode('guide');
    else return false;
    this.#draw();
    return true;
  }

  #step(dir) {
    const rows = this.#visible();
    if (!rows.length) return;
    const i = rows.indexOf(this.sel);
    const next = rows[(i + dir + rows.length) % rows.length];
    this.sel = next;
    this.#centerOn(next.x, next.z, Math.max(this.view.zoom, 2.4));
    this.#renderCard(); this.#renderResults();
  }

  #cycleFilter(dir) {
    const i = FILTERS.findIndex(([id]) => id === this.filter);
    this.filter = FILTERS[(i + dir + FILTERS.length) % FILTERS.length][0];
    this.#renderFilters(); this.#renderResults();
  }

  /** Per-frame analog input: the left stick pans, the right stick pans faster, the triggers zoom. */
  analog(dt, move, look, lt, rt) {
    const cv = $('map-canvas'), k = this.#scale(cv);
    if (lt > 0.05 || rt > 0.05) this.#zoomAt(Math.exp((rt - lt) * dt * 2.2), cv.clientWidth / 2, cv.clientHeight / 2);
    const pan = (vx, vy, sp) => { this.view.cx += vx * sp * dt / k; this.view.cz += vy * sp * dt / k; this.#clampView(); };
    pan(move[0], move[1], 520);
    pan(look[0], look[1], 900);
    this.#draw();
  }

  // ---------------------------------------------------------------- draw
  draw(s) {
    this.state = s;
    this.#draw();
  }

  #draw() {
    if (!this.open || this.mode !== 'map') return;
    const now = performance.now();
    const dt = Math.min(0.05, this.lastT ? (now - this.lastT) / 1000 : 0);
    this.lastT = now;
    this.#physics(dt);
    const cv = $('map-canvas'), g = cv.getContext('2d');
    const dpr = devicePixelRatio, W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = this.world, k = this.#scale(cv), s = this.state;
    const P = (x, z) => [W / 2 + (x - this.view.cx) * k, H / 2 + (z - this.view.cz) * k];
    g.fillStyle = C.land;
    g.fillRect(0, 0, W, H);
    const [x0, y0] = P(-w.half, -w.half);
    g.imageSmoothingQuality = 'high';
    if (this.base) g.drawImage(this.base, x0, y0, w.extent * k, w.extent * k);

    // a dashed line from you to the pick
    if (this.sel && s) {
      const [ax, ay] = P(s.x, s.z), [bx, by] = P(this.sel.x, this.sel.z);
      g.strokeStyle = C.peach; g.lineWidth = 1.6; g.setLineDash([6, 6]);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke(); g.setLineDash([]);
    }

    // markers, then labels by priority, skipping any that would overlap
    const labels = this.view.zoom >= 2.2;
    const marks = [];
    for (const d of this.#visible()) {
      const [x, y] = P(d.x, d.z);
      if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
      marks.push({ d, x, y, on: d === this.sel, hot: d === this.hover });
    }
    for (const m of marks) this.#marker(g, m);

    // you
    if (s) {
      const [px, py] = P(s.x, s.z);
      g.save(); g.translate(px, py); g.rotate(-s.yaw);
      g.fillStyle = C.peach; g.strokeStyle = C.ink; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.closePath(); g.stroke(); g.fill();
      g.restore();
    }

    const placed = [];
    const prio = (m) => (m.on ? 100 : m.hot ? 90 : { tent: 80, car: 78, friend: 76, trailhead: 70, peak: 60, lake: 40 }[m.d.kind] || 30);
    for (const m of marks.sort((a, b) => prio(b) - prio(a))) {
      const { d, x, y, on, hot } = m;
      if (!on && !hot && !labels && d.kind === 'lake' && this.view.zoom < 3.2) continue;   // the overview keeps to the big names
      const label = d.kind === 'peak' && d.elev ? `${d.name}  ${ft(d.elev)}′` : d.name;
      g.font = `${on || hot ? 700 : 600} ${on || hot ? 14 : 12.5}px Gabarito, system-ui, sans-serif`;
      const tw = g.measureText(label).width, pad = 4;
      const rect = [x + 10 - pad, y - 9 - pad, tw + pad * 2, 18 + pad * 2];
      if (!on && !hot && placed.some((r) => rect[0] < r[0] + r[2] && rect[0] + rect[2] > r[0] && rect[1] < r[1] + r[3] && rect[1] + rect[3] > r[1])) continue;
      placed.push(rect);
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(10,13,18,0.85)'; g.lineWidth = 3.5;
      g.strokeText(label, x + 10, y);
      g.fillStyle = on || hot ? C.peach : C.white;
      g.fillText(label, x + 10, y);
    }
    // the cursor ring for the selection
    if (this.sel) {
      const [x, y] = P(this.sel.x, this.sel.z);
      g.strokeStyle = C.peach; g.lineWidth = 2;
      g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke();
    }
    this.#stats();
  }

  #stats() {
    const s = this.state, d = this.list;
    const lakes = d.filter((q) => q.kind === 'lake'), peaks = d.filter((q) => q.kind === 'peak');
    $('map-stats').textContent = `${lakes.filter((q) => q.known).length}/${lakes.length} lakes · ${peaks.filter((q) => q.known).length}/${peaks.length} summits · ${s.km.toFixed(1)} km`;
  }

  #marker(g, { d, x, y, on, hot }) {
    const r = (on || hot ? 6.5 : 5) ;
    g.fillStyle = MARK[d.kind] || C.white;
    g.strokeStyle = C.ink; g.lineWidth = 2;
    g.beginPath();
    if (d.kind === 'peak' || d.kind === 'tent') { g.moveTo(x, y - r * 1.5); g.lineTo(x + r * 1.3, y + r); g.lineTo(x - r * 1.3, y + r); g.closePath(); }
    else if (d.kind === 'car' || d.kind === 'trailhead') g.rect(x - r, y - r, r * 2, r * 2);
    else g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke(); g.fill();
    if (d.known) { g.strokeStyle = C.peach; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, r + 3.5, 0, Math.PI * 2); g.stroke(); }
  }
}

function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
