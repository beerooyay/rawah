import * as THREE from 'three';
import { hash2 } from './noise.js';
import { buildSpecies, paintAtlas, foliageMaterial, foliageDepth, bakeImpostors, impostorGeometry, impostorMaterial } from './trees.js';

// Trees, burned snags, downed logs, krummholz, willows and boulders around the
// hiker. Placement is a jittered grid driven by World.cover(), which reads the
// Sentinel-2 land cover, so live forest, the 2020 burn and the aspen groves
// grow where they really are. Square tiles hold placement data only; a few
// global instanced meshes are refilled as you move: card-built trees close
// up (trees.js), crossed-quad impostors out to the horizon of the forest.

const TILE_M = 232;        // tile side in metres
const SPACING = 5.2;       // metres between placement candidates
const ROCK_R = 240;        // boulders and logs inside this radius
const REFILL_M = 10;       // move this far before refilling instances
const TREES = ['spruce', 'lodgepole', 'aspen', 'snag', 'krumm', 'willow'];
const KINDS = [...TREES, 'boulder', 'log'];
const CAP = { spruce: 4000, lodgepole: 3000, aspen: 2000, snag: 3000, krumm: 3000, willow: 1500, boulder: 6000, log: 4000 };
const IMP_CAP = 140000;

function rockGeometries() {
  const boulder = new THREE.IcosahedronGeometry(1, 1);
  const p = boulder.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.82 + hash2(Math.round(p.getX(i) * 50), Math.round(p.getZ(i) * 50), 11) * 0.32;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.78, p.getZ(i) * k);
  }
  boulder.computeVertexNormals();
  const log = new THREE.CylinderGeometry(0.16, 0.2, 6, 7, 1);
  log.rotateZ(Math.PI / 2);
  return { boulder, log };
}

export class Flora {
  constructor(world, scene, renderer, { card = 85, radius = 1250, thin = 700, impostor = 4096 } = {}) {
    this.world = world;
    this.cardR = card;          // full trees inside this radius
    this.radius = radius;       // impostors out to here
    this.thin = thin;           // beyond this, every other impostor
    this.uniforms = { uTime: { value: 0 }, uCalm: { value: 0.6 } };
    const atlas = paintAtlas();
    this.species = buildSpecies();
    const foliage = foliageMaterial(atlas, this.uniforms);
    const depth = foliageDepth(atlas, this.uniforms);
    this.impostors = bakeImpostors(renderer, this.species, foliage, impostor);

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
    const rocks = rockGeometries();
    const stone = new THREE.MeshLambertMaterial({ color: 0x8e8882 });
    const wood = new THREE.MeshLambertMaterial({ color: 0x5d5650 });
    for (const [kind, geo, mat] of [['boulder', rocks.boulder, stone], ['log', rocks.log, wood]]) {
      const m = new THREE.InstancedMesh(geo, mat, CAP[kind]);
      m.setColorAt(0, new THREE.Color());
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = m.receiveShadow = true;
      this.group.add(m);
      this.meshes[kind] = [m];
    }
    const ig = impostorGeometry(IMP_CAP);
    this.imp = new THREE.InstancedMesh(ig, impostorMaterial(this.impostors.texture, this.uniforms), IMP_CAP);
    this.imp.setColorAt(0, new THREE.Color());
    this.imp.count = 0;
    this.imp.frustumCulled = false;
    this.group.add(this.imp);

    this.tile = Math.max(8, Math.round(TILE_M / world.cell));
    this.nt = Math.ceil(world.N / this.tile);
    this.tiles = new Map();
    this.filledAt = new THREE.Vector3(Infinity, 0, 0);
    this.dirty = true;
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
    if (this.dirty || this.filledAt.distanceTo(pos) > REFILL_M) this.#fill(pos);
    return todo.length - n;
  }

