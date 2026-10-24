import * as THREE from 'three';
import { clamp } from './noise.js';

// Camp coffee. A small iron grate bridges the fire and a speckled-enamel
// percolator sits on it. [U] facing the pot starts a brew (about 40 seconds of
// perking over a live fire; it chimes when it is done), then [U] pours it into
// your thermos tumbler. [O] takes a sip: each one lifts your stamina and uses
// up a swallow; the coffee in the tumbler slowly goes cold.

const BREW_S = 40;        // seconds over a live fire
const SERVINGS = 6;       // sips in one pot
const CAP = 6;            // sips the tumbler holds
const POUR_S = 1.6;
const SIP_S = 1.9;
const GRATE_Y = 0.34;     // height of the grate above the ground
const POT_AT = 0.38;      // how far along the grate the pot sits, from the fire's centre
const REACH = 2.8;

const UP = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _d = new THREE.Vector3(), _e2 = new THREE.Vector3();
const ease = (u) => u * u * (3 - 2 * u);

function enamel() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#22406a';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(245,245,240,${0.35 + Math.random() * 0.5})`;
    g.beginPath(); g.arc(Math.random() * 256, Math.random() * 256, 0.5 + Math.random() * 1.1, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
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

const lathe = (pts, seg = 28) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

/** The iron grate: two rails across the fire, cross bars, four legs outside the stones. */
function grateMesh() {
  const g = new THREE.Group();
  const iron = new THREE.MeshLambertMaterial({ color: 0x2c2b2a });
  const bar = (len, r, x, y, z, axis) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), iron);
    m.position.set(x, y, z);
    if (axis === 'x') m.rotation.z = Math.PI / 2; else if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.castShadow = true;
    g.add(m);
  };
  for (const z of [-0.11, 0.11]) bar(1.34, 0.011, 0, GRATE_Y, z, 'x');
  for (let i = -3; i <= 3; i++) bar(0.24, 0.007, i * 0.19, GRATE_Y + 0.016, 0, 'z');
  for (const x of [-0.62, 0.62]) for (const z of [-0.11, 0.11]) { bar(GRATE_Y, 0.013, x, GRATE_Y / 2, z); }
  return g;
}

/** The percolator: speckled enamel body, steel lid and glass knob, black handle and a pouring spout. */
function potMesh() {
  const g = new THREE.Group();
  const body = new THREE.MeshLambertMaterial({ map: enamel(), color: 0xffffff });
  const steel = new THREE.MeshLambertMaterial({ color: 0xb9bdc1 });
  const black = new THREE.MeshLambertMaterial({ color: 0x141414 });
  const shell = new THREE.Mesh(lathe([[0.001, 0], [0.074, 0], [0.083, 0.012], [0.09, 0.05], [0.092, 0.15], [0.088, 0.19], [0.084, 0.205]]), body);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.086, 0.006, 6, 28), steel);
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.205;
  const lid = new THREE.Mesh(lathe([[0.087, 0.2], [0.088, 0.208], [0.056, 0.222], [0.03, 0.23], [0.001, 0.232]]), steel);
  const knobMat = new THREE.MeshLambertMaterial({ color: 0xcfdde3, transparent: true, opacity: 0.55, emissive: 0x000000 });
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.027, 14, 10), knobMat);
  knob.scale.y = 0.8; knob.position.y = 0.246;
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.012, 14), black);
  cup.position.y = 0.232;
  // spout: a short wedge flaring out of the rim on +x
  const spout = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.07, 3, 1, true), body);
  spout.material = new THREE.MeshLambertMaterial({ map: body.map, side: THREE.DoubleSide });
  spout.rotation.set(0, 0, -Math.PI / 2 - 0.35); spout.position.set(0.1, 0.186, 0);
  // handle: a black arc on -x
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.0085, 6, 18, Math.PI * 1.05), black);
  handle.rotation.set(0, 0, Math.PI / 2 - 0.52); handle.position.set(-0.09, 0.115, 0);
  for (const y of [0.17, 0.065]) {
    const br = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.014, 0.022), steel);
    br.position.set(-0.093, y, 0);
    g.add(br);
  }
  g.add(shell, rim, lid, cup, knob, spout, handle);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.knob = knobMat;
  return g;
}

