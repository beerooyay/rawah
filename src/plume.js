import * as THREE from 'three';

// Smoke and heat from the campfire, carried by the paper's certified driven
// front (Certified Locality in Diffusive Simulation, Rouyea and Bourgeois,
// Example 6.8 and Theorems 6.5-6.7). A fire is not an event but a driven
// source: the cells under the flames are held at a level g(t) <= U, and the
// field spreads from them with diffusion D, dissipation k and a wind drift.
// For the monotone upwind scheme an exponential supersolution bounds the whole
// field outside the source, for every forcing g(t) <= U and every wind speed
// up to vmax, so only the cells that supersolution cannot clear need stepping;
// every other cell is exactly zero, and the error is bounded by the tolerance.
// Sources add (their bounds sum), so a second source (a burning skillet) is
// certified together with the fire, not given the whole tolerance of its own.
//
// Edges are absorbing (smoke leaves the 96 m square), which only lowers the
// solution, so no finite-domain correction is needed (Remark 6.9's reflecting
// case would need one). Windows are certified for k > 0 only.

const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** Largest a with D(2cosh a - 2) + advection(a) <= k per axis. `down`: the decay runs the way the wind blows. */
function rate(D, kAxis, v, down) {
  const f = (a) => D * (2 * Math.cosh(a) - 2) + (down ? v * (Math.exp(a) - 1) : -v * (1 - Math.exp(-a)));
  let hi = 0.01;
  while (f(hi) <= kAxis && hi < 40) hi *= 2;
  let lo = 0;
  if (!down) {   // upwind the drift helps and f dips below zero first: start from the bottom of the dip
    let a = 0, b = hi; for (let i = 0; i < 40; i++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3; if (f(m1) < f(m2)) b = m2; else a = m1; } lo = (a + b) / 2;
  }
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (f(m) <= kAxis) lo = m; else hi = m; }
  return lo;
}

export class Field {
  /**
   * n cells a side of `cell` metres. D (cell^2/s), k (1/s), v = [vx, vz] the
   * largest wind (cells/s); at run time the wind is that direction scaled by
   * 0..1. eps is the tolerance and U the largest level any source is held at.
   */
  constructor({ n = 96, cell = 1, D = 1, k = 0.03, v = [0, 0], eps = 0.02, U = 1, dt = 0.05 } = {}) {
    this.n = n; this.cell = cell; this.D = D; this.k = k; this.v = v; this.eps = eps; this.U = U; this.dt = dt;
    if (dt * (4 * D + Math.abs(v[0]) + Math.abs(v[1]) + k) > 1) throw new Error('step too large for a monotone scheme');
    this.u = new Float32Array(n * n);
    this.L = new Float64Array(n * n);                       // ledger: sum of the live sources' supersolutions
    this.slot = new Int32Array(n * n).fill(-1);
    this.awake = new Int32Array(n * n); this.awakeN = 0;
    this.epsWin = eps * 0.5; this.epsRet = eps * 0.25; this.epsCut = eps * 0.25;
    this.cut = this.epsCut / 4;                             // up to four live sources
    this.rho0 = this.epsRet / 4;
    this.retired = 0;
    this.sources = new Map();                               // id -> { cx, cz, r, level, off: null | time it may retire }
    this.wind = 1;                                          // 0..1 of v
    this.t = 0; this.acc = 0;
    this.stats = { touched: 0, violations: 0, steps: 0 };
    // supersolution rates per axis and side (k split evenly between the axes); pos/neg: decay toward +/- axis
    const kA = k / 2, sx = sgn(v[0]), sz = sgn(v[1]), ax = Math.abs(v[0]), az = Math.abs(v[1]);
    // downwind the worst wind is the strongest; upwind it is no wind at all (the drift only helps there)
    this.rx = { pos: rate(D, kA, sx > 0 ? ax : 0, sx > 0), neg: rate(D, kA, sx < 0 ? ax : 0, sx < 0) };
    this.rz = { pos: rate(D, kA, sz > 0 ? az : 0, sz > 0), neg: rate(D, kA, sz < 0 ? az : 0, sz < 0) };
  }

