import * as THREE from 'three';
import { clamp } from './noise.js';

// Fireworks. The fireworks tool sets mortar tubes down on the ground (an array of them, as many as
// you like); lighting one starts its fuse burning, sparks spitting from the tip, and a tube that
// sits near a burning one catches from it, so a row lights itself in a ripple. When the fuse is out
// the tube thumps, a shell climbs on a glowing trail (whistling), and above the tree tops it bursts.
//
// A burst is thousands of stars flung out at once. Each star's path is a closed form (drag and
// gravity), so the GPU draws them from the burst's start time alone: no per-frame work, and each
// star is drawn `TR` times along its own past to make a trail. The ascent trails, fuse sparks and
// the muzzle spray are ordinary CPU particles (`Sparks`). Bursts also flash the scene with a
// pooled point light, and the bang arrives late, at the speed of sound.

const TR = 10;              // points per star: the star and nine steps of its trail
const TDT = 0.022;           // seconds between trail points
const CAP = 9000;           // stars alive at once (about twenty big bursts)
const DRAG = 1.5, GRAV = 9.8;
const SOUND = 343;
const MAX_TUBES = 36;
const FUSE_S = 2.6;         // seconds a fuse burns
const FUSE_L = 0.15;        // metres of fuse on a tube
const REACH = 3.2;          // how far you can reach to light one

const PAL = {
  red: [1, 0.14, 0.1], orange: [1, 0.45, 0.08], gold: [1, 0.78, 0.25], green: [0.25, 1, 0.3], blue: [0.25, 0.5, 1],
  purple: [0.72, 0.28, 1], pink: [1, 0.32, 0.72], cyan: [0.25, 0.95, 1], white: [1, 0.96, 0.88], yellow: [1, 0.92, 0.2],
};
const BRIGHT = ['red', 'orange', 'gold', 'green', 'blue', 'purple', 'pink', 'cyan'];
const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const hsv = (h, s, v) => {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
};

// ------------------------------------------------------------------ shaders
const STAR_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aVel;      // initial velocity, life
attribute vec4 aCol;      // colour, size in metres
attribute vec4 aInfo;     // birth time, trail step, strobe, trail spacing
attribute vec2 aPhys;     // gravity and drag multipliers
uniform float uTime, uScale, uK, uG;
varying vec4 vColor;
void main() {
  float t = uTime - aInfo.x - aInfo.y * ${TDT} * aInfo.w;
  float life = aVel.w;
  if (t < 0.0 || t > life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec4(0.0); return; }
  float k = uK * aPhys.y;
  float e = 1.0 - exp(-k * t);
  vec3 p = position + aVel.xyz * (e / k);
  p.y -= uG * aPhys.x / k * (t - e / k);
  float u = t / life;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  float trail = 1.0 - aInfo.y / ${TR}.0;
  float burn = 1.0 - smoothstep(0.62, 1.0, u);
  float flick = mix(1.0, step(0.45, fract(uTime * 13.0 + aInfo.x * 37.0 + aVel.x * 0.31)), aInfo.z);
  vec3 c = mix(aCol.rgb, vec3(1.0, 0.3, 0.06), smoothstep(0.72, 1.0, u) * 0.7);
  c = mix(c, vec3(1.0), (1.0 - smoothstep(0.0, 0.16, u)) * 0.55 * trail);      // white hot at the break
  vColor = vec4(c * 1.6, burn * trail * trail * flick * smoothstep(0.0, 0.05, t));
  gl_PointSize = min(aCol.w * uScale * (0.72 + 0.28 * trail) * (1.0 - 0.3 * u) / max(-mv.z, 0.1), 220.0);
}`;

const SPARK_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aCol;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vColor = aCol;
  gl_PointSize = min(aSize * uScale / max(-mv.z, 0.1), 160.0);
}`;