  #populate(ti, tj) {
    const w = this.world, size = this.tile * w.cell;
    const x0 = ti * size - w.half, z0 = tj * size - w.half;
    const n = Math.floor(size / SPACING);
    const items = Object.fromEntries(KINDS.map((k) => [k, []]));
    const solids = []; // x, z, radius, top
    for (let b = 0; b < n; b++) {
      for (let a = 0; a < n; a++) {
        const gi = ti * n + a, gj = tj * n + b;
        const r1 = hash2(gi, gj, 1), r2 = hash2(gi, gj, 2), r3 = hash2(gi, gj, 3);
        const x = x0 + (a + r2) * SPACING, z = z0 + (b + r3) * SPACING;
        const e = w.height(x, z);
        const cv = w.cover(x, z, e);
        let kind = null;
        const pf = cv.forest * 0.6, pa = cv.aspen * 0.5, ps = cv.snag * 0.42, pk = cv.krumm * 0.3;
        if (r1 < pa) kind = 'aspen';
        else if (r1 < pa + pf) kind = e < 2980 + hash2(gi, gj, 4) * 160 ? 'lodgepole' : 'spruce';
        else if (r1 < pa + pf + ps) kind = 'snag';
        else if (r1 < pa + pf + ps + pk) kind = 'krumm';
        else if (r1 > 1 - (cv.snag * 0.1 + cv.forest * 0.025)) kind = 'log';
        else if (e < 2780 && cv.meadow > 0.6 && cv.grade < 0.08 && r1 > 0.93) kind = 'willow';
        else if (r1 > 1 - (cv.rock * 0.05 + cv.alpine * 0.004)) kind = 'boulder';
        if (!kind) continue;
        const lake = w.lakeAt(x, z);
        if (lake && e < lake.level + 0.7) continue;
        const near = w.nearestTrail(x, z);
        if (near.trail && near.d < near.trail.width / 2 + (kind === 'boulder' || kind === 'log' ? 1.2 : 2.2)) continue;
        const brook = w.nearestStream(x, z);
        if (brook.stream && brook.d < brook.stream.width / 2 + 1.5) continue;
        const s = kind === 'boulder' ? 0.5 + Math.pow(hash2(gi, gj, 5), 2.2) * (1.3 + cv.rock * 1.4)
          : kind === 'krumm' || kind === 'willow' ? 0.7 + hash2(gi, gj, 5) * 0.7
          : 0.62 + hash2(gi, gj, 5) * 0.55 - Math.max(0, e - cv.treeline + 120) / 450;
        if (s < 0.35) continue;
        items[kind].push(x, e, z, s, hash2(gi, gj, 6));
        if (kind === 'boulder') solids.push(x, z, s, e + s * 0.55);
        else if (kind !== 'krumm' && kind !== 'willow' && kind !== 'log') solids.push(x, z, (kind === 'snag' ? 0.2 : 0.3) * s + 0.1, Infinity);
      }
    }
    return { ti, tj, items, solids: new Float32Array(solids) };
  }

  /** Refill every instanced mesh from the tiles in range. */
  #fill(pos) {
    this.filledAt.copy(pos);
    this.dirty = false;
    const counts = new Map();
    const all = Object.values(this.meshes).flat();
    for (const m of all) counts.set(m, 0);
    let ni = 0;
    const imp = this.imp, im = imp.instanceMatrix.array, ic = imp.instanceColor.array, cell = imp.geometry.attributes.aCell.array;
    const cells = this.impostors.cells;
    const put = (mesh, x, y, z, sx, sy, sz, rot, v) => {
      const k = counts.get(mesh);
      if (k >= mesh.instanceMatrix.count) return;
      counts.set(mesh, k + 1);
      writeMatrix(mesh.instanceMatrix.array, k, x, y, z, sx, sy, sz, rot);
      const c = mesh.instanceColor.array;
      c[k * 3] = v; c[k * 3 + 1] = v * 0.99; c[k * 3 + 2] = v * 0.96;
    };
    for (const tile of this.tiles.values()) {
      for (const kind of KINDS) {
        const list = tile.items[kind];
        const variants = this.meshes[kind];
        for (let k = 0; k < list.length; k += 5) {
          const x = list[k], e = list[k + 1], z = list[k + 2], s = list[k + 3], r = list[k + 4];
          const d = Math.hypot(x - pos.x, z - pos.z);
          const rot = r * Math.PI * 2, v = 0.82 + r * 0.3;
          if (kind === 'boulder') {
            if (d < ROCK_R) put(variants[0], x, e - s * 0.2, z, s * (0.9 + r * 0.5), s, s * (1.3 - r * 0.4), rot, v);
            continue;
          }
          if (kind === 'log') {
            if (d < ROCK_R) put(variants[0], x, e + 0.12, z, 0.6 + s * 0.6, 1, 1, rot, v);
            continue;
          }
          const vi = Math.floor(((r * 7.31) % 1) * variants.length);
          if (d < this.cardR) { put(variants[vi], x, e - 0.15, z, s, s, s, rot, v); continue; }
          if (d > this.radius || (d > this.thin && r > 0.5) || ni >= IMP_CAP) continue;
          const c = cells[kind][vi];
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
