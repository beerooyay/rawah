import * as THREE from 'three';
import { clamp } from './noise.js';
import { barkTexture } from './fire.js';
import { barkUV } from './trees.js';
import { REST } from './props.js';

// Firewood, from felled tree to the fire.
//
//  1. Fell a tree with the axe ([T] to hold it, then click): `props.js` brings it down
//     whole and it lies on the slope, crown and all.
//  2. Swing the axe at the thick end of the lying trunk. The first strokes take the
//     branches off, leaving one continuous trunk; every couple of strokes after that
//     saws a fire-log length off the cut end, and the log flies to a neat pyramid
//     stack beside the trunk. When the usable trunk is gone the thin tip rots away.
//  3. [U] at a stack takes an armful (up to a pack of sixteen); [U] at camp stacks
//     what you carry in a woodpile beside the tent. [F] at the fire lays a log on it
//     (from your pack, or the camp pile); lighting a new fire takes three.

const LOG_LEN = 0.5, LOG_R = 0.085;  // a fire log
const SEG = 0.55;                    // trunk is sawn in lengths of this
const R_USABLE = 0.09;               // thinner than this is kindling, left on the trunk
const BASE_R = { spruce: 0.28, fir: 0.28, lodgepole: 0.26, aspen: 0.2, snag: 0.24 };   // trunk radius at the butt, scale 1
const BARK_OF = { spruce: 'spruce', fir: 'spruce', lodgepole: 'pine', aspen: 'aspen', snag: 'snag' };   // which bark strip of the tree atlas each kind wears
const LAYERS = [6, 5, 4, 3, 2, 1];   // a pyramid
const PER_STACK = 21;
const PACK = 16;
const LOG_CAP = 700, PILE_CAP = 60;
const Y = new THREE.Vector3(0, 1, 0);

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
const ease = (u) => u * u * (3 - 2 * u);

/** Position of the k-th log of a pyramid stack. */
function slot(k, origin, dir, side, gy) {
  const st = Math.floor(k / PER_STACK);
  let i = k % PER_STACK, l = 0;
  while (i >= LAYERS[l]) { i -= LAYERS[l]; l++; }
  const lat = (i - (LAYERS[l] - 1) / 2) * (LOG_R * 2 + 0.006), along = st * (LOG_LEN + 0.25);
  return new THREE.Vector3(origin.x + side.x * lat + dir.x * along, gy + LOG_R + l * LOG_R * 1.74, origin.z + side.z * lat + dir.z * along);
}

/** A handful of particles thrown out and falling: chips, needles. */
class Burst {
  constructor(scene, color, size, cap = 80) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.next = 0;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.pts = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, sizeAttenuation: true, transparent: true, opacity: 0.95, depthWrite: false }));
    this.pts.frustumCulled = false;
    scene.add(this.pts);
    for (let i = 0; i < cap; i++) this.pos[i * 3 + 1] = -9999;
  }

  emit(x, y, z, n, speed, up = 1.5, spread = 1) {
    for (let k = 0; k < n; k++) {
      const i = this.next; this.next = (this.next + 1) % this.cap;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2, v = speed * (0.4 + Math.random() * 0.8);
      this.vel[i * 3] = Math.cos(a) * v * spread; this.vel[i * 3 + 1] = up * (0.3 + Math.random()); this.vel[i * 3 + 2] = Math.sin(a) * v * spread;
      this.life[i] = 0.7 + Math.random() * 0.8;
    }
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.life[i] <= 0) this.pos[i * 3 + 1] = -9999;
      any = true;
    }
    if (any) this.pts.geometry.attributes.position.needsUpdate = true;
  }
}

