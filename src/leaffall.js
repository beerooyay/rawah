import * as THREE from 'three';
import { withAtmosphere } from './atmosphere.js';
import { gustAt, WIND_DIR } from './wind.js';

// Falling aspen leaves. From the middle of autumn (the same `TONE.uAutumn` / `uDrop` the crowns are toned by) leaves
// let go of the aspens around you, flutter down on the wind, land, lie a while and fade. They are the user's own leaf
// cut-outs (assets/foliage/leaves.webp, luminance only) tinted gold, orange or russet per leaf, and only exist near the
// player (aspens within RANGE m), so a whole stand turning costs a few hundred quads.

const MAX = 900, RANGE = 46, G_FALL = 0.62, LAND_LIFE = 55;
const TINTS = [0xf2c21c, 0xe8a114, 0xd9791a, 0xc2561a, 0xefd24a].map((c) => new THREE.Color(c));
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

export class LeafFall {
  constructor(scene, world, flora) {
    this.world = world; this.flora = flora;
    this.on = true;
    this.map = null;
    // one instanced mesh per leaf of the strip (four), so the stock Lambert shader and its alpha test do the work
    const mat = new THREE.MeshLambertMaterial({ alphaTest: 0.4, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => withAtmosphere(shader, { translucency: 0.5, weather: 0.6 });
    mat.customProgramCacheKey = () => 'rawah-leaffall';
    this.mat = mat;
    this.meshes = [];
    for (let c = 0; c < 4; c++) {
      const geo = new THREE.PlaneGeometry(1, 1);
      const uv = geo.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setX(k, (uv.getX(k) + c) * 0.25);
      const m = new THREE.InstancedMesh(geo, mat, MAX);
      m.frustumCulled = false; m.count = 0; m.castShadow = false;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
      scene.add(m);
      this.meshes.push(m);
    }
    this.cell = new Uint8Array(MAX);
    this.col = new Float32Array(MAX * 3);
    // state
    this.n = 0;
    this.x = new Float32Array(MAX); this.y = new Float32Array(MAX); this.z = new Float32Array(MAX);
    this.ph = new Float32Array(MAX); this.age = new Float32Array(MAX); this.land = new Float32Array(MAX);   // land: -1 falling, else time on the ground
    this.size = new Float32Array(MAX); this.yaw = new Float32Array(MAX); this.spin = new Float32Array(MAX);
    this.trees = []; this.treeT = 0; this.acc = 0; this.t = 0;
  }

  async load(url = './assets/foliage/leaves.webp') {
    try {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      this.mat.map = tex; this.mat.needsUpdate = true;
      this.map = tex;
    } catch (e) { console.warn('falling leaves: no leaf strip', e); }
  }

  #spawn(tr, groundY) {
    if (this.n >= MAX) return;
    const i = this.n++;
    const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 2.2;
    this.x[i] = tr.x + Math.cos(a) * r; this.z[i] = tr.z + Math.sin(a) * r;
    this.y[i] = groundY + 4.5 + Math.random() * 5.5;
    this.ph[i] = Math.random() * 6.283; this.age[i] = 0; this.land[i] = -1;
    this.size[i] = 0.13 + Math.random() * 0.08; this.yaw[i] = Math.random() * 6.283; this.spin[i] = (Math.random() - 0.5) * 3;
    this.cell[i] = Math.floor(Math.random() * 4);
    _c.copy(TINTS[Math.floor(Math.random() * TINTS.length)]).multiplyScalar(0.75 + Math.random() * 0.4);
    this.col[i * 3] = _c.r; this.col[i * 3 + 1] = _c.g; this.col[i * 3 + 2] = _c.b;
  }

  #kill(i) {
    const j = --this.n;
    if (i === j) return;
    for (const k of ['x', 'y', 'z', 'ph', 'age', 'land', 'size', 'yaw', 'spin']) this[k][i] = this[k][j];
    this.cell[i] = this.cell[j];
    this.col.copyWithin(i * 3, j * 3, j * 3 + 3);
  }

