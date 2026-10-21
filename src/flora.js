import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from './noise.js';

// Trees, burned snags, downed logs, krummholz, willows and boulders, streamed
// in square tiles around the hiker. Placement is a jittered grid driven by
// World.cover(), which reads the Sentinel-2 land cover, so live forest, the
// 2020 burn and the aspen groves grow where they really are. Near tiles get
// detailed meshes and cast shadows; far tiles get cheap silhouettes; beyond
// that the satellite colour carries the forest to the horizon.

const TILE_M = 232;       // tile side in metres
const SPACING = 5.2;      // metres between placement candidates
const NEAR = 150;         // detailed meshes + shadows
const THIN = 650;         // beyond this, far tiles draw every other tree
const RADIUS = 1250;
const KINDS = ['spruce', 'lodgepole', 'aspen', 'snag', 'krumm', 'willow', 'boulder', 'log'];
const NEAR_ONLY = new Set(['boulder', 'log']);

function painted(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  return g;
}

function cone(r, h, y, color, seg = 7) {
  const g = new THREE.ConeGeometry(r, h, seg, 1, false);
  g.translate(0, y + h / 2, 0);
  return painted(g, color);
}

function trunk(r, h, color, seg = 5) {
  const g = new THREE.CylinderGeometry(r * 0.7, r, h, seg, 1);
  g.translate(0, h / 2, 0);
  return painted(g, color);
}

function blob(r, y, sy, color, detail = 0, seed = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = 0.82 + hash2(i, seed, 7) * 0.32;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * sy, p.getZ(i) * k);
  }
  g.translate(0, y, 0);
  return painted(g, color);
}

function buildGeometries() {
  const bark = '#5a4636', dark = '#26402c', mid = '#2f4d33', pine = '#3f5a36';
  const spruce = mergeGeometries([
    trunk(0.2, 1.6, bark, 4),
    cone(1.55, 3.8, 0.9, dark, 6), cone(1.1, 3.4, 3.4, mid, 6), cone(0.6, 3.0, 5.8, dark, 5),
  ]);
  const lodgepole = mergeGeometries([
    trunk(0.17, 8.2, '#6b5240', 4),
    cone(1.05, 2.8, 5.6, pine, 6), cone(0.7, 2.6, 7.6, '#4a653d', 5),
  ]);
  const aspen = mergeGeometries([
    trunk(0.13, 6.5, '#e6e1d3', 5),
    blob(1.5, 5.4, 1.35, '#e0a62c', 0, 3), blob(1.0, 6.8, 1.2, '#f0bf3a', 0, 4), blob(0.9, 4.9, 1.1, '#c98c22', 0, 5),
  ]);
  const krumm = mergeGeometries([blob(1.3, 0.25, 0.45, '#2f4a32', 0, 6), blob(0.8, 0.45, 0.5, '#3b5a3a', 0, 8)]);
  const willow = mergeGeometries([blob(1.1, 0.5, 0.65, '#9c6a32', 0, 9), blob(0.7, 0.8, 0.7, '#b07a3a', 0, 10)]);
  const boulder = blob(1, 0, 0.78, '#8e8882', 1, 11);
  // fire-killed lodgepole and spruce: charred base, silver-grey spar, a few stubs
  const stubs = [];
  for (let i = 0; i < 4; i++) {
    const b = new THREE.BoxGeometry(0.05, 0.05, 0.6 + hash2(i, 2, 3) * 0.7);
    b.translate(0, 0, 0.35);
    b.rotateY(i * 2.4);
    b.rotateX(-0.25);
    b.translate(0, 3.6 + i * 1.4, 0);
    stubs.push(painted(b, '#77716a'));
  }
  const snag = mergeGeometries([trunk(0.17, 2.6, '#2b2724', 5), (() => { const g = new THREE.CylinderGeometry(0.03, 0.14, 7.4, 5, 1); g.translate(0, 2.5 + 3.7, 0); return painted(g, '#8a847c'); })(), ...stubs]);
  const log = (() => { const g = new THREE.CylinderGeometry(0.16, 0.2, 6, 6, 1); g.rotateZ(Math.PI / 2); return painted(g, '#5d5650'); })();
  const far = {
    snag: trunk(0.16, 9.5, '#6d6760', 3),
    spruce: cone(1.4, 9, 0, dark, 4),
    lodgepole: mergeGeometries([trunk(0.2, 6, '#6b5240', 3), cone(1, 5, 5.5, pine, 4)]),
    aspen: mergeGeometries([trunk(0.15, 5, '#e6e1d3', 3), cone(1.5, 4.6, 3.6, '#e0a62c', 5)]),
    krumm: blob(1.2, 0.3, 0.5, '#2f4a32', 0, 6), willow: blob(1.0, 0.5, 0.65, '#9c6a32', 0, 9), boulder,
  };
  return { near: { spruce, lodgepole, aspen, snag, krumm, willow, boulder, log }, far };
}