export class Wood {
  constructor(world, flora, scene, props) {
    this.world = world;
    this.flora = flora;
    this.scene = scene;
    this.props = props;
    this.carried = 0;        // logs in your pack
    this.campCount = 0;      // logs in the woodpile at camp
    this.cutTotal = 0;       // logs you have ever made
    this.hint = '';
    this.events = [];
    this.trunks = [];        // lying trees being sawn up
    this.ground = [];        // logs lying in stacks beside trunks
    this.flying = [];        // logs on their way to a stack
    this.dropStacks = [];    // stacks you made by dropping your pack
    this.trunkFar = Infinity;
    this.pile = null;        // { origin, dir, side, gy } the camp woodpile

    const bark = barkTexture();
    this.barkMat = new THREE.MeshLambertMaterial({ map: bark });
    this.cutMat = new THREE.MeshLambertMaterial({ color: 0xd2a96e });
    const geo = new THREE.CylinderGeometry(1, 1, 1, 10);
    const inst = (cap) => {
      const m = new THREE.InstancedMesh(geo, [this.barkMat, this.cutMat, this.cutMat], cap);
      m.setColorAt(0, _c.setScalar(1));
      m.count = 0; m.frustumCulled = false; m.castShadow = m.receiveShadow = true;
      scene.add(m);
      return m;
    };
    this.logs = inst(LOG_CAP);
    this.carry = inst(PACK);
    this.pileMesh = inst(PILE_CAP);

    this.chips = new Burst(scene, 0xe3c185, 0.075);
    this.leaves = new Burst(scene, 0x4f6b3a, 0.11, 160);
  }

