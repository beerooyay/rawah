import * as THREE from 'three';

// View culling. Three tests whole objects against the camera frustum, but
// nearly everything here is one huge mesh or one instance buffer, so the
// engine's test never rejects anything. This module supplies what's missing:
//
//   frustum    expandedFrustum() for CPU-filled instance buffers, chunkGeometry()
//              to cut a huge mesh into pieces the engine can reject.
//   occlusion  HorizonMap, a polar skyline of the terrain around the camera.
//              Anything whose top sits under the skyline of the ground in
//              front of it is hidden behind a ridge and need not be drawn.
//   back faces opaque meshes keep three's default FrontSide culling; the
//              double-sided exceptions (cards, grass, impostors) are alpha
//              cut-outs that must show both faces.

export const CULL = { frustum: true, occlusion: true, casters: true, margin: 0.16 };

const AZ = 512;                       // skyline bins around the circle
const BIN = (Math.PI * 2) / AZ;
const NEAR = 30;                      // ground closer than this never counts as an occluder
const RELIEF = 2.6;                   // micro-relief the lidar grid doesn't carry: lower every occluder by this
const SLICE = 64;                     // bins refreshed per frame while the skyline rebuilds
const MOVE = 4;                       // rebuild once the eye is this far from the skyline's origin
const TAN_PAD = 0.006;                // and an object must clear the skyline by this much (~0.35 degrees)
export const EYE_SLACK = 8;           // the skyline holds for any eye within this many metres of its origin

const _m = new THREE.Matrix4(), _p = new THREE.Matrix4();

/** The camera frustum widened by `margin` radians on every side, for buffers that are refilled only when the view has turned further than that. */
export function expandedFrustum(camera, margin, out = new THREE.Frustum()) {
  const mt = Math.tan(margin);
  const widen = (x) => (x + mt) / (1 - x * mt);
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const top = camera.near * widen(t), right = camera.near * widen(t * camera.aspect);
  _p.makePerspective(-right, right, top, -top, camera.near, camera.far);
  out.setFromProjectionMatrix(_m.multiplyMatrices(_p, camera.matrixWorldInverse));
  return out;
}

/** Sphere against the four side planes of a frustum (near and far are left to the depth buffer). */
export function sphereInView(planes, x, y, z, r) {
  for (let i = 0; i < 4; i++) {
    const p = planes[i];
    if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant < -r) return false;
  }
  return true;
}

// ------------------------------------------------------------------ occlusion
/**
 * For every direction around the eye, the steepest slope up to the ground at
 * each distance: tan(elevation) of the terrain skyline, kept as a running
 * maximum so a lookup at distance D answers "how high does the ground in front
 * of D reach". A point is hidden when its own slope is below that.
 *
 * Everything is conservative for any eye within EYE_SLACK of the origin: the
 * ground is lowered by the micro-relief and viewed from the worst eye
 * position, neighbouring bins are merged by the angle the eye could move
 * through, and objects are viewed from their worst position too. Trees do not
 * occlude (they are alpha cards); only the lidar ground does.
 */
export class HorizonMap {
  constructor(world, { range = 9000 } = {}) {
    this.world = world;
    const d = [];
    for (let r = NEAR; r < range; r += Math.max(world.cell * 2, r * 0.025)) d.push(r);
    this.dist = Float32Array.from(d);
    this.K = d.length;
    this.raw = new Float32Array(AZ * this.K);
    this.tan = new Float32Array(AZ * this.K);      // [k * AZ + bin], running max over samples 0..k
    // far ground is drawn from a coarse vertex lattice (about r/36 apart, 2-3 bins), which shaves thin crests:
    // so every sample is eroded by two bins sideways and one ring along the ray, as well as by the eye's slack
    this.reach = this.dist.map((r) => Math.max(2, Math.ceil(Math.asin(Math.min(1, EYE_SLACK / r)) / BIN)));
    this.ring = new Float32Array(AZ);
    this.ox = this.oy = this.oz = 0;
    this.active = false;
    this.version = 0;
    this.pending = null;
  }

