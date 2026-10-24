import * as THREE from 'three';
import { TREES, SAPLING, BOT, FOOT, rockPose, itemKey } from './flora.js';
import { withAtmosphere } from './atmosphere.js';
import { buildTool, TOOLS, TOOL_NAME } from './tools.js';
import { clamp } from './noise.js';
import { carvedTree } from './cuts.js';

// The things you can do to the world besides walk through it: swing an axe or a
// machete at trees, pick up small stones and throw them, and shove the bigger
// ones along. The world itself is placement data in flora.js; anything you
// disturb is taken out of it (`flora.take`, remembered in `flora.removed`) and
// lives here as a few real objects: a falling or lying tree, a stump, a rock
// that moves. Those are what a save keeps.
//
// Trees take a number of swings that grows with their girth (an axe on a mature
// tree is about ten; a machete on one is a long job, and quick work on
// saplings and brush). Rocks come in three weights by scale: stones you can
// carry, boulders you can push (slowly, and the heavier the slower), and
// everything bigger, which is part of the mountain.

const BRUSH = ['krumm', 'willow'];
const NAME = { spruce: 'spruce', fir: 'subalpine fir', lodgepole: 'lodgepole pine', aspen: 'aspen', snag: 'snag', krumm: 'krummholz', willow: 'willow' };
// felling an axe like a woodsman: three strokes undercut one side of the trunk, three the other, and it goes
const TREE_HITS = 6;
const CUT_H = 0.8;               // where the wedges go, metres up the trunk: the tree breaks here and the stump is this tall
const MAX_CUT_STUMPS = 400;
const CARRY_MAX = 0.55;        // rock scale you can lift
const PUSH_MIN = CARRY_MAX;
const PUSH_MAX = 1.45;         // rock scale you can shove; bigger is bedrock
const MAX_LYING = 40;          // felled trees kept on the ground (older ones rot away; their stumps stay)
const MAX_ROCKS = 160;         // loose rocks kept
const MAX_STUMPS = 3000;
const CHIPS = 72;
const GRAVITY = 18;
export const REST = Math.PI / 2 - 0.11;   // a felled tree lies a little short of flat: the crown's branches prop it up

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0), _axis = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/**
 * The sideways felling swing, seen from your own eyes: the handle level and pointing ahead, the head flat,
 * the edge leading across the trunk. `R` comes in from the right and sweeps left; `L` comes in from the left and
 * sweeps right, every position mirrored and the head turned so the edge still leads.
 */
const SIDE = (() => {
  const up = new THREE.Vector3(0, 1, 0);
  const euler = (m) => { const e = new THREE.Euler().setFromRotationMatrix(m, 'YXZ'); return [e.x, e.y, e.z]; };
  // `lead` is which way the edge goes: -1 sweeps toward the left, +1 toward the right. The axe's edge is on its +X side, so the
  // left-handed swing is not the right one reflected (that would put the edge behind the head): it turns the head over instead.
  const pose = (x, y, z, hx, hz, lead) => {
    const h = new THREE.Vector3(hx, 0.05, hz).normalize(), e = new THREE.Vector3().crossVectors(up, h).normalize().multiplyScalar(-lead), n = new THREE.Vector3().crossVectors(e, h);
    return [x, y, z, ...euler(new THREE.Matrix4().makeBasis(e, h, n))];
  };
  const set = (side) => ({
    rest: [0.3, -0.34, -0.55, -0.35, 1.0, -0.3],
    back: pose(side * 0.46, -0.2, -0.52, side * 0.7, -0.7, -side),
    hit: pose(-side * 0.14, -0.28, -0.72, -side * 0.3, -0.95, -side),
  });
  return { R: set(1), L: set(-1) };
})();

/** Held in front of the camera, [x, y, z, rotX, rotY, rotZ] at rest, drawn back, and at the moment of the blow. */
export const VM = {
  axe: { rest: [0.3, -0.34, -0.55, -0.35, 1.0, -0.3], back: [0.32, -0.1, -0.42, 0.6, 1.0, -0.35], hit: [0.12, -0.36, -0.72, -1.4, 1.0, -0.1] },
  axeR: SIDE.R,
  axeL: SIDE.L,
  fireworks: { rest: [0.3, -0.3, -0.5, -0.5, 0.6, -0.15], back: [0.3, -0.3, -0.5, -0.5, 0.6, -0.15], hit: [0.3, -0.3, -0.5, -0.5, 0.6, -0.15] },
  machete: { rest: [0.3, -0.32, -0.52, -0.5, 1.2, -0.5], back: [0.4, -0.08, -0.4, 0.4, 1.0, -0.9], hit: [0.02, -0.34, -0.7, -1.2, 1.4, 0.4] },
};