  // ---------------------------------------------------------------- the camp woodpile
  /** Where the camp woodpile goes: beside the tent. */
  setCamp(tent) {
    if (!tent) { this.pile = null; this.#drawPile(); return; }
    const dir = new THREE.Vector3(Math.sin(tent.yaw), 0, Math.cos(tent.yaw)), side = new THREE.Vector3(Math.cos(tent.yaw), 0, -Math.sin(tent.yaw));
    const off = tent.kind === 'family' ? 3.1 : 2.4;
    const origin = new THREE.Vector3(tent.x + side.x * off + dir.x * 0.4, 0, tent.z + side.z * off + dir.z * 0.4);
    this.pile = { origin, dir, side, gy: this.world.height(origin.x, origin.z) };
    this.#drawPile();
  }

  pileDist(p) { return this.pile ? Math.hypot(this.pile.origin.x - p.x, this.pile.origin.z - p.z) : Infinity; }

  #drawPile() {
    const m = this.pileMesh;
    m.count = this.pile ? Math.min(this.campCount, PILE_CAP) : 0;
    if (!this.pile) { m.instanceMatrix.needsUpdate = true; return; }
    _q.setFromUnitVectors(Y, this.pile.dir);
    for (let k = 0; k < m.count; k++) {
      const at = slot(k, this.pile.origin, this.pile.dir, this.pile.side, this.pile.gy);
      m.setMatrixAt(k, _m.compose(at, _q, _s.set(LOG_R, LOG_LEN, LOG_R)));
      m.setColorAt(k, _c.setScalar(0.82 + ((k * 37) % 17) / 17 * 0.2));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- the pack and the fire
  available(p) { return this.carried + (this.pileDist(p) < 10 ? this.campCount : 0); }

  /** Spend logs from the pack, then the camp pile (if you're at camp). False if there aren't enough. */
  consume(p, n = 1) {
    if (this.available(p) < n) return false;
    const fromPack = Math.min(this.carried, n);
    this.carried -= fromPack;
    this.campCount -= n - fromPack;
    this.#drawPile();
    return true;
  }

  // ---------------------------------------------------------------- trunks
  /** The point t metres along the trunk from its butt. */
  #at(trunk, t) { return trunk.base.clone().addScaledVector(trunk.axis, t); }
  #radius(trunk, t) { return trunk.r0 + (0.02 - trunk.r0) * (t / trunk.L); }

  /** The sawing record for a tree lying in `props.lying` (made the first time it is struck). */
  #trunkOf(f) {
    if (f.trunk) return f.trunk;
    if (!BASE_R[f.kind]) return null;
    const L = f.H * 0.97, r0 = BASE_R[f.kind] * f.s;
    const useful = r0 > R_USABLE ? ((r0 - R_USABLE) / (r0 - 0.02)) * L : SEG;
    const n = Math.max(1, Math.floor(useful / SEG));
    const dir = new THREE.Vector3(Math.cos(f.yaw), 0, Math.sin(f.yaw));
    const axis = new THREE.Vector3(dir.x * Math.sin(REST), Math.cos(REST), dir.z * Math.sin(REST));
    const base = new THREE.Vector3(f.x, f.y + 0.3 * Math.sin(REST) + (f.lift || 0) * Math.cos(REST), f.z);
    const t = { f, dir, L, r0, n, cutCount: 0, prog: 0, axis, base, intact: true, mesh: null, stack: null, count: 0, bark: barkUV(BARK_OF[f.kind]) };
    f.trunk = t;
    this.trunks.push(t);
    return t;
  }

  /** The bare trunk as one piece, from the cut end to the tip, wearing the tree's own bark. */
  #buildTrunkMesh(t) {
    if (t.mesh) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
    const t0 = t.cutCount * SEG;
    if (t0 >= t.L - 0.05) return;
    const len = t.L - t0;
    const geo = new THREE.CylinderGeometry(this.#radius(t, t.L), this.#radius(t, t0), len, 8, 1);
    // the same strip of the same atlas as the standing tree, stretched once along the whole trunk: a cut leaves the bark where it was
    const [u0, v0, du, dv] = t.bark, tb = t0 / t.L, uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + du * uv.getX(i), v0 + dv * (tb + uv.getY(i) * (1 - tb)));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(uv.count * 3).fill(0.9), 3));
    // the foliage material is written for instancing (wind, tint), so the trunk is a one-instance mesh like the standing trees
    const mesh = new THREE.InstancedMesh(geo, [this.flora.foliage, this.cutMat, this.cutMat], 1);
    mesh.setMatrixAt(0, _m.compose(this.#at(t, t0 + len / 2), _q.setFromUnitVectors(Y, t.axis), _s.set(1, 1, 1)));
    mesh.setColorAt(0, _c.setRGB(0.82, 0.81, 0.79));
    mesh.frustumCulled = false;
    mesh.castShadow = mesh.receiveShadow = true;
    this.scene.add(mesh);
    t.mesh = mesh;
  }

  /** The first cut: the branches come off, leaving the trunk. */
  #limb(t) {
    t.intact = false;
    t.f.mesh.visible = false;
    const c = this.#at(t, t.L * 0.62);
    this.leaves.emit(c.x, c.y + 0.4, c.z, 90, 3, 3, 1.6);
    this.chips.emit(c.x, c.y, c.z, 20, 2.2, 2, 1.4);
    this.#buildTrunkMesh(t);
    this.#toast('Branches off. Keep chopping from the thick end: each cut makes a log.');
  }

  #drawGround() {
    const m = this.logs;
    let k = 0;
    for (const l of this.ground) {
      if (l.taken || k >= LOG_CAP) continue;
      m.setMatrixAt(k, _m.compose(l.pos, l.q, _s.set(LOG_R, LOG_LEN, LOG_R)));
      m.setColorAt(k, _c.setScalar(l.shade));
      k++;
    }
    for (const f of this.flying) {
      if (k >= LOG_CAP) break;
      m.setMatrixAt(k, _m.compose(f.cur, f.curQ, _s.set(LOG_R, LOG_LEN, LOG_R)));
      m.setColorAt(k, _c.setScalar(f.log.shade));
      k++;
    }
    m.count = k;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  /** The lying trunk whose cut end is within the axe's reach of (x, z). */
  trunkNear(x, z, reach) {
    let best = null, bd = Infinity, far = Infinity;
    for (const f of this.props.lying) {
      const t = this.#trunkOf(f);
      if (!t || t.cutCount >= t.n) continue;
      const mid = this.#at(t, (t.cutCount + 0.5) * SEG);
      const d = Math.hypot(mid.x - x, mid.z - z) - this.#radius(t, (t.cutCount + 0.5) * SEG);
      far = Math.min(far, d);
      if (d < reach && d < bd) { bd = d; best = t; }
    }
    this.trunkFar = far;
    return best;
  }

  /** The butt-most length of the trunk comes off as a log and flies to the stack. */
  #cutSegment(t, from) {
    const i = t.cutCount;
    t.cutCount++; t.prog = 0;
    this.cutTotal++;
    const mid = this.#at(t, (i + 0.5) * SEG);
    if (!t.stack) {
      // the stack goes beside the thick end, on your side of the trunk
      const sx = -t.dir.z, sz = t.dir.x;
      const sign = Math.sign((from.x - mid.x) * sx + (from.z - mid.z) * sz) || 1;
      const o = this.#at(t, 1.4);
      const origin = new THREE.Vector3(o.x + sx * sign * 1.5, 0, o.z + sz * sign * 1.5);
      t.stack = { origin, side: new THREE.Vector3(sx, 0, sz), gy: this.world.height(origin.x, origin.z) };
    }
    const to = slot(t.count++, t.stack.origin, t.dir, t.stack.side, t.stack.gy);
    const log = { pos: to, q: new THREE.Quaternion().setFromUnitVectors(Y, t.dir), taken: false, shade: 0.8 + Math.random() * 0.22 };
    const q0 = new THREE.Quaternion().setFromUnitVectors(Y, t.axis);
    this.flying.push({ log, from: mid.clone(), q0, t: 0, dur: 0.55, cur: mid.clone(), curQ: q0.clone() });
    this.chips.emit(mid.x, mid.y + 0.1, mid.z, 8, 1.6);
    this.#sound('saw');
    if (t.cutCount >= t.n) {
      // nothing usable left: the thin tip rots away
      if (t.mesh) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
      this.props.dropLying(t.f);
      this.trunks.splice(this.trunks.indexOf(t), 1);
      t.done = true;
    } else this.#buildTrunkMesh(t);
  }

  /** An axe stroke from the hiker (a `strike` event). Returns true if it landed on a lying trunk. */
  strike(e, hiker) {
    const p = hiker.pos;
    const t = this.trunkNear(p.x, p.z, 2.6);
    if (!t) return false;
    this.#sound('chop');
    if (t.intact) this.#limb(t);
    t.prog++;
    const m = this.#at(t, (t.cutCount + 0.5) * SEG);
    this.chips.emit(m.x, m.y + 0.1, m.z, 5, 1.3);
    if (t.prog >= 2) this.#cutSegment(t, p);
    return true;
  }

  #toast(text, warn = false) { this.events.push({ type: 'toast', text, warn }); }
  #sound(name) { this.events.push({ type: 'sound', name }); }

  // ---------------------------------------------------------------- taking logs
  /** Distance to the nearest log lying in a stack (for choosing what [U] does). */
  stackDist(p) {
    let bd = Infinity;
    for (const l of this.ground) if (!l.taken) bd = Math.min(bd, Math.hypot(l.pos.x - p.x, l.pos.z - p.z));
    return bd;
  }

  /** [U] at a stack, or at the camp pile: take an armful, or put your armful down. Returns what it did. */
  interact(p) {
    const room = PACK - this.carried;
    const dPile = this.pileDist(p), dStack = this.stackDist(p);
    if (dPile < 3.2 && (dPile <= dStack) && (this.carried > 0 || this.campCount > 0)) {
      if (this.carried > 0) {
        const n = Math.min(this.carried, PILE_CAP - this.campCount);
        if (n <= 0) { this.#toast('The woodpile is full.'); return 'full'; }
        this.carried -= n; this.campCount += n;
        this.#drawPile(); this.#sound('clunk');
        this.#toast(`Stacked ${n} log${n > 1 ? 's' : ''} by the tent · ${this.campCount} in the pile`);
        return 'stacked';
      }
      const n = Math.min(4, this.campCount, room);
      this.campCount -= n; this.carried += n;
      this.#drawPile(); this.#sound('clunk');
      this.#toast(`Took ${n} from the pile · carrying ${this.carried}`);
      return 'took';
    }
    if (dStack < 3.0) {
      if (room <= 0) { this.#toast('Your pack is full. Stack them at camp: [U] at the woodpile.', true); return 'full'; }
      // the top of the stack nearest you first
      const near = this.ground.filter((l) => !l.taken && Math.hypot(l.pos.x - p.x, l.pos.z - p.z) < 3.0)
        .sort((a, b) => (Math.hypot(a.pos.x - p.x, a.pos.z - p.z) - a.pos.y * 0.5) - (Math.hypot(b.pos.x - p.x, b.pos.z - p.z) - b.pos.y * 0.5));
      const n = Math.min(4, room, near.length);
      for (let i = 0; i < n; i++) near[i].taken = true;
      this.carried += n;
      this.#drawGround(); this.#sound('clunk');
      this.#toast(`Took ${n} log${n > 1 ? 's' : ''} · carrying ${this.carried} · [J] to drop them`);
      return 'took';
    }
    return null;
  }

  // ---------------------------------------------------------------- per frame
  /** view: { pos, yaw }, ctl: { axe: holding the axe, carryVisible, heading, first }. Returns events. */
  update(dt, view, ctl) {
    this.chips.update(dt);
    this.leaves.update(dt);

    // logs flying to their stack
    if (this.flying.length) {
      for (let i = this.flying.length - 1; i >= 0; i--) {
        const f = this.flying[i];
        f.t += dt;
        if (f.t < 0) { f.cur.copy(f.from); continue; }
        const u = clamp(f.t / f.dur, 0, 1), e = ease(u);
        f.cur.lerpVectors(f.from, f.log.pos, e); f.cur.y += Math.sin(Math.PI * u) * 0.7;
        f.curQ.slerpQuaternions(f.q0, f.log.q, e);
        if (u >= 1) { this.ground.push(f.log); this.flying.splice(i, 1); this.#sound('clunk'); }
      }
      this.#drawGround();
    }
    this.#carryBundle(view, ctl);

    // what to tell you: a stack or the woodpile within reach comes first
    const dPile = this.pileDist(view.pos), dStack = this.stackDist(view.pos);
    let near = '';
    if (dPile < 3.2 && this.carried > 0) near = `[U] stack your ${this.carried} log${this.carried > 1 ? 's' : ''} in the woodpile`;
    else if (dPile < 3.2 && this.campCount > 0) near = `[U] take firewood from the pile (${this.campCount})`;
    else if (dStack < 3.0) near = `[U] take firewood (carrying ${this.carried}/${PACK})`;
    const nearTrunk = this.trunkNear(view.pos.x, view.pos.z, 2.6);
    this.hint = near;
    if (!near && ctl.axe && nearTrunk) this.hint = nearTrunk.intact && nearTrunk.cutCount === 0 ? '[Click] chop the branches off, then cut it into firewood' : '[Click] cut a log';
    else if (!near && ctl.axe && this.trunkFar < 7) this.hint = 'Step along to the cut end of the trunk to keep cutting';
    return this.events.splice(0);
  }

  /** The armful you are carrying: across your chest from outside, or low in front of you in first person. */
  #carryBundle(view, ctl) {
    const m = this.carry, n = ctl.carryVisible === false ? 0 : Math.min(this.carried, PACK);
    m.count = n;
    if (!n) return;
    const yaw = ctl.first ? view.yaw : (ctl.heading ?? view.yaw);     // the body faces where it walks, the camera where you look
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const rx = cy, rz = -sy, fx = -sy, fz = -cy;
    const h = ctl.first ? 1.2 : 1.1, ahead = ctl.first ? 0.5 : 0.34, across = ctl.first ? 0.06 : 0;
    _q.setFromUnitVectors(Y, _p.set(rx, 0, rz));       // logs lie across you
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / 4), col = i % 4;
      const at = new THREE.Vector3(view.pos.x + fx * ahead + rx * across, view.pos.y + h + row * 0.075, view.pos.z + fz * ahead + rz * across);
      at.x += fx * (col - 1.5) * 0.07; at.z += fz * (col - 1.5) * 0.07;
      m.setMatrixAt(i, _m.compose(at, _q, _s.set(0.034, LOG_LEN * 0.9, 0.034)));
      m.setColorAt(i, _c.setScalar(0.85));
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }

  /** Put what you are carrying down in a neat stack in front of you. */
  drop(view, heading) {
    if (this.carried <= 0) { this.#toast('You are not carrying any firewood.'); return false; }
    const yaw = heading ?? view.yaw, sy = Math.sin(yaw), cy = Math.cos(yaw);
    const fx = -sy, fz = -cy, rx = cy, rz = -sy;
    const spot = new THREE.Vector3(view.pos.x + fx * 1.3, 0, view.pos.z + fz * 1.3);
    // add to a stack you already started here, if there is one
    let st = this.dropStacks.find((d) => Math.hypot(d.origin.x - spot.x, d.origin.z - spot.z) < 1.4 && d.count < PER_STACK * 2 - this.carried);
    if (!st) {
      st = { origin: spot, dir: new THREE.Vector3(rx, 0, rz), side: new THREE.Vector3(fx, 0, fz), gy: this.world.height(spot.x, spot.z), count: 0 };
      this.dropStacks.push(st);
    }
    const n = this.carried, q = new THREE.Quaternion().setFromUnitVectors(Y, st.dir);
    for (let i = 0; i < n; i++) {
      const to = slot(st.count++, st.origin, st.dir, st.side, st.gy);
      const log = { pos: to, q: q.clone(), taken: false, shade: 0.8 + Math.random() * 0.22 };
      const from = new THREE.Vector3(view.pos.x + fx * 0.4, view.pos.y + 1.0 + (i % 4) * 0.05, view.pos.z + fz * 0.4);
      this.flying.push({ log, from, q0: q.clone(), t: -i * 0.04, dur: 0.5, cur: from.clone(), curQ: q.clone() });
    }
    this.carried = 0;
    this.#sound('clunk');
    this.#toast(`Dropped ${n} log${n > 1 ? 's' : ''} in a stack. [U] picks them up again.`);
    return true;
  }

  /** A new game: everything cut, stacked or carried is gone. */
  reset() {
    for (const t of this.trunks) if (t.mesh) { this.scene.remove(t.mesh); t.mesh.geometry.dispose(); }
    this.trunks = []; this.ground = []; this.flying = []; this.dropStacks = [];
    this.carried = 0; this.campCount = 0; this.cutTotal = 0;
    this.setCamp(null);
    this.#drawGround();
  }

  /** Striking camp: the woodpile goes into your pack as far as it fits. */
  packUpCamp() {
    const n = Math.min(this.campCount, PACK - this.carried);
    this.carried += n; this.campCount = 0;
    this.setCamp(null);
    return n;
  }

  /** Bare ground for the grass to stay off: a strip a foot wide either side of the fallen trunk, and under its stack. */
  clearings(p) {
    let best = null, bd = 80;
    for (const t of this.trunks) {
      const d = Math.hypot(t.base.x - p.x, t.base.z - p.z);
      if (d < bd) { bd = d; best = t; }
    }
    if (!best) return [];
    const t = best, out = [[t.base.x, t.base.z, t.base.x + t.axis.x * t.L, t.base.z + t.axis.z * t.L, t.r0 + 0.32]];
    if (t.stack) out.push([t.stack.origin.x, t.stack.origin.z, 1.1]);
    return out;
  }

  save() { return { carried: this.carried, camp: this.campCount, cut: this.cutTotal }; }
  load(s) {
    if (!s) return;
    this.carried = s.carried || 0; this.campCount = s.camp || 0; this.cutTotal = s.cut || 0;
    this.#drawPile();
  }
}
