import { fbm, clamp, smoothstep, lerp } from './noise.js';
import { relief, reliefAmp } from './detail.js';

// The world is real data baked by tools/bake_world.py onto one grid over the
// Rawah crest: USGS lidar elevation, Sentinel-2 imagery and land cover, and
// OpenStreetMap trails, streams, lakes and names. Metres everywhere: x east,
// z south, y true elevation above sea level. Grid sample (r, c) sits at
// x = (c - N/2) * cell, z = (r - N/2) * cell.

const FIELD = 512; // resolution of the precomputed noise fields

export class World {
  static async load(base, onProgress = () => {}) {
    const meta = await (await fetch(`${base}/world.json`)).json();
    const N = meta.size, F = meta.far.size, C = meta.cover;
    const [dem, cover, far, color, farColor] = await Promise.all([
      fetchPacked(`${base}/dem.png`, N * N * 2, (f) => onProgress(f * 0.85)),
      fetchPacked(`${base}/cover.png`, C * C * 4),
      fetchPacked(`${base}/far.png`, F * F * 2),
      loadImage(`${base}/color.jpg`),
      loadImage(`${base}/far.jpg`),
    ]);
    onProgress(0.95);
    if (meta.demCoding === 'delta2') undelta(dem, meta.size);
    const raw = new Uint16Array(dem.buffer, dem.byteOffset, meta.size * meta.size);
    return new World(meta, raw, decode(far, meta), cover, color, farColor);
  }

  constructor(meta, heights, farHeights, cover, colorImage, farImage) {
    this.meta = meta;
    this.N = meta.size;
    this.cell = meta.cell;
    this.extent = this.N * this.cell;
    this.half = this.extent / 2;
    this.h = heights;              // raw uint16: (m - hOffset) * hScale
    this.hScale = 1 / meta.hScale;
    this.hOffset = meta.hOffset;
    this.far = { N: meta.far.size, cell: meta.far.cell, h: farHeights, image: farImage };
    this.colorImage = colorImage;
    this.coverData = cover;
    this.coverN = meta.cover;
    this.lakes = meta.lakes;
    this.places = meta.places;
    this.trails = meta.trails;
    this.streams = meta.streams;

    // lake id + 1 for every cell a lake's water sheet covers
    this.water = new Uint16Array(this.N * this.N);
    this.lakes.forEach((lake, i) => {
      const id = i + 1;
      for (const [r, c0, c1] of lake.runs) this.water.fill(id, r * this.N + c0, r * this.N + c1 + 1);
      lake.label = lake.name || `Unnamed tarn · ${Math.round(lake.level * 3.28084).toLocaleString()} ft`;
    });

    this.#buildFields();
    this.#buildLineIndex();
    this.#buildMask();
  }

  // ------------------------------------------------------------ sampling
  gridH(c, r) {
    const N = this.N;
    c = c < 0 ? 0 : c >= N ? N - 1 : c;
    r = r < 0 ? 0 : r >= N ? N - 1 : r;
    return this.h[r * N + c] * this.hScale + this.hOffset;
  }

  /** Ground height: lidar plus fractal micro-relief plus whatever has been sculpted, exactly as the terrain shader draws it. */
  height(x, z) {
    const base = this.baseHeight(x, z);
    const rock = this.coverAt(x, z, 3);
    return base + relief(x, z, reliefAmp(rock, this.maskAt(x, z)), rock) + (this.sculpt ? this.sculpt.at(x, z) : 0);
  }

  /** Lidar height alone, matching the grid triangulation (quad split along the c,r to c+1,r+1 diagonal). */
  baseHeight(x, z) {
    const u = x / this.cell + this.N / 2, v = z / this.cell + this.N / 2;
    const c = Math.floor(u), r = Math.floor(v);
    const fu = u - c, fv = v - r;
    const ha = this.gridH(c, r), hc = this.gridH(c + 1, r + 1);
    if (fu > fv) return ha + fu * (this.gridH(c + 1, r) - ha) + fv * (hc - this.gridH(c + 1, r));
    return ha + fv * (this.gridH(c, r + 1) - ha) + fu * (hc - this.gridH(c, r + 1));
  }

