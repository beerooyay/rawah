import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp } from './noise.js';

// A four-wheeler you can climb on and ride. The body is a simple arcade model:
// throttle and brake along the heading, steering that tightens at low speed,
// grip that bleeds off sideways slide, and a suspension that rides the four
// wheel contact points over the lidar (the body pitches and rolls with the
// ground). Deep water, trees, boulders and slopes too steep for the engine all
// stop it.
//
// The model: point MODEL.file at a glTF (e.g. './assets/vehicles/atv.glb') and
// it is used; null means the procedural stand-in is drawn without probing.
// See MODEL for how it is fitted.

const MODEL = {
  file: null,
  length: 1.95,        // metres, nose to tail
  flip: false,         // glTF vehicles face +z and are turned to face -z like the hiker; set true if yours comes in nose-first the other way
};

const WHEELBASE = 1.15, TRACK = 0.95, WHEEL_R = 0.28;
const SEAT_Y = 0.78;
const TOP = 13.5, BOOST = 19, REVERSE = 3;
const SEAT_RADIUS = 3.6;     // how close you must be to climb on
const STEEP = 0.8;           // |dh/dxz| the engine will climb (~39 deg)

export class ATV {
  constructor(world, flora, scene) {
    this.world = world;
    this.flora = flora;
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.speed = 0;        // signed, along the heading
    this.side = 0;         // sideways slide
    this.pitch = 0; this.roll = 0;
    this.y = 0;
    this.riding = false;
    this.hold = false;     // true while a passenger is still climbing on
    this.steer = 0;        // smoothed, -1 left .. 1 right
    this.wheelSpin = 0;
    this.events = [];
    this.root = new THREE.Group();
    this.body = new THREE.Group();     // pitched and rolled by the suspension
    this.root.add(this.body);
    this.wheels = [];
    this.#standIn();
    scene.add(this.root);
    this.load();
    this._p = new THREE.Vector3();
  }

