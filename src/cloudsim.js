import { clamp, smoothstep } from './noise.js';
import { sunDirection } from './sky.js';

// Where the clouds are. A small live weather field, 128 x 128 cells of 500 m over 64 km around the map,
// carries humidity and cloud water on the wind aloft. Air pushed up a slope cools and its humidity rises;
// past saturation it condenses into cloud, which drifts downwind and dries out again where the air sinks in
// the lee. Afternoon sun heats the ridges and peaks into thermals that build cumulus over the crest and
// lets them tower. The weather schedule (weather.js) sets the large-scale humidity and instability; this
// field decides where, and a slow correction keeps its average cover near the schedule's so the HUD,
// the light and the forecast still agree with what you see.
//
// The result is packed into the G (cover) and B (how tall) channels of the shared cloud noise texture,
// whose R channel is the old static noise. The sky, the ground's cloud shadows, the light shafts and the
// stars already sample that texture, so none of them needs another texture unit (the terrain has none left).

export const SIM = { N: 128, E: 64000 };

const LIFT_PER_RH = 1700;   // metres of lift that multiply relative humidity by e (about 6% per 100 m)

export class CloudSim {
  constructor(world, tex) {
    const { N, E } = SIM;
    this.cell = E / N;
    this.tex = tex;
    this.data = tex.image.data;
    this.size = tex.image.width;
    const far = world.far, half = (far.N * far.cell) / 2;
    const at = (c, r) => far.h[clamp(r, 0, far.N - 1) * far.N + clamp(c, 0, far.N - 1)];
    const ground = (x, z) => {
      const u = clamp((x + half) / far.cell, 0, far.N - 1.001), v = clamp((z + half) / far.cell, 0, far.N - 1.001);
      const c = Math.floor(u), r = Math.floor(v), fx = u - c, fz = v - r;
      const a = at(c, r), b = at(c + 1, r), d = at(c, r + 1), e = at(c + 1, r + 1);
      return a + (b - a) * fx + (d - a) * fz + (a - b - d + e) * fx * fz;
    };
    const n = N * N;
    this.h = new Float32Array(n);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * this.cell - E / 2, z = (j + 0.5) * this.cell - E / 2;
      let s = 0;
      for (const [ox, oz] of [[-0.25, -0.25], [0.25, -0.25], [-0.25, 0.25], [0.25, 0.25]]) s += ground(x + ox * this.cell, z + oz * this.cell);
      this.h[j * N + i] = s / 4;
    }
    // ridgeness: height above the mean of the surrounding 3.5 km, so crests and peaks set off thermals
    const mean = blur(this.h, N, 3);
    this.ridge = new Float32Array(n);
    for (let k = 0; k < n; k++) this.ridge[k] = clamp((this.h[k] - mean[k]) / 350, -1, 1);
    this.gx = new Float32Array(n); this.gz = new Float32Array(n);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, H = (a, b) => this.h[clamp(b, 0, N - 1) * N + clamp(a, 0, N - 1)];
      this.gx[k] = (H(i + 1, j) - H(i - 1, j)) / (2 * this.cell);
      this.gz[k] = (H(i, j + 1) - H(i, j - 1)) / (2 * this.cell);
    }
    this.rh = new Float32Array(n).fill(0.6);   // relative humidity aloft, before any lift
    this.cw = new Float32Array(n);             // cloud water
    this.tall = new Float32Array(n);           // how deep the convection is, 0 flat to 1 towering
    this.cov = new Float32Array(n);
    this._a = new Float32Array(n); this._b = new Float32Array(n); this._c = new Float32Array(n);
    this.heat = 0;     // the day's heating of the ground: builds through the morning, peaks mid-afternoon
    this.bias = 0;     // slow correction that keeps the average cover near the schedule's
    this.wind = { x: 11, z: 4 };
    this.acc = 0;
    this.maxTall = 0;
  }

  /** Large-scale humidity the schedule asks for, with patches that drift slower than the wind. */
  #background(x, z, w) {
    const nz = this.#noise((x - w.offset.x * 0.45) / 160000, (z - w.offset.y * 0.45) / 160000);
    return 0.4 + 0.62 * w.cloud + 0.22 * (nz - 0.5) + this.bias;
  }

  #noise(u, v) {
    const n = this.size, d = this.data;
    const fx = (u - Math.floor(u)) * n, fy = (v - Math.floor(v)) * n;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const s = (i, j) => d[(((j % n) + n) % n * n + (((i % n) + n) % n)) * 4] / 255;
    const a = s(x0, y0), b = s(x0 + 1, y0), c = s(x0, y0 + 1), e = s(x0 + 1, y0 + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + e) * tx * ty;
  }

  /**
   * Advance. `dt` real seconds (the drift, which matches the noise offset), `gameSec` game seconds (forming,
   * drying and the day's heating), `w` the weather, `sunUp` the sun's height (sin).
   */
  update(dt, gameSec, w, sunUp) {
    this.acc += dt;
    this.gameAcc = (this.gameAcc || 0) + gameSec;
    if (this.acc < 0.25) return;
    this.#step(this.acc, this.gameAcc, w, sunUp);
    this.acc = 0; this.gameAcc = 0;
    this.#write();
  }

  /** Jump to the field this hour would have: replay the last six hours of heating and drift. */
  settle(w, hour) {
    this.rh.fill(0.4 + 0.62 * w.cloud); this.cw.fill(0); this.tall.fill(0);
    this.heat = 0; this.bias = 0; this.maxTall = 0;
    for (let k = 72; k > 0; k--) {
      const s = sunDirection(((hour - k / 12) % 24 + 24) % 24).y;
      this.#step(90, 300, w, s);
    }
    this.#write();
  }

  #step(dt, gs, w, sunUp) {
    const { N, E } = SIM, cell = this.cell;
    const vx = 11 + w.wind * 14, vz = 4 + w.wind * 5;   // the westerlies aloft, as weather.offset drifts
    this.wind.x = vx; this.wind.z = vz;
    const instab = clamp(0.2 + 0.55 * w.thick + 0.7 * w.storm, 0, 1.4);
    // ground heating lags the sun by a couple of hours, so cumulus peak in the afternoon, not at noon
    this.heat += (smoothstep(0.0, 0.7, sunUp) * instab - this.heat) * (1 - Math.exp(-gs / 7200));
    const kForm = 1 - Math.exp(-gs / 500), kDry = 1 - Math.exp(-gs / 1000), kBack = 1 - Math.exp(-gs / 3000);
    // drift: semi-Lagrangian, fresh background air blowing in at the upwind edges
    const sx = (vx * dt) / cell, sz = (vz * dt) / cell;
    const A = this._a, B = this._b, C = this._c;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, u = i - sx, v = j - sz;
      if (u < 0 || v < 0 || u > N - 1 || v > N - 1) {
        A[k] = this.#background((i + 0.5) * cell - E / 2, (j + 0.5) * cell - E / 2, w);
        B[k] = Math.max(0, w.cloud - 0.04) * 0.4;
        C[k] = 0.45 + 0.4 * w.cloud;
        continue;
      }
      const i0 = Math.floor(u), j0 = Math.floor(v), fx = u - i0, fz = v - j0;
      const k0 = j0 * N + i0, i1 = Math.min(i0 + 1, N - 1) - i0, j1 = (Math.min(j0 + 1, N - 1) - j0) * N;
      const bl = (f) => (f[k0] * (1 - fx) + f[k0 + i1] * fx) * (1 - fz) + (f[k0 + j1] * (1 - fx) + f[k0 + j1 + i1] * fx) * fz;
      A[k] = bl(this.rh); B[k] = bl(this.cw); C[k] = bl(this.tall);
    }
    let sum = 0, cnt = 0, top = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const x = (i + 0.5) * cell - E / 2, z = (j + 0.5) * cell - E / 2;
      let rh = A[k] + (this.#background(x, z, w) - A[k]) * kBack;
      // lift: the wind running up the slope (a few minutes of it), plus thermals off sunny crests
      const oro = clamp((vx * this.gx[k] + vz * this.gz[k]) * 420, -900, 1400);
      const therm = this.heat * Math.max(0, this.ridge[k] + 0.35) * 1500;
      const rhEff = rh * Math.exp((oro + therm) / LIFT_PER_RH);
      // the schedule's cover becomes condensation over the whole region; lift piles it over the terrain
      const baseCond = Math.max(0, w.cloud - 0.06) * 0.34;
      const liftCond = Math.max(0, rhEff - 0.95) * 1.5;
      const target = baseCond + liftCond;
      let cw = B[k];
      const was = cw;
      cw += (target - cw) * (target > cw ? kForm : kDry);
      rh -= (cw - was) * 0.08;   // condensing takes vapour out of the air, drying gives it back
      // how tall: puffs stay low, thermals and storms climb the slab
      const baseTall = 0.2 + 0.3 * w.cloud + 0.15 * w.thick;
      const tt = clamp(baseTall + (therm / 1400) * (0.3 + instab * 0.4) + w.storm * 0.4, 0.18, 1.0);
      const tall = C[k] + (tt - C[k]) * kForm;
      this.rh[k] = rh; this.cw[k] = cw; this.tall[k] = tall;
      const cov = clamp(1 - Math.exp(-cw * 5.0), 0, 1);
      this.cov[k] = cov;
      if (Math.abs(x) < 16000 && Math.abs(z) < 16000) { sum += cov; cnt++; }
      if (cov > 0.15 && tall > top) top = tall;
    }
    this.maxTall += (top - this.maxTall) * Math.min(1, gs / 600);   // the tallest cloud anywhere, which sets how deep the sky marches
    // keep the sky over the map near what the schedule says: more humid if too clear, drier if too cloudy
    this.bias = clamp(this.bias + (w.cloud - sum / cnt) * Math.min(1, gs / 900) * 0.25, -0.35, 0.35);
  }

  /** Cover and height at a point (CPU, for the light at the hiker). */
  coverAt(x, z) {
    const { N, E } = SIM;
    const u = clamp((x + E / 2) / this.cell - 0.5, 0, N - 1.001), v = clamp((z + E / 2) / this.cell - 0.5, 0, N - 1.001);
    const i = Math.floor(u), j = Math.floor(v), fx = u - i, fz = v - j, k = j * N + i, f = this.cov;
    return (f[k] * (1 - fx) + f[k + 1] * fx) * (1 - fz) + (f[k + N] * (1 - fx) + f[k + N + 1] * fx) * fz;
  }

  /** Upsample the field into the texture's G (cover) and B (height) channels. */
  #write() {
    const { N } = SIM, n = this.size, d = this.data, cov = this.cov, tall = this.tall;
    for (let y = 0; y < n; y++) {
      const v = clamp((y + 0.5) / n * N - 0.5, 0, N - 1.001), j = Math.floor(v), fz = v - j;
      for (let x = 0; x < n; x++) {
        const u = clamp((x + 0.5) / n * N - 0.5, 0, N - 1.001), i = Math.floor(u), fx = u - i, k = j * N + i;
        const a = (cov[k] * (1 - fx) + cov[k + 1] * fx) * (1 - fz) + (cov[k + N] * (1 - fx) + cov[k + N + 1] * fx) * fz;
        const b = (tall[k] * (1 - fx) + tall[k + 1] * fx) * (1 - fz) + (tall[k + N] * (1 - fx) + tall[k + N + 1] * fx) * fz;
        const o = (y * n + x) * 4;
        d[o + 1] = a * 255; d[o + 2] = b * 255;
      }
    }
    this.tex.needsUpdate = true;
  }
}

function blur(src, N, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let o = -r; o <= r; o++) { const ii = i + o; if (ii >= 0 && ii < N) { s += src[j * N + ii]; c++; } }
    tmp[j * N + i] = s / c;
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let s = 0, c = 0;
    for (let o = -r; o <= r; o++) { const jj = j + o; if (jj >= 0 && jj < N) { s += tmp[jj * N + i]; c++; } }
    out[j * N + i] = s / c;
  }
  return out;
}
