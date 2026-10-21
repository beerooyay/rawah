import { fbm, clamp, smoothstep, lerp } from './noise.js';

// The world is a real 2048x2048 elevation grid (~7.25 m cells, ~14.8 km a side)
// over the Rawah crest, baked by tools/bake_world.py. Metres everywhere:
// x east, z south, y is true elevation above sea level.

const FIELD = 512; // resolution of the precomputed ecology noise fields

export class World {
  static async load(base, onProgress = () => {}) {
    const meta = await (await fetch(`${base}/world.json`)).json();
    const dem = await fetchBytes(`${base}/dem.bin`, (f) => onProgress(f * 0.9));
    const far = await fetchBytes(`${base}/far.bin`, () => {});
    onProgress(0.95);
    return new World(meta, decode(dem, meta), decode(far, meta));
  }

  constructor(meta, heights, farHeights) {
    this.meta = meta;
    this.N = meta.size;
    this.cell = meta.cell;
    this.extent = this.N * this.cell;
    this.half = this.extent / 2;
    this.h = heights;
    this.far = { N: meta.far.size, cell: meta.far.cell, h: farHeights };
    this.lakes = meta.lakes;
    this.places = meta.places;
    this.trails = meta.trails;

    let lo = Infinity, hi = -Infinity;
    for (const v of heights) { if (v < lo) lo = v; if (v > hi) hi = v; }
    this.minH = lo; this.maxH = hi;

    // lake id + 1 for every cell a lake's water sheet covers
    this.water = new Uint8Array(this.N * this.N);
    this.lakes.forEach((lake, i) => {
      for (const [r, c0, c1] of lake.runs) this.water.fill(i + 1, r * this.N + c0, r * this.N + c1 + 1);
      lake.label = lake.name || `Lake ${Math.round(lake.level * 3.28084).toLocaleString()} ft`;
    });

    this.#buildFields();
    this.#buildTrailIndex();
  }

  // ------------------------------------------------------------ sampling
  gridH(c, r) {
    const N = this.N;
    c = c < 0 ? 0 : c >= N ? N - 1 : c;
    r = r < 0 ? 0 : r >= N ? N - 1 : r;
    return this.h[r * N + c];
  }

  /** Terrain height matching the full-resolution mesh triangulation exactly. */
  height(x, z) {
    const u = x / this.cell + this.N / 2, v = z / this.cell + this.N / 2;
    const c = Math.floor(u), r = Math.floor(v);
    const fu = u - c, fv = v - r;
    const ha = this.gridH(c, r), hc = this.gridH(c + 1, r + 1);
    if (fu > fv) return ha + fu * (this.gridH(c + 1, r) - ha) + fv * (hc - this.gridH(c + 1, r));
    return ha + fv * (this.gridH(c, r + 1) - ha) + fu * (hc - this.gridH(c, r + 1));
  }