  // ---------------------------------------------------------------- model
  /** Replace the stand-in with the glTF, if there is one. */
  async load() {
    try {
      if (!MODEL.file) return false;
      const head = await fetch(MODEL.file, { method: 'HEAD' });
      if (!head.ok) return false;
      const gltf = await new GLTFLoader().loadAsync(MODEL.file);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      let box = new THREE.Box3().setFromObject(root);
      // the long horizontal axis is the vehicle's length
      const size = box.getSize(new THREE.Vector3());
      const holder = new THREE.Group();
      holder.add(root);
      if (size.x > size.z) { root.rotation.y = Math.PI / 2; root.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(root); }
      const s = MODEL.length / Math.max(0.1, box.getSize(new THREE.Vector3()).z);
      root.scale.multiplyScalar(s);
      root.updateMatrixWorld(true);
      box = new THREE.Box3().setFromObject(root);
      const c = box.getCenter(new THREE.Vector3());
      root.position.set(-c.x, -box.min.y, -c.z);
      holder.rotation.y = MODEL.flip ? 0 : Math.PI;
      const wheels = [];
      root.traverse((o) => {
        if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.frustumCulled = true; }
        if (/wheel|tire|tyre/i.test(o.name) && !wheels.some((w) => w.contains?.(o))) wheels.push(o);
      });
      this.standIn.removeFromParent();
      this.body.add(holder);
      this.model = holder;
      this.wheels = wheels.filter((w) => !wheels.some((p) => p !== w && isAncestor(p, w)));
      this.wheels.forEach((w) => { w.userData.axle = 'x'; });
      return true;
    } catch (e) {
      console.warn('ATV model not loaded, using the stand-in', e);
      return false;
    }
  }

  /** A chunky low-poly quad: frame, fenders, tank, seat, bars, rack and four tyres. */
  #standIn() {
    const g = this.standIn = new THREE.Group();
    const M = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
    const red = M(0xb3281f), black = M(0x1c1c1e), grey = M(0x6c6f72), seat = M(0x26262a);
    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      return m;
    };
    // nose is toward -z, like the hiker
    add(new THREE.BoxGeometry(0.55, 0.28, 1.15), black, 0, 0.5, 0.05);                 // frame / engine
    add(new THREE.BoxGeometry(0.62, 0.3, 0.7), red, 0, 0.8, -0.05);                    // tank cover
    add(new THREE.BoxGeometry(0.42, 0.14, 1.2), seat, 0, SEAT_Y + 0.04, 0.55);         // long two-up seat
    add(new THREE.BoxGeometry(0.4, 0.06, 0.12), grey, 0, SEAT_Y + 0.14, 1.18);         // grab bar for the passenger
    add(new THREE.BoxGeometry(0.7, 0.07, 0.5), red, 0, 0.7, -0.62, -0.18);             // front fascia
    add(new THREE.BoxGeometry(0.75, 0.05, 0.4), red, 0, 0.8, 1.22, 0.1);               // rear fender
    add(new THREE.BoxGeometry(0.5, 0.05, 0.3), grey, 0, 0.86, 1.5);                    // rack
    add(new THREE.CylinderGeometry(0.025, 0.025, 0.76, 8), grey, 0, 1.0, -0.28, 0, 0, Math.PI / 2); // handlebar
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), grey, 0, 0.84, -0.3, -0.25);   // steering column
    for (const x of [-0.26, 0.26]) add(new THREE.BoxGeometry(0.12, 0.1, 0.1), M(0xfff3c4, { emissive: 0xffe9a8, emissiveIntensity: 0.5 }), x * 0.8, 0.82, -0.9); // lamps
    for (const x of [-1, 1]) {
      add(new THREE.BoxGeometry(0.1, 0.05, 0.62), red, x * 0.45, 0.62, -WHEELBASE / 2 - 0.1, -0.1); // front fenders
      add(new THREE.BoxGeometry(0.1, 0.05, 0.66), red, x * 0.5, 0.64, WHEELBASE / 2 + 0.1);         // rear fenders
    }
    // axles
    add(new THREE.CylinderGeometry(0.03, 0.03, TRACK, 6), grey, 0, WHEEL_R, -WHEELBASE / 2, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.03, 0.03, TRACK, 6), grey, 0, WHEEL_R, WHEELBASE / 2, 0, 0, Math.PI / 2);
    // tyres: a fat tube with block tread, a hub in the middle
    const tyreGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.22, 16);
    tyreGeo.rotateZ(Math.PI / 2);
    const tread = new THREE.CylinderGeometry(WHEEL_R + 0.02, WHEEL_R + 0.02, 0.2, 8);
    tread.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.24, 10);
    hubGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const w = new THREE.Group();
      w.position.set(x * TRACK / 2, WHEEL_R, z * WHEELBASE / 2);
      for (const [geo, mat] of [[tyreGeo, black], [tread, M(0x2b2b2e, { flatShading: true })], [hubGeo, grey]]) {
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = m.receiveShadow = true;
        w.add(m);
      }
      w.userData.front = z < 0;
      g.add(w);
      this.wheels.push(w);
    }
    this.body.add(g);
  }

  // ---------------------------------------------------------------- placement
  place(x, z, yaw) {
    this.pos.set(x, this.world.height(x, z), z);
    this.y = this.pos.y;
    this.yaw = yaw;
    this.speed = this.side = 0;
    this.pitch = this.roll = 0;
    this.#pose();
  }

  near(p) { return Math.hypot(p.x - this.pos.x, p.z - this.pos.z) < SEAT_RADIUS; }

  /** Where a rider's feet-origin goes: over the long seat, sunk so the hips land on the cushion. Slot 0 drives, slot 1 rides on the back. */
  seat(out, slot = 0) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);   // (s, c) points to the back of the quad
    const back = slot ? 0.78 : 0.22;
    return out.set(this.pos.x + s * back, this.y + 0.32 - this.pitch * back, this.pos.z + c * back);
  }

  /** The spot behind the quad where a passenger steps up from. */
  step(out) {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return out.set(this.pos.x + s * 1.7, this.pos.y, this.pos.z + c * 1.7);
  }

  mount() { this.riding = true; this.speed = 0; }

  /** Step off to the left; returns { x, z, yaw } for the hiker. */
  dismount() {
    this.riding = false;
    const lx = -Math.cos(this.yaw), lz = Math.sin(this.yaw);   // to the vehicle's left
    for (const d of [1.5, 1.9, 1.1, -1.5]) {
      const x = this.pos.x + lx * d, z = this.pos.z + lz * d;
      const lake = this.world.lakeAt(x, z);
      if (lake && !(lake.level >= this.world.iceLine) && lake.level - this.world.height(x, z) > 0.5) continue;
      return { x, z, yaw: this.yaw };
    }
    return { x: this.pos.x + lx * 1.5, z: this.pos.z + lz * 1.5, yaw: this.yaw };
  }

  // ---------------------------------------------------------------- driving
  /** `ctl`: { move: Vector2 (x steer, y throttle), sprint }. Returns events: { type: 'bump', hard } | { type: 'splash' }. */
  update(dt, ctl) {
    this.events.length = 0;
    const w = this.world, p = this.pos;
    const go = this.riding && !this.hold;
    const throttle = go ? clamp(ctl.move.y, -1, 1) : 0;
    const steerIn = go ? clamp(ctl.move.x, -1, 1) : 0;
    const boost = this.riding && ctl.sprint;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);

    // slope along the heading: climbing saps speed, descending adds it
    const ahead = w.height(p.x + fx * 1.2, p.z + fz * 1.2), here = w.height(p.x, p.z);
    const grade = clamp((ahead - here) / 1.2, -1.2, 1.2);

    const top = boost ? BOOST : TOP;
    if (throttle > 0.02) {
      const cap = top * throttle / (1 + Math.max(0, grade) * 1.6);
      if (this.speed < cap) this.speed = Math.min(cap, this.speed + (boost ? 9 : 6.5) * (1 - Math.max(0, this.speed) / (top * 1.1)) * dt);
      else this.speed += (cap - this.speed) * Math.min(1, dt * 0.8);
    } else if (throttle < -0.02) {
      // brake first, then back up
      if (this.speed > 0.2) this.speed = Math.max(0, this.speed - 14 * dt);
      else this.speed = Math.max(-REVERSE * -throttle, this.speed - 3 * dt);
    } else {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), (1.6 + Math.abs(this.speed) * 0.12) * dt);
    }
    this.speed -= grade * 5.5 * dt * (Math.abs(this.speed) > 0.3 || Math.abs(grade) > 0.25 ? 1 : 0);   // gravity along the slope
    this.speed *= 1 - 0.012 * dt * Math.abs(this.speed);                                              // drag

    // steering: nothing when stopped, tight at a crawl, wider at speed
    this.steer += (steerIn - this.steer) * Math.min(1, dt * 7);
    const v = Math.abs(this.speed);
    const rate = 2.1 / (1 + v * 0.11) * clamp(v / 1.6, 0, 1);
    this.yaw -= this.steer * rate * dt * Math.sign(this.speed || 1);

    // move along the heading with some sideways carry that grip removes
    const nfx = -Math.sin(this.yaw), nfz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    this.side -= this.steer * v * 0.35 * (boost ? 1.4 : 1) * dt;   // the tail swings out of the turn
    this.side -= this.side * Math.min(1, dt * 5.5);
    let dx = nfx * this.speed + rx * this.side, dz = nfz * this.speed + rz * this.side;
    let nx = p.x + dx * dt, nz = p.z + dz * dt;

    // water: wade a creek, but not a lake
    const lake = w.lakeAt(nx, nz);
    const frozen = lake && lake.level >= w.iceLine;
    const depth = lake && !frozen ? lake.level - w.height(nx, nz) : 0;
    const brook = w.nearestStream(nx, nz);
    const creek = brook.stream && brook.d < brook.stream.width / 2 + 0.4 ? Math.max(0, brook.y - w.height(nx, nz)) : 0;
    if (Math.max(depth, creek) > 0.55) {
      if (v > 1.5) this.events.push({ type: 'splash' });
      this.speed *= -0.15; this.side = 0;
      nx = p.x; nz = p.z;
    } else if (Math.max(depth, creek) > 0.1) this.speed *= 1 - Math.min(0.9, 2.2 * dt);

    // too steep for the engine
    if (w.localGrade(nx, nz) > STEEP && w.height(nx, nz) > here + 0.01) {
      if (v > 2) this.events.push({ type: 'bump', hard: false });
      this.speed *= 0.2 ** Math.min(1, dt * 6); this.side = 0;
      nx = p.x; nz = p.z;
    }

    const lim = w.half - 40;
    p.x = clamp(nx, -lim, lim); p.z = clamp(nz, -lim, lim);

    // trees and boulders push the quad out (and take the speed with them)
    const bx = p.x, bz = p.z;
    this.solids?.(p, 1.1);
    const lift = this.flora.collide(p, 0.85, this.y);
    const pushed = Math.hypot(p.x - bx, p.z - bz);
    if (pushed > 0.01) {
      if (v > 3) this.events.push({ type: 'bump', hard: v > 8 });
      this.speed *= 1 - Math.min(0.8, pushed * 3);
    }

    // suspension: ride the four contact points
    const wp = (lx, lz) => {   // local (x right, z back) -> world
      const x = p.x + rx * lx + (-nfx) * lz, z = p.z + rz * lx + (-nfz) * lz;
      return w.height(x, z);
    };
    const hf = (wp(-TRACK / 2, -WHEELBASE / 2) + wp(TRACK / 2, -WHEELBASE / 2)) / 2;
    const hr = (wp(-TRACK / 2, WHEELBASE / 2) + wp(TRACK / 2, WHEELBASE / 2)) / 2;
    const hl = (wp(-TRACK / 2, -WHEELBASE / 2) + wp(-TRACK / 2, WHEELBASE / 2)) / 2;
    const hrt = (wp(TRACK / 2, -WHEELBASE / 2) + wp(TRACK / 2, WHEELBASE / 2)) / 2;
    const ground = Math.max((hf + hr) / 2, lift);
    const k = 1 - Math.exp(-16 * dt);
    this.y += (ground - this.y) * k;
    this.pitch += (Math.atan2(hf - hr, WHEELBASE) - this.pitch) * k;       // nose up when the front is higher
    this.roll += (Math.atan2(hl - hrt, TRACK) - this.roll) * k;            // right side down when the left is higher
    p.y = this.y;
    this.wheelSpin += this.speed * dt / WHEEL_R;
    this.#pose();
    return this.events;
  }

  #pose() {
    this.root.position.set(this.pos.x, this.y, this.pos.z);
    this.root.rotation.set(0, this.yaw, 0);              // the nose is -z, the hiker's forward
    this.body.rotation.set(this.pitch, 0, -this.roll);    // nose up with the front wheels; the low side dips
    // wheels spin; the front pair turn with the steering
    for (const w of this.wheels) {
      if (w.userData.front) w.rotation.y = -this.steer * 0.45;
      w.children.forEach((m) => { m.rotation.x = this.wheelSpin; });
      if (!w.children.length) w.rotation.x = this.wheelSpin;
    }
  }
}

function isAncestor(a, b) {
  for (let o = b.parent; o; o = o.parent) if (o === a) return true;
  return false;
}