  /** `autumn` and `drop` are the crowns' own state (`TONE`), so leaves fall exactly when the tops thin; wind is 0..1 (`weather.wind`). */
  update(dt, p, { autumn, drop, wind = 0.3, snow = 0, calm = 0.6 }) {
    if (!this.on || !this.map) { for (const m of this.meshes) m.count = 0; return; }
    this.t += dt;
    const rate = THREE.MathUtils.smoothstep(autumn, 0.5, 0.9) * (1 - THREE.MathUtils.smoothstep(drop, 0.85, 1)) * (1 - snow);
    if ((this.treeT -= dt) <= 0) {
      this.treeT = 1.5;
      this.trees = rate > 0 ? this.flora.treesAround(p.x, p.z, RANGE).filter((t) => t.kind === 'aspen') : [];
    }
    if (rate > 0 && this.trees.length) {
      this.acc += dt * rate * Math.min(this.trees.length, 40) * (1.8 + 3 * drop + 1.5 * wind);
      while (this.acc >= 1) {
        this.acc -= 1;
        const tr = this.trees[Math.floor(Math.random() * this.trees.length)];
        this.#spawn(tr, this.world.height(tr.x, tr.z));
      }
    }
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (Math.hypot(this.x[i] - p.x, this.z[i] - p.z) > RANGE + 12) { this.#kill(i); continue; }
      if (this.land[i] < 0) {
        const g = gustAt(this.x[i], this.z[i], this.t, calm);
        const sway = Math.sin(this.t * 2.1 + this.ph[i]);
        const drift = (0.35 + wind * 1.6 + g * 1.2);
        this.x[i] += (WIND_DIR[0] * drift + Math.cos(this.ph[i]) * sway * 0.45) * dt;
        this.z[i] += (WIND_DIR[1] * drift + Math.sin(this.ph[i]) * sway * 0.45) * dt;
        this.y[i] -= (G_FALL + 0.25 * (1 + sway) * 0.5) * dt;
        const gy = this.world.height(this.x[i], this.z[i]);
        if (this.y[i] <= gy + 0.14) { this.y[i] = gy + 0.14; this.land[i] = 0; }
      } else {
        this.land[i] += dt;
        if (this.land[i] > LAND_LIFE) { this.#kill(i); continue; }
      }
    }
    const used = [0, 0, 0, 0];
    for (let i = 0; i < this.n; i++) {
      const falling = this.land[i] < 0;
      const sway = Math.sin(this.t * 2.1 + this.ph[i]);
      if (falling) _e.set(1.0 * sway + 0.5, this.yaw[i] + this.t * this.spin[i], 0.9 * Math.cos(this.t * 1.7 + this.ph[i]), 'YXZ');
      else _e.set(-Math.PI / 2 + 0.12 * Math.sin(this.ph[i] * 3), this.yaw[i], 0, 'YXZ');
      _q.setFromEuler(_e);
      const fade = falling ? 1 : 1 - THREE.MathUtils.smoothstep(this.land[i], LAND_LIFE - 12, LAND_LIFE);
      _s.setScalar(this.size[i] * fade);
      _m.compose(_p.set(this.x[i], this.y[i], this.z[i]), _q, _s);
      const c = this.cell[i], m = this.meshes[c], k = used[c]++;
      m.setMatrixAt(k, _m);
      m.instanceColor.array[k * 3] = this.col[i * 3]; m.instanceColor.array[k * 3 + 1] = this.col[i * 3 + 1]; m.instanceColor.array[k * 3 + 2] = this.col[i * 3 + 2];
    }
    for (let c = 0; c < 4; c++) { const m = this.meshes[c]; m.count = used[c]; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
  }

  clear() { this.n = 0; for (const m of this.meshes) m.count = 0; }
}
