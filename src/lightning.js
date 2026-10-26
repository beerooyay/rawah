import * as THREE from 'three';

// Lightning that grows the way it does in the air.
//
// The channel is grown on a voxel grid by the dielectric breakdown model
// (Niemeyer, Pietronero and Wiesmann): the potential between the charge region
// and the ground is a solution of Laplace's equation; each step the channel
// extends into one of the voxels next to it, chosen with probability
// proportional to the potential there raised to eta, and the cell it takes
// becomes part of the conductor (potential 0). That is what makes a real
// stepped leader fork, bend and hunt downward, and every fork it makes is a
// branch you see. After each growth step the potential is relaxed only in a
// window around the new tip, and the window's rim is checked: if the field
// still moves by more than the tolerance there, the update was not local
// enough and is counted (`stats.violations`), the same "touch only what can
// change, and prove it" rule as the certified boxels. The potential field is
// a voxel grid with a sleeping rim: nothing is stepped outside the window.
//
// A strike then plays out the way the high-speed footage does: a faint stepped
// leader feeds down the tree in a few tenths of a second; when it touches
// down, the return stroke lights the whole channel (the main trunk far
// brighter than the forks); two to six strokes follow through the same
// channel a few tens of milliseconds apart, each a little dimmer, with a
// continuing current glowing between some of them; then it cools. The colour is
// physical: the channel is a ~28,000 K plasma (blue-white, a little violet at the
// rim), it cools through white to a dull amber over the afterglow, and the light
// that reaches you has been through the air: Rayleigh and rain scattering take
// the blue out with distance, so a far bolt comes yellower and dimmer, and in
// heavy rain the halo picks up the pink of hydrogen alpha.

// ------------------------------------------------------------------ colour
/** Blackbody colour for a temperature (K), linear RGB 0..1 (Tanner Helland's fit, sRGB decoded). */
export function blackbody(T) {
  const t = Math.min(40000, Math.max(1000, T)) / 100;
  let r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  let g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  let b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.pow(Math.min(255, Math.max(0, v)) / 255, 2.2);
  return [c(r), c(g), c(b)];
}

/** Fraction of each colour that survives `d` metres of air, with rain in it (0..1). */
export function transmit(d, rain) {
  const mie = 21e-6 * (1 + rain * 20);                       // aerosol and raindrops scatter every colour alike
  return [Math.exp(-d * (5.8e-6 + mie)), Math.exp(-d * (13.5e-6 + mie)), Math.exp(-d * (33.1e-6 + mie))];   // Rayleigh takes blue first
}

// ------------------------------------------------------------------ the voxel field and the growth
const NB = [];
for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
  const n = Math.abs(x) + Math.abs(y) + Math.abs(z);
  if (n === 1 || n === 2) NB.push([x, y, z]);                // faces and edges: 18 neighbours, so the grid does not show
}

export class LeaderGrid {
  constructor(N = 64) {
    this.N = N;
    const n = N * N * N;
    this.phi = new Float32Array(n);
    this.fix = new Uint8Array(n);      // 1: a boundary or the channel itself (potential held)
    this.block = new Uint8Array(n);    // 1: outside the flash layer (insulating)
    this.site = new Int32Array(n);     // channel site index at a voxel, -1 none
    this.cand = new Int32Array(n);     // parent site for a voxel the channel could grow into, -1 none
    this.sites = [];                   // { x, y, z, par }
    this.candList = [];
    this.stats = { steps: 0, relaxed: 0, edge: 0, violations: 0, ms: 0 };
  }

  #i(x, y, z) { const N = this.N; return (z * N + y) * N + x; }