  /** The supersolution of a source at (cx, cz) with radius r, at cell offset (dx, dz). */
  #w(dx, dz, r) {
    const ax = dx >= 0 ? this.rx.pos : this.rx.neg, az = dz >= 0 ? this.rz.pos : this.rz.neg;
    return Math.min(this.U, this.U * Math.exp(ax * (r - Math.abs(dx)) + az * (r - Math.abs(dz))));
  }

  /** Add or remove a source's supersolution from the ledger. */
  #ledger(s, sign) {
    const { n, L } = this;
    let R = s.r;
    while (R < 4 * n && (this.#w(R, 0, s.r) >= this.cut || this.#w(-R, 0, s.r) >= this.cut || this.#w(0, R, s.r) >= this.cut || this.#w(0, -R, s.r) >= this.cut)) R++;
    R = Math.min(R + 1, 2 * n);
    const x0 = Math.max(0, s.cx - R), x1 = Math.min(n - 1, s.cx + R), z0 = Math.max(0, s.cz - R), z1 = Math.min(n - 1, s.cz + R);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const p = this.#w(x - s.cx, z - s.cz, s.r);
      if (p < this.cut) continue;
      const i = z * n + x;
      L[i] = Math.max(0, L[i] + sign * p);
      if (sign > 0 && L[i] > this.epsWin && this.slot[i] < 0) { this.slot[i] = this.awakeN; this.awake[this.awakeN++] = i; }
    }
  }

  /** (x, z) in metres relative to the field's centre -> cell index, or -1. */
  idx(x, z) {
    const n = this.n, cx = Math.floor(x / this.cell + n / 2), cz = Math.floor(z / this.cell + n / 2);
    return cx < 0 || cz < 0 || cx >= n || cz >= n ? -1 : cz * n + cx;
  }

  /** Start or update a driven source. Its level may change freely up to U. */
  drive(id, x, z, r, level) {
    let s = this.sources.get(id);
    if (!s) {
      const i = this.idx(x, z); if (i < 0) return;
      s = { cx: i % this.n, cz: (i / this.n) | 0, r, level: 0, off: null };
      this.sources.set(id, s);
      this.#ledger(s, +1);
    }
    s.off = null;
    s.level = Math.min(this.U, Math.max(0, level));
  }

  /** The source stops (its cells are released and diffuse like any others); its field is certified until it has decayed under rho0. */
  stop(id) {
    const s = this.sources.get(id);
    if (!s || s.off !== null) return;
    s.level = 0;
    s.off = this.t + Math.log(this.U / this.rho0) / this.k;
  }

  sample(x, z) { const i = this.idx(x, z); return i < 0 ? 0 : this.u[i]; }

  #step(dt) {
    const { u, L, n, D, k, epsWin } = this;
    const vx = this.v[0] * this.wind, vz = this.v[1] * this.wind;
    this.retired *= Math.exp(-k * dt);
    for (const [id, s] of this.sources) {
      if (s.off === null || this.t < s.off) continue;
      if (this.retired + this.rho0 > this.epsRet) { s.off = this.t + 1; continue; }
      this.#ledger(s, -1); this.retired += this.rho0; this.sources.delete(id);
    }
    // the driven cells are held at their level
    for (const s of this.sources.values()) if (s.off === null) for (let dz = -s.r; dz <= s.r; dz++) for (let dx = -s.r; dx <= s.r; dx++) {
      const x = s.cx + dx, z = s.cz + dz;
      if (dx * dx + dz * dz <= s.r * s.r && x >= 0 && x < n && z >= 0 && z < n) u[z * n + x] = s.level;
    }
    let a = 0;
    while (a < this.awakeN) {
      const i = this.awake[a];
      if (L[i] <= epsWin) {
        if (u[i] > epsWin * 1.5) this.stats.violations++;
        else { u[i] = 0; const last = this.awake[--this.awakeN]; this.awake[a] = last; this.slot[last] = a; this.slot[i] = -1; continue; }
      }
      a++;
    }
    // explicit monotone step: absorbing edges (ghost cells are 0), upwind drift
    const next = this.next || (this.next = new Float32Array(n * n));
    for (let q = 0; q < this.awakeN; q++) {
      const i = this.awake[q], x = i % n, z = (i / n) | 0, c = u[i];
      const xm = x > 0 ? u[i - 1] : 0, xp = x < n - 1 ? u[i + 1] : 0, zm = z > 0 ? u[i - n] : 0, zp = z < n - 1 ? u[i + n] : 0;
      let adv = 0;
      if (vx > 0) adv += vx * (xm - c); else adv += -vx * (xp - c);
      if (vz > 0) adv += vz * (zm - c); else adv += -vz * (zp - c);
      next[i] = Math.max(0, c + dt * (D * (xm + xp + zm + zp - 4 * c) + adv - k * c));
    }
    for (let q = 0; q < this.awakeN; q++) { const i = this.awake[q]; u[i] = next[i]; }
    // the sources hold their cells after the step too
    for (const s of this.sources.values()) if (s.off === null) for (let dz = -s.r; dz <= s.r; dz++) for (let dx = -s.r; dx <= s.r; dx++) {
      const x = s.cx + dx, z = s.cz + dz;
      if (dx * dx + dz * dz <= s.r * s.r && x >= 0 && x < n && z >= 0 && z < n) u[z * n + x] = s.level;
    }
    this.t += dt;
    this.stats.touched += this.awakeN; this.stats.steps++;
  }

  /** Advance by real seconds, in fixed steps. `wind` 0..1 scales the drift. */
  update(dt, wind = 1) {
    this.wind = Math.min(1, Math.max(0, wind));
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.dt && n++ < 8) { this.acc -= this.dt; this.#step(this.dt); }
    if (this.acc > this.dt * 8) this.acc = 0;
  }

  get asleep() { return this.awakeN === 0 && this.sources.size === 0; }
  reset() { this.u.fill(0); this.L.fill(0); this.slot.fill(-1); this.awakeN = 0; this.sources.clear(); this.retired = 0; this.acc = 0; }

  /**
   * Falsification: a fire at the centre with a flickering level and a wind that
   * swings between calm and the maximum, then stopped, against a dense run of
   * every cell. Returns the worst error anywhere, the audit count and the work.
   */
  bench({ seconds = 240, off = 160, seed = 5 } = {}) {
    const n = this.n, c = n >> 1, dt = this.dt, steps = Math.round(seconds / dt);
    let sd = seed; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const ref = new Float32Array(n * n), nxt = new Float32Array(n * n);
    this.reset();
    let err = 0, dense = 0, ph = 0, g = 0.8, drawn = false;
    for (let s = 0; s < steps; s++) {
      const t = s * dt;
      ph += dt * 0.6; g = Math.min(this.U, Math.max(0.2, g + (rnd() - 0.5) * 0.2));   // flicker
      const wind = 0.5 + 0.5 * Math.sin(ph);
      if (t < off) this.drive('fire', 0, 0, 1, g); else this.stop('fire');
      this.update(dt, wind);
      const vx = this.v[0] * wind, vz = this.v[1] * wind;
      if (t < off) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx * dx + dz * dz <= 1) ref[(c + dz) * n + c + dx] = g;
      for (let i = 0; i < n * n; i++) {
        const x = i % n, z = (i / n) | 0, cc = ref[i];
        const xm = x > 0 ? ref[i - 1] : 0, xp = x < n - 1 ? ref[i + 1] : 0, zm = z > 0 ? ref[i - n] : 0, zp = z < n - 1 ? ref[i + n] : 0;
        const adv = (vx > 0 ? vx * (xm - cc) : -vx * (xp - cc)) + (vz > 0 ? vz * (zm - cc) : -vz * (zp - cc));
        nxt[i] = Math.max(0, cc + dt * (this.D * (xm + xp + zm + zp - 4 * cc) + adv - this.k * cc));
      }
      ref.set(nxt); dense += n * n;
      if (t < off) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx * dx + dz * dz <= 1) ref[(c + dz) * n + c + dx] = g;
      if (s % 20 === 0) for (let i = 0; i < n * n; i++) err = Math.max(err, Math.abs(this.u[i] - ref[i]));
    }
    return { cells: n * n, steps, eps: this.eps, maxErr: err, withinEps: err <= this.eps, violations: this.stats.violations, updates: this.stats.touched, denseUpdates: dense, saving: dense / Math.max(1, this.stats.touched), awakeEnd: this.awakeN, sourcesEnd: this.sources.size };
  }
}