export class Props {
  constructor({ world, flora, scene, camera, hiker, rig, avatar, hud, audio }) {
    Object.assign(this, { world, flora, scene, camera, hiker, rig, avatar, hud, audio });
    flora.props = this;
    this.tool = 'fists';
    this.carry = null;                 // { kind, vi, s, r, mesh } while holding a stone
    this.rocks = [];                   // loose rocks in the world
    this.falling = []; this.lying = [];
    this.damage = new Map();           // tree key -> swings taken
    this.cutStumps = [];               // stumps of trees felled with wedges, each its own mesh
    this.cutting = new Map();          // tree key -> a standing tree with wedges in it (see #makeCut)
    this.pushT = 0; this.dt = 1 / 60; this.tick = 0; this.told = new Set();
    this.hint = '';

    // first-person tools hang off the camera
    this.vm = new THREE.Group();
    this.vm.visible = false;
    this.vmTools = {};
    for (const k of ['axe', 'machete', 'fireworks']) { const t = buildTool(k); t.visible = false; this.vm.add(t); this.vmTools[k] = t; }
    camera.add(this.vm);
    this.vmRock = new THREE.Group();   // the stone you carry, seen from your own eyes
    camera.add(this.vmRock);

    // stumps, one instanced mesh
    const bark = new THREE.MeshLambertMaterial({ color: 0x5a3d25 }), cut = new THREE.MeshLambertMaterial({ color: 0xc8a577 });
    for (const [i, m] of [bark, cut].entries()) { m.onBeforeCompile = (sh) => withAtmosphere(sh, { weather: 0.8 }); m.customProgramCacheKey = () => `rawah-stump-${i}`; }
    const stump = new THREE.CylinderGeometry(0.24, 0.33, 0.5, 9, 1);
    stump.translate(0, 0.22, 0);
    this.stumpMesh = new THREE.InstancedMesh(stump, [bark, cut, bark], MAX_STUMPS);
    this.stumpMesh.count = 0; this.stumpMesh.frustumCulled = false; this.stumpMesh.castShadow = this.stumpMesh.receiveShadow = true;
    this.stumps = [];                  // x, e, z, s
    scene.add(this.stumpMesh);

    // wood chips
    const chip = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: false });
    chip.onBeforeCompile = (sh) => withAtmosphere(sh, { weather: 0 });
    chip.customProgramCacheKey = () => 'rawah-chip';
    this.chips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 0.012, 0.07), chip, CHIPS);
    this.chips.frustumCulled = false; this.chips.count = 0;
    this.chips.setColorAt(0, new THREE.Color());
    this.chipData = Array.from({ length: CHIPS }, () => ({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, rz: 0 }));
    this.chipCursor = 0;
    scene.add(this.chips);
  }

  // ------------------------------------------------------------------ tools
  setTool(kind) {
    this.tool = TOOLS.includes(kind) ? kind : 'fists';
    this.hiker.tool = this.tool;
    this.avatar.setTool?.(this.tool);
    for (const [k, t] of Object.entries(this.vmTools)) t.visible = k === this.tool;
  }

  cycleTool() {
    if (this.carry) { this.hud.toast('Put the stone down first.'); return; }
    this.setTool(TOOLS[(TOOLS.indexOf(this.tool) + 1) % TOOLS.length]);
    this.hud.toast(this.tool === 'mind' ? 'Telekinesis · [Click] lift · [R] sink · [E] level · [Wheel] size' : this.tool === 'fireworks' ? 'Fireworks · [Click] set one down · [R] light · [I] style' : `${TOOL_NAME[this.tool]}${this.tool === 'fists' ? '' : ' · [Click] to swing'}`);
  }

  /** A swing connected (the hiker's `strike` event with kind chop or slash). */
  strike(e) {
    const p = this.hiker.pos, tool = this.tool;
    const rx = p.x + e.x * 0.7, rz = p.z + e.z * 0.7;
    const cut = this.#cutNear(rx, rz, 1.35);
    const found = cut ? { kind: cut.kind, x: cut.x, e: cut.e, z: cut.z, s: cut.s, r: cut.r, variant: cut.vi, cut } : this.flora.find(rx, rz, 1.35, [...TREES, ...BRUSH]);
    if (!found) {
      if (tool === 'axe' && this.wood?.strike(e, this.hiker)) return;   // sawing a lying trunk into firewood
      this.audio.chop?.(false);
      return;
    }
    const small = BRUSH.includes(found.kind) || found.s < SAPLING;
    const key = itemKey(found.kind, found.x, found.z);
    // swings to bring it down: six with an axe on any mature tree, a machete a long afternoon
    const hp = small ? (BRUSH.includes(found.kind) ? 3 : 1.6) : TREE_HITS;
    const power = tool === 'axe' ? 1 : small ? 1.25 : 0.28;
    const taken = (this.damage.get(key) || 0) + power;
    this.damage.set(key, taken);
    const hx = found.x - e.x * 0.3, hz = found.z - e.z * 0.3;
    this.#burst(hx, found.e + (small ? 0.5 : 1.15), hz, -e.x, -e.z, small ? 5 : 8);
    this.audio.chop?.(true, small);
    this.rig.land(0.5);
    let rec = null;
    if (!small) {
      rec = found.cut || this.#startCut(found, p);
      rec.taken = taken;
      this.#carve(rec);
    }
    if (taken < hp) {
      if (!small && taken > hp * 0.8 && !this.told.has(key)) { this.told.add(key); this.hud.toast('It is starting to lean — stand clear.'); }
      return;
    }
    this.damage.delete(key);
    if (small) {
      this.flora.take(found);
      this.#burst(found.x, found.e + 0.5, found.z, 0, 0, 10);
      return;
    }
    this.#fell(rec, found.x - p.x, found.z - p.z);
    this.hud.toast(`Timber! A ${NAME[found.kind]}.`);
  }

  // ------------------------------------------------------------------ cutting a standing tree
  // The first stroke takes the tree out of the forest (`flora.take`) and puts a one-instance copy of it
  // in its place, with a finer trunk (`carvedTree`) that every stroke cuts a little deeper: three
  // strokes into a wedge on your right, three into one on your left. When it falls, this same mesh falls.

  /** The tree being cut within `reach` of (x, z), if any. */
  #cutNear(x, z, reach) {
    for (const c of this.cutting.values()) if (Math.hypot(c.x - x, c.z - z) < reach) return c;
    return null;
  }

  #startCut(h, from) {
    this.flora.take(h);
    return this.#makeCut(h.kind, h.variant, h.x, h.e, h.z, h.s, h.r, 0, null, from);
  }

  /** `sides`: [rightX, rightZ, leftX, leftZ], the world directions the two wedges face, or null to work them out from where `from` stands. */
  #makeCut(kind, vi, x, e, z, s, r, taken, sides, from) {
    const shade = 0.82 + r * 0.3;
    const { mesh } = this.flora.treeMesh(kind, vi, shade);
    mesh.setMatrixAt(0, _m.compose(_p.set(x, e - 0.15, z), _q.setFromAxisAngle(Y, r * Math.PI * 2), _s.setScalar(s)));
    this.scene.add(mesh);
    if (!sides) {
      // the two wedges face you, 75 degrees either side of straight on: the cuts on the left and right of the trunk as you see it
      let ux = from.x - x, uz = from.z - z;
      const l = Math.hypot(ux, uz) || 1;
      ux /= l; uz /= l;
      const rx = Math.cos(this.hiker.yaw), rz = -Math.sin(this.hiker.yaw), c = Math.cos(1.31), sn = Math.sin(1.31);
      sides = [ux * c + rx * sn, uz * c + rz * sn, ux * c - rx * sn, uz * c - rz * sn];
    }
    const rec = { key: itemKey(kind, x, z), kind, vi, x, e, z, s, r, taken, sides, mesh, geo: null };
    this.cutting.set(rec.key, rec);
    return rec;
  }

  /** The two wedges as deep as the strokes so far, in the tree geometry's own units. Both floors share one height: where it will break. */
  #notches(rec) {
    const T = this.flora.meshes[rec.kind][rec.vi].geometry.userData.trunk;
    const u = clamp(rec.taken / TREE_HITS, 0, 1), rot = rec.r * Math.PI * 2, co = Math.cos(rot), si = Math.sin(rot);
    const notch = (dx, dz, f) => {
      const y0 = CUT_H / rec.s, R0 = T.r0 + (T.r1 - T.r0) * (y0 / T.h);
      // world direction to the geometry's own: the instance is turned by `rot` about Y
      const lx = dx * co - dz * si, lz = dx * si + dz * co;
      return { ang: Math.atan2(lz, lx), D: f > 0 ? R0 * (0.15 + 0.4 * f) : 0, y0, slope: 1.05 };
    };
    return [notch(rec.sides[0], rec.sides[1], clamp(u * 2, 0, 1)), notch(rec.sides[2], rec.sides[3], clamp((u - 0.5) * 2, 0, 1))];
  }

  /** Rebuild the trunk with the wedges as deep as the strokes so far. */
  #carve(rec) {
    const src = this.flora.meshes[rec.kind][rec.vi].geometry;
    if (!src.userData.trunk) return;
    const g = carvedTree(src, this.#notches(rec));
    if (!g) return;
    rec.mesh.geometry = g;
    rec.geo?.dispose();
    rec.geo = g;
  }

  /** The cut is through: the trunk below it stays as a stump with a flat top; everything above falls from the notches. */
  #fell(rec, dx, dz) {
    this.cutting.delete(rec.key);
    const { kind, vi, x, e, z, s, r } = rec, src = this.flora.meshes[kind][vi].geometry;
    const notches = this.#notches(rec);
    const log = carvedTree(src, notches, 'log');
    let mesh = rec.mesh, geo = rec.geo;
    if (log) { mesh.geometry = log; geo?.dispose(); geo = log; this.#makeStump(kind, vi, x, e, z, s, r, rec.sides); }
    else this.#stump(x, e, z, s);
    const shade = 0.82 + r * 0.3, height = src.boundingBox.max.y;
    const a = Math.atan2(dz, dx) + (Math.random() - 0.5) * 0.5, lift = log ? CUT_H : 0;
    this.falling.push({ mesh, geo, kind, vi, x, y: e - 0.15, lift, z, s, r, shade, yaw: a, t: 0, dur: clamp(1.7 + height * s * 0.055, 2.1, 3.4), H: height * s - lift });
  }

  /** The stump a felled tree leaves: its own trunk to the height of the cut, flat and pale on top. */
  #makeStump(kind, vi, x, e, z, s, r, sides) {
    const rec = { kind, vi, x, e, z, s, r, sides, taken: TREE_HITS };
    const g = carvedTree(this.flora.meshes[kind][vi].geometry, this.#notches(rec), 'stump');
    if (!g) return;
    const { mesh } = this.flora.treeMesh(kind, vi, 0.82 + r * 0.3);
    mesh.geometry = g;
    mesh.setMatrixAt(0, _m.compose(_p.set(x, e - 0.15, z), _q.setFromAxisAngle(Y, r * Math.PI * 2), _s.setScalar(s)));
    this.scene.add(mesh);
    rec.mesh = mesh; rec.geo = g;
    this.cutStumps.push(rec);
    if (this.cutStumps.length > MAX_CUT_STUMPS) { const old = this.cutStumps.shift(); old.mesh.parent?.remove(old.mesh); old.mesh.dispose(); old.geo.dispose(); }
  }

  /** A lying tree that has been sawn up: take it away (its stump stays). */
  dropLying(f) {
    f.mesh.parent?.remove(f.mesh); f.mesh.dispose?.(); f.geo?.dispose();
    const i = this.lying.indexOf(f);
    if (i >= 0) this.lying.splice(i, 1);
  }

  #stump(x, e, z, s) {
    if (this.stumps.length >= MAX_STUMPS * 4) this.stumps.splice(0, 4);
    this.stumps.push(x, e, z, s);
    this.#writeStumps();
  }

  #writeStumps() {
    const n = this.stumps.length / 4;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      _m.compose(_p.set(this.stumps[k], this.stumps[k + 1], this.stumps[k + 2]), _q.identity(), _s.setScalar(this.stumps[k + 3]));
      this.stumpMesh.setMatrixAt(i, _m);
    }
    this.stumpMesh.count = n;
    this.stumpMesh.instanceMatrix.needsUpdate = true;
  }

  /** Where a tree of this fall is, lying or part-way down, as a matrix on its mesh. */
  #poseTree(f, theta) {
    // the tree falls toward (cos yaw, sin yaw) in (x, z); the axis that tips +Y toward that is Y x dir = (dz, 0, -dx)
    _axis.set(Math.sin(f.yaw), 0, -Math.cos(f.yaw));
    _q.setFromAxisAngle(_axis, theta);
    _q2.setFromAxisAngle(Y, f.r * Math.PI * 2);
    _q.multiply(_q2);
    // a log that broke at `lift` metres starts on its stump and slides down as it tips
    f.mesh.setMatrixAt(0, _m.compose(_p.set(f.x, f.y + 0.3 * Math.sin(theta) + (f.lift || 0) * Math.cos(theta), f.z), _q, _s.setScalar(f.s)));
    f.mesh.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------------ stones
  /** `E`: drop what you carry, or lift a small stone in front of you. Returns true if it used the press. */
  interact() {
    const h = this.hiker, p = h.pos, fx = -Math.sin(h.yaw), fz = -Math.cos(h.yaw);
    if (this.carry) {
      this.#drop(p.x + fx * 1.0, p.z + fz * 1.0, p.y + 0.7, 0, 0, 0, false);
      this.audio.thud(false);
      return true;
    }
    if (h.mode !== 'walk' || !h.grounded || h.action) return false;
    const stone = this.#nearStone(p.x + fx * 0.9, p.z + fz * 0.9, 1.3);
    if (!stone) return false;
    this.#lift(stone);
    return true;
  }

  /** The loose stone or placed stone you could pick up near (x, z). */
  #nearStone(x, z, reach) {
    let best = null, bd = reach;
    for (const r of this.rocks) {
      const d = Math.hypot(r.x - x, r.z - z);
      if (d < bd && r.s < CARRY_MAX && !r.air) { bd = d; best = { loose: r }; }
    }
    // a rock stacked on another is part of its formation, not a stone
    const placed = this.flora.find(x, z, bd, ['boulder', 'slab'], (kind, s, y, px, pz) => s < CARRY_MAX && this.flora.restY(kind, px, pz, s, y) !== null);
    return placed ? { placed } : best;
  }

  #lift(stone) {
    let kind, vi, s, r;
    if (stone.loose) {
      const l = stone.loose;
      ({ kind, vi, s, r } = l);
      this.#remove(l);
    } else {
      const h = stone.placed;
      ({ kind, variant: vi, s, r } = h);
      this.flora.take(h);
    }
    const { geometry, material } = this.flora.rockParts(kind, vi);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    rockPose(kind, s, r, mesh.quaternion, mesh.scale);
    this.carry = { kind, vi, s, r, mesh };
    this.hiker.load = 1;
    this.#showCarry();
    this.audio.thud(false);
    if (!this.told.has('carry')) { this.told.add('carry'); this.hud.toast('[E] put it down · [Click] throw it'); }
  }

  /** The carried stone is a scene object in third person, and a camera child in first. */
  #showCarry() {
    const c = this.carry;
    if (!c) return;
    const first = this.rig.mode === 'first';
    const want = first ? this.vmRock : this.scene;
    if (c.mesh.parent !== want) want.add(c.mesh);
    if (first) c.mesh.position.set(0, -0.38, -0.7);
  }

  #drop(x, z, y, vx, vz, vy, air) {
    const c = this.carry;
    c.mesh.parent?.remove(c.mesh);
    this.carry = null;
    this.hiker.load = 0;
    this.#spawn(c.kind, c.vi, x, y, z, c.s, c.r, vx, vz, vy, air);
  }

  /** Left click with a stone in hand. */
  throwStone() {
    const c = this.carry, h = this.hiker, p = h.pos;
    if (!c) return false;
    const cp = Math.cos(h.pitch), speed = 9;
    const dx = -Math.sin(h.yaw) * cp, dz = -Math.cos(h.yaw) * cp, dy = Math.sin(h.pitch);
    this.#drop(p.x + dx * 0.7, p.z + dz * 0.7, p.y + 1.45, dx * speed, dz * speed, dy * speed + 1.5, true);
    this.audio.thud(false);
    h.stamina = Math.max(0, h.stamina - 2);
    return true;
  }

  #spawn(kind, vi, x, y, z, s, r, vx = 0, vz = 0, vy = 0, air = false) {
    const { geometry, material } = this.flora.rockParts(kind, vi);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    rockPose(kind, s, r, mesh.quaternion, mesh.scale);
    this.scene.add(mesh);
    const rock = { kind, vi, x, y, z, s, r, vx, vz, vy, air, mesh };
    if (!air) rock.y = this.#groundY(rock);
    mesh.position.set(rock.x, rock.y, rock.z);
    this.rocks.push(rock);
    if (this.rocks.length > MAX_ROCKS) this.#remove(this.rocks[0]);
    return rock;
  }

  #remove(rock) {
    rock.mesh.parent?.remove(rock.mesh);
    const i = this.rocks.indexOf(rock);
    if (i >= 0) this.rocks.splice(i, 1);
  }

  /** Height a rock of this size rests at: sunk in by the slope, as when it was placed. */
  #groundY(r) {
    const g = this.world.gradient(r.x, r.z, this._g || (this._g = { x: 0, z: 0 }));
    return this.world.height(r.x, r.z) + (BOT[r.kind] - 0.1 - Math.min(1.1, Math.hypot(g.x, g.z)) * 0.4) * r.s;
  }

  /** Shoving: called from Flora.collide with the hiker's circle. The rock gives way at a pace set by its weight; what it won't give you feel as being held up. */
  collide(p, r, feetY = p.y) {
    if (p !== this.hiker.pos) return -Infinity;
    let ground = this.#lying(p, r, feetY);
    for (const k of this.rocks) {
      if (k.air || k.s < PUSH_MIN) continue;
      const dx = k.x - p.x, dz = k.z - p.z, rr = FOOT[k.kind] * k.s * 0.9 + r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 1e-3, over = rr - d, nx = dx / d, nz = dz / d;
      const pace = clamp(2.1 / (1 + k.s * k.s * 1.7), 0.45, 1.7);   // m/s the rock can be shoved at
      const move = Math.min(over, pace * this.dt);
      k.x += nx * move; k.z += nz * move;
      p.x -= nx * (over - move); p.z -= nz * (over - move);
      // held up: you move at the rock's pace, not your own
      const v = this.hiker.vel, into = v.x * nx + v.z * nz;
      if (into > pace) { v.x -= nx * (into - pace); v.z -= nz * (into - pace); }
      k.dirty = true;
      this.pushT = 0.25;
    }
    return ground;
  }

  /** A felled trunk is a wall as high as it is thick, tapering to the crown: step up onto it, or go round. Returns the height stood on, or -Infinity. */
  #lying(p, r, feetY) {
    let ground = -Infinity;
    for (const f of this.lying) {
      const dx = Math.cos(f.yaw), dz = Math.sin(f.yaw), len = f.H * Math.sin(REST);
      const px = p.x - f.x, pz = p.z - f.z;
      const t = clamp((px * dx + pz * dz) / len, 0, 1);
      const cx = f.x + dx * len * t, cz = f.z + dz * len * t;
      const ox = p.x - cx, oz = p.z - cz, d = Math.hypot(ox, oz);
      const rad = (0.34 * (1 - t * 0.75) + 0.08) * f.s + r;
      if (d >= rad) continue;
      const top = f.y + 0.3 * Math.sin(REST) + t * f.H * Math.cos(REST) + (0.34 * (1 - t * 0.75) + 0.08) * f.s;
      if (feetY > top - 0.45) { ground = Math.max(ground, top); continue; }
      const n = d || 1e-3;
      p.x = cx + (ox / n || 1) * rad; p.z = cz + (oz / n) * rad;
    }
    return ground;
  }

  /** A tree coming down catches anyone standing under it as it sweeps past. */
  #crush(f, theta) {
    const h = this.hiker, p = h.pos;
    if (f.hit || h.mode !== 'walk') return;
    const dx = Math.cos(f.yaw), dz = Math.sin(f.yaw), len = f.H * Math.sin(theta);
    const t = clamp(((p.x - f.x) * dx + (p.z - f.z) * dz) / Math.max(len, 0.1), 0, 1);
    const d = Math.hypot(p.x - (f.x + dx * len * t), p.z - (f.z + dz * len * t));
    const at = f.y + t * f.H * Math.cos(theta);
    if (d < 0.5 + 1.4 * t && at < p.y + 1.9 && at > p.y - 0.3 && t > 0.15) {
      f.hit = true;
      h.receiveHit('head', { x: f.x, z: f.z });
      h.injured = Math.max(h.injured, 25);
      h.stamina = Math.max(0, h.stamina - 25);
      this.audio.thud(true);
      this.hud.toast('The tree caught you. Next time, stand clear.', 'warn');
    }
  }

  // ------------------------------------------------------------------ per frame
  update(dt, live) {
    this.dt = clamp(dt, 1 / 240, 0.05);
    const h = this.hiker;
    this.#chips(dt);
    this.#trees(dt);
    this.#rocks(dt);
    this.pushT = Math.max(0, this.pushT - dt);
    h.pushing = this.pushT > 0;
    this.#carried();
    this.#viewmodel(dt);
    if (!live) return;
    this.tick += dt;
    if (this.tick > 0.1) { this.tick = 0; this.#free(); this.#hint(); }
  }

  /** Ground under this area was reshaped: loose rocks drop onto it or ride up; stumps and the trees lying beside them follow. */
  settle({ x0, z0, x1, z1 }) {
    for (const k of this.rocks) {
      if (k.x < x0 || k.x > x1 || k.z < z0 || k.z > z1) continue;
      if (k.y > this.#groundY(k) + 0.05) k.air = true; else k.dirty = true;
    }
    let moved = false;
    for (let i = 0; i < this.stumps.length; i += 4) {
      const x = this.stumps[i], z = this.stumps[i + 2];
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      const e = this.world.height(x, z), d = e - this.stumps[i + 1];
      if (Math.abs(d) < 0.01) continue;
      this.stumps[i + 1] = e; moved = true;
      for (const f of [...this.falling, ...this.lying]) {
        if (Math.abs(f.x - x) > 0.05 || Math.abs(f.z - z) > 0.05) continue;
        f.y += d;
        if (f.t >= f.dur) this.#poseTree(f, REST);
      }
    }
    if (moved) this.#writeStumps();
  }

  /** Walking up to a pushable boulder works it loose from the ground. */
  #free() {
    const p = this.hiker.pos;
    for (let n = 0; n < 3; n++) {
      // a rock stacked on another is part of its formation: it stays
      const h = this.flora.find(p.x, p.z, 3.2, ['boulder', 'slab'], (kind, s, y, x, z) => s >= CARRY_MAX && s <= PUSH_MAX && this.flora.restY(kind, x, z, s, y) !== null);
      if (!h) return;
      this.flora.take(h);
      this.#spawn(h.kind, h.variant, h.x, 0, h.z, h.s, h.r);
    }
  }

  #hint() {
    const h = this.hiker, p = h.pos, fx = -Math.sin(h.yaw), fz = -Math.cos(h.yaw);
    let hint = '';
    if (this.carry) hint = '[E] put down · [Click] throw';
    else if (h.mode === 'walk' && h.grounded) {
      if (this.#nearStone(p.x + fx * 0.9, p.z + fz * 0.9, 1.3)) hint = '[E] pick up';
      else if ((this.tool === 'axe' || this.tool === 'machete') && (this.#cutNear(p.x + fx * 0.7, p.z + fz * 0.7, 1.35) || this.flora.find(p.x + fx * 0.7, p.z + fz * 0.7, 1.35, [...TREES, ...BRUSH]))) hint = '[Click] chop';
    }
    this.hint = hint;
  }

  #carried() {
    const c = this.carry;
    if (!c) return;
    this.#showCarry();
    if (this.rig.mode === 'first') return;
    const a = this.avatar.heading, p = this.hiker.pos;
    c.mesh.position.set(p.x - Math.sin(a) * 0.42, p.y + 1.05, p.z - Math.cos(a) * 0.42);
  }

  #rocks(dt) {
    const eye = this.camera.position;
    for (const k of this.rocks) {
      const moving = k.air || k.dirty || Math.abs(k.vx) + Math.abs(k.vz) > 0.02;
      if (moving) {
        if (k.air) {
          k.vy -= GRAVITY * dt;
          k.y += k.vy * dt;
        }
        k.x += k.vx * dt; k.z += k.vz * dt;
        const ground = this.#groundY(k);
        if (k.air && k.y <= ground) {
          k.y = ground;
          if (k.vy < -2.5) { k.vy = -k.vy * 0.25; k.vx *= 0.55; k.vz *= 0.55; this.audio.thud(k.s > 0.35); }
          else { k.air = false; k.vy = 0; }
        } else if (!k.air) {
          const f = Math.exp(-6 * dt);
          k.vx *= f; k.vz *= f;
          k.y = ground;
        }
        k.dirty = false;
        k.mesh.position.set(k.x, k.y, k.z);
      }
      k.mesh.visible = Math.abs(k.x - eye.x) < 500 && Math.abs(k.z - eye.z) < 500;
    }
  }

  #trees(dt) {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      f.t += dt;
      const u = Math.min(1, f.t / f.dur);
      // slow at first, then gathering: the last quarter is the crash
      const theta = REST * Math.pow(u, 2.4);
      this.#poseTree(f, theta);
      if (u > 0.4) this.#crush(f, theta);
      if (u >= 1) {
        const near = Math.hypot(this.camera.position.x - f.x, this.camera.position.z - f.z);
        this.audio.thud(true);
        if (near < f.H * 1.6 + 25) this.rig.land(clamp(6 - near / 12, 1, 5));
        const tip = [f.x + Math.cos(f.yaw) * f.H * 0.9, f.z + Math.sin(f.yaw) * f.H * 0.9];
        this.#burst(tip[0], this.world.height(tip[0], tip[1]) + 0.3, tip[1], 0, 0, 14);
        this.falling.splice(i, 1);
        this.lying.push(f);
        if (this.lying.length > MAX_LYING) { const old = this.lying.shift(); old.mesh.parent?.remove(old.mesh); old.mesh.dispose(); old.geo?.dispose(); }
      }
    }
  }

  /** Somebody else's swing connected at (x, y, z): chips and a knock, for the friends chopping. */
  swingFx(x, y, z, nx, nz) {
    this.#burst(x, y, z, nx, nz, 7);
    if (Math.hypot(x - this.camera.position.x, z - this.camera.position.z) < 45) this.audio.chop(true);
  }

  // ------------------------------------------------------------------ chips
  #burst(x, y, z, nx, nz, n) {
    for (let i = 0; i < n; i++) {
      const c = this.chipData[this.chipCursor];
      this.chipCursor = (this.chipCursor + 1) % CHIPS;
      c.life = 0.7 + Math.random() * 0.6;
      c.x = x + (Math.random() - 0.5) * 0.2; c.y = y + (Math.random() - 0.5) * 0.2; c.z = z + (Math.random() - 0.5) * 0.2;
      c.vx = nx * (1 + Math.random() * 2) + (Math.random() - 0.5) * 2.6; c.vz = nz * (1 + Math.random() * 2) + (Math.random() - 0.5) * 2.6;
      c.vy = 1.2 + Math.random() * 2.4;
      c.rx = Math.random() * 6; c.rz = Math.random() * 6;
    }
  }

  #chips(dt) {
    let n = 0;
    const col = new THREE.Color();
    for (const c of this.chipData) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vy -= GRAVITY * 0.6 * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;
      const ground = this.world.height(c.x, c.z) + 0.02;
      if (c.y < ground) { c.y = ground; c.vx *= 0.3; c.vz *= 0.3; c.vy = 0; }
      _e.set(0, c.rx, c.rz);
      this.chips.setMatrixAt(n, _m.compose(_p.set(c.x, c.y, c.z), _q.setFromEuler(_e), _s.setScalar(Math.min(1, c.life * 3))));
      this.chips.setColorAt(n, col.setHex(n % 3 ? 0xd9b27c : 0x7a5632));
      n++;
    }
    this.chips.count = n;
    this.chips.instanceMatrix.needsUpdate = true;
    if (this.chips.instanceColor) this.chips.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------------ first-person tool
  #viewmodel(dt) {
    const first = this.rig.mode === 'first', tool = this.tool;
    this.vm.visible = first && (tool === 'axe' || tool === 'machete' || tool === 'fireworks');
    this.vmRock.visible = first;
    if (!this.vm.visible) return;
    const a = this.hiker.action;
    if (tool === 'axe' && a && a.kind === 'chop' && a.id !== this.vmAction) {
      // felling a standing tree swings sideways, from the right for the first three strokes and from the left for the rest;
      // sawing a lying trunk is the overhead chop
      this.vmAction = a.id;
      const p = this.hiker.pos, rx = p.x - Math.sin(this.hiker.yaw) * 0.7, rz = p.z - Math.cos(this.hiker.yaw) * 0.7;
      const cut = this.#cutNear(rx, rz, 1.35), tree = cut || this.flora.find(rx, rz, 1.35, TREES, (k, sc) => sc >= SAPLING);
      const taken = cut ? cut.taken : tree ? this.damage.get(itemKey(tree.kind, tree.x, tree.z)) || 0 : 0;
      this.vmSide = !tree ? 'axe' : taken >= TREE_HITS / 2 ? 'axeL' : 'axeR';
    }
    const set = VM[tool === 'axe' && a?.kind === 'chop' ? this.vmSide || 'axeR' : tool];
    let from = set.rest, to = set.rest, u = 0;
    if (a && (a.kind === 'chop' || a.kind === 'slash')) {
      const p = a.t / a.dur, hit = a.hits[0] / a.dur, back = hit * 0.62;
      if (p < back) { from = set.rest; to = set.back; u = sm(0, back, p); }
      else if (p < hit) { from = set.back; to = set.hit; u = sm(back, hit, p) ** 0.7; }
      else { from = set.hit; to = set.rest; u = sm(hit, 1, p); }
    }
    const t = this.vm, k = (i) => from[i] + (to[i] - from[i]) * u;
    // a little sway so it is not nailed to the screen
    const sway = Math.sin(this.hiker.phase) * 0.006 * this.hiker.moving;
    t.position.set(k(0) + sway, k(1) - Math.abs(sway), k(2));
    if (set === VM.axeR || set === VM.axeL) {
      // the level swing passes through a straight-up pitch where Euler angles jump, so turn between poses as quaternions
      _q.setFromEuler(_e.set(from[3], from[4], from[5], 'YXZ'));
      _q2.setFromEuler(_e.set(to[3], to[4], to[5], 'YXZ'));
      t.quaternion.copy(_q).slerp(_q2, u);
    } else t.rotation.set(k(3), k(4), k(5), 'YXZ');
  }

  // ------------------------------------------------------------------ save
  save() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      tool: this.tool,
      removed: [...this.flora.removed].slice(-4000),
      stumps: this.stumps.map(r2),
      lying: this.lying.map((f) => [f.kind, f.vi, r2(f.x), r2(f.y), r2(f.z), r2(f.s), r2(f.r), r2(f.yaw), r2(f.shade)]),
      rocks: this.rocks.map((k) => [k.kind, k.vi, r2(k.x), r2(k.z), r2(k.s), r2(k.r)]),
      carry: this.carry ? [this.carry.kind, this.carry.vi, this.carry.s, this.carry.r] : null,
      stumpCuts: this.cutStumps.map((c) => [c.kind, c.vi, r2(c.x), r2(c.e), r2(c.z), r2(c.s), r2(c.r), ...c.sides.map(r2)]),
      cuts: [...this.cutting.values()].map((c) => [c.kind, c.vi, r2(c.x), r2(c.e), r2(c.z), r2(c.s), r2(c.r), c.taken, ...c.sides.map(r2)]),
    };
  }

  load(d) {
    this.reset(false);
    if (!d) return;
    for (const k of d.removed || []) this.flora.removed.add(k);
    this.flora.sweep();
    this.stumps = d.stumps || [];
    this.#writeStumps();
    for (const [kind, vi, x, y, z, s, r, yaw, shade] of d.lying || []) {
      if (!this.flora.meshes[kind]?.[vi]) continue;
      const { mesh, height } = this.flora.treeMesh(kind, vi, shade);
      this.scene.add(mesh);
      const f = { mesh, kind, vi, x, y, z, s, r, yaw, shade, t: 99, dur: 1, H: height * s };
      this.#poseTree(f, REST);
      this.lying.push(f);
    }
    for (const [kind, vi, x, e, z, s, r, ...sides] of d.stumpCuts || []) if (this.flora.meshes[kind]?.[vi]) this.#makeStump(kind, vi, x, e, z, s, r, sides);
    for (const [kind, vi, x, e, z, s, r, taken, ...sides] of d.cuts || []) {
      if (!this.flora.meshes[kind]?.[vi]) continue;
      this.damage.set(itemKey(kind, x, z), taken);
      this.#carve(this.#makeCut(kind, vi, x, e, z, s, r, taken, sides));
    }
    for (const [kind, vi, x, z, s, r] of d.rocks || []) if (this.flora.meshes[kind]?.[vi]) this.#spawn(kind, vi, x, 0, z, s, r);
    if (d.carry && this.flora.meshes[d.carry[0]]?.[d.carry[1]]) {
      const [kind, vi, s, r] = d.carry;
      const { geometry, material } = this.flora.rockParts(kind, vi);
      const mesh = new THREE.Mesh(geometry, material);
      rockPose(kind, s, r, mesh.quaternion, mesh.scale);
      this.carry = { kind, vi, s, r, mesh };
      this.hiker.load = 1;
    }
    this.setTool(d.tool);
  }

  /** Put everything back (a new game): the world is rebuilt from placement data. */
  reset(rebuild = true) {
    for (const f of [...this.falling, ...this.lying]) { f.mesh.parent?.remove(f.mesh); f.mesh.dispose(); f.geo?.dispose(); }
    this.falling = []; this.lying = [];
    for (const k of [...this.rocks]) this.#remove(k);
    if (this.carry) { this.carry.mesh.parent?.remove(this.carry.mesh); this.carry = null; }
    this.hiker.load = 0;
    this.stumps = []; this.#writeStumps();
    for (const c of this.cutting.values()) { c.mesh.parent?.remove(c.mesh); c.mesh.dispose(); c.geo?.dispose(); }
    this.cutting.clear();
    for (const c of this.cutStumps) { c.mesh.parent?.remove(c.mesh); c.mesh.dispose(); c.geo.dispose(); }
    this.cutStumps = [];
    this.damage.clear(); this.told.clear();
    if (rebuild) { this.flora.removed.clear(); this.flora.tiles.clear(); this.flora.dirty = true; }
    this.setTool('fists');
  }
}