const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec4 vColor;
void main() {
  #include <logdepthbuf_fragment>
  float a = texture2D(uMap, gl_PointCoord).a;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

/** A soft round glow with a hot core. */
function glow() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.18, 'rgba(255,255,255,0.85)'); r.addColorStop(0.5, 'rgba(255,255,255,0.2)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

function pointsMaterial(vert, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: FRAG, uniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
}

// ------------------------------------------------------------------ the stars of a burst
class Stars {
  constructor(scene, shared) {
    const n = CAP * TR;
    this.n = n; this.next = 0;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    this.vel = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.col = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.info = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
    this.phys = new THREE.BufferAttribute(new Float32Array(n * 2), 2);
    for (const a of [this.pos, this.vel, this.col, this.info, this.phys]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aVel', this.vel); geo.setAttribute('aCol', this.col); geo.setAttribute('aInfo', this.info); geo.setAttribute('aPhys', this.phys);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Points(geo, pointsMaterial(STAR_VERT, { ...shared, uK: { value: DRAG }, uG: { value: GRAV } }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    scene.add(this.mesh);
  }

  /** Write a burst's stars: each star takes TR consecutive points, one for the star and the rest for its trail. */
  add(c, stars, birth) {
    const per = TR, first = this.next;
    for (const s of stars) {
      if (this.next + per > this.n) this.next = 0;
      for (let j = 0; j < per; j++) {
        const i = this.next + j;
        this.pos.setXYZ(i, c.x + (s.o ? s.o[0] : 0), c.y + (s.o ? s.o[1] : 0), c.z + (s.o ? s.o[2] : 0));
        this.vel.setXYZW(i, s.v[0], s.v[1], s.v[2], j && s.flash ? 0 : s.life);
        this.col.setXYZW(i, s.col[0], s.col[1], s.col[2], s.size);
        this.info.setXYZW(i, birth + (s.delay || 0), j, s.strobe || 0, s.trail ?? 1);
        this.phys.setXY(i, s.g ?? 1, s.k ?? 1);
      }
      this.next += per;
    }
    // upload only what changed (the ring may have wrapped)
    const last = this.next;
    const ranges = last >= first ? [[first, last]] : [[first, this.n], [0, last]];
    for (const [a, b] of ranges) {
      this.pos.addUpdateRange(a * 3, (b - a) * 3); this.vel.addUpdateRange(a * 4, (b - a) * 4); this.col.addUpdateRange(a * 4, (b - a) * 4);
      this.info.addUpdateRange(a * 4, (b - a) * 4); this.phys.addUpdateRange(a * 2, (b - a) * 2);
    }
    for (const a of [this.pos, this.vel, this.col, this.info, this.phys]) a.needsUpdate = true;
  }

  clear() {
    this.vel.array.fill(0);
    this.vel.clearUpdateRanges?.();
    this.vel.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ CPU sparks
class Sparks {
  constructor(scene, shared, cap = 2400) {
    this.cap = cap; this.next = 0;
    this.p = new Float32Array(cap * 3); this.v = new Float32Array(cap * 3);
    this.rgba = new Float32Array(cap * 4); this.size = new Float32Array(cap);
    this.life = new Float32Array(cap); this.age = new Float32Array(cap);
    this.c0 = new Float32Array(cap * 3); this.s0 = new Float32Array(cap); this.drag = new Float32Array(cap); this.grav = new Float32Array(cap);
    this.life.fill(0);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.rgba, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos); geo.setAttribute('aCol', this.aCol); geo.setAttribute('aSize', this.aSize);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.mesh = new THREE.Points(geo, pointsMaterial(SPARK_VERT, shared));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    scene.add(this.mesh);
  }

  emit(x, y, z, vx, vy, vz, col, size, life, drag = 1.2, grav = 6) {
    const i = this.next; this.next = (this.next + 1) % this.cap;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.c0[i * 3] = col[0]; this.c0[i * 3 + 1] = col[1]; this.c0[i * 3 + 2] = col[2];
    this.s0[i] = size; this.life[i] = life; this.age[i] = 0; this.drag[i] = drag; this.grav[i] = grav;
  }

  update(dt) {
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) { this.size[i] = 0; continue; }
      this.age[i] += dt;
      const u = this.age[i] / this.life[i];
      if (u >= 1) { this.life[i] = 0; this.size[i] = 0; continue; }
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= k; this.v[i * 3 + 1] = this.v[i * 3 + 1] * k - this.grav[i] * dt; this.v[i * 3 + 2] *= k;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      const a = (1 - u) * (1 - u);
      this.rgba[i * 4] = this.c0[i * 3] * 1.5; this.rgba[i * 4 + 1] = this.c0[i * 3 + 1] * (1 - 0.3 * u) * 1.5; this.rgba[i * 4 + 2] = this.c0[i * 3 + 2] * (1 - 0.6 * u) * 1.5; this.rgba[i * 4 + 3] = a;
      this.size[i] = this.s0[i] * (1 - 0.5 * u);
    }
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
  }

  clear() { this.life.fill(0); this.size.fill(0); this.aSize.needsUpdate = true; }
}

// ------------------------------------------------------------------ patterns
const _rot = new THREE.Quaternion(), _v = new THREE.Vector3();

/** n directions spread evenly over a sphere, turned at random. */
function sphere(n) {
  _rot.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).normalize();
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), a = i * 2.399963;
    _v.set(Math.cos(a) * r + rnd(-0.03, 0.03), y, Math.sin(a) * r + rnd(-0.03, 0.03)).normalize().applyQuaternion(_rot);
    out.push([_v.x, _v.y, _v.z]);
  }
  return out;
}

