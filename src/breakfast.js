import * as THREE from 'three';
import { clamp } from './noise.js';

// Bacon and eggs in a cast-iron skillet on the free half of the fire's grate
// (the coffee percolator has the other end). [K] at a rigged fire puts the pan
// on; it sizzles for about half a minute, chimes when it is done, and [U]
// facing it eats breakfast: a good stretch of stamina, and warmth. Leave it too
// long and it burns.

const COOK_S = 32;        // seconds to done over a live fire
const DONE = 0.8;         // cook level that counts as ready
const GOOD = 1.1;         // ...and still perfect up to here
const BURNT = 1.4;
const PAN_AT = -0.38;     // along the grate from the fire's centre (the pot is at +0.38)
const GRATE_Y = 0.34;
const REACH = 2.8;

const _v = new THREE.Vector3(), _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function baconTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 32;
  const g = cv.getContext('2d');
  const bands = [['#b3403a', 7], ['#f0d2c4', 4], ['#a83a34', 6], ['#ecc9ba', 3], ['#b3403a', 5], ['#f2d6c8', 4], ['#a83a34', 3]];
  let y = 0;
  for (const [c, h] of bands) { g.fillStyle = c; g.fillRect(0, y, 128, h); y += h; }
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 30; i++) { g.beginPath(); g.moveTo(Math.random() * 128, 0); g.lineTo(Math.random() * 128, 32); g.stroke(); }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function puffTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
}

/** A cast-iron skillet, handle toward -x. */
function panMesh() {
  const g = new THREE.Group();
  const iron = new THREE.MeshLambertMaterial({ color: 0x1f2022, side: THREE.DoubleSide });
  const body = new THREE.Mesh(new THREE.LatheGeometry([[0.001, 0], [0.11, 0], [0.125, 0.012], [0.14, 0.04], [0.145, 0.052], [0.138, 0.054], [0.128, 0.034], [0.11, 0.014], [0.001, 0.012]].map(([r, y]) => new THREE.Vector2(r, y)), 28), iron);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.015, 0.24, 8), iron);
  handle.rotation.z = Math.PI / 2; handle.position.set(-0.255, 0.046, 0);
  const grip = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.005, 5, 10), iron);
  grip.position.set(-0.38, 0.046, 0); grip.rotation.y = Math.PI / 2;
  g.add(body, handle, grip);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function baconMesh(map) {
  const geo = new THREE.BoxGeometry(0.15, 0.007, 0.03, 12, 1, 3);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setY(i, p.getY(i) + Math.sin(x * 55) * 0.0045 * (p.getY(i) > 0 ? 1 : 0.6));
    p.setZ(i, p.getZ(i) + Math.sin(x * 38 + 1) * 0.004);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map, color: 0xffffff }));
  m.castShadow = true;
  return m;
}

function eggMesh() {
  const g = new THREE.Group();
  const pts = [];
  for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2; pts.push(new THREE.Vector2(Math.cos(a) * (0.046 + Math.sin(a * 3 + 1) * 0.008 + Math.sin(a * 2) * 0.006), Math.sin(a) * (0.046 + Math.sin(a * 3 + 1) * 0.008 + Math.sin(a * 2) * 0.006))); }
  const white = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(pts)), new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
  white.rotation.x = -Math.PI / 2;
  const yolk = new THREE.Mesh(new THREE.SphereGeometry(0.017, 12, 8), new THREE.MeshStandardMaterial({ color: 0xffb81c, roughness: 0.25 }));
  yolk.scale.y = 0.65; yolk.position.set(0.005, 0.004, 0);
  g.add(white, yolk);
  g.userData = { white: white.material, yolk: yolk.material, yolkMesh: yolk };
  return g;
}