/** The camp's smoke and heat: two fields over a 96 m square centred on the fire, and the sprites that draw the smoke. */
export class Plume {
  constructor(world, scene) {
    this.world = world;
    // wind: the prevailing direction (wind.js) at up to 1.6 m/s near the ground for smoke, a little for heat
    const dir = [0.92, 0.38], l = Math.hypot(dir[0], dir[1]);
    this.dir = [dir[0] / l, dir[1] / l];
    this.smoke = new Field({ D: 1.0, k: 0.03, v: [this.dir[0] * 1.6, this.dir[1] * 1.6], eps: 0.02, U: 1, dt: 0.05 });
    this.heat = new Field({ D: 2.0, k: 0.15, v: [this.dir[0] * 0.5, this.dir[1] * 0.5], eps: 0.02, U: 1, dt: 0.05 });
    this.ox = 0; this.oz = 0; this.active = false;
    this.sprites = [];
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,0.8)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    for (let i = 0; i < 48; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0x8a8782 }));
      s.visible = false; scene.add(s);
      this.sprites.push({ s, age: 99, life: 1, x: 0, y: 0, z: 0 });
    }
    this.stats = { smoke: 0, heat: 0 };
  }

  /** ctx: { fire: {x, z, life} | null, pan: {x, z, level} | null, wind: 0..1, p: your position, dt } */
  update(dt, ctx) {
    const { fire, pan, p } = ctx;
    if (fire && (!this.active || Math.hypot(fire.x - this.ox, fire.z - this.oz) > 30)) {
      this.smoke.reset(); this.heat.reset(); this.ox = fire.x; this.oz = fire.z; this.active = true;
    }
    if (this.active) {
      const fx = fire ? fire.x - this.ox : 0, fz = fire ? fire.z - this.oz : 0;
      const fuel = fire ? Math.min(1, fire.life / 25) : 0;
      if (fire) { this.smoke.drive('fire', fx, fz, 1, 0.9 * fuel); this.heat.drive('fire', fx, fz, 1, fuel); } else { this.smoke.stop('fire'); this.heat.stop('fire'); }
      if (pan && pan.level > 0 && fire) this.smoke.drive('pan', pan.x - this.ox, pan.z - this.oz, 0, Math.min(1, pan.level));
      else this.smoke.stop('pan');
      this.smoke.update(dt, ctx.wind); this.heat.update(dt, ctx.wind);
      if (!fire && this.smoke.asleep && this.heat.asleep) this.active = false;
    }
    this.stats.smoke = this.smoke.awakeN; this.stats.heat = this.heat.awakeN;
    this.#sprites(dt, p);
  }

  /** Smoke and heat at a world point, 0..1. */
  at(x, z) {
    if (!this.active) return { smoke: 0, heat: 0 };
    return { smoke: this.smoke.sample(x - this.ox, z - this.oz), heat: this.heat.sample(x - this.ox, z - this.oz) };
  }

  #sprites(dt, p) {
    const f = this.smoke, n = f.n;
    for (const q of this.sprites) {
      if (q.age < q.life) {
        q.age += dt;
        const u = q.age / q.life;
        q.x += this.dir[0] * 0.7 * ((f.wind || 0) + 0.2) * dt; q.z += this.dir[1] * 0.7 * ((f.wind || 0) + 0.2) * dt; q.y += 0.22 * dt;
        q.s.position.set(q.x, q.y, q.z);
        q.s.scale.setScalar(1.2 + u * 2.4);
        q.s.material.opacity = Math.sin(Math.PI * Math.min(1, u)) * q.o;
        if (u >= 1) q.s.visible = false;
      } else if (this.active && f.awakeN > 0) {
        // draw a smoky cell at random, in proportion to how smoky it is
        const i = f.awake[(Math.random() * f.awakeN) | 0], c = f.u[i];
        if (Math.random() * 0.5 > c) continue;
        const x = this.ox + ((i % n) - n / 2 + Math.random()) * f.cell, z = this.oz + (((i / n) | 0) - n / 2 + Math.random()) * f.cell;
        if (Math.hypot(x - p.x, z - p.z) > 60) continue;
        q.age = 0; q.life = 3 + Math.random() * 3; q.o = Math.min(0.3, 0.05 + c * 0.35);
        q.x = x; q.z = z; q.y = this.world.height(x, z) + 1.0 + Math.random() * 1.6;
        q.s.visible = true;
      }
    }
  }
}