/** The plane that faces a watcher: their right (level), and the way up the picture, tilted back to meet their eyes. */
function facing(to, n3) {
  const u = new THREE.Vector3(to[1], 0, -to[0]).normalize(), w = new THREE.Vector3().crossVectors(n3, u).normalize();
  return { u, w };
}

/** A plane with this normal: two perpendicular unit vectors in it. */
function plane(nx, ny, nz) {
  const n = new THREE.Vector3(nx, ny, nz).normalize();
  const a = Math.abs(n.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(a, n).normalize(), w = new THREE.Vector3().crossVectors(n, u).normalize();
  return { u, w };
}

/**
 * Words drawn in stars. The text is painted to a canvas once and sampled on a grid; each lit pixel becomes a star
 * that flies to its place in a flat plane facing the watcher. Every star slows to a stop at a distance proportional
 * to its launch speed, so the picture keeps its shape as it opens out and then hangs there, drifting down slowly.
 */
let _words = null;
function wordPoints(lines) {
  if (_words) return _words;
  const cv = document.createElement('canvas');
  cv.width = 760; cv.height = 150 * lines.length + 40;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '170px "Paytone One", Impact, "Arial Black", sans-serif';
  lines.forEach((t, i) => g.fillText(t, cv.width / 2, 20 + 75 + i * 150));
  const { data, width, height } = g.getImageData(0, 0, cv.width, cv.height);
  const pts = [], STEP = 6;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (let y = STEP / 2; y < height; y += STEP) for (let x = STEP / 2; x < width; x += STEP) {
    if (data[((y | 0) * width + (x | 0)) * 4 + 3] < 128) continue;
    pts.push([x, y]);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  // centred, in units of the text's own width (1 = whole width), y up
  const w = x1 - x0;
  _words = pts.map(([x, y]) => [(x - (x0 + x1) / 2) / w, -(y - (y0 + y1) / 2) / w, (y - y0) / (y1 - y0)]);
  return _words;
}

/** A cartoon doodle in stars: a filled silhouette sampled on a grid, in units of its own height (y up, 1 = top to bottom). Cached. */
let _doodle = null;
function doodle() {
  if (_doodle) return _doodle;
  const pts = [], balls = [[-0.115, -0.36], [0.115, -0.36]], th = -0.3, c = Math.cos(th), sn = Math.sin(th);
  const rot = (x, y) => [x * c - y * sn, x * sn + y * c];
  for (let y = -0.5; y <= 0.5; y += 0.02) for (let x = -0.2; x <= 0.2; x += 0.02) {
    const ball = balls.some(([bx, by]) => (x - bx) ** 2 + (y - by) ** 2 <= 0.125 ** 2);
    const head = x * x + (y - 0.34) ** 2 <= 0.115 ** 2;
    const shaft = Math.abs(x) <= 0.09 && y >= -0.3 && y <= 0.34;
    if (!(ball || head || shaft)) continue;
    const [rx, ry] = rot(x, y);
    pts.push({ x: rx, y: ry, kind: head ? 2 : shaft ? 1 : 0 });
  }
  const tip = rot(0, 0.455), dir = rot(0, 1);
  _doodle = { pts, tip, dir };
  return _doodle;
}

const star = (d, speed, col, o = {}) => ({ v: [d[0] * speed, d[1] * speed, d[2] * speed], col, life: 3.2, size: 1.6, ...o });

/** `to`: the horizontal direction toward the watcher, `n3` the full direction to their eyes, so flat shapes (hearts, words) face them. */
const STYLES = [
  { name: 'Peony', make: () => {
    const c = PAL[pick(BRIGHT)], c2 = PAL[pick(['white', 'gold', 'cyan'])], out = [];
    for (const d of sphere(300)) out.push(star(d, rnd(40, 46), c, { trail: 0.8 }));
    for (const d of sphere(80)) out.push(star(d, 17, c2, { life: 2.6, trail: 0.6 }));          // a pistil of another colour
    return out;
  } },
  { name: 'Chrysanthemum', make: () => {
    const c = PAL[pick(['gold', 'red', 'green', 'purple'])], out = [];
    for (const d of sphere(340)) out.push(star(d, rnd(42, 50), c, { life: 4.1, trail: 2.1, g: 0.9, size: 1.5 }));
    for (const d of sphere(90)) out.push(star(d, 18, PAL.white, { life: 3, trail: 1, strobe: 0 }));
    return out;
  } },
  { name: 'Willow', make: () => {
    const out = [];
    for (const d of sphere(260)) out.push(star(d, rnd(30, 38), PAL.gold, { life: 6.5, trail: 2.8, g: 1.7, k: 0.8, size: 1.7 }));
    return out;
  } },
  { name: 'Ring', make: (to) => {
    const { u, w } = plane(to[0] + rnd(-0.6, 0.6), rnd(0.1, 0.9), to[1] + rnd(-0.6, 0.6)), a = PAL[pick(BRIGHT)], b = PAL[pick(['white', 'gold', 'cyan', 'pink'])], out = [];
    for (let i = 0; i < 110; i++) { const t = (i / 110) * Math.PI * 2; out.push(star([u.x * Math.cos(t) + w.x * Math.sin(t), u.y * Math.cos(t) + w.y * Math.sin(t), u.z * Math.cos(t) + w.z * Math.sin(t)], 44, a, { trail: 0.9 })); }
    for (let i = 0; i < 70; i++) { const t = (i / 70) * Math.PI * 2; out.push(star([u.x * Math.cos(t) + w.x * Math.sin(t), u.y * Math.cos(t) + w.y * Math.sin(t), u.z * Math.cos(t) + w.z * Math.sin(t)], 24, b, { trail: 0.7 })); }
    return out;
  } },
  { name: 'Heart', make: (to, n3) => {
    // a plane facing the watcher; the classic heart curve, outlined twice
    const { u, w } = facing(to, n3), out = [];
    const pt = (t, s) => [s * 16 * Math.pow(Math.sin(t), 3) / 17, s * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17];
    const c = PAL[pick(['red', 'pink'])];
    for (const [n, s, col] of [[130, 1, c], [70, 0.55, PAL.white]]) {
      for (let i = 0; i < n; i++) {
        const [x, y] = pt((i / n) * Math.PI * 2, s);
        out.push({ v: [(u.x * x + w.x * y) * 44, (u.y * x + w.y * y) * 44, (u.z * x + w.z * y) * 44], col, life: 3.2, size: 1.7, g: 0.55, trail: 0.7 });
      }
    }
    return out;
  } },
  { name: 'Palm', make: () => {
    const out = [], arms = 8, off = rnd(0, 6.28);
    for (let a = 0; a < arms; a++) {
      const az = off + (a / arms) * Math.PI * 2, el = rnd(0.35, 0.95), d = [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)];
      for (let i = 0; i < 18; i++) out.push(star(d, 14 + i * 2.1, i % 4 === 3 ? PAL.green : PAL.gold, { life: 4.6, trail: 1.9, g: 2.1, size: 1.6 }));
    }
    for (const d of sphere(60)) out.push(star(d, 11, PAL.orange, { life: 2.8 }));
    return out;
  } },
  { name: 'Strobe', make: () => {
    const out = [];
    for (const d of sphere(280)) out.push(star(d, rnd(30, 40), pick([PAL.white, [0.85, 0.92, 1]]), { life: 3.8, strobe: 1, trail: 0.15, size: 1.8 }));
    return out;
  } },
  { name: 'Rainbow', make: () => {
    const out = [], h0 = rnd(0, 1);
    for (const d of sphere(440)) out.push(star(d, rnd(40, 47), hsv((h0 + (Math.atan2(d[2], d[0]) / (Math.PI * 2) + 1)) % 1, 0.85, 1), { life: 3.7, trail: 1.1 }));
    for (const d of sphere(100)) out.push(star(d, 14, PAL.white, { life: 2.6 }));
    return out;
  } },
  { name: 'Saturn', make: (to) => {
    const a = PAL[pick(BRIGHT)], b = PAL[pick(['gold', 'white', 'cyan', 'pink'])], out = [];
    for (const d of sphere(170)) out.push(star(d, 22, a, { trail: 0.8, life: 3.4 }));
    const { u, w } = plane(rnd(-0.4, 0.4), 1, rnd(-0.4, 0.4));
    for (let i = 0; i < 120; i++) { const t = (i / 120) * Math.PI * 2; out.push(star([u.x * Math.cos(t) + w.x * Math.sin(t), u.y * Math.cos(t) + w.y * Math.sin(t), u.z * Math.cos(t) + w.z * Math.sin(t)], 46, b, { trail: 1, life: 3.4 })); }
    return out;
  } },
  { name: 'Gay Bois', H: [150, 175], toast: 'Step well back and look up, so you can read it.', make: (to, n3) => {
    // GAY over BOIS in the colours of the pride flag, in a plane tilted back so it faces your eyes square on from the ground
    const pts = wordPoints(['GAY', 'BOIS']), W = 96, K = DRAG * 1.7, out = [], { u, w } = facing(to, n3);
    const stripes = [PAL.red, PAL.orange, PAL.yellow, PAL.green, PAL.blue, PAL.purple];
    for (const [x, y, f] of pts) {
      const sx = x * W * K, sy = y * W * K;               // where it ends up, times the drag it will meet
      // one point each (no trail), and dimmed: the stars overlap, and would burn out to white
      out.push({ v: [u.x * sx + w.x * sy, u.y * sx + w.y * sy, u.z * sx + w.z * sy], col: stripes[Math.min(5, Math.floor(f * 6))].map((c) => c * 0.8), life: 7.5, size: 2.3, g: 0.07, k: 1.7, flash: true });
    }
    return out;
  } },
  { name: 'Penis', H: [145, 170], toast: 'Step back and look up. Take a good look.', make: (to, n3) => {
    // a cartoon doodle in pink stars, tilted to face you; once it has formed, white streams spray from the tip across the sky
    const { pts, tip, dir } = doodle(), { u, w } = facing(to, n3), S = 70, K = DRAG * 1.7, out = [];
    const tone = [[1, 0.42, 0.5], [1, 0.55, 0.45], [1, 0.25, 0.4]];
    const at = (x, y) => [u.x * x + w.x * y, u.y * x + w.y * y, u.z * x + w.z * y];
    for (const p of pts) {
      const v = at(p.x * S * K, p.y * S * K);
      out.push({ v, col: tone[p.kind].map((c) => c * 0.62), life: 7.5, size: 2.2, g: 0.07, k: 1.7, flash: true });
    }
    // the streams: white comets with long tails, thrown up and across from the tip, a few at a time over most of a second
    const o = at(tip[0] * S, tip[1] * S);
    out.push({ v: [0, 0, 0], o, col: [0.8, 0.8, 0.8], life: 0.4, size: 12, flash: true, g: 0, k: 1, delay: 1.2 });
    for (let i = 0; i < 190; i++) {
      const a = rnd(-0.6, 0.6) + 0.45 + Math.atan2(dir[0], dir[1]), sp = rnd(34, 76), side = rnd(-0.12, 0.12);
      const d = at(Math.sin(a), Math.cos(a));
      out.push({ v: [d[0] * sp + n3.x * sp * side, d[1] * sp + n3.y * sp * side, d[2] * sp + n3.z * sp * side], o, col: [0.95, 0.95, 0.95], life: rnd(2.6, 3.6), size: 1.6, g: 1.1, k: 0.35, trail: 2.4, delay: 1.2 + Math.pow(i / 190, 0.8) * 1.1 });
    }
    return out;
  } },
  { name: 'Spiral', make: (to) => {
    const out = [], arms = 4, { u, w } = plane(to[0] + rnd(-0.5, 0.5), rnd(0.2, 0.8), to[1] + rnd(-0.5, 0.5)), cs = [pick(BRIGHT), pick(BRIGHT), pick(BRIGHT), pick(BRIGHT)];
    for (let a = 0; a < arms; a++) {
      for (let i = 0; i < 75; i++) {
        const s = i / 75, t = (a / arms) * Math.PI * 2 + s * 3.6;
        out.push(star([u.x * Math.cos(t) + w.x * Math.sin(t), u.y * Math.cos(t) + w.y * Math.sin(t), u.z * Math.cos(t) + w.z * Math.sin(t)], 10 + s * 38, PAL[cs[a]], { trail: 1.1, life: 3.4 }));
      }
    }
    return out;
  } },
];
export const STYLE_NAMES = STYLES.map((s) => s.name);

// ------------------------------------------------------------------ tubes
const PAPER = [0xb3261e, 0x1f4f8f, 0x2f7a3c, 0xc98a14, 0x6b2b8c, 0x1c1c1c];
let _mats = null;
function materials() {
  if (_mats) return _mats;
  const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
  _mats = { paper: PAPER.map(lam), band: lam(0xf1e2b5), fuse: lam(0x2b2118), char: lam(0x15110d), cap: lam(0xcfb27a), ember: new THREE.MeshBasicMaterial({ color: 0xffaa44 }) };
  return _mats;
}

/** A cardboard mortar tube with a paper band and a length of fuse. Origin at the foot, the fuse's tip is `tip`. */
export function tubeMesh(paper = 0) {
  const m = materials(), g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 14), m.paper[paper % m.paper.length]);
  body.position.y = 0.15;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0515, 0.0515, 0.07, 14), m.band);
  band.position.y = 0.2;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.012, 14), m.cap);
  cap.position.y = 0.306;
  const fuse = new THREE.Group();
  fuse.position.set(0.028, 0.31, 0);
  fuse.rotation.z = -0.6;
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, FUSE_L, 6), m.fuse);
  cord.position.y = FUSE_L / 2;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 6), m.ember);
  tip.position.y = FUSE_L;
  tip.visible = false;
  fuse.add(cord, tip);
  g.add(body, band, cap, fuse);
  g.traverse((o) => { if (o.isMesh && o !== tip) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData = { body, band, cap, fuse, cord, tip };
  return g;
}

// ------------------------------------------------------------------ the whole thing
export class Fireworks {
  constructor(world, scene) {
    this.world = world; this.scene = scene;
    this.t = 0;
    this.style = 0;
    this.tubes = []; this.shells = []; this.events = [];
    this.hint = '';
    const shared = { uMap: { value: glow() }, uTime: { value: 0 }, uScale: { value: 800 } };
    this.shared = shared;
    this.stars = new Stars(scene, shared);
    this.sparks = new Sparks(scene, shared);
    // the burst's flash on the trees and ground: a few lights made up front so the shaders never recompile
    this.lights = Array.from({ length: 3 }, () => { const l = new THREE.PointLight(0xffffff, 0, 0, 2); l.visible = true; scene.add(l); return { l, t: 99, life: 0.6, peak: 0 }; });
    this.volley = 0;
  }

  get styleName() { return STYLES[this.style].name; }
  nextStyle(d = 1) { this.style = (this.style + d + STYLES.length) % STYLES.length; return this.styleName; }

  lit(p, r = 40) { return this.tubes.some((t) => t.state === 'fuse' && Math.hypot(t.x - p.x, t.z - p.z) < r) || this.shells.length > 0; }

  // -------------------------------------------------------------- setting down and lighting
  /** Set a tube down `ahead` metres in front of where you face. Returns a message, or null if it was placed. */
  place(p, yaw, ahead = 1.1) {
    if (this.tubes.length >= MAX_TUBES) return 'That is plenty: light some of them first.';
    const x = p.x - Math.sin(yaw) * ahead, z = p.z - Math.cos(yaw) * ahead, w = this.world;
    if (w.lakeAt(x, z) || w.localGrade(x, z) > 0.7) return 'Too steep or too wet to stand a tube.';
    if (this.tubes.some((t) => Math.hypot(t.x - x, t.z - z) < 0.36)) return 'There is already one there: step along.';
    const mesh = tubeMesh(this.style);
    const y = w.height(x, z), tx = rnd(-0.08, 0.08), tz = rnd(-0.08, 0.08);
    mesh.position.set(x, y - 0.01, z);
    mesh.rotation.set(tx, rnd(0, 6.28), tz, 'YXZ');
    this.scene.add(mesh);
    this.tubes.push({ x, y, z, mesh, state: 'idle', style: this.style, tilt: [tx, tz], burn: 0, hiss: 0, catchAt: Infinity, paper: this.style });
    this.events.push({ type: 'sound', name: 'clunk', v: 0.6 });
    return null;
  }

  /** Light the fuse of the tube nearest the point you are aiming at. */
  light(p, yaw) {
    const ax = p.x - Math.sin(yaw) * 1.2, az = p.z - Math.cos(yaw) * 1.2;
    let best = null, bd = REACH;
    for (const t of this.tubes) {
      if (t.state !== 'idle') continue;
      const d = Math.hypot(t.x - ax, t.z - az) * 0.7 + Math.hypot(t.x - p.x, t.z - p.z) * 0.5;
      if (d < bd && Math.hypot(t.x - p.x, t.z - p.z) < REACH) { bd = d; best = t; }
    }
    if (!best) return false;
    this.#ignite(best);
    this.events.push({ type: 'toast', text: 'Fuse lit. Stand back and look up.' });
    return true;
  }

  #ignite(t) {
    if (t.state !== 'idle') return;
    t.state = 'fuse'; t.burn = 0;
    t.mesh.userData.tip.visible = true;
    // a tube close to a burning one catches from its sparks a moment later
    for (const o of this.tubes) {
      if (o.state !== 'idle') continue;
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      if (d < 2.1) o.catchAt = Math.min(o.catchAt, this.t + 0.45 + d * 0.35 + rnd(0, 0.35));
    }
    this.events.push({ type: 'sound', name: 'strike', v: 0.5 });
  }

  /** Take every tube that has not been lit back (and the spent ones): [U] near them. */
  pickUp(p) {
    let n = 0;
    for (let i = this.tubes.length - 1; i >= 0; i--) {
      const t = this.tubes[i];
      if (t.state === 'fuse' || Math.hypot(t.x - p.x, t.z - p.z) > REACH) continue;
      this.scene.remove(t.mesh); t.mesh.traverse((o) => o.geometry?.dispose());
      this.tubes.splice(i, 1); n++;
    }
    return n;
  }

  /** What is set down near you, for the prompt. */
  near(p, r = 4) { return this.tubes.filter((t) => t.state === 'idle' && Math.hypot(t.x - p.x, t.z - p.z) < r).length; }

  clear() {
    for (const t of this.tubes) { this.scene.remove(t.mesh); t.mesh.traverse((o) => o.geometry?.dispose()); }
    this.tubes = []; this.shells = [];
    this.stars.clear(); this.sparks.clear();
    for (const L of this.lights) { L.l.intensity = 0; L.t = 99; }
  }

  // -------------------------------------------------------------- per frame
  /** `view`: { p: where you stand, camera, scale: pixels per metre at one metre }. Returns events. */
  update(dt, view) {
    this.t += dt;
    this.shared.uTime.value = this.t;
    this.shared.uScale.value = view.scale;
    if (dt > 0) {
      this.#tubes(dt, view);
      this.#shells(dt, view);
      this.sparks.update(dt);
      this.#lights(dt);
    }
    return this.events.splice(0);
  }

  #tubes(dt, view) {
    const m = materials();
    for (const t of this.tubes) {
      if (t.state === 'idle' && this.t >= t.catchAt) this.#ignite(t);
      if (t.state !== 'fuse') continue;
      t.burn += dt;
      const b = clamp(t.burn / FUSE_S, 0, 1), U = t.mesh.userData;
      U.cord.scale.y = Math.max(0.05, 1 - b); U.cord.position.y = (FUSE_L * U.cord.scale.y) / 2;
      U.tip.position.y = FUSE_L * U.cord.scale.y;
      t.mesh.updateMatrixWorld(true);
      const tip = U.tip.getWorldPosition(_v.clone());
      // sparks spit from the burning end, and it glows
      const n = Math.floor(dt * 90 + Math.random());
      for (let i = 0; i < n; i++) {
        const a = rnd(0, 6.28), s = rnd(0.6, 2.4);
        this.sparks.emit(tip.x, tip.y, tip.z, Math.cos(a) * s, rnd(0.8, 2.6), Math.sin(a) * s, pick([PAL.gold, PAL.orange, PAL.white]), rnd(0.012, 0.03), rnd(0.2, 0.5), 2, 7);
      }
      this.sparks.emit(tip.x, tip.y, tip.z, 0, 0, 0, [1, 0.7, 0.3], 0.07 + 0.03 * Math.random(), 0.07, 1, 0);
      t.hiss -= dt;
      if (t.hiss <= 0) { t.hiss = 0.16; this.events.push({ type: 'sound', name: 'hiss', v: clamp(1 - Math.hypot(t.x - view.p.x, t.z - view.p.z) / 40, 0.1, 1) }); }
      if (b >= 1) this.#launch(t, view);
    }
    void m;
  }

  #launch(t, view) {
    t.state = 'spent';
    const U = t.mesh.userData, m = materials();
    U.tip.visible = false; U.fuse.visible = false;
    for (const part of [U.body]) part.material = m.char;
    t.mesh.updateMatrixWorld(true);
    const top = new THREE.Vector3(0, 0.31, 0).applyMatrix4(t.mesh.matrixWorld);
    const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(t.mesh.quaternion);
    const st = STYLES[t.style], H = st.H ? rnd(st.H[0], st.H[1]) : rnd(105, 150), T = 2.5 + H / 120;
    this.shells.push({ x0: top.x, y0: top.y, z0: top.z, dx: dir.x / dir.y, dz: dir.z / dir.y, H, T, t: 0, style: t.style, trail: 0, x: top.x, y: top.y, z: top.z });
    // the muzzle: a flash and a spray of sparks
    for (let i = 0; i < 70; i++) {
      const a = rnd(0, 6.28), s = rnd(1, 7);
      this.sparks.emit(top.x, top.y, top.z, Math.cos(a) * s * 0.7, rnd(2, 10), Math.sin(a) * s * 0.7, pick([PAL.gold, PAL.orange, PAL.white]), rnd(0.03, 0.07), rnd(0.3, 0.8), 1.5, 9);
    }
    for (let i = 0; i < 10; i++) this.sparks.emit(top.x, top.y, top.z, rnd(-1, 1), rnd(1, 3), rnd(-1, 1), [0.5, 0.48, 0.45], rnd(0.5, 1.1), rnd(0.9, 1.6), 1.8, -0.5);   // smoke
    this.#flash(top.x, top.y + 0.6, top.z, [1, 0.7, 0.35], 0.045, 0.25);
    const d = Math.hypot(top.x - view.p.x, top.z - view.p.z);
    this.events.push({ type: 'sound', name: 'mortar', v: clamp(1.1 - d / 120, 0.15, 1), delay: d / SOUND });
    this.events.push({ type: 'sound', name: 'whistle', v: clamp(1 - d / 160, 0.1, 1), dur: T * 0.85, delay: d / SOUND });
    if (this.t - this.volley > 6) { this.volley = this.t; this.events.push({ type: 'toast', text: st.toast || 'Look up!' }); }
    this.events.push({ type: 'shake', amount: clamp(1 - d / 25, 0, 1) });
  }

  #shells(dt, view) {
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.t += dt;
      const u = Math.min(1, s.t / s.T), h = s.H * (1 - (1 - u) * (1 - u));
      s.x = s.x0 + s.dx * h; s.y = s.y0 + h; s.z = s.z0 + s.dz * h;
      const speed = (2 * s.H / s.T) * (1 - u);
      // a glowing head and a trail of orange sparks falling away behind it
      const n = Math.floor(dt * 140 + Math.random());
      for (let k = 0; k < n; k++) {
        this.sparks.emit(s.x + rnd(-0.1, 0.1), s.y - rnd(0, speed * dt), s.z + rnd(-0.1, 0.1), rnd(-1.2, 1.2), -speed * rnd(0.04, 0.12) - rnd(0, 2), rnd(-1.2, 1.2),
          pick([PAL.gold, PAL.orange, PAL.gold, PAL.white]), rnd(0.08, 0.2), rnd(0.7, 1.4), 1.4, 4);
      }
      this.sparks.emit(s.x, s.y, s.z, 0, 0, 0, [1, 0.85, 0.5], 0.5, 0.06, 1, 0);
      if (u >= 1) { this.shells.splice(i, 1); this.#burst(s, view); }
    }
  }

  #burst(s, view) {
    const style = STYLES[s.style], c = new THREE.Vector3(s.x, s.y, s.z);
    let tx = view.p.x - s.x, tz = view.p.z - s.z;
    const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    // and the way to the watcher's eyes, up included: the shapes that face you tilt back to meet you
    const n3 = new THREE.Vector3(view.p.x - s.x, view.p.y + 1.7 - s.y, view.p.z - s.z).normalize();
    const stars = style.make([tx, tz], n3);
    // the break itself: a big soft flash that is gone in a third of a second
    stars.push({ v: [0, 0, 0], col: [0.6, 0.57, 0.5], life: 0.3, size: 13, flash: true, g: 0, k: 1 });
    stars.push({ v: [0, 0, 0], col: stars[0].col.map((c) => c * 0.5), life: 0.8, size: 12, flash: true, g: 0, k: 1 });
    this.stars.add(c, stars, this.t);
    const col = stars[0].col;
    this.#flash(s.x, s.y, s.z, col, 1, 0.9);
    const d = Math.hypot(s.x - view.p.x, s.y - view.p.y, s.z - view.p.z), delay = d / SOUND;
    this.events.push({ type: 'sound', name: 'boom', v: clamp(1.15 - d / 600, 0.2, 1), delay });
    if (style.name === 'Strobe' || style.name === 'Chrysanthemum' || style.name === 'Willow' || style.name === 'Gay Bois') this.events.push({ type: 'sound', name: 'crackle', v: clamp(1 - d / 500, 0.15, 1), delay: delay + 0.25, n: style.name === 'Strobe' ? 40 : 18 });
  }

  /** Light the trees and ground for a moment. The nearest unused of three lights takes it. */
  #flash(x, y, z, col, size, life) {
    let L = this.lights[0];
    for (const o of this.lights) if (o.t > L.t) L = o;
    L.l.position.set(x, y, z);
    L.l.color.setRGB(col[0], col[1], col[2]);
    L.t = 0; L.life = life; L.peak = 45000 * size;
  }

  #lights(dt) {
    for (const L of this.lights) {
      L.t += dt;
      const u = L.t / L.life;
      L.l.intensity = u >= 1 ? 0 : L.peak * Math.pow(1 - u, 2.4) * (u < 0.04 ? u / 0.04 : 1);
    }
  }

  /** The line under the screen while the fireworks tool is in your hands. */
  toolHint(p) {
    if (this.lit(p, 60)) return 'Stand clear and look up!';
    const n = this.near(p);
    if (n) return `[R] light the fuse (${n} set down)  ·  [Click] set down another  ·  [I] style: ${this.styleName}  ·  [U] pick up`;
    return `[Click] set down a ${this.styleName}  ·  [I] change style`;
  }
}