  /** Smoothed gradient (dh/dx, dh/dz) over one cell either side. */
  gradient(x, z, out = { x: 0, z: 0 }) {
    const d = this.cell;
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

  lakeAt(x, z) {
    const c = Math.round(x / this.cell + this.N / 2), r = Math.round(z / this.cell + this.N / 2);
    if (c < 0 || r < 0 || c >= this.N || r >= this.N) return null;
    const id = this.water[r * this.N + c];
    return id ? this.lakes[id - 1] : null;
  }

  /** Lake whose shore is within `pad` metres of (x, z), if any. */
  nearWater(x, z, pad) {
    const step = this.cell;
    for (let dz = -pad; dz <= pad; dz += step) {
      for (let dx = -pad; dx <= pad; dx += step) {
        if (dx * dx + dz * dz > pad * pad) continue;
        const l = this.lakeAt(x + dx, z + dz);
        if (l && this.height(x + dx, z + dz) < l.level) return l;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ ecology
  #buildFields() {
    const make = (scale, oct, seed) => {
      const f = new Float32Array(FIELD * FIELD);
      const k = this.extent / FIELD;
      for (let r = 0; r < FIELD; r++) {
        for (let c = 0; c < FIELD; c++) f[r * FIELD + c] = fbm((c * k) / scale, (r * k) / scale, oct, seed);
      }
      return f;
    };
    this.fPatch = make(260, 3, 1);   // forest clearings / meadows
    this.fFine = make(70, 2, 2);      // rock & lichen mottling
    this.fLine = make(900, 2, 3);     // treeline wobble
    this.fAspen = make(180, 3, 4);    // aspen groves
    this.fSnow = make(90, 3, 5);      // late-season snowfields
  }

  /** Bilinear lookup into a noise field; wraps so the far horizon gets texture too. */
  field(f, x, z) {
    const u = (x + this.half) / this.extent * FIELD, v = (z + this.half) / this.extent * FIELD;
    const cu = Math.floor(u), rv = Math.floor(v), fu = u - cu, fv = v - rv;
    const c0 = ((cu % FIELD) + FIELD) % FIELD, r0 = ((rv % FIELD) + FIELD) % FIELD;
    const c1 = (c0 + 1) % FIELD, r1 = (r0 + 1) % FIELD;
    const a = f[r0 * FIELD + c0], b = f[r0 * FIELD + c1], d = f[r1 * FIELD + c0], e = f[r1 * FIELD + c1];
    return a + (b - a) * fu + (d - a) * fv + (a - b - d + e) * fu * fv;
  }

  treeline(x, z) {
    return 3425 + (this.field(this.fLine, x, z) - 0.5) * 150;
  }

  /**
   * Land cover at a point. Returns the shared `cover` scratch object:
   * forest/krumm/aspen/rock/snow/meadow weights in 0..1 and the treeline.
   */
  cover(x, z, e = this.height(x, z), g = this.gradient(x, z, _g)) {
    const grade = Math.hypot(g.x, g.z);
    const north = grade > 1e-4 ? g.z / grade : 0; // +1 = slope faces north
    const tl = this.treeline(x, z);
    const patch = this.field(this.fPatch, x, z);
    const fine = this.field(this.fFine, x, z);

    const steep = smoothstep(0.7, 1.05, grade);
    const alpine = smoothstep(tl - 20, tl + 120, e);
    const valley = smoothstep(2790, 2690, e) * smoothstep(0.13, 0.05, grade);

    _cover.treeline = tl;
    _cover.rock = clamp(steep + alpine * smoothstep(0.3, 0.75, grade) * 0.8 + alpine * smoothstep(tl + 250, tl + 450, e) * (0.4 + fine * 0.6), 0, 1);
    _cover.forest = smoothstep(tl + 40, tl - 90, e) * (1 - steep) * smoothstep(0.24, 0.38, patch) * (1 - valley);
    _cover.aspen = _cover.forest * smoothstep(3080, 2920, e) * smoothstep(0.63, 0.7, this.field(this.fAspen, x, z)) * (0.6 - north * 0.4);
    _cover.krumm = smoothstep(tl - 80, tl - 10, e) * smoothstep(tl + 170, tl + 60, e) * (1 - _cover.rock) * smoothstep(0.35, 0.55, patch + 0.1);
    _cover.meadow = Math.max(valley, (1 - smoothstep(0.24, 0.38, patch)) * (1 - alpine));
    _cover.snow = e > 3560 && north > 0.35 && grade < 1.0
      ? smoothstep(0.7, 0.78, this.field(this.fSnow, x, z) + (e - 3560) / 1400 + north * 0.08) : 0;
    _cover.north = north;
    _cover.grade = grade;
    _cover.fine = fine;
    _cover.patch = patch;
    return _cover;
  }

  /** RGBA colour map (sRGB bytes) for any height grid sharing our ecology. */
  colorMap(sample, size, cellSize, originX, originZ) {
    const data = new Uint8Array(size * size * 4);
    const col = [0, 0, 0];
    const g = { x: 0, z: 0 };
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const x = originX + c * cellSize, z = originZ + r * cellSize;
        const e = sample(c, r);
        g.x = (sample(c + 1, r) - sample(c - 1, r)) / (2 * cellSize);
        g.z = (sample(c, r + 1) - sample(c, r - 1)) / (2 * cellSize);
        const cv = this.cover(x, z, e, g);
        // concavity darkening: cheap ambient occlusion from the laplacian
        const lap = (sample(c + 2, r) + sample(c - 2, r) + sample(c, r + 2) + sample(c, r - 2) - 4 * e) / (4 * cellSize);
        groundColor(cv, e, col);
        const ao = clamp(1 + lap * 0.9, 0.78, 1.08);
        const i = (r * size + c) * 4;
        data[i] = clamp(col[0] * ao, 0, 255);
        data[i + 1] = clamp(col[1] * ao, 0, 255);
        data[i + 2] = clamp(col[2] * ao, 0, 255);
        data[i + 3] = 255;
      }
    }
    return data;
  }

  // ------------------------------------------------------------ trails
  #buildTrailIndex() {
    this.trailCell = 32;
    this.trailGrid = new Map();
    this.segments = [];
    for (const t of this.trails) {
      const pts = resample(t.pts, t.kind === 'road' ? 4 : 2.5);
      t.dense = pts;
      t.width = t.kind === 'road' ? 4.2 : t.kind === 'trail' ? 1.3 : 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const s = { ax: pts[i][0], az: pts[i][1], bx: pts[i + 1][0], bz: pts[i + 1][1], trail: t };
        const id = this.segments.push(s) - 1;
        const k = this.#trailKey((s.ax + s.bx) / 2, (s.az + s.bz) / 2);
        if (!this.trailGrid.has(k)) this.trailGrid.set(k, []);
        this.trailGrid.get(k).push(id);
      }
    }
  }

  #trailKey(x, z) {
    return `${Math.floor(x / this.trailCell)},${Math.floor(z / this.trailCell)}`;
  }

  /** Distance to the nearest trail or road centreline within ~32 m. */
  nearestTrail(x, z) {
    let best = Infinity, trail = null;
    const cx = Math.floor(x / this.trailCell), cz = Math.floor(z / this.trailCell);
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const ids = this.trailGrid.get(`${cx + i},${cz + j}`);
        if (!ids) continue;
        for (const id of ids) {
          const s = this.segments[id];
          const d = segDist(x, z, s.ax, s.az, s.bx, s.bz);
          if (d < best) { best = d; trail = s.trail; }
        }
      }
    }
    _near.d = best; _near.trail = trail;
    return _near;
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
const _near = { d: Infinity, trail: null };

