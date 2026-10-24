import * as THREE from 'three';

// Certified-window world memory ("boxels"). A field over the valley holds
// moisture and wear; every event gets a closed-form footprint from the cone
// law, the sim only touches cells inside live cones, and every skipped cell is
// provably below the visible threshold. Weather rides the gauge clock
// Theta = integral I dt: intensity only scales the action clock, it never
// wakes a cell. Cost scales with what happens, not with world size.

export class Boxels {
  /**
   * n: grid side in cells covering world.extent. Moisture diffuses and dries
   * (D, k in theta-time); wear only fades. eps is the visibility tolerance.
   */
  constructor(world, { n = 512, d = 12, k = 0.02, kWear = 0.002, eps = 0.002 } = {}) {
    this.n = n;
    this.cell = world.extent / n;
    this.d = d; this.k = k; this.kWear = kWear; this.eps = eps;
    this.u = new Float32Array(n * n);   // moisture, 0..1
    this.w = new Float32Array(n * n);   // wear, 0..1
    this.live = new Map();              // cell index -> theta expiry
    this.theta = 0;
    this.px = new Uint8Array(n * n * 4);
    this.texture = new THREE.DataTexture(this.px, n, n);
    this.dirty = true;              // set by events and steps; #paint only runs when something changed
    this.paintT = -1;               // theta of the last repaint — moisture moves slowly, ~12 Hz is plenty
    this.stats = { touched: 0, total: 0, ms: 0, live: 0, events: 0, violations: 0 };
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

  #wake(i, lo, hi) {
    const t0 = this.theta + lo, t1 = this.theta + hi, w = this.live.get(i);
    if (!w || t1 > w[1]) this.live.set(i, w ? [Math.min(w[0], t0), t1] : [t0, t1]);
  }

  /** Moisture event: saturate every cell in the disc with a; the certificate bounds the whole deposit as mass a·πr² at the nearest edge. */
  wet(x, z, a, r = 0) {
    const i0 = this.#idx(x, z); if (i0 < 0) return;
    const cx = i0 % this.n, cz = (i0 / this.n) | 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const i = (cz + dz) * this.n + cx + dx;
      if (dx * dx + dz * dz <= r * r && i >= 0 && i < this.u.length) this.u[i] = Math.min(1, this.u[i] + a);
    }
    this.dirty = true;
    const mass = a * Math.PI * r * r, R = r + this.#cone(mass);
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      const i = (cz + dz) * this.n + cx + dx, dist = Math.hypot(dx, dz);
      if (dx * dx + dz * dz <= R * R && i >= 0 && i < this.u.length) {
        const w = dist <= r ? [0, Math.log(a / this.eps) / this.k] : this.#window(dist - r, mass);
        if (w) this.#wake(i, w[0], w[1]);
      }
    }
    this.stats.events++;
  }

  /** Drying event: pull `a` moisture out of every cell in the disc. Removing mass can only shrink the field, so the neighbours' existing cones still certify what arrives later — no new windows needed. */
  dry(x, z, a, r = 0) {
    const i0 = this.#idx(x, z); if (i0 < 0) return;
    const cx = i0 % this.n, cz = (i0 / this.n) | 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const i = (cz + dz) * this.n + cx + dx;
      if (dx * dx + dz * dz <= r * r && i >= 0 && i < this.u.length && this.u[i] > 0) {
        this.u[i] = Math.max(0, this.u[i] - a);
        if (!this.live.has(i)) this.live.set(i, [0, Math.log(Math.max(this.u[i], 1e-4) / this.eps) / this.k]);   // keep fading whatever is left
      }
    }
    this.dirty = true;
    this.stats.events++;
  }

  /** Moisture and wear at a world point, nearest cell. For game reads (mist, stamina), not the shader. */
  sample(x, z) {
    const i = this.#idx(x, z);
    return i < 0 ? { u: 0, w: 0 } : { u: this.u[i], w: this.w[i] };
  }

  /** Wear event: a footstep. No diffusion — the mark fades on its own clock. */
  wear(x, z, a) {
    const i = this.#idx(x, z); if (i < 0) return;
    this.w[i] = Math.min(1, this.w[i] + a);
    this.#wake(i, 0, Math.log(a / this.eps) / this.kWear);
    this.dirty = true;
    this.stats.events++;
  }

  /** One gauge-clock step: integrate only cells whose certified window contains theta. */
  #step(dt) {
    const { u, w, n, d, k, kWear } = this;
    for (const [i, win] of this.live) {
      if (this.theta < win[0]) continue;                    // front hasn't arrived: certified asleep
      if (this.theta > win[1]) {                          // envelope says permanently below eps
        if (u[i] < this.eps && w[i] < this.eps) { this.live.delete(i); continue; }
        this.stats.violations++;                          // bound failed — keep the cell, report it
      }
      const l = i % n, m = i - l;
      const lap = (l > 0 ? u[i - 1] : u[i]) + (l < n - 1 ? u[i + 1] : u[i]) + (m >= n ? u[i - n] : u[i]) + (m < u.length - n ? u[i + n] : u[i]) - 4 * u[i];
      u[i] = Math.max(0, u[i] + dt * (d * lap - k * u[i]));
      w[i] = Math.max(0, w[i] - dt * kWear * w[i]);
      this.dirty = true;
      this.stats.touched++; this.stats.total++;
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
    this.stats.live = this.live.size;
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
}