  /**
   * kind 'cg': charge region across the top (potential 0), ground across the bottom (1).
   * kind 'ic': a flash inside a layer, growing sideways from x = 1 toward x = N - 1.
   * `dxz`, `dy`: voxel size in metres (the Laplacian is anisotropic).
   */
  reset(kind, dxz, dy, rng, { yLo = 0.55, yHi = 0.9, screen = 220, R = 10, tol = 4e-3 } = {}) {
    const N = this.N;
    this.kind = kind; this.rng = rng; this.eta = kind === 'cg' ? 1.7 : 1.4;
    this.wx = 1 / (dxz * dxz); this.wy = 1 / (dy * dy);
    // Laplace's equation has no locality: a new conductor changes the field everywhere, as 1/r. Space charge in the air and
    // ions off the ground screen it, which is real (corona and attachment layers), and a screened field decays like
    // exp(-r / screen), which is exactly what a certified window needs: the update is carried out inside R cells and the
    // rim is checked against `tol`.
    this.kap2 = 1 / (screen * screen); this.R = R; this.tol = tol;
    const kk = Math.sqrt(this.kap2);
    this.phi.fill(0); this.fix.fill(0); this.block.fill(0); this.site.fill(-1); this.cand.fill(-1);
    this.sites.length = 0; this.candList.length = 0; this.done = false; this.contact = -1;
    this.stats = { steps: 0, relaxed: 0, edge: 0, violations: 0, ms: 0 };
    if (kind === 'cg') {
      for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = this.#i(x, y, z);
        this.phi[i] = Math.sinh(kk * (N - 1 - y) * dy) / Math.sinh(kk * (N - 1) * dy);   // 0 under the charge region, 1 at the ground, screened between
        if (y === 0) { this.fix[i] = 1; this.phi[i] = 1; }       // the ground
        if (y === N - 1) { this.fix[i] = 1; this.phi[i] = 0; }   // the charge region
      }
      const x0 = Math.round(N * (0.35 + 0.3 * rng())), z0 = Math.round(N * (0.35 + 0.3 * rng()));
      this.#take(x0, N - 2, z0, -1);
    } else {
      const lo = Math.floor(N * yLo), hi = Math.floor(N * yHi);
      for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const i = this.#i(x, y, z);
        this.phi[i] = Math.sinh(kk * x * dxz) / Math.sinh(kk * (N - 1) * dxz);
        if (y < lo || y > hi) this.block[i] = 1;
        if (x === N - 1 && !this.block[i]) { this.fix[i] = 1; this.phi[i] = 1; }   // the opposite charge pocket
      }
      this.#take(1, Math.round((lo + hi) / 2), Math.round(N * (0.35 + 0.3 * rng())), -1);
    }
  }

  /** The channel takes a voxel: it becomes a conductor, its neighbours become candidates, and the field is relaxed around it. */
  #take(x, y, z, par) {
    const N = this.N, i = this.#i(x, y, z), id = this.sites.length;
    this.sites.push({ x, y, z, par });
    this.site[i] = id; this.fix[i] = 1; this.phi[i] = 0; this.cand[i] = -1;
    for (const [dx, dy, dz] of NB) {
      const a = x + dx, b = y + dy, c = z + dz;
      if (a < 1 || b < 1 || c < 1 || a > N - 2 || b > N - 2 || c > N - 2) continue;
      const j = this.#i(a, b, c);
      if (this.fix[j] || this.block[j] || this.site[j] >= 0 || this.cand[j] >= 0) continue;
      this.cand[j] = id; this.candList.push(j);
    }
    this.#relax(x, y, z);
  }

  /** Gauss-Seidel on Laplace's equation inside a window around (x, y, z); the window's rim is the certificate. */
  #relax(cx, cy, cz) {
    const N = this.N, R = this.R, phi = this.phi, fix = this.fix, blk = this.block, wx = this.wx, wy = this.wy;
    const x0 = Math.max(1, cx - R), x1 = Math.min(N - 2, cx + R), y0 = Math.max(1, cy - R), y1 = Math.min(N - 2, cy + R), z0 = Math.max(1, cz - R), z1 = Math.min(N - 2, cz + R);
    const s = N, S = N * N, den = 2 * wx + 2 * wx + 2 * wy + this.kap2;
    let edge = 0;
    for (let sweep = 0; sweep < 3; sweep++) {
      const last = sweep === 2;
      for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = (z * N + y) * N + x;
        if (fix[i] || blk[i]) continue;
        const e = blk[i + 1] ? phi[i] : phi[i + 1], w = blk[i - 1] ? phi[i] : phi[i - 1];
        const u = blk[i + s] ? phi[i] : phi[i + s], d = blk[i - s] ? phi[i] : phi[i - s];
        const f = blk[i + S] ? phi[i] : phi[i + S], b = blk[i - S] ? phi[i] : phi[i - S];
        const v = (wx * (e + w + f + b) + wy * (u + d)) / den;
        if (last && (x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1)) edge = Math.max(edge, Math.abs(v - phi[i]));
        phi[i] = v;
      }
    }
    this.stats.relaxed += (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) * 3;
    this.stats.edge = Math.max(this.stats.edge, edge);
    if (edge > this.tol) this.stats.violations++;        // the potential was still moving at the rim: the window was too small here
  }

  /** One growth step. Returns false once the channel has finished. */
  step() {
    if (this.done) return false;
    const N = this.N, list = this.candList, eta = this.eta;
    if (!list.length || this.sites.length > 1400) { this.done = true; return false; }
    let sum = 0;
    if (!this.w || this.w.length < list.length) this.w = new Float32Array(Math.max(1 << 12, list.length * 2));
    const ww = this.w;
    for (let k = 0; k < list.length; k++) { const v = Math.max(this.phi[list[k]], 1e-7); ww[k] = Math.pow(v, eta); sum += ww[k]; }
    let r = this.rng() * sum, k = 0;
    while (k < list.length - 1 && r > ww[k]) { r -= ww[k]; k++; }
    const j = list[k]; list[k] = list[list.length - 1]; list.pop();
    const x = j % N, y = ((j / N) | 0) % N, z = (j / (N * N)) | 0;
    this.#take(x, y, z, this.cand[j] >= 0 ? this.cand[j] : this.site[j]);
    this.stats.steps++;
    // arrived?
    if (this.kind === 'cg' ? y <= 1 : x >= N - 3) {
      const par = this.sites.length - 1;
      this.contact = this.sites.length;
      this.sites.push({ x: this.kind === 'cg' ? x : N - 1, y: this.kind === 'cg' ? 0 : y, z, par });
      this.done = true;
    }
    return !this.done;
  }
}