export class Breakfast {
  constructor(parent, scene) {
    this.parent = parent;     // the grate's group (coffee.stand)
    this.scene = scene;
    this.mode = 'off';        // off | cooking
    this.cook = 0;
    this.eaten = 0;
    this.ready = false;
    this.events = [];
    this.hint = ''; this.tip = '';
    this.sizzleIn = 0;
    this.pan = new THREE.Group();
    this.pan.position.set(PAN_AT, GRATE_Y + 0.022, 0);
    this.pan.add(panMesh());
    const map = baconTexture();
    this.bacon = [-0.07, 0, 0.07].map((z, i) => { const b = baconMesh(map); b.position.set(-0.05, 0.02, z); b.rotation.y = (i - 1) * 0.06; this.pan.add(b); return b; });
    this.eggs = [-0.05, 0.05].map((z) => { const e = eggMesh(); e.position.set(0.075, 0.016, z * 1.1); this.pan.add(e); return e; });
    this.pan.visible = false;
    parent.add(this.pan);
    const tex = puffTexture();
    this.puffs = Array.from({ length: 12 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0xdddddd }));
      s.visible = false;
      scene.add(s);
      return { s, age: 99, life: 1, vx: 0, vz: 0 };
    });
    this.puffT = 0;
  }

  #toast(text, warn = false) { this.events.push({ type: 'toast', text, warn }); }
  #sound(name) { this.events.push({ type: 'sound', name }); }
  #world(out) { return this.pan.getWorldPosition(out); }

  get quality() { return this.cook < GOOD ? 1 : this.cook < BURNT ? 0.65 : 0.3; }

  /** Distance to the pan if you are near it and facing it, else Infinity. */
  reach(p, yaw) {
    if (!this.pan.visible) return Infinity;
    const w = this.#world(_v), dx = w.x - p.x, dz = w.z - p.z, d = Math.hypot(dx, dz);
    if (d > REACH) return Infinity;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    return d < 0.8 || (dx * fx + dz * fz) / (d || 1) > 0.6 ? d : Infinity;
  }

  /** [K] at a rigged fire: put the pan on with bacon and eggs. */
  start(rigged, fire, p) {
    if (!rigged || !fire) { this.#toast('Set up the grate first: [K] makes coffee.'); return false; }
    if (this.mode === 'cooking') { this.#toast('Breakfast is already on.'); return false; }
    if (Math.hypot(fire.x - p.x, fire.z - p.z) > 4.5) { this.#toast('Get closer to the fire.'); return false; }
    this.mode = 'cooking'; this.cook = 0; this.ready = false;
    this.#sound('lid');
    this.#toast('Bacon and eggs in the skillet. Listen for the sizzle.');
    return true;
  }

  /** [U] at the pan: eat what is cooked. */
  interact() {
    if (this.mode !== 'cooking') return null;
    if (this.cook < DONE * 0.7) { this.#toast(`Not done yet… ${Math.round(this.cook / DONE * 100)}%`); return 'wait'; }
    const q = this.quality, c = this.cook;
    this.events.push({ type: 'eat', q, label: c < DONE ? 'Barely done' : c < GOOD ? 'Perfectly cooked' : c < BURNT ? 'A little overdone' : 'Burnt black' });
    this.eaten++;
    this.mode = 'off'; this.cook = 0; this.ready = false;
    return 'ate';
  }

  /** ctx: { on: grate is up over a fire, fire, p, yaw, coffeeReach } */
  update(dt, ctx) {
    this.events.length = 0;
    const { on, fire, p } = ctx;
    if (!on && this.mode === 'cooking') { this.mode = 'off'; this.cook = 0; this.ready = false; }
    this.pan.visible = on && this.mode === 'cooking';
    const live = !!fire && fire.life > 4;
    if (this.mode === 'cooking' && live && dt > 0) {
      this.cook = Math.min(1.8, this.cook + dt / COOK_S * DONE);
      const near = Math.hypot(fire.x - p.x, fire.z - p.z) < 14;
      this.sizzleIn -= dt;
      if (this.sizzleIn <= 0) { this.sizzleIn = 0.22 + Math.random() * 0.15; if (near && this.cook < BURNT + 0.1) this.#sound('sizzle'); }
      if (!this.ready && this.cook >= DONE) {
        this.ready = true;
        this.events.push({ type: 'ready' });
        this.#toast('Breakfast is ready! [U] at the skillet to eat. Do not let it burn.');
      }
    }
    this.#look();
    this.#steam(dt, live);
    // hints: when you face the pan, or a tip while the grate is up and the pan is off
    const d = this.reach(p, ctx.yaw);
    const aimed = d < ctx.coffeeReach;
    const c = this.cook;
    this.hint = this.mode === 'cooking' && aimed ? (c < DONE ? `Sizzling… ${Math.round(c / DONE * 100)}%` : c < GOOD ? '[U] eat breakfast: it is perfect' : c < BURNT ? '[U] eat breakfast (getting dark)' : '[U] it is burnt… eat anyway') : '';
    this.tip = on && this.mode === 'off' && fire && !ctx.seated && Math.hypot(fire.x - p.x, fire.z - p.z) < 3.8 ? '[K] cook bacon and eggs' : '';
  }

  /** Raw pink bacon and glassy eggs through golden to brown and black. */
  #look() {
    const c = this.cook;
    // bacon: shrinks, darkens
    const k = clamp(c / DONE, 0, 1.8);
    _c.setRGB(1, 1, 1);
    if (k < 1) _c.lerp(new THREE.Color(0.62, 0.38, 0.28), k); else _c.setRGB(0.62, 0.38, 0.28).lerp(new THREE.Color(0.05, 0.03, 0.025), clamp((k - 1) / 0.8, 0, 1));
    for (const b of this.bacon) { b.material.color.copy(_c); b.scale.set(1 - Math.min(0.28, c * 0.3), 1 + c * 0.6, 1 - Math.min(0.12, c * 0.1)); }
    // eggs: the white spreads and goes opaque; the edges brown late
    const spread = clamp(0.45 + c * 1.2, 0.45, 1), opaque = clamp(c * 3.2, 0, 1);
    for (const e of this.eggs) {
      const d = e.userData;
      e.children[0].scale.setScalar(spread);
      d.white.opacity = 0.55 + opaque * 0.45;
      d.white.color.setRGB(1, 1, 1).lerp(_c.setRGB(0.62, 0.38, 0.12), clamp((c - 0.8) / 0.7, 0, 1) * 0.9);
      d.yolk.color.setRGB(1, 0.72, 0.1).lerp(_c.setRGB(0.5, 0.25, 0.04), clamp((c - 1.0) / 0.6, 0, 1));
      d.yolkMesh.scale.set(1, 0.65 - Math.min(0.25, c * 0.15), 1);
    }
  }

  #steam(dt, live) {
    const on = this.pan.visible && this.mode === 'cooking' && live;
    const w = on ? this.#world(_v) : null;
    const burnt = this.cook > GOOD;
    this.puffT -= dt;
    for (const f of this.puffs) {
      if (f.age < f.life) {
        f.age += dt;
        const u = f.age / f.life;
        f.s.position.x += f.vx * dt; f.s.position.z += f.vz * dt; f.s.position.y += (0.3 + u * 0.2) * dt;
        f.s.scale.setScalar(0.07 + u * 0.25);
        f.s.material.opacity = Math.sin(Math.PI * Math.min(1, u)) * (burnt ? 0.5 : 0.28);
        f.s.material.color.setScalar(burnt ? 0.35 : 0.9);
        if (u >= 1) f.s.visible = false;
      } else if (on && this.puffT <= 0 && this.cook > 0.1) {
        this.puffT = (0.25 + Math.random() * 0.3) / (0.5 + Math.min(1, this.cook));
        f.age = 0; f.life = 1.4 + Math.random() * 0.9;
        f.s.visible = true;
        f.s.position.set(w.x + (Math.random() - 0.5) * 0.18, w.y + 0.07, w.z + (Math.random() - 0.5) * 0.18);
        f.vx = (Math.random() - 0.5) * 0.06; f.vz = (Math.random() - 0.5) * 0.06;
      }
    }
  }

  save() { return { mode: this.mode, cook: this.cook, eaten: this.eaten }; }

  load(s) {
    if (!s) return;
    this.mode = s.mode || 'off'; this.cook = s.cook || 0; this.eaten = s.eaten || 0;
    this.ready = this.cook >= DONE;
  }
}
