import * as THREE from 'three';
import { hash2, clamp } from './noise.js';
import { rng, buildSpecies, paintAtlas, foliageMaterial, foliageDepth, bakeImpostors, impostorGeometry, impostorMaterial, loadBark } from './trees.js';
import { rockGeometries, rockMaterial } from './rocks.js';
import { CULL, expandedFrustum, sphereInView } from './culling.js';

// Trees, burned snags, downed logs, krummholz, willows and rock around the
// hiker. Placement is a jittered grid driven by World.cover(), which reads the
// Sentinel-2 land cover, so live forest, the 2020 burn and the aspen groves
// grow where they really are. Square tiles hold placement data only; a few
// global instanced meshes are refilled as you move: card-built trees close
// up (trees.js), crossed-quad impostors out to the horizon of the forest.
//
// Species follow elevation and aspect: lodgepole on the lower and sunnier
// slopes, Engelmann spruce and subalpine fir above and down the cool
// north-facing and wet ground, thickets and clearings from a slow noise field,
// and a scatter of saplings underneath. Rock (rocks.js) comes as lone
// boulders, outcrops, tors on the high ground, talus fans under the steep
// rock, and the odd glacial erratic.

const TILE_M = 232;        // tile side in metres
const SPACING = 3.9;       // metres between placement candidates
const FORM = 5;            // rock formation cells per tile side
const REFILL_M = 14;       // move this far before refilling instances
const TREES = ['spruce', 'fir', 'lodgepole', 'aspen', 'snag', 'krumm', 'willow'];
const ROCKS = ['boulder', 'slab', 'tooth'];
const KINDS = [...TREES, ...ROCKS, 'log'];
const CAP = { spruce: 4000, fir: 4000, lodgepole: 3000, aspen: 2000, snag: 3000, krumm: 3000, willow: 1500, boulder: 5000, slab: 3000, tooth: 2000, log: 4000 };
const SAPLING = 0.4;       // scale under this is an understory sapling: only drawn close up, never an impostor, no trunk to bump
// per rock shape, in units of its scale: how far its base sits below the origin, how tall it stands, how wide its footprint
const BOT = { boulder: 0.4, slab: 0.1, tooth: 1.5 };
const TOP = { boulder: 0.65, slab: 0.3, tooth: 1.7 };
const FOOT = { boulder: 0.85, slab: 1.2, tooth: 0.5 };
const TILT = { boulder: 1, slab: 2.2, tooth: 0.5 };
const SEE = [[0.5, 70], [1, 150], [2, 280], [Infinity, 520]];   // [scale up to, metres you can see it from]
const ROCK_R = 240;        // boulders and logs inside this radius
// Culling. The buffers are refilled only when the view has turned ROT_REFILL or moved
// REFILL_M, so the frustum used to fill them is wider than the camera's by CULL.margin
// (culling.js), which must stay above ROT_REFILL.
const ROT_REFILL = 0.12;   // radians
const OCC_FROM = 120;      // impostors nearer than this are never tested against the skyline
const TALL = 30;           // tallest tree, for tile bounds
const LOW_SUN = 0.55;      // below this (33 degrees up) shadows run long, and down a slope they run on without end: keep every caster
const SHADOW_REACH = 170;  // longest shadow worth keeping a caster for (the shadow map reaches about this far)
// height and crown radius of each kind at scale 1, for shadow-aware culling
const DIM = { spruce: [18, 3.4], fir: [22, 3], lodgepole: [20, 3], aspen: [12, 3], snag: [19, 1.5], krumm: [3, 2], willow: [3, 2], boulder: [2.5, 2.5], slab: [2.5, 3], tooth: [4, 1.2], log: [1, 3.2] };

