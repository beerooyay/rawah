import * as THREE from 'three';
import { Boxels } from './boxels.js';

// The water remembers. A second certified-window field (the boxels of
// `boxels.js`, tuned for water) holds two things over every lake, pond and
// stream in the valley, not just the ones near you:
//   R  turbidity: silt stirred up by wading, swimming, a quad, a fish, or washed
//      in by heavy rain. It spreads, settles (about 80 s to fade) and in a
//      stream is carried downhill, so what you kick up at one pool clouds the
//      water below it a minute later.
//   G  foam: whitecaps in a storm, a wake's churn, rain on a creek. It does not
//      spread and fades on its own clock.
// Events are the boxel events (`wet` for silt, `wear` for foam), so the whole
// field is certified the same way as the ground's moisture: a per-cell ledger of
// peaks, the tolerance split, merging, and sleeping everything the ledger clears.
// Streams carry silt with a cascade of smaller puffs that walk downstream, each
// its own event, instead of an advection term.
//
// Lakes and streams read it with `waterState(xz)` -> (turbidity, foam).

export const WATERBOX = {
  uWaterTex: { value: null },
  uWaterExt: { value: 4096 },
};

export const WATERBOX_GLSL = /* glsl */ `
uniform sampler2D uWaterTex;
uniform float uWaterExt;
vec2 waterState(vec2 xz) { return texture2D(uWaterTex, xz / uWaterExt + 0.5).rg; }
// silt clouds the water and takes the blue out of it; foam lies in broken patches
vec4 waterTint(vec2 xz, vec3 col, float t, vec2 st) {
  float turb = clamp((st.x - 0.03) * 1.9, 0.0, 0.78);
  col = mix(col, vec3(0.34, 0.29, 0.21), turb);
  vec2 wq = vec2(dot(xz, uWindDir), dot(xz, vec2(-uWindDir.y, uWindDir.x)));   // streaks lie along the wind
  float n = wNoise(wq * vec2(0.8, 2.6) + t * 0.1) * 0.5 + wNoise(wq * vec2(2.2, 7.5) - t * 0.15) * 0.3 + wNoise(wq * vec2(5.0, 16.0) + t * 0.2) * 0.2;
  float cover = smoothstep(0.1, 0.6, st.y);                       // faint foam stays invisible; heavy foam breaks into streaks
  float foam = cover * smoothstep(0.72 - 0.35 * cover, 0.86 - 0.3 * cover, n);
  col = mix(col, vec3(0.93, 0.96, 0.97), clamp(foam, 0.0, 0.9));
  return vec4(col, max(turb * 0.85, foam));
}
`;

export class WaterCells {
  constructor(world) {
    this.world = world;
    // cells are about 29 m; d and k are in cell units per gauge time (the lattice windows need a decay length of 5 cells or more to hold)
    this.b = new Boxels(world, { n: 512, d: 0.3, k: 0.012, kWear: 0.08, eps: 0.01 });
    const tx = this.b.texture;
    tx.magFilter = THREE.LinearFilter; tx.minFilter = THREE.LinearFilter; tx.generateMipmaps = false;
    tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
    WATERBOX.uWaterTex.value = tx;
    WATERBOX.uWaterExt.value = world.extent;
    this.carry = [];          // puffs of silt walking downstream: { x, z, a, t }
    this.clock = 0;
    this.tickRain = 0; this.tickFoam = 0;
  }

  /** Silt stirred up at a point: a splash, a wade, a wake. `a` is how much (0..1 of a cell's worth). */
  stir(x, z, a, onStream = false, r = 0) {
    this.b.wet(x, z, a, r);
    if (onStream && a > 0.02) this.carry.push({ x, z, a: a * 0.8, t: this.clock + 1.2 });
  }

  /** Foam churned up at a point. */
  foam(x, z, a = 0.4) { this.b.wear(x, z, a); }

  /**
   * ctx: { p (you), wind 0..1, precip 0..1, waterAt(x, z), flowAt(x, z) -> {x, z} m/s, onStream(x, z), lakeAt(x, z) }
   */
  update(dt, ctx) {
    this.clock += dt;
    const { p } = ctx;
    // heavy rain washes silt into the creeks and churns them white
    this.tickRain -= dt;
    if (ctx.precip > 0.25 && this.tickRain <= 0) {
      this.tickRain = 1.2 / ctx.precip;
      for (let k = 0; k < 4; k++) {
        const x = p.x + (Math.random() - 0.5) * 360, z = p.z + (Math.random() - 0.5) * 360;
        if (ctx.onStream(x, z)) { this.stir(x, z, 0.03 * ctx.precip, true); this.foam(x, z, 0.08 * ctx.precip); }
      }
    }
    // whitecaps on the open water when it blows
    this.tickFoam -= dt;
    if (ctx.wind > 0.55 && this.tickFoam <= 0) {
      this.tickFoam = 0.35 / (ctx.wind - 0.4);
      for (let k = 0; k < 3; k++) {
        const x = p.x + (Math.random() - 0.5) * 300, z = p.z + (Math.random() - 0.5) * 300;
        if (ctx.lakeAt(x, z)) this.foam(x, z, 0.12 + 0.3 * (ctx.wind - 0.55));
      }
    }
    // silt walks downstream a step at a time, thinning as it goes
    for (let i = this.carry.length - 1; i >= 0; i--) {
      const c = this.carry[i];
      if (this.clock < c.t) continue;
      const f = ctx.flowAt(c.x, c.z);
      const sp = Math.hypot(f.x, f.z);
      if (sp < 0.05 || c.a < 0.012) { this.carry.splice(i, 1); continue; }
      c.x += f.x / sp * 14; c.z += f.z / sp * 14;     // a stream-lit hop: a few seconds of current, scaled so the puff clears a ~29 m cell
      if (!ctx.onStream(c.x, c.z)) { this.carry.splice(i, 1); continue; }
      this.b.wet(c.x, c.z, c.a, 0);
      c.a *= 0.88; c.t = this.clock + 2.5;
    }
    if (this.carry.length > 160) this.carry.splice(0, this.carry.length - 160);
    this.b.update(dt, 0.5);   // water mixes at half the ground's clock: a cloud of silt takes minutes to spread and clear
  }

  /** Turbidity and foam at a world point. */
  at(x, z) { const s = this.b.sample(x, z); return { turbidity: s.u, foam: s.w }; }
}