  /** Smoothed gradient (dh/dx, dh/dz) over ~2 m either side. */
  gradient(x, z, out = { x: 0, z: 0 }) {
    const d = Math.max(2, this.cell * 0.75);
    out.x = (this.height(x + d, z) - this.height(x - d, z)) / (2 * d);
    out.z = (this.height(x, z + d) - this.height(x, z - d)) / (2 * d);
    return out;
  }

  /** Steepness of the exact triangle under (x, z), as |dh/dxz|. */
  localGrade(x, z) {
    const u = x / this.cell + this.N / 2, v = z / this.cell + this.N / 2;
    const c = Math.floor(u), r = Math.floor(v);
    const ha = this.gridH(c, r), hb = this.gridH(c, r + 1), hc = this.gridH(c + 1, r + 1), hd = this.gridH(c + 1, r);
    let gx, gz;
    if (u - c > v - r) { gx = hd - ha; gz = hc - hd; } else { gz = hb - ha; gx = hc - hb; }
    return Math.hypot(gx, gz) / this.cell;
  }

  inBounds(x, z, margin = 0) {
    const m = this.half - margin;
    return x > -m && x < m && z > -m && z < m;
  }

  /** Lakes with their surface above this elevation are frozen (set from the calendar). */
  iceLine = 9999;

  lakeAt(x, z) {
    const c = Math.round(x / this.cell + this.N / 2), r = Math.round(z / this.cell + this.N / 2);
    if (c < 0 || r < 0 || c >= this.N || r >= this.N) return null;
    const id = this.water[r * this.N + c];
    return id ? this.lakes[id - 1] : null;
  }