export { TREES, ROCKS, SAPLING, BOT, FOOT, TOP };
const fract = (v) => v - Math.floor(v);
/** Identity of a placed thing: placement is deterministic, so where it stands names it. */
export const itemKey = (kind, x, z) => `${kind}:${x.toFixed(2)}:${z.toFixed(2)}`;
/** The lean, yaw and squash every rock gets from its one random number. */
export function rockPose(kind, s, r, q = new THREE.Quaternion(), scale = new THREE.Vector3()) {
  const lean = 0.35 * TILT[kind];
  q.setFromEuler(_e.set((fract(r * 47.1) - 0.5) * lean, r * Math.PI * 2, (fract(r * 71.9) - 0.5) * lean, 'YXZ'));
  scale.set(s * (0.85 + fract(r * 13.7) * 0.5), s, s * (0.85 + fract(r * 29.3) * 0.5));
  return { q, scale };
}
const smoothstepFine = (v) => { const t = Math.min(1, Math.max(0, (v - 0.5) / 0.3)); return t * t * (3 - 2 * t); };
const rngFor = (i, j) => rng(Math.floor(hash2(i, j, 47) * 4294967295));
const _g = { x: 0, z: 0 };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export class Flora {
  constructor(world, scene, renderer, { card = 85, radius = 1250, thin = 700, impostor = 4096, cap = 240000 } = {}, leaves = 'autumn') {
    this.world = world;
    this.cardR = card;          // full trees inside this radius
    this.radius = radius;       // impostors out to here
    this.thin = thin;           // beyond this, every other impostor
    this.uniforms = { uTime: { value: 0 }, uCalm: { value: 0.6 }, uExt: { value: world.extent } };
    const atlas = paintAtlas(leaves);
    this.species = buildSpecies();
    const foliage = this.foliage = foliageMaterial(atlas, this.uniforms);
    const depth = foliageDepth(atlas, this.uniforms);
    this.impostors = bakeImpostors(renderer, this.species, foliage, impostor);   // baked with the painted bark: the real textures load after
    loadBark();

    this.group = new THREE.Group();
    scene.add(this.group);
    this.meshes = {};
    for (const kind of TREES) {
      this.meshes[kind] = this.species[kind].map((geo) => {
        const m = new THREE.InstancedMesh(geo, foliage, CAP[kind]);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.setColorAt(0, new THREE.Color());
        m.count = 0;
        m.frustumCulled = false;
        m.castShadow = kind !== 'willow';
        m.receiveShadow = true;
        m.customDepthMaterial = depth;
        this.group.add(m);
        return m;
      });
    }
    const rocks = rockGeometries(), stone = rockMaterial(this.world.extent);
    const log = new THREE.CylinderGeometry(0.16, 0.2, 6, 7, 1);
    log.rotateZ(Math.PI / 2);
    const wood = new THREE.MeshLambertMaterial({ color: 0x5d5650 });
    const make = (kind, geo, mat) => {
      const m = new THREE.InstancedMesh(geo, mat, CAP[kind]);
      m.setColorAt(0, new THREE.Color());
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      return m;
    };
    for (const kind of ROCKS) this.meshes[kind] = rocks[kind].map((geo) => make(kind, geo, stone));
    this.meshes.log = [make('log', log, wood)];
    this.impCap = cap;
    const ig = impostorGeometry(cap);
    this.imp = new THREE.InstancedMesh(ig, impostorMaterial(this.impostors.texture, this.uniforms), cap);
    this.imp.setColorAt(0, new THREE.Color());
    this.imp.count = 0;
    this.imp.frustumCulled = false;
    this.group.add(this.imp);

    this.removed = new Set();   // keys of trees and rocks that were felled, picked up or pushed loose
    this.props = null;          // props.js, which wants a say in who stands where
    this.depth = depth;
    this.tile = Math.max(8, Math.round(TILE_M / world.cell));
    this.nt = Math.ceil(world.N / this.tile);
    this.tiles = new Map();
    this.filledAt = new THREE.Vector3(Infinity, 0, 0);
    this.dirty = true;

    // view culling: set each frame by setView()
    this.camera = null;
    this.horizon = null;
    this.shadowDir = null;
    this.frustum = new THREE.Frustum();
    this.fill = { key: -1, dir: new THREE.Vector3(0, 0, -1), cam: new THREE.Vector3(Infinity, 0, 0), fov: 0, aspect: 0, horizon: -1, light: new THREE.Vector3(), shadows: false };
    this._dir = new THREE.Vector3();
    this.stats = { kept: 0, outside: 0, hidden: 0 };
  }

  /** The camera, the terrain skyline and the direction the light comes from (null when nothing casts a shadow). */
  setView(camera, horizon, shadowDir) {
    this.camera = camera;
    this.horizon = horizon;
    this.shadowDir = shadowDir;
  }

  #cullKey() {
    return (CULL.frustum && this.camera ? 1 : 0) + (CULL.occlusion && this.horizon?.active ? 2 : 0) + (this.shadowDir ? 4 : 0) + (this.shadowDir && this.shadowDir.y < LOW_SUN ? 8 : 0);
  }

  /** Has the view changed enough that the culled buffers no longer cover it? */
  #viewStale() {
    const f = this.fill, cam = this.camera;
    if (!cam) return false;
    const key = this.#cullKey();
    if (key !== f.key) return true;
    if (key & 1) {
      cam.getWorldDirection(this._dir);
      if (this._dir.angleTo(f.dir) > ROT_REFILL || Math.abs(cam.fov - f.fov) > 1 || cam.aspect !== f.aspect) return true;
      if (cam.position.distanceTo(f.cam) > REFILL_M) return true;
      if (key & 4 && this.shadowDir.angleTo(f.light) > 0.04) return true;
    }
    if (key & 2 && this.horizon.version !== f.horizon) return true;
    return false;
  }

  /** Ground under (x0..x1, z0..z1) was reshaped: forget the tiles there so trees and rocks are planted at the new height. */
  reground({ x0, z0, x1, z1 }) {
    const w = this.world, size = this.tile * w.cell;
    for (const key of [...this.tiles.keys()]) {
      const i = key % this.nt, j = Math.floor(key / this.nt);
      const tx = i * size - w.half, tz = j * size - w.half;
      if (tx <= x1 && tx + size >= x0 && tz <= z1 && tz + size >= z0) { this.tiles.delete(key); this.dirty = true; }
    }
  }

  tileKey(x, z) {
    const w = this.world;
    return [Math.floor((x + w.half) / (this.tile * w.cell)), Math.floor((z + w.half) / (this.tile * w.cell))];
  }

  /** Stream placement tiles in and out; refill instances when we've moved far enough. Returns tiles still pending. */
  update(pos, budget = 1, dt = 0) {
    this.uniforms.uTime.value += dt;
    const w = this.world, size = this.tile * w.cell;
    const want = new Set();
    const span = Math.ceil(this.radius / size) + 1;
    const [ti, tj] = this.tileKey(pos.x, pos.z);
    const todo = [];
    for (let j = tj - span; j <= tj + span; j++) {
      for (let i = ti - span; i <= ti + span; i++) {
        if (i < 0 || j < 0 || i >= this.nt || j >= this.nt) continue;
        const cx = (i + 0.5) * size - w.half, cz = (j + 0.5) * size - w.half;
        const d = Math.max(0, Math.hypot(cx - pos.x, cz - pos.z) - size * 0.71);
        if (d > this.radius) continue;
        const key = j * this.nt + i;
        want.add(key);
        if (!this.tiles.has(key)) todo.push([d, key, i, j]);
      }
    }
    for (const key of this.tiles.keys()) if (!want.has(key)) { this.tiles.delete(key); this.dirty = true; }
    todo.sort((a, b) => a[0] - b[0]);
    const n = Math.min(budget, todo.length);
    for (let k = 0; k < n; k++) {
      const [, key, i, j] = todo[k];
      this.tiles.set(key, this.#populate(i, j));
      this.dirty = true;
    }
    if (this.dirty || this.filledAt.distanceTo(pos) > REFILL_M || this.#viewStale()) this.#fill(pos);
    return todo.length - n;
  }

  #populate(ti, tj) {
    const w = this.world, size = this.tile * w.cell;
    const x0 = ti * size - w.half, z0 = tj * size - w.half;
    const n = Math.floor(size / SPACING);
    const items = Object.fromEntries(KINDS.map((k) => [k, []]));
    const solids = []; // x, z, radius, top
    let minY = Infinity, maxY = -Infinity;
    const blocks = []; // x, z, radius of the big rocks, so trees leave them room

    // water, trail and brook keep clear of whatever is placed
    const free = (x, z, e, margin) => {
      const lake = w.lakeAt(x, z);
      if (lake && e < lake.level + 0.7) return false;
      const near = w.nearestTrail(x, z);
      if (near.trail && near.d < near.trail.width / 2 + margin) return false;
      const brook = w.nearestStream(x, z);
      return !(brook.stream && brook.d < brook.stream.width / 2 + 1.5);
    };
    const inside = (x, z) => x >= x0 && x < x0 + size && z >= z0 && z < z0 + size;
    const crowded = (x, z, pad) => {
      for (let k = 0; k < blocks.length; k += 3) {
        const dx = x - blocks[k], dz = z - blocks[k + 1], rr = blocks[k + 2] + pad;
        if (dx * dx + dz * dz < rr * rr) return true;
      }
      return false;
    };

    /**
     * Set a rock of `kind` and scale `s` at x, z: on the ground sunk in by the
     * slope, or sitting on `base` (the top of the rock below). Returns the
     * top height so something can be stacked on it. Only what falls inside this
     * tile is kept, so neighbouring tiles can build the same formation.
     */
    const addRock = (kind, x, z, s, r, base = null) => {
      const e = w.height(x, z);
      let y;
      if (base === null) {
        const g = w.gradient(x, z, _g);
        y = e + (BOT[kind] - 0.1 - Math.min(1.1, Math.hypot(g.x, g.z)) * 0.4) * s;
      } else y = base + (BOT[kind] - 0.1) * s;
      if (s >= 0.9) blocks.push(x, z, FOOT[kind] * s);
      if (inside(x, z) && (base !== null || free(x, z, e, 1.2)) && !this.#gone(kind, x, z)) {
        items[kind].push(x, y, z, s, r);
        if (y < minY) minY = y;
        if (y + TOP[kind] * s > maxY) maxY = y + TOP[kind] * s;
        if (s >= 0.6) solids.push(x, z, FOOT[kind] * s * 0.9, y + TOP[kind] * s);
      }
      return y + TOP[kind] * s;
    };
    const rubble = (R, x, z, reach, count) => {
      for (let j = 0; j < count; j++) {
        const a = R() * Math.PI * 2, d = reach * (0.35 + R() * 0.65);
        addRock('boulder', x + Math.cos(a) * d, z + Math.sin(a) * d, 0.25 + R() * R() * 0.7, R());
      }
    };

    // formations: one candidate per cell, with the ring of neighbouring cells
    // so a fan or outcrop that straddles a tile edge is built the same on both sides
    const cs = size / FORM;
    for (let b = -1; b <= FORM; b++) {
      for (let a = -1; a <= FORM; a++) {
        const fi = ti * FORM + a, fj = tj * FORM + b;
        const h0 = hash2(fi, fj, 41), h1 = hash2(fi, fj, 42), h2 = hash2(fi, fj, 43), h3 = hash2(fi, fj, 44);
        const x = x0 + (a + 0.15 + h0 * 0.7) * cs, z = z0 + (b + 0.15 + h1 * 0.7) * cs;
        const e = w.height(x, z), cv = w.cover(x, z, e);
        const p = Math.max(cv.rock * 0.55 + cv.alpine * 0.1, 0.045 + cv.forest * 0.03);
        if (h2 > p) continue;
        const rock = cv.rock, alpine = cv.alpine, grade = cv.grade, k = 1 + rock * 0.6;
        const g = w.gradient(x, z, _g), gl = Math.hypot(g.x, g.z) || 1;
        const R = rngFor(fi, fj);
        if (rock > 0.3 && grade > 0.35 && h3 < 0.65) {
          // talus: a fan of broken rock spilling downhill, coarser at the foot
          const dx = gl > 0.02 ? -g.x / gl : 1, dz = gl > 0.02 ? -g.z / gl : 0;
          const count = 16 + Math.floor(R() * 18), len = 22 + R() * 30;
          for (let i = 0; i < count; i++) {
            const t = R(), lat = (R() - 0.5) * (4 + t * 14);
            addRock(R() < 0.2 ? 'slab' : 'boulder', x + dx * t * len - dz * lat, z + dz * t * len + dx * lat, (0.25 + R() * R() * 1.1) * (0.6 + t * 0.8), R());
          }
        } else if (alpine > 0.35 && h3 < 0.55) {
          // tor: weathered stacks of blocks, some with a capstone spike
          const cols = 2 + Math.floor(R() * 3);
          for (let c = 0; c < cols; c++) {
            const cx = x + (R() - 0.5) * 7, cz = z + (R() - 0.5) * 7;
            let s = (1.6 + R() * 1.6) * k, top = addRock('boulder', cx, cz, s, R());
            for (let l = 1 + Math.floor(R() * 2); l > 0; l--) {
              s *= 0.7;
              top = addRock(R() < 0.3 ? 'slab' : 'boulder', cx + (R() - 0.5) * 0.8, cz + (R() - 0.5) * 0.8, s, R(), top);
            }
            if (R() < 0.6) addRock('tooth', cx, cz, s * 0.8, R(), top);
          }
          rubble(R, x, z, 9, 8 + Math.floor(R() * 8));
        } else if (rock < 0.3 && h3 < 0.3) {
          // a lone glacial erratic
          const s = 2.2 + R() * 2.3;
          addRock('boulder', x, z, s, R());
          rubble(R, x, z, s * 1.5, 3 + Math.floor(R() * 4));
        } else {
          // outcrop: a ridge of blocks along a strike, biggest in the middle, some stacked
          const ang = R() * Math.PI * 2, count = 3 + Math.floor(R() * 5), len = 5 + R() * 12, big = (1.3 + R() * 2.4) * k;
          for (let i = 0; i < count; i++) {
            const u = i / (count - 1) - 0.5, along = u * len;
            const px = x + Math.cos(ang) * along + (R() - 0.5) * 2.5, pz = z + Math.sin(ang) * along + (R() - 0.5) * 2.5;
            const s = big * (1 - Math.abs(u) * 0.8) * (0.7 + R() * 0.6), roll = R();
            const top = addRock(roll < 0.6 ? 'boulder' : roll < 0.85 ? 'slab' : 'tooth', px, pz, s, R());
            if (s > 1.2 && R() < 0.55) addRock('boulder', px + (R() - 0.5) * s, pz + (R() - 0.5) * s, s * (0.4 + R() * 0.25), R(), top);
          }
          rubble(R, x, z, len * 0.5 + 2, 6 + Math.floor(big * 3));
        }
      }
    }

    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const gi = ti * n + a, gj = tj * n + b;
        const r1 = hash2(gi, gj, 1), r2 = hash2(gi, gj, 2), r3 = hash2(gi, gj, 3);
        const x = x0 + (a + r2) * SPACING, z = z0 + (b + r3) * SPACING;
        const e = w.height(x, z);
        const cv = w.cover(x, z, e);
        const dens = 0.45 + cv.fine * 1.1;     // thickets and openings, from a slow noise field
        let kind = null;
        const pf = cv.forest * 0.5 * dens, pa = cv.aspen * 0.45 * dens, ps = cv.snag * 0.34, pk = cv.krumm * 0.24;
        const brook = w.nearestStream(x, z);
        const wet = brook.stream ? brook.d - brook.stream.width / 2 : Infinity;
        const forest = cv.forest, grade = cv.grade;
        // sunny slopes hold lodgepole higher; cool north-facing and wet ground drop into spruce-fir early
        const g = r1 < pa + pf && r1 >= pa ? w.gradient(x, z, _g) : null;
        const north = g && grade > 0.04 ? clamp(g.z / grade, -1, 1) : 0;
        if (r1 < pa) kind = 'aspen';
        else if (r1 < pa + pf) {
          const lodge = 2890 + hash2(gi, gj, 4) * 200 - north * 120 - (wet < 40 ? 150 : 0);
          kind = e < lodge ? 'lodgepole' : hash2(gi, gj, 8) < clamp((e - 3000) / 450, 0.15, 0.6) ? 'fir' : 'spruce';
        } else if (r1 < pa + pf + ps) kind = 'snag';
        else if (r1 < pa + pf + ps + pk) kind = 'krumm';
        else if (r1 > 1 - (cv.snag * 0.1 + forest * 0.025)) kind = 'log';
        else if (cv.meadow > 0.4 && grade < 0.25 && e < 3500 && r1 > 1 - (0.025 + 0.16 * smoothstepFine(cv.fine))) kind = 'willow';   // willow thickets in the meadows, thicker in patches
        else if (r1 > 1 - (cv.rock * 0.06 + cv.alpine * 0.006)) kind = 'boulder';
        const rock = cv.rock, tl = cv.treeline, fine = cv.fine;
        if (kind === 'boulder') {
          const roll = hash2(gi, gj, 12);
          addRock(roll < 0.8 ? 'boulder' : roll < 0.93 ? 'slab' : 'tooth', x, z, 0.35 + Math.pow(hash2(gi, gj, 5), 2.2) * (1 + rock * 1.4), hash2(gi, gj, 6));
          continue;
        }
        if (kind) {
          const lake = w.lakeAt(x, z);
          const near = w.nearestTrail(x, z);
          const bad = (lake && e < lake.level + 0.7)
            || (near.trail && near.d < near.trail.width / 2 + (kind === 'log' ? 1.2 : 2.2))
            || wet < 1.5
            || (kind !== 'log' && crowded(x, z, 0.8));
          if (!bad) {
            const s = kind === 'krumm' || kind === 'willow' ? 0.7 + hash2(gi, gj, 5) * 0.7
              : 0.62 + hash2(gi, gj, 5) * 0.55 - Math.max(0, e - tl + 120) / 450;
            if (s >= 0.35 && !this.#gone(kind, x, z)) {
              items[kind].push(x, e, z, s, hash2(gi, gj, 6));
              if (e < minY) minY = e;
              if (e > maxY) maxY = e;
              if (kind !== 'krumm' && kind !== 'willow' && kind !== 'log') solids.push(x, z, (kind === 'snag' ? 0.2 : 0.3) * s + 0.1, Infinity);
            }
          }
        }
        // understory: saplings among the live forest, drawn only up close
        if (forest > 0.15 && hash2(gi, gj, 9) < Math.min(0.9, forest * dens * 0.8)) {
          const sx = x0 + (a + r3) * SPACING, sz = z0 + (b + r2) * SPACING, se = w.height(sx, sz);
          if (free(sx, sz, se, 1) && !crowded(sx, sz, 0.5)) {
            const q = hash2(gi, gj, 10), sk = se < 3040 - fine * 80 ? 'lodgepole' : q < 0.55 ? 'fir' : 'spruce';
            if (!this.#gone(sk, sx, sz)) items[sk].push(sx, se, sz, 0.17 + hash2(gi, gj, 11) * 0.2, hash2(gi, gj, 13));
          }
        }
      }
    }
    if (minY > maxY) minY = maxY = w.baseHeight(x0 + size / 2, z0 + size / 2);
    return { ti, tj, items, solids: new Float32Array(solids), x0, z0, size, minY, maxY };
  }

  /** Refill every instanced mesh from the tiles in range, leaving out what the camera cannot see. */
  #fill(pos) {
    this.filledAt.copy(pos);
    this.dirty = false;
    const counts = new Map();
    const all = Object.values(this.meshes).flat();
    for (const m of all) counts.set(m, 0);
    let ni = 0;
    const imp = this.imp, im = imp.instanceMatrix.array, ic = imp.instanceColor.array, cell = imp.geometry.attributes.aCell.array;
    const cells = this.impostors.cells;
    const shade = (mesh, k, v) => {
      const c = mesh.instanceColor.array;
      c[k * 3] = v; c[k * 3 + 1] = v * 0.99; c[k * 3 + 2] = v * 0.96;
    };


    // what to cull against, remembered so #viewStale knows when it has gone out of date
    const f = this.fill, cam = this.camera, horizon = this.horizon;
    const key = f.key = this.#cullKey();
    const planes = key & 1 ? expandedFrustum(cam, CULL.margin, this.frustum).planes : null;
    const sky = key & 2 ? horizon : null;
    const sun = key & 4 ? this.shadowDir : null;
    if (cam) { cam.getWorldDirection(f.dir); f.cam.copy(cam.position); f.fov = cam.fov; f.aspect = cam.aspect; }
    f.horizon = horizon ? horizon.version : -1;
    if (sun) f.light.copy(sun);
    // a shadow falls away from the light: this much sideways per metre of height
    const sk = sun ? 1 / Math.max(sun.y, 0.05) : 0;
    const sx = sun ? -sun.x * sk : 0, sz = sun ? -sun.z * sk : 0;
    const keepCasters = !CULL.casters || !!(key & 8);
    const stats = this.stats;
    stats.kept = stats.outside = stats.hidden = 0;

    /** Could this caster, or the shadow it throws, be on screen? (centre, half-height, crown radius) */
    const casterSeen = (x, y, z, hh, R) => {
      if (!planes || keepCasters) return true;
      const r = hh + R + REFILL_M;
      if (sphereInView(planes, x, y + hh, z, r)) return true;
      if (!sun) return false;
      // the shadow of the crown runs out along the ground to here; look along it in four samples
      let h = hh * 2;
      const len = Math.hypot(sx, sz) * h;
      if (len > SHADOW_REACH) h *= SHADOW_REACH / len;
      const L = Math.hypot(sx, sz) * h * 0.125 + REFILL_M;
      for (let t = 0.125; t < 1.01; t += 0.25) if (sphereInView(planes, x + sx * h * t, y, z + sz * h * t, R + L)) return true;
      return false;
    };

    const put = (mesh, x, y, z, sx, sy, sz, rot, v) => {
      const k = counts.get(mesh);
      if (k >= mesh.instanceMatrix.count) return;
      counts.set(mesh, k + 1);
      writeMatrix(mesh.instanceMatrix.array, k, x, y, z, sx, sy, sz, rot);
      shade(mesh, k, v);
    };
    // rocks are squashed, yawed and leaned a little, each different, all from one number
    const putRock = (mesh, kind, x, y, z, s, r) => {
      const k = counts.get(mesh);
      if (k >= mesh.instanceMatrix.count) return;
      counts.set(mesh, k + 1);
      rockPose(kind, s, r, _q, _s);
      _m.compose(_p.set(x, y, z), _q, _s);
      _m.toArray(mesh.instanceMatrix.array, k * 16);
      shade(mesh, k, 0.9 + r * 0.2);
    };
    const rr = ROCK_R + REFILL_M;
    for (const tile of this.tiles.values()) {
      // whole-tile rejection: off screen (shadows included), or behind a ridge with nothing but far impostors in it
      if (planes || sky) {
        const cx = tile.x0 + tile.size / 2, cz = tile.z0 + tile.size / 2;
        const hy = (tile.maxY - tile.minY) / 2, cy = tile.minY + hy;
        // a sphere around the whole tile that holds every crown and shadow in it
        if (planes && !casterSeen(cx, cy, cz, hy + TALL / 2, tile.size * 0.71 + hy + 20)) { stats.outside++; continue; }
        // past the boulders and the full trees a tile holds nothing but impostors, which cast no shadow
        const near = Math.hypot(cx - pos.x, cz - pos.z) - tile.size * 0.71;
        if (sky && near > rr && sky.hiddenBox(tile.x0, tile.x0 + tile.size, tile.z0, tile.z0 + tile.size, tile.maxY + TALL)) { stats.hidden++; continue; }
      }
      for (const kind of KINDS) {
        const list = tile.items[kind];
        const variants = this.meshes[kind];
        const rocky = ROCKS.includes(kind);
        const [dh, dr] = DIM[kind];
        for (let k = 0; k < list.length; k += 5) {
          const x = list[k], e = list[k + 1], z = list[k + 2], s = list[k + 3], r = list[k + 4];
          const ex = x - pos.x, ez = z - pos.z, d = Math.sqrt(ex * ex + ez * ez);
          const rot = r * Math.PI * 2, v = 0.82 + r * 0.3;
          if (rocky) {
            let see = 520;
            for (const [m, dist] of SEE) if (s <= m) { see = dist; break; }
            if (d < see && casterSeen(x, e, z, dh * s * 0.5, dr * s)) { putRock(variants[Math.floor(fract(r * 5.77) * variants.length)], kind, x, e, z, s, r); stats.kept++; }
            continue;
          }
          if (kind === 'log') {
            if (d < 240 && casterSeen(x, e, z, 0.5 * s, dr)) put(variants[0], x, e + 0.12, z, 0.6 + s * 0.6, 1, 1, rot, v);
            continue;
          }
          const vi = Math.floor(fract(r * 7.31) * variants.length);
          if (s < SAPLING) { if (d < 55) put(variants[vi], x, e - 0.1, z, s, s, s, rot, v); continue; }
          if (d < this.cardR) {
            if (casterSeen(x, e, z, dh * s * 0.5, dr * s)) { put(variants[vi], x, e - 0.15, z, s, s, s, rot, v); stats.kept++; }
            else stats.outside++;
            continue;
          }
          // far forest thins out progressively; the fog hides the difference
          const keep = d < this.thin * 0.5 ? 1 : d < this.thin ? 0.7 : 0.4;
          if (d > this.radius || fract(r * 3.77) > keep || ni >= this.impCap) continue;
          const c = cells[kind][vi];
          if (planes && !sphereInView(planes, x, e + c.h * s * 0.5, z, c.h * s * 0.5 + REFILL_M)) { stats.outside++; continue; }
          if (sky && d > OCC_FROM && sky.hidden(x, e + c.h * s, z)) { stats.hidden++; continue; }
          writeMatrix(im, ni, x, e - 0.15, z, c.w * s, c.h * s, c.w * s, rot);
          ic[ni * 3] = v; ic[ni * 3 + 1] = v; ic[ni * 3 + 2] = v;
          cell[ni * 2] = c.u; cell[ni * 2 + 1] = c.v;
          ni++;
        }
      }
    }
    for (const m of all) {
      m.count = counts.get(m);
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }
    imp.count = ni;
    imp.instanceMatrix.needsUpdate = true;
    imp.instanceColor.needsUpdate = true;
    imp.geometry.attributes.aCell.needsUpdate = true;
  }

  #gone(kind, x, z) { return this.removed.size > 0 && this.removed.has(itemKey(kind, x, z)); }

  /**
   * The nearest placed thing of `kinds` whose centre is within `reach` of (x, z),
   * as a handle for `take`. `ok(kind, scale, y, x, z)` can rule candidates out.
   */
  find(x, z, reach, kinds, ok = null) {
    const w = this.world, size = this.tile * w.cell;
    const ci = Math.floor((x + w.half) / size), cj = Math.floor((z + w.half) / size);
    let best = null, bd = reach;
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        const tile = this.tiles.get(j * this.nt + i);
        if (!tile) continue;
        for (const kind of kinds) {
          const list = tile.items[kind], variants = this.meshes[kind].length;
          for (let k = 0; k < list.length; k += 5) {
            const d = Math.hypot(list[k] - x, list[k + 2] - z);
            if (d >= bd || (ok && !ok(kind, list[k + 3], list[k + 1], list[k], list[k + 2]))) continue;
            const r = list[k + 4];
            bd = d;
            best = { tile, kind, k, x: list[k], e: list[k + 1], z: list[k + 2], s: list[k + 3], r, d, variant: Math.floor(fract(r * (ROCKS.includes(kind) ? 5.77 : 7.31)) * variants) };
          }
        }
      }
    }
    return best;
  }

  /** Remove a thing `find` returned from the world for good (it is remembered in `removed`). */
  take(h) {
    h.tile.items[h.kind].splice(h.k, 5);
    this.removed.add(itemKey(h.kind, h.x, h.z));
    const s = h.tile.solids;
    for (let k = 0; k < s.length; k += 4) {
      if (Math.abs(s[k] - h.x) < 0.01 && Math.abs(s[k + 1] - h.z) < 0.01) {
        const rest = new Float32Array(s.length - 4);
        rest.set(s.subarray(0, k)); rest.set(s.subarray(k + 4), k);
        h.tile.solids = rest;
        break;
      }
    }
    this.dirty = true;
  }

  /** Apply `removed` to tiles that were built before it was loaded (a loaded save). */
  sweep() {
    for (const tile of this.tiles.values()) {
      for (const kind of KINDS) {
        const list = tile.items[kind], keep = [];
        for (let k = 0; k < list.length; k += 5) if (!this.#gone(kind, list[k], list[k + 2])) keep.push(list[k], list[k + 1], list[k + 2], list[k + 3], list[k + 4]);
        tile.items[kind] = keep;
      }
      const s = tile.solids, keep = [];
      for (let k = 0; k < s.length; k += 4) {
        const x = s[k], z = s[k + 1];
        if (!TREES.concat(ROCKS).some((kind) => this.#gone(kind, x, z))) keep.push(s[k], s[k + 1], s[k + 2], s[k + 3]);
      }
      tile.solids = new Float32Array(keep);
    }
    this.dirty = true;
  }

  /** Where a freshly freed rock rests: the sunk-in height populate gave it, or null if it was stacked on another rock. */
  restY(kind, x, z, s, y) {
    const g = this.world.gradient(x, z, _g);
    const y0 = this.world.height(x, z) + (BOT[kind] - 0.1 - Math.min(1.1, Math.hypot(g.x, g.z)) * 0.4) * s;
    return Math.abs(y - y0) < 0.3 ? y0 : null;
  }

  /** Geometry and material of a rock variant, for one that moves. */
  rockParts(kind, vi) { const m = this.meshes[kind][vi]; return { geometry: m.geometry, material: m.material }; }

  /** A single-instance copy of a tree variant, for one that is falling or lying down. Returns the mesh and the tree's height. */
  /** Standing full-size trees within r of (x, z): { x, z, rad }. Only the loaded tiles around the point. */
  treesAround(x, z, r) {
    const out = [], w = this.world, size = this.tile * w.cell;
    const ci = Math.floor((x + w.half) / size), cj = Math.floor((z + w.half) / size);
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        const tile = this.tiles.get(j * this.nt + i);
        if (!tile) continue;
        for (const kind of ['spruce', 'lodgepole', 'aspen', 'snag']) {
          const list = tile.items[kind];
          for (let k = 0; k < list.length; k += 5) {
            if (list[k + 3] >= SAPLING && Math.hypot(list[k] - x, list[k + 2] - z) <= r) out.push({ x: list[k], z: list[k + 2], rad: 0.24 * list[k + 3] });
          }
        }
      }
    }
    return out;
  }

  treeMesh(kind, vi, shade = 1) {
    const src = this.meshes[kind][vi];
    const m = new THREE.InstancedMesh(src.geometry, src.material, 1);
    m.setColorAt(0, new THREE.Color(shade, shade * 0.99, shade * 0.96));
    m.frustumCulled = false;
    m.castShadow = true; m.receiveShadow = true;
    m.customDepthMaterial = this.depth;
    if (!src.geometry.boundingBox) src.geometry.computeBoundingBox();
    return { mesh: m, height: src.geometry.boundingBox.max.y };
  }

  /** Push a circle of radius r out of trunks and boulders; returns ground lift from boulder tops. */
  collide(p, r, feetY) {
    let ground = -Infinity;
    const w = this.world, size = this.tile * w.cell;
    const fi = (p.x + w.half) / size, fj = (p.z + w.half) / size;
    for (let j = Math.floor(fj - 0.1); j <= Math.floor(fj + 0.1); j++) {
      for (let i = Math.floor(fi - 0.1); i <= Math.floor(fi + 0.1); i++) {
        const tile = this.tiles.get(j * this.nt + i);
        if (!tile) continue;
        const s = tile.solids;
        for (let k = 0; k < s.length; k += 4) {
          const dx = p.x - s[k], dz = p.z - s[k + 1];
          const rr = s[k + 2] + r;
          const d2 = dx * dx + dz * dz;
          if (d2 > rr * rr) continue;
          const top = s[k + 3];
          if (top !== Infinity) {
            // boulder: a dome you can stand on if you are already near its top
            const R = s[k + 2];
            const dd = Math.sqrt(d2);
            const surf = dd < R ? top - R * 0.55 + Math.sqrt(R * R - dd * dd) * 0.55 : -Infinity;
            if (feetY > surf - 0.45) { ground = Math.max(ground, surf); continue; }
          }
          const d = Math.sqrt(d2) || 1e-3;
          p.x = s[k] + (dx / d) * rr;
          p.z = s[k + 1] + (dz / d) * rr;
        }
      }
    }
    if (this.props) ground = Math.max(ground, this.props.collide(p, r, feetY));
    return ground;
  }

  /** Nearest standing tree within reach (for gathering deadfall). */
  treeNear(x, z, reach) {
    for (const tile of this.tiles.values()) {
      const s = tile.solids;
      for (let k = 0; k < s.length; k += 4) {
        if (s[k + 3] === Infinity && Math.hypot(s[k] - x, s[k + 1] - z) < reach) return true;
      }
    }
    return false;
  }
}

/** Column-major TRS with a rotation about Y, written straight into an instance buffer. */
function writeMatrix(a, i, x, y, z, sx, sy, sz, rot) {
  const c = Math.cos(rot), s = Math.sin(rot), o = i * 16;
  a[o] = c * sx; a[o + 1] = 0; a[o + 2] = -s * sx; a[o + 3] = 0;
  a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = s * sz; a[o + 9] = 0; a[o + 10] = c * sz; a[o + 11] = 0;
  a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
}