/** A stainless travel tumbler with a black lid. */
function tumblerMesh() {
  const g = new THREE.Group();
  const steel = new THREE.MeshLambertMaterial({ color: 0xaeb4b8 });
  const black = new THREE.MeshLambertMaterial({ color: 0x141517 });
  const shell = new THREE.Mesh(lathe([[0.001, 0], [0.03, 0], [0.034, 0.008], [0.04, 0.13], [0.042, 0.15]], 20), steel);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.0415, 0.0415, 0.018, 20), black);
  band.position.y = 0.075;
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.026, 20), black);
  lid.position.y = 0.163;
  const nub = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.012, 14), black);
  nub.position.set(0.012, 0.18, 0);
  g.add(shell, band, lid, nub);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

export class Coffee {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.rigged = false;      // grate and pot set up over the fire
    this.pot = { mode: 'idle', brew: 0, left: 0, heat: 0 };   // idle | brewing | ready (left: sips still in the pot)
    this.cup = { sips: 0, heat: 0 };
    this.events = [];
    this.hint = '';
    this.at = null;           // { x, z, y, yaw } of the grate
    this.sipT = -1; this.sipDone = false;
    this.pourT = -1;
    this.perkIn = 0; this.flash = 0;
    this.pourSound = false;

    this.stand = new THREE.Group();
    this.stand.add(grateMesh());
    this.potRoot = new THREE.Group();            // sits on the grate; turns toward you to pour
    this.potTilt = new THREE.Group();
    this.potMesh = potMesh();
    this.potTilt.add(this.potMesh);
    this.potRoot.add(this.potTilt);
    this.potRoot.position.set(POT_AT, GRATE_Y + 0.022, 0);
    this.stand.add(this.potRoot);
    this.stand.visible = false;
    scene.add(this.stand);