  /** Lake whose water is within `pad` metres of (x, z), if any. */
  nearWater(x, z, pad) {
    const step = Math.max(this.cell, pad / 8);
    for (let dz = -pad; dz <= pad; dz += step) {
      for (let dx = -pad; dx <= pad; dx += step) {
        if (dx * dx + dz * dz > pad * pad) continue;
        const l = this.lakeAt(x + dx, z + dz);
        if (l && this.height(x + dx, z + dz) < l.level) return l;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ smoothing mask
  /** 0..255 per grid sample: where micro-relief is suppressed (trails, roads, water). */
  #buildMask() {
    const N = this.N, cell = this.cell, m = this.mask = new Uint8Array(N * N);
    const stamp = (x, z, inner, outer) => {
      const u = x / cell + N / 2, v = z / cell + N / 2;
      const R = Math.ceil(outer / cell);
      for (let r = Math.floor(v) - R; r <= Math.ceil(v) + R; r++) {
        if (r < 0 || r >= N) continue;
        for (let c = Math.floor(u) - R; c <= Math.ceil(u) + R; c++) {
          if (c < 0 || c >= N) continue;
          const d = Math.hypot(c - u, r - v) * cell;
          if (d > outer) continue;
          const k = d <= inner ? 255 : Math.round(255 * (1 - (d - inner) / (outer - inner)));
          if (k > m[r * N + c]) m[r * N + c] = k;
        }
      }
    };
    for (const t of this.trails) for (const [x, z] of t.dense) stamp(x, z, t.width / 2 + 0.8, t.width / 2 + 4);
    for (const st of this.streams) for (const [x, z] of st.pts) stamp(x, z, st.width / 2 + 1, st.width / 2 + 5);
    for (const lake of this.lakes) {
      for (const [r, c0, c1] of lake.runs) {
        for (let c = c0; c <= c1; c += 2) stamp((c - N / 2) * cell, (r - N / 2) * cell, 2, 9);
        stamp((c1 - N / 2) * cell, (r - N / 2) * cell, 2, 9);
      }
    }
  }

  /** Smoothing mask 0..1, bilinear on grid samples. */
  maskAt(x, z) {
    const N = this.N, m = this.mask;
    const u = clamp(x / this.cell + N / 2, 0, N - 1.001), v = clamp(z / this.cell + N / 2, 0, N - 1.001);
    const c = u | 0, r = v | 0, fu = u - c, fv = v - r, i = r * N + c;
    const a = m[i], b = m[i + 1], d = m[i + N], e = m[i + N + 1];
    return (a + (b - a) * fu + (d - a) * fv + (a - b - d + e) * fu * fv) / 255;
  }

  // ------------------------------------------------------------ land cover
  #buildFields() {
    const make = (scale, oct, seed) => {
      const f = new Float32Array(FIELD * FIELD);
      const k = this.extent / FIELD;
      for (let r = 0; r < FIELD; r++) {
        for (let c = 0; c < FIELD; c++) f[r * FIELD + c] = fbm((c * k) / scale, (r * k) / scale, oct, seed);
      }
      return f;
    };
    this.fFine = make(70, 2, 2);
    this.fLine = make(900, 2, 3);
  }

  /** Bilinear lookup into a noise field; wraps. */
  field(f, x, z) {
    const u = (x + this.half) / this.extent * FIELD, v = (z + this.half) / this.extent * FIELD;
    const cu = Math.floor(u), rv = Math.floor(v), fu = u - cu, fv = v - rv;
    const c0 = ((cu % FIELD) + FIELD) % FIELD, r0 = ((rv % FIELD) + FIELD) % FIELD;
    const c1 = (c0 + 1) % FIELD, r1 = (r0 + 1) % FIELD;
    const a = f[r0 * FIELD + c0], b = f[r0 * FIELD + c1], d = f[r1 * FIELD + c0], e = f[r1 * FIELD + c1];
    return a + (b - a) * fu + (d - a) * fv + (a - b - d + e) * fu * fv;
  }

  /** Satellite land-cover channel (0 live conifer, 1 burned, 2 aspen, 3 rock), bilinear, 0..1. */
  coverAt(x, z, ch) {
    const n = this.coverN, d = this.coverData;
    const u = clamp((x + this.half) / this.extent * n - 0.5, 0, n - 1.001);
    const v = clamp((z + this.half) / this.extent * n - 0.5, 0, n - 1.001);
    const c = u | 0, r = v | 0, fu = u - c, fv = v - r;
    const i = (r * n + c) * 4 + ch;
    const a = d[i], b = d[i + 4], e = d[i + n * 4], f = d[i + n * 4 + 4];
    return (a + (b - a) * fu + (e - a) * fv + (a - b - e + f) * fu * fv) / 255;
  }

  treeline(x, z) {
    return 3430 + (this.field(this.fLine, x, z) - 0.5) * 140;
  }

  /**
   * Land cover at a point, from the Sentinel-2 classification plus terrain.
   * Returns the shared `cover` scratch object with weights in 0..1.
   */
  cover(x, z, e = this.height(x, z), g = this.gradient(x, z, _g)) {
    const grade = Math.hypot(g.x, g.z);
    const tl = this.treeline(x, z);
    const live = this.coverAt(x, z, 0);
    const burned = this.coverAt(x, z, 1);
    const aspen = this.coverAt(x, z, 2);
    const rockSat = this.coverAt(x, z, 3);
    const nearLine = smoothstep(tl - 110, tl - 10, e);
    const steep = smoothstep(0.85, 1.2, grade);
    _cover.treeline = tl;
    _cover.forest = live * (1 - nearLine) * (1 - steep);
    _cover.krumm = live * nearLine * (1 - steep) + smoothstep(tl - 40, tl + 40, e) * smoothstep(tl + 160, tl + 60, e) * 0.15 * (1 - rockSat);
    _cover.snag = burned * (1 - steep);
    _cover.aspen = aspen * (1 - steep);
    _cover.rock = clamp(Math.max(rockSat, steep, smoothstep(0.6, 0.95, grade) * smoothstep(tl, tl + 200, e)), 0, 1);
    _cover.meadow = clamp(1 - live - burned - _cover.rock, 0, 1);
    _cover.alpine = smoothstep(tl - 20, tl + 120, e);
    _cover.grade = grade;
    _cover.fine = this.field(this.fFine, x, z);
    return _cover;
  }

  // ------------------------------------------------------------ trails & streams
  #buildLineIndex() {
    this.lineCell = 32;
    this.trailGrid = new Map();
    this.streamGrid = new Map();
    this.segments = [];
    this.streamSegs = [];
    const add = (grid, key, id) => { if (!grid.has(key)) grid.set(key, []); grid.get(key).push(id); };
    const totals = new Map();
    for (const t of this.trails) {
      const pts = resample(t.pts, t.kind === 'road' ? 4 : 2.5);
      t.dense = pts;
      t.width = t.kind === 'road' ? 6.6 : t.kind === 'track' ? 3 : 1.1;
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const s = { ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1], trail: t };
        len += Math.hypot(s.bx - s.ax, s.bz - s.az);
        add(this.trailGrid, this.#key((s.ax + s.bx) / 2, (s.az + s.bz) / 2), this.segments.push(s) - 1);
      }
      totals.set(t.name, (totals.get(t.name) || 0) + len);
    }
    this.trailLength = totals;
    for (const st of this.streams) {
      const p = st.pts;
      for (let i = 0; i < p.length - 1; i++) {
        const s = { ax: p[i][0], az: p[i][1], ay: p[i][2], bx: p[i + 1][0], bz: p[i + 1][1], by: p[i + 1][2], stream: st };
        add(this.streamGrid, this.#key((s.ax + s.bx) / 2, (s.az + s.bz) / 2), this.streamSegs.push(s) - 1);
      }
    }
  }

