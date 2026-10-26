import * as THREE from 'three';

// Certified-window world memory ("boxels"). A field over the valley holds
// moisture and wear; every event gets a closed-form footprint from the cone
// law, the sim only touches cells inside live cones, and every skipped cell is
// provably below the visible threshold. Overlapping events are composed the
// way the paper says (Prop. 4.2, Thm. 6.7): one ledger per cell sums every
// live event's certified peak (so masses add, they are not each given the
// whole tolerance), the tolerance is split between sleeping cells, retired
// events and truncated tails, and when too many events are live the closest
// pair is merged into one event of summed mass. Weather rides the gauge clock
// Theta = integral I dt: intensity only scales the action clock, it never
// wakes a cell. Cost scales with what happens, not with world size.

export class Boxels {
  /**
   * n: grid side in cells covering world.extent. Moisture diffuses and dries
   * (D, k in theta-time); wear only fades. eps is the visibility tolerance.
   */
  constructor(world, { n = 512, d = 12, k = 0.02, kWear = 0.002, eps = 0.002, shift = 1 } = {}) {
    this.sShift = shift;                // cells the continuum envelope is moved inward to cover the lattice (more when the decay length is short)
    this.n = n;
    this.cell = world.extent / n;
    this.d = d; this.k = k; this.kWear = kWear; this.eps = eps;
    this.u = new Float32Array(n * n);   // moisture, 0..1
    this.w = new Float32Array(n * n);   // wear, 0..1
    this.live = new Map();              // wear cells: cell index -> theta expiry (exact first passage)
    this.theta = 0;
    // certified moisture composition (see #ledgerAdd): the tolerance eps is split three ways
    this.epsWin = eps * 0.5;            // a cell sleeps while the summed peaks of the live events on it stay below this
    this.epsRet = eps * 0.25;           // budget for retired events' residual fields (decays with the dissipation)
    this.epsCut = eps * 0.25;           // budget for ledger tails dropped below `cut`
    this.nMax = 48;                     // live events before the closest pair is merged
    this.cut = this.epsCut / this.nMax;
    this.rho0 = this.epsRet * k / 2;    // residual an event may leave when it retires (at most two retirements per theta unit)
    this.retired = 0;                   // decaying sum of those residuals
    this.ev = [];                       // live events
    this.L = new Float64Array(n * n);   // ledger: sum over live events of their certified peak at the cell
    this.awake = new Int32Array(n * n); this.awakeN = 0;   // cells whose ledger exceeds epsWin, and where each sits in that list
    this.slot = new Int32Array(n * n).fill(-1);
    this.sTab = null;
    this.px = new Uint8Array(n * n * 4);
    this.texture = new THREE.DataTexture(this.px, n, n);
    this.dirty = true;              // set by events and steps; #paint only runs when something changed
    this.paintT = -1;               // theta of the last repaint — moisture moves slowly, ~12 Hz is plenty
    this.stats = { touched: 0, total: 0, ms: 0, live: 0, events: 0, violations: 0, merged: 0, retired: 0, deferred: 0, events_live: 0 };
    this.stepAcc = 0;
    this.ell = 1 / Math.acosh(1 + k / (2 * d));   // discrete decay length of the super-solution, in cells
  }