export class Flora {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.geos = buildGeometries();
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.tile = Math.max(8, Math.round(TILE_M / world.cell));
    this.nt = Math.ceil(world.N / this.tile);
    this.tiles = new Map();
    this.group = new THREE.Group();
    scene.add(this.group);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._c = new THREE.Color();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  tileKey(x, z) {
    const w = this.world;
    return [Math.floor((x + w.half) / (this.tile * w.cell)), Math.floor((z + w.half) / (this.tile * w.cell))];
  }

  update(pos, budget = 1) {
    const w = this.world, size = this.tile * w.cell;
    const want = new Set();
    const span = Math.ceil(RADIUS / size) + 1;
    const [ti, tj] = this.tileKey(pos.x, pos.z);
    const todo = [];
    for (let j = tj - span; j <= tj + span; j++) {
      for (let i = ti - span; i <= ti + span; i++) {
        if (i < 0 || j < 0 || i >= this.nt || j >= this.nt) continue;
        const cx = (i + 0.5) * size - w.half, cz = (j + 0.5) * size - w.half;
        const d = Math.max(0, Math.hypot(cx - pos.x, cz - pos.z) - size * 0.7);
        if (d > RADIUS) continue;
        const key = j * this.nt + i;
        want.add(key);
        const lod = d < NEAR ? 'near' : d < THIN ? 'far' : 'thin';
        const tile = this.tiles.get(key);
        if (!tile) todo.push([d, key, i, j, lod]);
        else if (tile.lod !== lod) this.#dress(tile, lod);
      }
    }
    for (const [key, tile] of this.tiles) {
      if (!want.has(key)) { this.#undress(tile); this.tiles.delete(key); }
    }
    todo.sort((a, b) => a[0] - b[0]);
    for (let k = 0; k < Math.min(budget, todo.length); k++) {
      const [, key, i, j, lod] = todo[k];
      const tile = this.#populate(i, j);
      this.tiles.set(key, tile);
      this.#dress(tile, lod);
    }
    return todo.length - Math.min(budget, todo.length);
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
          : 0.7 + hash2(gi, gj, 5) * 0.65 - Math.max(0, e - cv.treeline + 120) / 400;
        if (s < 0.35) continue;
        items[kind].push(x, e, z, s, hash2(gi, gj, 6));
        if (kind === 'boulder') solids.push(x, z, s, e + s * 0.55);
        else if (kind !== 'krumm' && kind !== 'willow' && kind !== 'log') solids.push(x, z, (kind === 'snag' ? 0.16 : 0.32) * s + 0.12, Infinity);
      }
    }
    return { ti, tj, items, solids: new Float32Array(solids), meshes: [], lod: null };
  }

  #dress(tile, lod) {
    this.#undress(tile);
    tile.lod = lod;
    for (const kind of KINDS) {
      const list = tile.items[kind];
      const stride = lod === 'thin' ? 2 : 1;
      const count = Math.floor(list.length / 5 / stride);
      if (!count) continue;
      if (lod !== 'near' && NEAR_ONLY.has(kind)) continue;
      const mesh = new THREE.InstancedMesh(this.geos[lod === 'near' ? 'near' : 'far'][kind], this.material, count);
      for (let n = 0; n < count; n++) {
        const k = n * stride;
        const x = list[k * 5], e = list[k * 5 + 1], z = list[k * 5 + 2], s = list[k * 5 + 3], r = list[k * 5 + 4];
        this._q.setFromAxisAngle(this._up, r * Math.PI * 2);
        if (kind === 'boulder') {
          this._p.set(x, e - s * 0.2, z);
          this._s.set(s * (0.9 + r * 0.5), s, s * (1.3 - r * 0.4));
        } else if (kind === 'log') {
          this._p.set(x, e + 0.12, z);
          this._s.set(0.6 + s * 0.6, 1, 1);
        } else {
          this._p.set(x, e - 0.15, z);
          this._s.set(s, s * (kind === 'spruce' ? 0.9 + r * 0.35 : 1), s);
        }
        this._m.compose(this._p, this._q, this._s);
        mesh.setMatrixAt(n, this._m);
        const v = 0.82 + r * 0.3;
        this._c.setRGB(v, v * (0.97 + r * 0.06), v * 0.95);
        mesh.setColorAt(n, this._c);
      }
      mesh.castShadow = lod === 'near' && kind !== 'willow';
      mesh.receiveShadow = lod === 'near';
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      tile.meshes.push(mesh);
    }
  }

  #undress(tile) {
    for (const m of tile.meshes) { this.group.remove(m); m.dispose(); }
    tile.meshes = [];
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