// ------------------------------------------------------------------ the bolt as geometry
/** A tree of segments from the grown voxels: points jittered off the grid, forks pruned, brightness by branch order. */
function buildBolt(grid, origin, dxz, dy, rng) {
  const N = grid.N, S = grid.sites, n = S.length;
  const P = S.map((s) => new THREE.Vector3(
    origin.x + (s.x - N / 2 + (rng() - 0.5) * 0.7) * dxz,
    origin.y + (s.y + (rng() - 0.5) * 0.5) * dy,
    origin.z + (s.z - N / 2 + (rng() - 0.5) * 0.7) * dxz));
  if (grid.contact >= 0) P[grid.contact].y = origin.y + (grid.kind === 'cg' ? 0 : P[grid.contact].y - origin.y);
  // the trunk: from the strike point back to the root
  const main = new Uint8Array(n);
  let c = grid.contact >= 0 ? grid.contact : n - 1;
  for (; c >= 0; c = S[c].par) main[c] = 1;
  // forks: hops from the trunk, and how much channel hangs off each site
  const hop = new Int16Array(n), kids = new Int16Array(n);
  for (let i = 0; i < n; i++) { const p = S[i].par; if (p >= 0) { kids[p]++; hop[i] = main[i] ? 0 : (main[p] ? 1 : hop[p] + 1); } }
  const size = new Int16Array(n).fill(1);
  for (let i = n - 1; i > 0; i--) { const p = S[i].par; if (p >= 0) size[p] += size[i]; }
  const segs = [];     // { a, b, br, t }
  const order = [];    // leader order of each site
  for (let i = 1; i < n; i++) order[i] = i / n;
  const lvl = new Float32Array(n);
  for (let i = 0; i < n; i++) lvl[i] = main[i] ? 1 : 0.5 * Math.exp(-hop[i] / 14) * (0.55 + 0.9 * ((i * 0.6180339) % 1));
  for (let i = 1; i < n; i++) {
    const p = S[i].par;
    if (p < 0) continue;
    if (!main[i] && size[i] < 3 && rng() < 0.6) continue;        // short twigs mostly drop out
    const a = P[p], b = P[i], len = a.distanceTo(b);
    // a kink in the middle, a few percent of the length off the line
    const m = a.clone().lerp(b, 0.5 + (rng() - 0.5) * 0.3);
    const dir = b.clone().sub(a).normalize(), up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const u = new THREE.Vector3().crossVectors(dir, up).normalize(), v = new THREE.Vector3().crossVectors(dir, u);
    m.addScaledVector(u, (rng() - 0.5) * len * 0.26).addScaledVector(v, (rng() - 0.5) * len * 0.26);
    const br = main[i] ? 1 : lvl[i];
    segs.push({ a, b: m, br, t: order[p] ?? 0 }, { a: m, b, br, t: order[i] });
  }
  return { segs, P, main, n, root: P[0], contact: grid.contact >= 0 ? P[grid.contact] : null };
}