  /** Call once a frame with the eye position; `on` is false while the camera flies. */
  update(eye, on = true) {
    on = on && CULL.occlusion;
    if (!on) {
      if (this.active) { this.active = false; this.pending = null; this.version++; }
      return;
    }
    if (!this.active) {
      this.#sample(eye.x, eye.y, eye.z, 0, AZ);
      this.#finish(eye.x, eye.y, eye.z);
      this.active = true;
      this.version++;
      return;
    }
    if (!this.pending) {
      if (Math.hypot(eye.x - this.ox, eye.z - this.oz) < MOVE && Math.abs(eye.y - this.oy) < MOVE * 0.5) return;
      this.pending = { x: eye.x, y: eye.y, z: eye.z, next: 0 };
    }
    const p = this.pending;
    this.#sample(p.x, p.y, p.z, p.next, Math.min(AZ, p.next + SLICE));
    p.next += SLICE;
    if (p.next >= AZ) {
      this.#finish(p.x, p.y, p.z);
      this.pending = null;
      this.version++;
    }
  }

  /** Worst-case slope of the ground at every (distance, bin) from any eye within EYE_SLACK of the origin. */
  #sample(ox, oy, oz, a0, a1) {
    const w = this.world, { dist, K, raw } = this;
    const lo = oy + EYE_SLACK + RELIEF;
    for (let a = a0; a < a1; a++) {
      const ang = (a + 0.5) * BIN - Math.PI, dx = Math.cos(ang), dz = Math.sin(ang);
      let live = true;
      for (let k = 0; k < K; k++) {
        const d = dist[k];
        const x = ox + dx * d, z = oz + dz * d;
        if (!live || !w.inBounds(x, z, 8)) { live = false; raw[k * AZ + a] = -Infinity; continue; }
        const num = w.baseHeight(x, z) - lo;
        raw[k * AZ + a] = num / (num > 0 ? d + EYE_SLACK : d - EYE_SLACK);
      }
    }
  }

  /** Erode the samples (along the ray, and by the angle the eye and the coarse lattice could swing them through), then take the running maximum outward. */
  #finish(ox, oy, oz) {
    const { K, raw, tan, reach, ring } = this;
    for (let k = 0; k < K; k++) {
      const row = k * AZ, r = reach[k], prev = (k - 1) * AZ;
      for (let a = 0; a < AZ; a++) {
        let v = raw[row + a];
        if (k && raw[row - AZ + a] < v) v = raw[row - AZ + a];
        if (k < K - 1 && raw[row + AZ + a] < v) v = raw[row + AZ + a];
        ring[a] = v;
      }
      for (let a = 0; a < AZ; a++) {
        let v = ring[a];
        for (let j = 1; j <= r && v > -Infinity; j++) {
          const l = ring[(a - j + AZ) & (AZ - 1)], h = ring[(a + j) & (AZ - 1)];
          if (l < v) v = l;
          if (h < v) v = h;
        }
        tan[row + a] = k && tan[prev + a] > v ? tan[prev + a] : v;
      }
    }
    this.ox = ox; this.oy = oy; this.oz = oz;
  }

  /** Number of ring samples strictly nearer than `d` (so index - 1 is the last one in front). */
  #ring(d) {
    const a = this.dist;
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < d) lo = m + 1; else hi = m; }
    return lo;
  }

  /** True when `top` at (x, z) is below the skyline from every eye within EYE_SLACK of the origin. */
  hidden(x, top, z) {
    if (!this.active) return false;
    const dx = x - this.ox, dz = z - this.oz, D = Math.sqrt(dx * dx + dz * dz);
    if (D < NEAR + EYE_SLACK * 2) return false;
    const k = this.#ring(D - EYE_SLACK) - 1;
    if (k < 0) return false;
    const num = top - this.oy + EYE_SLACK;
    const t = num / (num > 0 ? D - EYE_SLACK : D + EYE_SLACK);
    const bin = Math.floor((Math.atan2(dz, dx) + Math.PI) / BIN);
    const r = 1 + Math.ceil(Math.asin(Math.min(1, EYE_SLACK / D)) / BIN);
    const row = k * AZ;
    for (let j = -r; j <= r; j++) if (this.tan[row + ((bin + j) & (AZ - 1))] <= t + TAN_PAD) return false;
    return true;
  }

  /** True when everything inside the box (top at most `top`) is hidden. */
  hiddenBox(x0, x1, z0, z1, top) {
    if (!this.active) return false;
    const ox = this.ox, oz = this.oz;
    const nx = Math.max(x0 - ox, 0, ox - x1), nz = Math.max(z0 - oz, 0, oz - z1);
    const Dmin = Math.sqrt(nx * nx + nz * nz);
    if (Dmin < NEAR + EYE_SLACK * 2) return false;
    const fx = Math.max(Math.abs(x0 - ox), Math.abs(x1 - ox)), fz = Math.max(Math.abs(z0 - oz), Math.abs(z1 - oz));
    const Dmax = Math.sqrt(fx * fx + fz * fz);
    const num = top - this.oy + EYE_SLACK;
    const t = num / (num > 0 ? Dmin - EYE_SLACK : Dmax + EYE_SLACK);
    const k = this.#ring(Dmin - EYE_SLACK) - 1;
    if (k < 0) return false;
    // the arc the box covers, as seen from the origin
    const mid = Math.atan2((z0 + z1) * 0.5 - oz, (x0 + x1) * 0.5 - ox);
    let lo = 0, hi = 0;
    for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
      let d = Math.atan2(cz - oz, cx - ox) - mid;
      d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
      if (d < lo) lo = d; if (d > hi) hi = d;
    }
    const pad = Math.asin(Math.min(1, EYE_SLACK / Dmin));
    const b0 = Math.floor((mid + lo - pad + Math.PI) / BIN), b1 = Math.floor((mid + hi + pad + Math.PI) / BIN);
    if (b1 - b0 >= AZ) return false;
    const row = k * AZ;
    for (let b = b0; b <= b1; b++) if (this.tan[row + (b & (AZ - 1))] <= t + TAN_PAD) return false;
    return true;
  }
}