// late-September palette: gold aspens, tawny meadows, rust tundra, pink-grey granite
const C = {
  meadow: [176, 158, 96], willow: [150, 104, 58], forest: [40, 62, 40], lodgepole: [58, 80, 50],
  aspen: [218, 166, 52], tundra: [138, 112, 76], tundra2: [112, 96, 70], krumm: [62, 84, 54],
  rock: [160, 152, 144], rock2: [138, 131, 124], talus: [172, 165, 155], snow: [236, 241, 246],
};

function mix(out, a, t) {
  out[0] += (a[0] - out[0]) * t; out[1] += (a[1] - out[1]) * t; out[2] += (a[2] - out[2]) * t;
}

export function groundColor(cv, e, out) {
  const tundra = cv.fine > 0.5 ? C.tundra : C.tundra2;
  out[0] = C.meadow[0]; out[1] = C.meadow[1]; out[2] = C.meadow[2];
  if (e < 2760) mix(out, C.willow, smoothstep(0.45, 0.75, cv.patch) * 0.6 * cv.meadow);
  mix(out, tundra, smoothstep(cv.treeline - 150, cv.treeline + 60, e));
  mix(out, e < 3000 ? C.lodgepole : C.forest, cv.forest * 0.92);
  mix(out, C.aspen, cv.aspen * 0.95);
  mix(out, C.krumm, cv.krumm * 0.55);
  const rockTone = cv.fine > 0.55 ? C.rock2 : e > cv.treeline + 200 ? C.talus : C.rock;
  mix(out, rockTone, cv.rock);
  mix(out, C.snow, cv.snow);
  return out;
}

function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return Math.hypot(px - ax - dx * t, pz - az - dz * t);
}

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

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const out = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return out;
}

function decode(bytes, meta) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true) / meta.hScale + meta.hOffset;
  return out;
}