  #idx(x, z) {
    const n = this.n, cx = Math.floor((x + this.n * this.cell / 2) / this.cell), cz = Math.floor((z + this.n * this.cell / 2) / this.cell);
    return (cx < 0 || cz < 0 || cx >= n || cz >= n) ? -1 : cz * n + cx;
  }

  /** Cone radius in cells for an event of mass A: the certified window. */
  #cone(a) {
    let r = this.ell * Math.log(a / this.eps) || 1;
    for (let i = 0; i < 3; i++) r = Math.max(1, this.ell * Math.log(a / (2 * Math.PI * this.ell * r * this.eps)));
    return Math.ceil(r);
  }

  /**
   * The 2D heat-kernel envelope: the largest value mass a can have delivered to
   * radius r (cells) by theta. Peak is at t*(r); the cell's certified live
   * window is where this envelope exceeds eps — lo on the rising side, hi on
   * the falling side. Returns relative [lo, hi] or null when outside the cone.
   */
  #env(r, th, a) { return a * Math.exp(-this.k * th - r * r / (4 * this.d * th)) / (4 * Math.PI * this.d * th); }
  #window(r, a, eps = this.eps) {
    const { d, k } = this;
    if (d <= 0) return [0, Infinity];
    const ts = k > 1e-9 ? (Math.sqrt(1 + k * r * r / d) - 1) / (2 * k) : r * r / (4 * d);
    const peak = r < 1 ? a : this.#env(r, ts, a);
    if (peak < eps) return null;
    let lo = 0;
    if (r >= 1) {
      let a0 = 0, b0 = ts;
      for (let i = 0; i < 50; i++) { const m = (a0 + b0) / 2; if (this.#env(r, m, a) < eps) a0 = m; else b0 = m; }
      lo = a0;
    }
    let hi = Infinity;
    if (k > 1e-9) {
      let a0 = ts, b0 = Math.max(ts * 2, 1 / k);
      while (this.#env(r, b0, a) > eps) b0 *= 2;
      for (let i = 0; i < 60; i++) { const m = (a0 + b0) / 2; if (this.#env(r, m, a) > eps) a0 = m; else b0 = m; }
      hi = b0;
    }
    return [lo, hi];
  }

  /**
   * s(rho): the most a unit of mass can ever put on a cell rho cells away,
   * sup over time of e^(-k t) G_t(rho) for the lattice's diffusivity (the
   * peak of Theorem 5.1's envelope; closed form, no search). Table lookup in
   * quarter cells, shifted one cell nearer to absorb the lattice/continuum
   * gap (the paper measures under a cell).
   */
  #s(rho) {
    if (!this.sTab) {
      const { d, k } = this, T = new Float64Array(4 * 1024 + 2);
      for (let q = 0; q < T.length; q++) {
        const r = q / 4;
        const ts = k > 1e-9 ? (Math.sqrt(1 + k * r * r / d) - 1) / (2 * k) : r * r / (4 * d);
        T[q] = r < 0.25 ? 1e9 : Math.exp(-k * ts - r * r / (4 * d * ts)) / (4 * Math.PI * d * ts);
      }
      this.sTab = T;
    }
    const q = Math.floor(Math.max(0.5, rho - this.sShift) * 4);
    return q < this.sTab.length ? this.sTab[q] : 0;
  }

  /**
   * Add (sign +1) or remove (-1) an event's certified peaks on every cell it
   * can reach. The grid has reflecting edges, so the field is the free-space
   * field plus its mirror images (Remark 6.9's finite-domain case): the event
   * is also counted from its reflection across each edge and each corner.
   */
  #ledgerAdd(e, sign) {
    const { n, L } = this, cut = this.cut / 9;
    // reach: where A s(rho) falls under the cut
    let R = 0;
    while (R < 1000 && e.A * this.#s(R + 1) >= cut) R++;
    R += e.r + 1;
    e.R = R;
    const xs = [e.cx, -1 - e.cx, 2 * n - 1 - e.cx], zs = [e.cz, -1 - e.cz, 2 * n - 1 - e.cz];
    for (const ix of xs) for (const iz of zs) {
      const x0 = Math.max(0, ix - R), x1 = Math.min(n - 1, ix + R), z0 = Math.max(0, iz - R), z1 = Math.min(n - 1, iz + R);
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const rho = Math.max(0, Math.hypot(x - ix, z - iz) - e.r);
          const p = Math.min(e.a, e.A * this.#s(rho));   // never more than the event's own density (max principle)
          if (p < cut) continue;
          const i = z * n + x;
          L[i] = Math.max(0, L[i] + sign * p);
          if (sign > 0 && L[i] > this.epsWin && this.slot[i] < 0) { this.slot[i] = this.awakeN; this.awake[this.awakeN++] = i; }
        }
      }
    }
  }

  /** Theta at which an event's whole field is certified under rho0: every part decays as e^(-k s) A / (4 pi D s) at its peak. */
  #retireAt(e) {
    const f = (th) => { let m = 0; for (const [A, t] of e.parts) { const s = Math.max(th - t, 1e-6); m += A * Math.exp(-this.k * s) / (4 * Math.PI * this.d * s); } return 4 * m; };   // x4: a corner reflects the field twice over
    let lo = this.theta, hi = this.theta + 1;
    while (f(hi) > this.rho0 && hi < this.theta + 1e7) hi = this.theta + (hi - this.theta) * 2;
    for (let it = 0; it < 50; it++) { const m = (lo + hi) / 2; if (f(m) > this.rho0) lo = m; else hi = m; }
    return hi;
  }

  /** Two live events become one of summed mass inside the smallest disc that holds both (Prop. 4.2(a): the sum of peaks is at most the merged mass at the hull's distance). */
  #merge() {
    const ev = this.ev;
    let bi = 0, bj = 1, best = Infinity;
    for (let i = 0; i < ev.length; i++) for (let j = i + 1; j < ev.length; j++) {
      const d = Math.hypot(ev[i].cx - ev[j].cx, ev[i].cz - ev[j].cz), rn = Math.max(ev[i].r, ev[j].r, (d + ev[i].r + ev[j].r) / 2);
      const cost = rn - Math.max(ev[i].r, ev[j].r);
      if (cost < best) { best = cost; bi = i; bj = j; }
    }
    const a = ev[bi], b = ev[bj];
    this.#ledgerAdd(a, -1); this.#ledgerAdd(b, -1);
    const d = Math.hypot(a.cx - b.cx, a.cz - b.cz);
    let big = a, small = b; if (b.r > a.r) { big = b; small = a; }
    let cx = big.cx, cz = big.cz, r = big.r;
    if (d + small.r > big.r) {
      r = (d + a.r + b.r) / 2;
      const t = d > 0 ? (r - a.r) / d : 0;
      cx = Math.round(a.cx + (b.cx - a.cx) * t); cz = Math.round(a.cz + (b.cz - a.cz) * t);
      r = Math.max(r, Math.hypot(cx - a.cx, cz - a.cz) + a.r, Math.hypot(cx - b.cx, cz - b.cz) + b.r);   // rounding the centre must not uncover either disc
    }
    // where the two discs overlap their densities add (one cell can hold both deposits); apart, the larger one bounds the union
    const m = { cx, cz, r, a: d <= a.r + b.r + 1 ? a.a + b.a : Math.max(a.a, b.a), A: a.A + b.A, parts: a.parts.concat(b.parts), ret: 0, R: 0 };
    m.ret = this.#retireAt(m);
    ev.splice(bj, 1); ev[bi] = m;
    this.#ledgerAdd(m, +1);
    this.stats.merged++;
  }

  /** Moisture event: saturate every cell in the disc with a; the ledger adds the event's certified peak to every cell it can reach. */
  wet(x, z, a, r = 0) {
    const i0 = this.#idx(x, z); if (i0 < 0) return;
    const cx = i0 % this.n, cz = (i0 / this.n) | 0;
    let cells = 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const i = (cz + dz) * this.n + cx + dx;
      if (dx * dx + dz * dz <= r * r && i >= 0 && i < this.u.length) {
        this.u[i] = Math.min(1, this.u[i] + a); cells++;
        // deposits stack in a sleeping cell: once it holds more than the sleeping tolerance it must be stepped
        if (this.u[i] > this.epsWin && this.slot[i] < 0) { this.slot[i] = this.awakeN; this.awake[this.awakeN++] = i; }
      }
    }
    this.dirty = true;
    const e = { cx, cz, r, a, A: a * cells, parts: [[a * cells, this.theta]], ret: 0, R: 0 };
    e.ret = this.#retireAt(e);
    this.ev.push(e);
    this.#ledgerAdd(e, +1);
    if (this.ev.length > this.nMax) this.#merge();
    this.stats.events++;
  }

  /** Drying event: pull `a` moisture out of every cell in the disc. Removing mass can only shrink the field, so every live certificate still holds: nothing to add. */
  dry(x, z, a, r = 0) {
    const i0 = this.#idx(x, z); if (i0 < 0) return;
    const cx = i0 % this.n, cz = (i0 / this.n) | 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const i = (cz + dz) * this.n + cx + dx;
      if (dx * dx + dz * dz <= r * r && i >= 0 && i < this.u.length && this.u[i] > 0) this.u[i] = Math.max(0, this.u[i] - a);
    }
    this.dirty = true;
    this.stats.events++;
  }

  /** Moisture and wear at a world point, nearest cell. For game reads (mist, stamina), not the shader. */
  sample(x, z) {
    const i = this.#idx(x, z);
    return i < 0 ? { u: 0, w: 0 } : { u: this.u[i], w: this.w[i] };
  }

  /** Wear event: a footstep. No diffusion, so no cone: the mark fades on its own clock, and the cell sleeps at the exact first passage of its own value (Example 7.5), however many steps stacked on it. */
  wear(x, z, a) {
    const i = this.#idx(x, z); if (i < 0) return;
    this.w[i] = Math.min(1, this.w[i] + a);
    this.live.set(i, this.theta + Math.log(Math.max(this.w[i], this.eps) / this.eps) / this.kWear);
    this.dirty = true;
    this.stats.events++;
  }

  /** One gauge-clock step: retire what can retire, then integrate the cells the ledger says can matter. */
  #step(dt) {
    const { u, w, L, n, d, k, kWear, epsWin } = this;
    const decay = Math.exp(-k * dt);
    this.retired *= decay;
    // retire events whose whole field is under rho0, while the retired residuals stay inside their budget
    for (let q = this.ev.length - 1; q >= 0; q--) {
      const e = this.ev[q];
      if (this.theta < e.ret) continue;
      if (this.retired + this.rho0 > this.epsRet) { e.ret = this.theta + 1; this.stats.deferred++; continue; }
      this.#ledgerAdd(e, -1);
      this.retired += this.rho0;
      this.ev.splice(q, 1);
      this.stats.retired++;
    }
    // moisture: only awake cells; a cell whose ledger has fallen under epsWin goes back to sleep (and is audited)
    const next = this.next || (this.next = new Float32Array(this.awake.length));
    let a = 0;
    while (a < this.awakeN) {
      const i = this.awake[a];
      if (L[i] <= epsWin) {
        if (u[i] > epsWin * 1.5) this.stats.violations++;   // the ledger says nothing should be here: report it, and keep stepping the cell
        if (u[i] <= epsWin) {                                // asleep, keeping the little it holds (stale, under the tolerance)
          const last = this.awake[--this.awakeN]; this.awake[a] = last; this.slot[last] = a; this.slot[i] = -1; continue;
        }
      }
      const l = i % n, m = i - l;
      const lap = (l > 0 ? u[i - 1] : u[i]) + (l < n - 1 ? u[i + 1] : u[i]) + (m >= n ? u[i - n] : u[i]) + (m < u.length - n ? u[i + n] : u[i]) - 4 * u[i];
      next[a] = Math.max(0, u[i] + dt * (d * lap - k * u[i]));   // every cell reads the old values: the step does not depend on the order of the list
      this.stats.touched++; this.stats.total++;
      a++;
    }
    for (let q = 0; q < a; q++) u[this.awake[q]] = next[q];
    if (this.awakeN) this.dirty = true;
    // wear: only its own cells, each until its own first passage
    for (const [i, until] of this.live) {
      if (this.theta > until) {
        if (w[i] < this.eps) { this.live.delete(i); continue; }
        this.stats.violations++;
        this.live.set(i, this.theta + Math.log(w[i] / this.eps) / kWear);
      }
      w[i] = Math.max(0, w[i] - dt * kWear * w[i]);
      this.dirty = true;
    }
  }

  /**
   * Advance the gauge clock by world intensity I over dt seconds; the sim
   * integrates in theta-space at a bounded step. Returns touched-cell count.
   */
  update(dt, intensity) {
    const t0 = performance.now();
    let rem = dt * intensity;
    while (rem > 1e-6) {
      const s = Math.min(rem, 0.01);   // inside the Euler stability bound for this D
      this.theta += s;
      this.#step(s);
      rem -= s;
    }
    if (this.dirty && this.theta - this.paintT > 0.08) this.#paint();
    this.stats.ms = this.stats.ms * 0.9 + (performance.now() - t0) * 0.1;
    this.stats.live = this.awakeN + this.live.size;
    this.stats.events_live = this.ev.length;
    return this.stats.touched;
  }

  #paint() {
    const { u, w, px } = this;
    for (let i = 0; i < u.length; i++) {
      px[i * 4] = Math.min(255, u[i] * 255);
      px[i * 4 + 1] = Math.min(255, w[i] * 255);
      px[i * 4 + 3] = 255;
    }
    this.texture.needsUpdate = true;
    this.stats.touched = 0;
    this.dirty = false;
    this.paintT = this.theta;
  }

  /**
   * The falsification harness: identical events through three schedulers on the
   * same kernel. Returns the error-vs-cost table — updates, sim ms, and max
   * error against a dense reference at the same step size.
   */
  bench({ a = 0.9, r = 8, steps = 400, dt = 0.02 } = {}) {
    const n = this.n, c = n / 2, D = this.d, k = this.k;
    const ev = (u, live, i) => {
      const cx = i % n, cz = (i / n) | 0, R = r + this.#cone(a);
      u[i] = Math.min(1, u[i] + a);
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const j = (cz + dz) * n + cx + dx;
        if (dx * dx + dz * dz <= R * R && j >= 0 && j < n * n) {
          const w = this.#window(Math.max(0, Math.hypot(dx, dz) - r), a);
          if (w) live.set(j, w);
        }
      }
    };
    const eul = (u, i) => { const l = i % n; const lap = (l > 0 ? u[i - 1] : u[i]) + (l < n - 1 ? u[i + 1] : u[i]) + (i >= n ? u[i - n] : u[i]) + (i < u.length - n ? u[i + n] : u[i]) - 4 * u[i]; return Math.max(0, u[i] + dt * (D * lap - k * u[i])); };
    const t = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };
    // reference: dense, every cell every step
    const ud = new Float32Array(n * n); ud[c * n + c] = a;
    let updD = 0; const msD = t(() => { for (let s = 0; s < steps; s++) for (let i = 0; i < n * n; i++) { ud[i] = eul(ud, i); updD++; } });
    // activity sleeping: awake cells plus their neighbours
    const ua = new Float32Array(n * n); ua[c * n + c] = a;
    const wake = new Set([c * n + c]); let updA = 0;
    const msA = t(() => {
      for (let s = 0; s < steps; s++) {
        const next = new Set();
        for (const i of wake) { ua[i] = eul(ua, i); updA++; if (ua[i] > this.eps) { next.add(i); if (i % n > 0) next.add(i - 1); if (i % n < n - 1) next.add(i + 1); if (i >= n) next.add(i - n); if (i < ua.length - n) next.add(i + n); } }
        wake.clear(); for (const j of next) wake.add(j);
      }
    });
    // certified windows: per-cell [lo, hi] from the envelope, on the event's clock
    const uc = new Float32Array(n * n); const live = new Map();
    ev(uc, live, c * n + c);
    let updC = 0, viol = 0;
    const msC = t(() => { for (let s = 0; s < steps; s++) { const th = s * dt; for (const [i, win] of live) { if (th < win[0]) continue; if (th > win[1]) { if (uc[i] < this.eps) { live.delete(i); continue; } viol++; } uc[i] = eul(uc, i); updC++; } } });
    const err = (u) => { let m = 0; for (let i = 0; i < n * n; i++) m = Math.max(m, Math.abs(u[i] - ud[i])); return m; };
    return {
      cells: n * n, steps, event: { a, radius: r },
      dense: { updates: updD, ms: msD },
      activity: { updates: updA, ms: msA, maxErr: err(ua) },
      certified: { updates: updC, ms: msC, maxErr: err(uc), window: live.size, violations: viol },
      speedup: updD / updC,
    };
  }

  /**
   * Experiment 1: quantum sleep inside certified windows. Each windowed cell
   * freezes while its drift bound says it cannot cross a contract band (dq)
   * edge; band crossings announce to neighbours and force re-rating. This is
   * the certified version of what activity sleeping does by feel — the test of
   * whether the ~10x window-vs-activity gap is the price of the proof or just
   * the missing temporal half.
   */
  benchQ({ a = 0.9, r = 8, steps = 400, dt = 0.005, dq = 0.001 } = {}) {
    const n = this.n, c = n / 2, D = this.d, k = this.k, eps = this.eps, epsw = eps * 0.99;
    const eul = (u, i) => { const l = i % n; const lap = (l > 0 ? u[i - 1] : u[i]) + (l < n - 1 ? u[i + 1] : u[i]) + (i >= n ? u[i - n] : u[i]) + (i < u.length - n ? u[i + n] : u[i]) - 4 * u[i]; return Math.max(0, u[i] + dt * (D * lap - k * u[i])); };
    const wins = (u, live, i) => {
      const cx = i % n, cz = (i / n) | 0, R = r + this.#cone(a);
      u[i] = Math.min(1, u[i] + a);
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const j = (cz + dz) * n + cx + dx;
        if (dx * dx + dz * dz <= R * R && j >= 0 && j < n * n) {
          const w = this.#window(Math.max(0, Math.hypot(dx, dz) - r), a, epsw);
          if (w) live.set(j, w);
        }
      }
    };
    const t = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };
    // dense reference + the exact active volume (cell-steps above eps)
    const ud = new Float32Array(n * n); ud[c * n + c] = a;
    let updD = 0, vol = 0;
    const msD = t(() => { for (let s = 0; s < steps; s++) for (let i = 0; i < n * n; i++) { ud[i] = eul(ud, i); updD++; if (ud[i] > this.eps) vol++; } });
    // certified windows only (same as bench)
    const uc = new Float32Array(n * n); const live = new Map();
    wins(uc, live, c * n + c);
    let updC = 0, viol = 0;
    const msC = t(() => { for (let s = 0; s < steps; s++) { const th = s * dt; for (const [i, w] of live) { if (th < w[0]) continue; if (th > w[1]) { if (uc[i] < eps) { live.delete(i); continue; } viol++; } uc[i] = eul(uc, i); updC++; } } });
    // quantum-certified: same windows + band-contract sleep inside them
    const uq = new Float32Array(n * n); const live2 = new Map();
    wins(uq, live2, c * n + c);
    const band = new Map(), nxt = new Map();
    let updQ = 0, announces = 0, violQ = 0;
    const msQ = t(() => {
      for (let s = 0; s < steps; s++) {
        const th = s * dt;
        for (const [i, w] of live2) {
          if (th < w[0]) continue;
          if (th > w[1]) {                                             // window expired: certificate licenses truncation
            if (uq[i] >= eps) violQ++;
            uq[i] = Math.min(uq[i], eps); live2.delete(i); nxt.delete(i); continue;
          }
          const nc = nxt.get(i);
          if (nc !== undefined && th < nc) continue;                    // quantum sleep
          uq[i] = eul(uq, i); updQ++;
          const b0 = Math.floor(uq[i] / dq);
          if (b0 !== (band.get(i) ?? -1)) {                             // crossed a band: announce
            band.set(i, b0); announces++;
            const l = i % n;
            if (l > 0 && live2.has(i - 1)) nxt.set(i - 1, th);
            if (l < n - 1 && live2.has(i + 1)) nxt.set(i + 1, th);
            if (i >= n && live2.has(i - n)) nxt.set(i - n, th);
            if (i < uq.length - n && live2.has(i + n)) nxt.set(i + n, th);
          }
          // drift bound: inflow from neighbours' band tops + own decay
          const l = i % n;
          let nmax = 0;
          for (const j of [l > 0 ? i - 1 : -1, l < n - 1 ? i + 1 : -1, i >= n ? i - n : -1, i < uq.length - n ? i + n : -1]) {
            if (j < 0) continue;
            const nb = live2.has(j) ? (((band.get(j) ?? 0) + 1) * dq) : uq[j];
            if (nb > nmax) nmax = nb;
          }
          const rate = D * Math.abs(4 * nmax - 4 * uq[i]) + k * uq[i];
          const h = rate > 1e-9 ? dq / rate : Infinity;
          nxt.set(i, th + Math.max(dt, h));
        }
      }
    });
    const err = (u) => { let m = 0; for (let i = 0; i < n * n; i++) m = Math.max(m, Math.abs(u[i] - ud[i])); return m; };
    return {
      cells: n * n, steps, dt, event: { a, radius: r }, band: dq, activeVolume: vol,
      dense: { updates: updD, ms: msD },
      certified: { updates: updC, ms: msC, maxErr: err(uc), violations: viol, overhead: updC / vol },
      quantum: { updates: updQ, ms: msQ, maxErr: err(uq), violations: violQ, announces, overhead: updQ / vol },
    };
  }

  /**
   * Experiment 2: overlapping events. Per-event windows each certified against
   * full eps can breach eps in the overlap; theorem 4.1's fix is one window on
   * the cluster's summed mass. Measures both against a dense run of the same
   * event cluster.
   */
  benchMulti({ events = [[0, 0, 0.9], [6, 4, 0.7], [-5, 6, 0.6], [3, -7, 0.5]], r = 8, steps = 12000, dt = 0.005 } = {}) {
    const n = this.n, c = n / 2, D = this.d, k = this.k, eps = this.eps, epsw = eps * 0.99;
    const eul = (u, i) => { const l = i % n; const lap = (l > 0 ? u[i - 1] : u[i]) + (l < n - 1 ? u[i + 1] : u[i]) + (i >= n ? u[i - n] : u[i]) + (i < u.length - n ? u[i + n] : u[i]) - 4 * u[i]; return Math.max(0, u[i] + dt * (D * lap - k * u[i])); };
    const t = (f) => { const t0 = performance.now(); f(); return performance.now() - t0; };
    const pts = events.map(([dx, dz, a]) => [(c + dz) * n + c + dx, a]);
    // dense
    const ud = new Float32Array(n * n); for (const [i, a] of pts) ud[i] = a;
    let updD = 0; const msD = t(() => { for (let s = 0; s < steps; s++) for (let i = 0; i < n * n; i++) { ud[i] = eul(ud, i); updD++; } });
    // per-event windows: each event certifies alone (the unsound compose)
    const ua = new Float32Array(n * n); const liveA = new Map();
    for (const [i, a] of pts) {
      ua[i] = Math.min(1, ua[i] + a);
      const cx = i % n, cz = (i / n) | 0, R = r + this.#cone(a);
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const j = (cz + dz) * n + cx + dx;
        if (dx * dx + dz * dz <= R * R && j >= 0 && j < n * n) {
          const w = this.#window(Math.max(0, Math.hypot(dx, dz) - r), a, epsw);
          if (w) liveA.set(j, w);
        }
      }
    }
    let updA = 0, violA = 0;
    const msA = t(() => { for (let s = 0; s < steps; s++) { const th = s * dt; for (const [i, w] of liveA) { if (th < w[0]) continue; if (th > w[1]) { if (ua[i] < eps) { liveA.delete(i); continue; } violA++; } ua[i] = eul(ua, i); updA++; } } });
    // cluster: one window on summed mass centred on the deposits' mass centroid
    const uc = new Float32Array(n * n); const liveC = new Map();
    let mx = 0, mz = 0, mAll = 0;
    for (const [i, a] of pts) { uc[i] = Math.min(1, uc[i] + a); mx += (i % n) * a; mz += ((i / n) | 0) * a; mAll += a; }
    const ccx = Math.round(mx / mAll), ccz = Math.round(mz / mAll);
    const R = r + 16 + this.#cone(mAll);      // cluster extent + mass cone
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const j = (ccz + dz) * n + ccx + dx;
      if (dx * dx + dz * dz <= R * R && j >= 0 && j < n * n) {
        const w = this.#window(Math.max(0, Math.hypot(dx, dz) - r - 16), mAll, epsw);
        if (w) liveC.set(j, w);
      }
    }
    let updC = 0, violC = 0;
    const msC = t(() => { for (let s = 0; s < steps; s++) { const th = s * dt; for (const [i, w] of liveC) { if (th < w[0]) continue; if (th > w[1]) { if (uc[i] < eps) { liveC.delete(i); continue; } violC++; } uc[i] = eul(uc, i); updC++; } } });
    const err = (u) => { let m = 0; for (let i = 0; i < n * n; i++) m = Math.max(m, Math.abs(u[i] - ud[i])); return m; };
    return {
      cells: n * n, steps, dt, events: events.length, mass: mAll,
      dense: { updates: updD, ms: msD },
      perEvent: { updates: updA, ms: msA, maxErr: err(ua), violations: violA, window: liveA.size },
      cluster: { updates: updC, ms: msC, maxErr: err(uc), violations: violC, window: liveC.size },
    };
  }

  /**
   * Overlapping rain: a stream of wet events on one patch of ground (the case
   * Remark 4.3 warns about), run three ways on a small grid against a dense
   * reference: `ledger` is this class (summed peaks, split tolerance, merging,
   * budgeted retirement), `perEvent` gives every event the whole tolerance and
   * unions the windows (what this file used to do). Reports the worst error
   * anywhere at any time, updates, and certificate violations.
   */
  benchRain({ n = 96, rate = 0.25, until = 500, total = 800, dt = 0.01, box = 12, r = 3, a = 0.5, seed = 7 } = {}) {
    const { d, k, eps } = this, eul = (u, i) => { const l = i % n; const lap = (l > 0 ? u[i - 1] : u[i]) + (l < n - 1 ? u[i + 1] : u[i]) + (i >= n ? u[i - n] : u[i]) + (i < u.length - n ? u[i + n] : u[i]) - 4 * u[i]; return Math.max(0, u[i] + dt * (d * lap - k * u[i])); };
    let sd = seed; const rnd = () => { sd = (sd * 1664525 + 1013904223) >>> 0; return sd / 4294967296; };
    const c = n >> 1, steps = Math.round(total / dt), plan = [];
    for (let s = 0; s < steps; s++) if (s * dt < until && rnd() < rate * dt) plan.push([s, c + Math.round((rnd() * 2 - 1) * box), c + Math.round((rnd() * 2 - 1) * box)]);
    const sim = new Boxels({ extent: n * this.cell }, { n, d, k, eps, kWear: this.kWear });
    const ud = new Float32Array(n * n), ul = new Float32Array(n * n), tmp = new Float32Array(n * n), tmpP = new Map(), live = new Map();
    const drop = (u, cx, cz) => { for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) { const i = (cz + dz) * n + cx + dx; u[i] = Math.min(1, u[i] + a); } };
    let ei = 0, eL = 0, eP = 0, updD = 0, updP = 0, viol = 0, awakeMax = 0;
    const cell = this.cell, x0 = -n * cell / 2 + cell / 2;
    for (let s = 0; s < steps; s++) {
      const th = s * dt;
      while (ei < plan.length && plan[ei][0] === s) {
        const [, cx, cz] = plan[ei++];
        drop(ud, cx, cz); drop(ul, cx, cz);
        sim.wet(x0 + cx * cell, x0 + cz * cell, a, r);
        const mass = a * Math.PI * r * r, R = r + this.#cone(mass);   // the old per-event window, at the whole tolerance
        for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
          const i = (cz + dz) * n + cx + dx, dist = Math.hypot(dx, dz);
          if (dx * dx + dz * dz <= R * R && cz + dz >= 0 && cz + dz < n && cx + dx >= 0 && cx + dx < n) {
            const w = dist <= r ? [0, Math.log(a / eps) / k] : this.#window(dist - r, mass);
            if (w) { const o = live.get(i), t0 = th + w[0], t1 = th + w[1]; if (!o || t1 > o[1]) live.set(i, o ? [Math.min(o[0], t0), t1] : [t0, t1]); }
          }
        }
      }
      for (let i = 0; i < n * n; i++) tmp[i] = eul(ud, i);
      ud.set(tmp); updD += n * n;
      sim.update(dt, 1);
      for (const [i, w] of live) {
        if (th < w[0]) continue;
        if (th > w[1]) { if (ul[i] < eps) { live.delete(i); continue; } viol++; }
        tmpP.set(i, eul(ul, i)); updP++;
      }
      for (const [i, v] of tmpP) ul[i] = v;
      tmpP.clear();
      awakeMax = Math.max(awakeMax, sim.awakeN);
      if (s % 40 === 0) for (let i = 0; i < n * n; i++) { eL = Math.max(eL, Math.abs(sim.u[i] - ud[i])); eP = Math.max(eP, Math.abs(ul[i] - ud[i])); }
    }
    return {
      grid: n, events: plan.length, theta: total, eps,
      dense: { updates: updD },
      ledger: { updates: sim.stats.total, maxErr: eL, withinEps: eL <= eps, violations: sim.stats.violations, merged: sim.stats.merged, retired: sim.stats.retired, deferred: sim.stats.deferred, awakeMax, liveEvents: sim.ev.length },
      perEvent: { updates: updP, maxErr: eP, withinEps: eP <= eps, violations: viol },
    };
  }
}