// ------------------------------------------------------------------ chunking
/**
 * Cut an indexed geometry into square chunks of `size` metres (by triangle
 * centroid), each with its own compact vertex buffers and bounds, so three can
 * reject the chunks that are off screen. Triangles are never split, so chunks
 * overlap their neighbours' edges by a triangle at most.
 */
export function chunkGeometry(geo, size) {
  const pos = geo.attributes.position, idx = geo.index.array;
  const buckets = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3, cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const key = Math.floor(cx / size) * 100003 + Math.floor(cz / size);
    let list = buckets.get(key);
    if (!list) buckets.set(key, list = []);
    list.push(a, b, c);
  }
  const out = [];
  for (const tris of buckets.values()) {
    const remap = new Map(), src = [];
    const index = new Uint32Array(tris.length);
    for (let i = 0; i < tris.length; i++) {
      let v = remap.get(tris[i]);
      if (v === undefined) { v = src.length; remap.set(tris[i], v); src.push(tris[i]); }
      index[i] = v;
    }
    const g = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(geo.attributes)) {
      const n = attr.itemSize, from = attr.array, to = new from.constructor(src.length * n);
      for (let i = 0; i < src.length; i++) for (let j = 0; j < n; j++) to[i * n + j] = from[src[i] * n + j];
      g.setAttribute(name, new THREE.BufferAttribute(to, n, attr.normalized));
    }
    g.setIndex(new THREE.BufferAttribute(index, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    out.push(g);
  }
  return out;
}

/** A big static mesh cut into chunks: the engine rejects the off-screen ones, and chunks behind a ridge are switched off. */
export class ChunkSet {
  constructor(geometry, material, size, setup = () => {}) {
    this.group = new THREE.Group();
    this.meshes = chunkGeometry(geometry, size).map((g) => {
      const m = new THREE.Mesh(g, material);
      setup(m);
      this.group.add(m);
      return m;
    });
    this.seen = -1;
  }

  /** Hide the chunks the skyline covers. Cheap to call every frame: it only works when the skyline changed. */
  cull(horizon, rise = 4) {
    const key = horizon.active ? horizon.version : -2;
    if (key === this.seen) return;
    this.seen = key;
    for (const m of this.meshes) {
      const b = m.geometry.boundingBox;
      m.visible = !horizon.hiddenBox(b.min.x, b.max.x, b.min.z, b.max.z, b.max.y + rise);
    }
  }
}