  #key(x, z) {
    return `${Math.floor(x / this.lineCell)},${Math.floor(z / this.lineCell)}`;
  }

  #nearest(grid, list, x, z, out) {
    let best = Infinity, hit = null, t = 0;
    const cx = Math.floor(x / this.lineCell), cz = Math.floor(z / this.lineCell);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ids = grid.get(`${cx + i},${cz + j}`);
        if (!ids) continue;
        for (const id of ids) {
          const s = list[id];
          const dx = s.bx - s.ax, dz = s.bz - s.az;
          const k = clamp(((x - s.ax) * dx + (z - s.az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
          const d = Math.hypot(x - s.ax - dx * k, z - s.az - dz * k);
          if (d < best) { best = d; hit = s; t = k; }
        }
      }
    }
    out.d = best; out.seg = hit; out.t = t;
    return out;
  }

  /** Distance to the nearest trail, track or road centreline within ~32 m. */
  nearestTrail(x, z) {
    this.#nearest(this.trailGrid, this.segments, x, z, _near);
    _near.trail = _near.seg ? _near.seg.trail : null;
    return _near;
  }

  /** Nearest stream within ~32 m: distance, the stream, and its water surface height there. */
  nearestStream(x, z) {
    this.#nearest(this.streamGrid, this.streamSegs, x, z, _stream);
    const s = _stream.seg;
    _stream.stream = s ? s.stream : null;
    _stream.y = s ? lerp(s.ay, s.by, _stream.t) : -Infinity;
    return _stream;
  }

  nearestPlace(x, z, filter = () => true) {
    let best = null, bd = Infinity;
    for (const p of this.places) {
      if (!filter(p)) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    return { place: best, d: bd };
  }
}

const _g = { x: 0, z: 0 };
const _cover = {};
const _near = { d: Infinity, seg: null, trail: null, t: 0 };
const _stream = { d: Infinity, seg: null, stream: null, t: 0, y: 0 };

export function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    let t = step - carry;
    while (t <= len) {
      out.push([lerp(ax, bx, t / len), lerp(az, bz, t / len)]);
      t += step;
    }
    carry = len - (t - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Binary data ships as lossless RGB PNGs (tools/pack_png.py): bytes run through
 * the R, G, B channels row by row. Decode without colour conversion and read
 * the first `length` bytes back.
 */
async function fetchPacked(url, length, onProgress = () => {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0;
  const counted = res.body.pipeThrough(new TransformStream({
    transform(chunk, ctl) { got += chunk.length; if (total) onProgress(got / total); ctl.enqueue(chunk); },
  }));
  const blob = await new Response(counted).blob();
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
  const g = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const px = g.getImageData(0, 0, cv.width, cv.height).data;
  const out = new Uint8Array(length);
  for (let i = 0, j = 0; i < length; j += 4) {
    out[i++] = px[j];
    if (i < length) out[i++] = px[j + 1];
    if (i < length) out[i++] = px[j + 2];
  }
  return out;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${url}: failed to load`));
    img.src = url;
  });
}

/** Undo the bake's 2-D delta coding in place (uint16, wrapping): rows first, then columns. */
function undelta(bytes, n) {
  const q = new Uint16Array(bytes.buffer, bytes.byteOffset, n * n);
  for (let r = 1; r < n; r++) {
    const o = r * n;
    for (let c = 0; c < n; c++) q[o + c] += q[o - n + c];
  }
  for (let r = 0; r < n; r++) {
    const o = r * n;
    for (let c = 1; c < n; c++) q[o + c] += q[o + c - 1];
  }
}

function decode(bytes, meta) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true) / meta.hScale + meta.hOffset;
  return out;
}
