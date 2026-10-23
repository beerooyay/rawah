import * as THREE from 'three';

// Telekinesis: the ground answers to your attention. With the tool in hand a
// ring on the ground follows the crosshair; hold lift to draw the earth up
// under it, sink to push it down, level to press it flat at the height where
// you began. The pull builds the longer it is held. Heavy work: a stroke eases
// in, and what you have shaped is remembered (sculpt.js).

const REACH = 70;          // metres from you the ground can be worked
const R_MIN = 2, R_MAX = 14;
const RATE = 1.3;          // metres per second at the centre of the brush, before it builds
const MOTES = 240, DUST = 160;
const RING = 56;

function soft() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,0.45)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A swarm of points with a position, velocity and life each; `spawn` places one, `step` ages and moves them. */
class Swarm {
  constructor(n, { color, size, additive, opacity }) {
    this.n = n; this.i = 0;
    this.pos = new Float32Array(n * 3).fill(1e5);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.alive = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      map: soft(), color, size, transparent: true, opacity, depthWrite: false, sizeAttenuation: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, fog: true,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  spawn(x, y, z, vx, vy, vz, life) {
    const k = this.i; this.i = (this.i + 1) % this.n;
    this.pos[k * 3] = x; this.pos[k * 3 + 1] = y; this.pos[k * 3 + 2] = z;
    this.vel[k * 3] = vx; this.vel[k * 3 + 1] = vy; this.vel[k * 3 + 2] = vz;
    this.life[k] = life;
    this.alive = this.n;
  }

  step(dt, gravity, drag) {
    if (!this.alive) return;
    let live = 0;
    const f = Math.exp(-drag * dt);
    for (let k = 0; k < this.n; k++) {
      if (this.life[k] <= 0) continue;
      this.life[k] -= dt;
      if (this.life[k] <= 0) { this.pos[k * 3 + 1] = 1e5; continue; }
      live++;
      const o = k * 3;
      this.vel[o] *= f; this.vel[o + 2] *= f; this.vel[o + 1] = this.vel[o + 1] * f - gravity * dt;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
    }
    this.alive = live;
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

export class Mind {
  constructor({ scene, world, hiker, camera, hud, audio }) {
    this.world = world; this.hiker = hiker; this.camera = camera; this.hud = hud; this.audio = audio;
    this.radius = 6;
    this.target = new THREE.Vector3();
    this.has = false;
    this.mode = '';              // '', 'lift', 'sink', 'level'
    this.held = 0;               // seconds the current pull has lasted
    this.level = 0;              // the height 'level' presses toward
    this.sound = 0;
    this.flush = 0;              // seconds until things standing on the ground are told it moved
    this.pulse = 0;
    this._ray = new THREE.Vector3(); this._dir = new THREE.Vector3();

    this.group = new THREE.Group();
    this.group.visible = false;
    const ring = (op) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const l = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xa9f2ff, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false }));
      l.frustumCulled = false; l.renderOrder = 7;
      this.group.add(l);
      return l;
    };
    this.outer = ring(0.7); this.inner = ring(0.35);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: soft(), color: 0x8fe8ff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.glow.renderOrder = 6;
    this.group.add(this.glow);
    this.motes = new Swarm(MOTES, { color: 0xb8f4ff, size: 0.22, additive: true, opacity: 0.9 });
    this.dust = new Swarm(DUST, { color: 0x8d7556, size: 0.3, additive: false, opacity: 0.75 });
    this.group.add(this.motes.points, this.dust.points);
    scene.add(this.group);
  }

  get active() { return this.hiker.tool === 'mind'; }

  /** First place the view ray meets the ground within reach of the hiker, or null. */
  #aim() {
    const w = this.world, cam = this.camera, o = cam.position, d = cam.getWorldDirection(this._dir);
    const p = this._ray, hp = this.hiker.pos;
    let prev = 0, hit = -1;
    for (let t = 1; t < 160; t += Math.max(0.6, t * 0.02)) {
      p.copy(o).addScaledVector(d, t);
      if (p.y < w.height(p.x, p.z)) { hit = t; break; }
      prev = t;
    }
    if (hit < 0) return false;
    let lo = prev, hi = hit;
    for (let i = 0; i < 8; i++) {
      const m = (lo + hi) / 2;
      p.copy(o).addScaledVector(d, m);
      if (p.y < w.height(p.x, p.z)) hi = m; else lo = m;
    }
    p.copy(o).addScaledVector(d, hi);
    if (Math.hypot(p.x - hp.x, p.z - hp.z) > REACH) return false;
    this.target.set(p.x, w.height(p.x, p.z), p.z);
    return true;
  }

  /** Brush size from the wheel. */
  resize(wheel) { if (wheel) this.radius = Math.min(R_MAX, Math.max(R_MIN, this.radius - wheel * 0.75)); }

  update(dt, live, { lift, sink, level }, onShaped) {
    const on = this.active && live;
    this.group.visible = this.active;
    this.has = on && this.#aim();
    const want = !this.has ? '' : level ? 'level' : lift && !sink ? 'lift' : sink && !lift ? 'sink' : '';
    if (want !== this.mode) {
      if (want === 'level') this.level = this.target.y;
      this.held = 0; this.mode = want;
    }
    this.hiker.channel = !!this.mode;
    const sculpt = this.world.sculpt;

    if (this.mode) {
      this.held += dt;
      const build = 1 + Math.min(1.8, this.held * 0.7), t = this.target, r = this.radius;
      const amount = RATE * build * dt * (0.6 + r / 14);   // a wide brush moves more earth
      if (this.mode === 'level') {
        const lv = this.level, k = Math.min(1, 2.4 * dt * build);
        sculpt.paint(t.x, t.z, r, (cur, wx, wz, wt) => cur + (lv - this.world.height(wx, wz)) * k * wt);
      } else {
        const sign = this.mode === 'lift' ? 1 : -1;
        sculpt.paint(t.x, t.z, r, (cur, wx, wz, wt) => cur + sign * amount * wt);
      }
      this.flush += dt;
      this.sound -= dt;
      if (this.sound <= 0) { this.sound = 0.16; this.audio?.rumble?.(Math.min(1, 0.4 + this.held * 0.3)); }
      this.#emit(dt);
    } else this.held = 0;

    sculpt.flush();
    // things standing on the ground follow it, a few times a second while it moves and once more at the end
    if (this.flush > 0.45 || (!this.mode && this.flush > 0)) {
      this.flush = 0;
      const rect = sculpt.takeRect();
      if (rect) onShaped?.(rect);
    }
    this.#fx(dt);
  }

  #emit(dt) {
    const t = this.target, w = this.world, r = this.radius, lift = this.mode === 'lift', sink = this.mode === 'sink';
    const n = Math.ceil(dt * 90 * (0.5 + r / 12));
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d, y = w.height(x, z);
      const swirl = 0.7 + Math.random() * 0.8;
      if (sink) {
        // motes fall into the hole: start above, drift inward and down
        this.motes.spawn(x, y + 1.6 + Math.random() * 1.6, z, -Math.sin(a) * swirl, -0.8, Math.cos(a) * swirl, 0.8 + Math.random() * 0.5);
      } else {
        this.motes.spawn(x, y + 0.1, z, -Math.sin(a) * swirl, (lift ? 1.6 : 0.5) + Math.random() * 1.8, Math.cos(a) * swirl, 0.9 + Math.random() * 0.9);
      }
      if (Math.random() < 0.7) {
        this.dust.spawn(x, y + 0.15, z, (Math.random() - 0.5) * 1.2, (lift ? 1.2 : 0.6) + Math.random() * 1.3, (Math.random() - 0.5) * 1.2, 0.8 + Math.random() * 0.8);
      }
    }
  }

  #fx(dt) {
    this.motes.step(dt, -0.25, 1.4);
    this.dust.step(dt, 3.4, 0.9);
    if (!this.active || !this.has) { this.outer.visible = this.inner.visible = this.glow.visible = false; return; }
    this.outer.visible = this.inner.visible = this.glow.visible = true;
    this.pulse += dt * (this.mode ? 5 : 1.8);
    const t = this.target, w = this.world, r = this.radius;
    const set = (line, rad, lift) => {
      const a = line.geometry.attributes.position.array;
      for (let i = 0; i < RING; i++) {
        const th = i / RING * Math.PI * 2, x = t.x + Math.cos(th) * rad, z = t.z + Math.sin(th) * rad;
        a[i * 3] = x; a[i * 3 + 1] = w.height(x, z) + lift; a[i * 3 + 2] = z;
      }
      line.geometry.attributes.position.needsUpdate = true;
    };
    set(this.outer, r, 0.12);
    set(this.inner, r * (0.45 + 0.1 * Math.sin(this.pulse)), 0.12);
    this.glow.position.set(t.x, t.y + 0.4, t.z);
    this.glow.scale.setScalar(r * 2.1);
    this.glow.material.opacity = this.mode ? 0.5 + 0.12 * Math.sin(this.pulse * 1.3) : 0.22;
  }

  save() { return this.world.sculpt.save(); }
  load(d) { this.world.sculpt.load(d); }
}