// ------------------------------------------------------------------ rendering
const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aA, aB;
attribute vec2 aC;
attribute float aBr, aT;
uniform float uWidth, uPixel, uMinPx;
varying vec2 vC;
varying float vBr, vT;
void main() {
  vec3 p = mix(aA, aB, aC.x);
  vec3 dir = normalize(aB - aA);
  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 side = normalize(cross(dir, toCam));
  // the channel is thin; what you see is the glow, so keep it at least a pixel and a half
  float w = max(uWidth * (0.3 + 0.7 * aBr), uPixel * dist * uMinPx);
  p += side * aC.y * w + dir * (aC.x * 2.0 - 1.0) * w * 0.6;
  vC = aC; vBr = aBr; vT = aT;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform vec3 uCore, uHalo;
uniform float uLeader, uLeaderGlow, uStroke, uAfter, uFork;
varying vec2 vC;
varying float vBr, vT;
void main() {
  #include <logdepthbuf_fragment>
  float r = abs(vC.y);
  // across the channel: a hot thin core, a violet-blue halo
  float core = exp(-r * r * 22.0), halo = exp(-r * r * 2.4);
  // the leader feeds down the tree in order; the strokes then light all of it, forks far less than the trunk
  float lead = step(vT, uLeader) * uLeaderGlow * (0.35 + 0.65 * vBr);
  float body = (uStroke + uAfter) * mix(uFork, 1.0, step(0.99, vBr)) * vBr;
  float I = lead + body;
  vec3 col = uCore * core * I * 9.0 + uHalo * halo * I * (0.8 + 1.6 * core);   // HDR: the core is far brighter than the sky, and tone mapping turns it white
  gl_FragColor = vec4(col, 1.0);
}`;

class BoltView {
  constructor(scene) {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,   // the ribbon always winds away from the camera: draw both faces
      uniforms: {
        uWidth: { value: 2 }, uPixel: { value: 0.0016 }, uMinPx: { value: 2.6 },
        uCore: { value: new THREE.Color(1, 1, 1) }, uHalo: { value: new THREE.Color(0.5, 0.6, 1) },
        uLeader: { value: 0 }, uLeaderGlow: { value: 0 }, uStroke: { value: 0 }, uAfter: { value: 0 }, uFork: { value: 0.3 },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  set(segs) {
    const n = segs.length, A = new Float32Array(n * 12), B = new Float32Array(n * 12), C = new Float32Array(n * 8), Br = new Float32Array(n * 4), T = new Float32Array(n * 4), idx = new Uint32Array(n * 6);
    segs.forEach((s, i) => {
      for (let k = 0; k < 4; k++) {
        const o = (i * 4 + k);
        A.set([s.a.x, s.a.y, s.a.z], o * 3); B.set([s.b.x, s.b.y, s.b.z], o * 3);
        C[o * 2] = k & 1; C[o * 2 + 1] = k < 2 ? -1 : 1;
        Br[o] = s.br; T[o] = s.t;
      }
      const v = i * 4; idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(A, 3));
    g.setAttribute('aA', new THREE.BufferAttribute(A, 3)); g.setAttribute('aB', new THREE.BufferAttribute(B, 3));
    g.setAttribute('aC', new THREE.BufferAttribute(C, 2)); g.setAttribute('aBr', new THREE.BufferAttribute(Br, 1)); g.setAttribute('aT', new THREE.BufferAttribute(T, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }
}

// ------------------------------------------------------------------ the storm
function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class Lightning {
  constructor(scene, world) {
    this.world = world; this.scene = scene;
    this.grid = new LeaderGrid(64);
    this.views = [new BoltView(scene), new BoltView(scene), new BoltView(scene)];
    this.active = [];
    this.pending = [];
    this.flash = 0;
    this.light = new THREE.PointLight(0xc8d4ff, 0, 0, 2);
    scene.add(this.light);
    this.events = [];
    this.stats = { bolts: 0, cg: 0, ic: 0, ms: 0 };
    this.seed = 1;
    /** For the sky: the directions and colours of the bolts lighting the clouds (up to three). */
    this.sky = { dir: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()], col: [new THREE.Color(), new THREE.Color(), new THREE.Color()] };
  }

  /**
   * A strike `dist` metres from `from` (x, y, z), toward `azimuth` (radians, 0 along +x). `type` 'cg', 'ic' or 'cc'.
   */
  strike({ from, dist, azimuth, type, rain = 0.6, severe = 0 }) {
    this.pending.push({ from: from.clone(), dist, azimuth, type, rain, severe, seed: (this.seed = (this.seed * 1664525 + 1013904223) >>> 0) });
  }

  #launch(job) {
    const rng = mulberry(job.seed), g = this.grid, N = g.N;
    const gx = job.from.x + Math.cos(job.azimuth) * job.dist, gz = job.from.z + Math.sin(job.azimuth) * job.dist;
    const ground = this.world.height(gx, gz);
    // the cloud base sits a mile or so over where you are
    const base = Math.max(ground + 1300, job.from.y + 1500 + rng() * 900), H = Math.min(3800, Math.max(1500, base - ground));
    let dxz = 34, dy = H / (N - 1), origin;
    if (job.type === 'cg') origin = new THREE.Vector3(gx, ground, gz);
    else { dxz = job.type === 'cc' ? 190 : 110; origin = new THREE.Vector3(gx, ground, gz); }
    g.reset(job.type === 'cg' ? 'cg' : 'ic', dxz, dy, rng);
    this.building = { job, rng, origin, dxz, dy, t0: performance.now() };
  }

  /** Returns events: { type: 'thunder', dist, kind, strength } and { type: 'strike', x, y, z, dist, kind }. */
  update(dt, cam, wx, pixel) {
    this.events.length = 0;
    // grow the leader a few milliseconds at a time
    if (!this.building && this.pending.length && this.active.length < 3) this.#launch(this.pending.shift());
    if (this.building) {
      const t0 = performance.now(), g = this.grid;
      while (performance.now() - t0 < 5 && g.step());
      if (g.done) this.#finish();
    }
    // the bolts in the air
    this.flash = 0;
    const sky = this.sky; sky.dir.forEach((d) => d.set(0, 1, 0, 0));
    let brightest = 0, bestPos = null, bestCol = null;
    for (let k = this.active.length - 1; k >= 0; k--) {
      const b = this.active[k];
      b.t += dt;
      const I = this.#intensity(b);
      this.#colour(b, I);
      const u = b.view.mat.uniforms;
      u.uPixel.value = pixel;
      u.uLeader.value = Math.min(1, b.t / b.leaderT);
      u.uLeaderGlow.value = b.t < b.leaderT ? 0.05 + 0.04 * Math.sin(b.t * 220) ** 2 : 0;
      u.uStroke.value = I.stroke; u.uAfter.value = I.after;
      if (!b.sounded && b.t >= b.leaderT) {
        b.sounded = true;
        this.events.push({ type: 'thunder', dist: b.dist, kind: b.type, strength: b.strength });
        if (b.contact) this.events.push({ type: 'strike', x: b.contact.x, y: b.contact.y, z: b.contact.z, dist: b.dist, kind: b.type });
      }
      const total = (I.stroke + I.after) * b.strength;
      this.flash = Math.max(this.flash, total * 0.35 * Math.exp(-b.dist / 7000));
      if (total > brightest) { brightest = total; bestPos = b.light; bestCol = b.coreCol; }
      if (k < 3) {
        const d = b.skyPos.clone().sub(cam).normalize();
        sky.dir[k].set(d.x, d.y, d.z, total * b.reach * Math.min(1, 1.5 * Math.exp(-b.dist / 9000)));
        sky.col[k].copy(b.haloCol).multiplyScalar(0.12);   // the cloud takes a fraction of the channel's glow
      }
      if (b.t > b.endT) { b.view.mesh.visible = false; this.active.splice(k, 1); }
    }
    // the light the bolt throws on the ground and the trees
    if (bestPos) {
      this.light.position.copy(bestPos); this.light.color.setRGB(bestCol.r, bestCol.g, bestCol.b);
      this.light.intensity = brightest * 2.2e7;
    } else this.light.intensity = 0;
    return this.events;
  }

  /** Stroke timeline: faint stepped leader, then return strokes with a continuing current between some, then the afterglow. */
  #intensity(b) {
    const t = b.t;
    if (t < b.leaderT) return { stroke: 0, after: 0 };
    let stroke = 0, cur = 0;
    for (const s of b.strokes) {
      const dt = t - s.t;
      if (dt < 0) continue;
      const v = dt < 0.003 ? dt / 0.003 : Math.exp(-(dt - 0.003) / s.tau);
      stroke = Math.max(stroke, s.p * v);
      if (s.cc && dt < s.cc) cur = Math.max(cur, s.p * 0.22 * (1 - dt / s.cc));
    }
    const last = b.strokes[b.strokes.length - 1].t;
    const after = t > last ? 0.1 * Math.exp(-(t - last) / 0.28) : 0;
    return { stroke: Math.max(stroke, cur) * (1 + 0.08 * Math.sin(t * 700)), after };
  }

  /** Channel temperature and the light that gets to you: a hot plasma cooling, seen through the air. */
  #colour(b, I) {
    const heat = Math.min(1, Math.pow(I.stroke + I.after * 0.5, 0.55));
    const T = 3600 + 24800 * heat;
    const [r, g, bl] = blackbody(T), tr = b.tr;
    b.coreCol.setRGB(r * tr[0], g * tr[1], bl * tr[2]).multiplyScalar(b.strength * 2.4);
    // the glow: more violet than the core, with hydrogen alpha's pink creeping in when rain is thick around the channel
    const pink = Math.min(1, b.rain * 0.9) * 0.45;
    b.haloCol.setRGB((0.5 + 0.5 * pink) * tr[0], (0.5 - 0.18 * pink) * tr[1], 1.0 * tr[2]).multiplyScalar(b.strength * 3.0 * (0.4 + 0.6 * heat));
    const u = b.view.mat.uniforms;
    u.uCore.value.copy(b.coreCol); u.uHalo.value.copy(b.haloCol);
  }

  #finish() {
    const { job, rng, origin, dxz, dy } = this.building;
    this.building = null;
    const g = this.grid;
    const { segs, root, contact, P } = buildBolt(g, origin, dxz, dy, rng);
    if (contact && job.type === 'cg') contact.y = this.world.height(contact.x, contact.z);   // the box floor is flat; the ground is not
    const view = this.views.find((v) => !v.mesh.visible) || this.views[0];
    view.set(segs);
    view.mesh.visible = true;
    const d = job.dist, kind = job.type;
    const strokes = [];
    let t = 0.2 + rng() * 0.35;
    const leaderT = t;
    const n = kind === 'cg' ? 1 + Math.floor(rng() * (job.severe > 0.5 ? 6 : 4.5)) : 1 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      strokes.push({ t, p: k === 0 ? 1 : 0.3 + 0.55 * rng(), tau: 0.016 + rng() * 0.05, cc: rng() < 0.45 ? 0.04 + rng() * 0.12 : 0 });
      t += 0.035 + rng() * 0.09;
    }
    const mid = new THREE.Vector3().addVectors(root, contact || P[P.length - 1]).multiplyScalar(0.5);
    const lightAt = contact ? contact.clone().add(new THREE.Vector3(0, 120, 0)) : mid;
    const strength = kind === 'cg' ? 1 : kind === 'ic' ? 0.5 : 0.4;
    const b = {
      view, type: kind, dist: d, t: 0, leaderT, strokes, endT: t + 1.4, strength, rain: job.rain, sounded: false,
      contact: contact ? contact.clone() : null, light: lightAt, skyPos: kind === 'cg' ? root.clone() : mid,
      reach: kind === 'cg' ? 0.9 : 1.6,                       // an in-cloud flash lights a far wider piece of cloud than a ground stroke
      tr: transmit(Math.max(300, d), job.rain), coreCol: new THREE.Color(), haloCol: new THREE.Color(),
    };
    const u = view.mat.uniforms;
    u.uWidth.value = kind === 'cg' ? 6 : 14;
    u.uFork.value = kind === 'cg' ? 0.22 : 0.5;
    this.active.push(b);
    this.stats.bolts++; this.stats[kind === 'cg' ? 'cg' : 'ic']++;
    this.stats.ms = g.stats.steps;
  }
}