    this.tumbler = tumblerMesh();
    this.tumbler.visible = false;
    scene.add(this.tumbler);
    this.stream = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 1, 6), new THREE.MeshBasicMaterial({ color: 0x2a170b }));
    this.stream.visible = false;
    scene.add(this.stream);

    const tex = puffTexture();
    this.puffs = Array.from({ length: 18 }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      scene.add(s);
      return { s, age: 99, life: 1, vx: 0, vz: 0 };
    });
    this.puffT = 0;
  }

  get sips() { return this.cup.sips; }

  /** Pot position in the world. */
  #potWorld(out) { return this.potRoot.getWorldPosition(out); }

  #toast(text, warn = false) { this.events.push({ type: 'toast', text, warn }); }
  #sound(name) { this.events.push({ type: 'sound', name }); }

  /** Where the grate goes: across the fire, long axis pointing away from the tent. */
  #place(fire, tent) {
    const a = tent ? Math.atan2(fire.z - tent.z, fire.x - tent.x) : 0;
    const y = this.world.height(fire.x, fire.z);
    this.at = { x: fire.x, z: fire.z, y, yaw: Math.atan2(-Math.sin(a), Math.cos(a)) };
    this.stand.position.set(fire.x, y, fire.z);
    this.stand.rotation.y = this.at.yaw;
    this.potRoot.rotation.y = 0;
  }

  /** Distance to the pot if you are within reach of it and facing it, else Infinity. */
  reach(p, yaw) {
    if (!this.stand.visible) return Infinity;
    const w = this.#potWorld(_v);
    const dx = w.x - p.x, dz = w.z - p.z, d = Math.hypot(dx, dz);
    if (d > REACH) return Infinity;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    return d < 0.8 || (dx * fx + dz * fz) / (d || 1) > 0.6 ? d : Infinity;
  }

  /** [K] near the fire: the logs come off, the grate goes over it and a pot of coffee goes on. */
  rig(fire, p) {
    if (!fire) { this.#toast('Light a campfire first: [F].'); return false; }
    if (this.rigged) { this.#toast('The coffee pot is already on the fire.'); return false; }
    if (Math.hypot(fire.x - p.x, fire.z - p.z) > 4.5) { this.#toast('Get closer to the fire.'); return false; }
    this.rigged = true;
    this.#sound('lid');
    if (this.pot.mode === 'idle') { this.pot.mode = 'brewing'; this.pot.brew = 0; this.pot.left = 0; this.#toast('Grate and percolator on the fire. It will chime when the coffee is done.'); }
    else this.#toast('Grate and percolator back on the fire.');
    return true;
  }

  /** [U] at the pot: start a brew, check it, or pour what is ready into the tumbler. */
  interact(p) {
    const pot = this.pot;
    if (this.pourT >= 0) return null;
    if (pot.mode === 'idle') {
      pot.mode = 'brewing'; pot.brew = 0; pot.left = 0;
      this.#sound('lid');
      this.#toast('Water and grounds in. It will perk for a bit, and chime when it is done.');
      return 'started';
    }
    if (pot.mode === 'brewing') { this.#toast(`Still perking… ${Math.round(pot.brew * 100)}%`); return 'wait'; }
    if (this.cup.sips >= CAP) { this.#toast('Your thermos is already full.'); return 'full'; }
    this.pourT = 0; this.pourFrom = { x: p.x, z: p.z };
    this.pourN = Math.min(pot.left, CAP - this.cup.sips);
    return 'pour';
  }

  /** [O]: a sip from the thermos. */
  sip() {
    if (this.sipT >= 0) return false;
    if (this.cup.sips <= 0) { this.#toast('Your thermos is empty. Brew a pot at the fire.', true); return false; }
    this.sipT = 0; this.sipDone = false;
    return true;
  }

  /**
   * ctx: { fire: {x,z,life}|null, tent, p (feet), yaw (where you look), heading (body), first, camera, seated, minutes }
   */
  update(dt, ctx) {
    this.events.length = 0;
    const { fire, p } = ctx, pot = this.pot;
    const was = this.stand.visible;
    if (!fire && this.rigged) { this.rigged = false; if (pot.mode === 'brewing') { pot.mode = 'idle'; pot.brew = 0; } }
    this.stand.visible = !!fire && this.rigged;
    if (this.stand.visible && (!was || !this.at || this.at.x !== fire.x || this.at.z !== fire.z)) this.#place(fire, ctx.tent);

    // cooling: a pot off the fire loses its heat; a thermos holds on to it much longer
    const min = ctx.minutes || 0;
    if (fire && pot.mode !== 'idle') pot.heat = Math.min(1, pot.heat + dt * 0.25); else pot.heat = Math.max(0, pot.heat - min / 90);
    this.cup.heat = Math.max(0, this.cup.heat - min / 240);
    if (this.cup.sips <= 0) this.cup.heat = 0;

    // brewing
    const live = !!fire && fire.life > 4;
    if (pot.mode === 'brewing' && live && dt > 0) {
      pot.brew = Math.min(1, pot.brew + dt / BREW_S);
      this.perkIn -= dt;
      const near = Math.hypot(this.at.x - p.x, this.at.z - p.z) < 16;
      if (this.perkIn <= 0) {
        this.perkIn = (1.3 - pot.brew * 0.8) * (0.6 + Math.random() * 0.8);
        this.flash = 1;
        if (near) this.#sound('perk');
      }
      if (pot.brew >= 1) {
        pot.mode = 'ready'; pot.left = SERVINGS;
        this.events.push({ type: 'ready' });
        this.#toast('Coffee is ready! [U] at the percolator to pour.');
      }
    }
    this.flash = Math.max(0, this.flash - dt * 4);
    const knob = this.potMesh.userData.knob;
    const dark = pot.mode === 'ready' ? 0.85 : pot.mode === 'brewing' ? this.flash * 0.9 * pot.brew + 0.1 * pot.brew : 0;
    knob.color.setRGB(0.81 - 0.6 * dark, 0.87 - 0.72 * dark, 0.89 - 0.78 * dark);
    knob.opacity = 0.55 + dark * 0.4;

    this.#pour(dt, ctx);
    this.#sipAnim(dt, ctx);
    this.#steam(dt, ctx);
    this.#hint(ctx);
  }

  #pour(dt, ctx) {
    const pot = this.pot;
    if (this.pourT < 0) { this.potTilt.rotation.z = 0; this.tumbler.visible = this.sipT >= 0; this.stream.visible = false; return; }
    this.pourT += dt;
    const t = this.pourT, u = t / POUR_S;
    // turn the spout toward you, tip it, hold, set it back
    const w = this.#potWorld(_v), dx = this.pourFrom.x - w.x, dz = this.pourFrom.z - w.z, dl = Math.hypot(dx, dz) || 1;
    const turn = Math.atan2(-dz, dx) - this.at.yaw;
    let d = turn - this.potRoot.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.potRoot.rotation.y += d * Math.min(1, dt * 8);
    const tilt = ease(clamp(u * 4, 0, 1)) * (1 - ease(clamp((u - 0.8) * 5, 0, 1)));
    this.potTilt.rotation.z = -tilt * 0.62;
    // the tumbler held out beside the spout, a stream between them
    const ux = dx / dl, uz = dz / dl;
    this.tumbler.visible = true;
    this.tumbler.position.set(w.x + ux * 0.2, w.y + 0.06, w.z + uz * 0.2);
    this.tumbler.rotation.set(0, 0, 0);
    const flow = u > 0.25 && u < 0.78;
    this.stream.visible = flow;
    if (flow) {
      const top = _d.set(w.x + ux * 0.115, w.y + 0.17 - tilt * 0.02, w.z + uz * 0.115), bot = _e2.set(w.x + ux * 0.2, w.y + 0.2, w.z + uz * 0.2);
      this.stream.position.copy(top).add(bot).multiplyScalar(0.5);
      this.stream.scale.set(1, top.distanceTo(bot), 1);
      this.stream.quaternion.setFromUnitVectors(UP, bot.sub(top).normalize());
      if (this.pourSound !== true) { this.pourSound = true; this.#sound('pour'); }
    }
    if (t >= POUR_S) {
      this.pourT = -1; this.pourSound = false;
      this.tumbler.visible = false; this.stream.visible = false; this.potTilt.rotation.z = 0;
      const n = this.pourN;
      const had = this.cup.sips;
      this.cup.heat = (this.cup.heat * had + pot.heat * n) / Math.max(1, had + n);
      this.cup.sips += n; pot.left -= n;
      this.#toast(`Poured ${n} sip${n > 1 ? 's' : ''} into your thermos · ${this.cup.sips}/${CAP}. [O] to sip.`);
      if (pot.left <= 0) { pot.mode = 'idle'; pot.heat = Math.min(pot.heat, 0.6); this.#toast('The pot is empty. [U] brews another.'); }
    }
  }

  #sipAnim(dt, ctx) {
    if (this.sipT < 0) return;
    this.sipT += dt;
    const t = this.sipT;
    if (t >= SIP_S) { this.sipT = -1; if (this.pourT < 0) this.tumbler.visible = false; return; }
    const up = ease(clamp(t / 0.4, 0, 1)) * (1 - ease(clamp((t - 1.4) / 0.5, 0, 1)));
    const tilt = ease(clamp((t - 0.35) / 0.3, 0, 1)) * (1 - ease(clamp((t - 1.2) / 0.3, 0, 1)));
    if (!this.sipDone && t > 0.8) {
      this.sipDone = true;
      this.cup.sips--;
      this.events.push({ type: 'sip', q: 0.45 + 0.55 * this.cup.heat, left: this.cup.sips });
    }
    this.tumbler.visible = true;
    if (ctx.first && ctx.camera) {
      const c = ctx.camera;
      _v.set(0.24 - 0.17 * up, -0.52 + 0.33 * up, -0.62 + 0.2 * up);
      this.tumbler.position.copy(c.localToWorld(_v));
      _q.setFromEuler(_e.set(tilt * 0.7, 0, 0));
      this.tumbler.quaternion.copy(c.quaternion).multiply(_q);
    } else {
      const h = ctx.heading, sy = Math.sin(h), cy = Math.cos(h);
      const fy = ctx.seated ? 0.72 : 1.0, top = ctx.seated ? 1.18 : 1.5;
      const ahead = 0.3 * (0.6 + 0.4 * up);
      this.tumbler.position.set(ctx.p.x + cy * 0.2 - sy * ahead, ctx.p.y + fy + (top - fy) * up, ctx.p.z - sy * 0.2 - cy * ahead);
      this.tumbler.quaternion.setFromEuler(_e.set(-tilt * 0.9, h, 0, 'YXZ'));
    }
  }

  #steam(dt, ctx) {
    const hot = this.stand.visible && this.pot.mode !== 'idle' && this.pot.heat > 0.3 && ctx.fire;
    const wp = hot ? this.#potWorld(_d) : null;
    const rate = this.pot.mode === 'brewing' ? 0.1 + 0.5 * this.pot.brew : 0.7;
    this.puffT -= dt;
    for (const f of this.puffs) {
      if (f.age < f.life) {
        f.age += dt;
        const u = f.age / f.life;
        f.s.position.x += f.vx * dt; f.s.position.z += f.vz * dt; f.s.position.y += (0.28 + u * 0.15) * dt;
        f.s.scale.setScalar(0.06 + u * 0.22);
        f.s.material.opacity = Math.sin(Math.PI * Math.min(1, u)) * 0.34;
        if (u >= 1) f.s.visible = false;
      } else if (hot && this.puffT <= 0) {
        this.puffT = (0.16 + Math.random() * 0.2) / rate;
        f.age = 0; f.life = 1.6 + Math.random() * 1.0;
        f.s.visible = true;
        f.s.position.set(wp.x + (Math.random() - 0.5) * 0.04, wp.y + 0.27, wp.z + (Math.random() - 0.5) * 0.04);
        f.vx = (Math.random() - 0.5) * 0.06; f.vz = (Math.random() - 0.5) * 0.06;
      }
    }
  }

  #hint(ctx) {
    const pot = this.pot;
    if (ctx.fire && !this.rigged) {
      this.hint = !ctx.seated && Math.hypot(ctx.fire.x - ctx.p.x, ctx.fire.z - ctx.p.z) < 3.8 ? '[K] make coffee  ·  [N] roast a marshmallow' : '';
      return;
    }
    const d = this.reach(ctx.p, ctx.yaw);
    const sipTip = this.cup.sips > 0 ? `  ·  [O] sip (${this.cup.sips})` : '';
    if (d === Infinity || ctx.seated) { this.hint = ''; return; }
    this.hint = pot.mode === 'idle' ? `[U] brew a pot of coffee${sipTip}`
      : pot.mode === 'brewing' ? `Perking… ${Math.round(pot.brew * 100)}%${sipTip}`
        : this.cup.sips >= CAP ? `Your thermos is full${sipTip}` : `[U] pour coffee into your thermos${sipTip}`;
  }

  save() { return { pot: { ...this.pot }, cup: { ...this.cup }, rigged: this.rigged }; }

  load(s) {
    if (!s) return;
    Object.assign(this.pot, s.pot); Object.assign(this.cup, s.cup);
    this.rigged = !!s.rigged;
  }
}
