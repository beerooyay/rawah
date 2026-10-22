import { vnoise } from './detail.js';

// One wind field for everything. Gusts are noise advected along the prevailing
// westerlies, so a gust you see flatten a meadow reaches the trees, then you,
// then the wind in your ears. Grass, trees, impostors and the audio all sample
// this same function: GLSL for the GPU, JS for sound.

export const WIND_DIR = (() => { const x = 0.92, z = 0.38, l = Math.hypot(x, z); return [x / l, z / l]; })();
const SPEED = 9;   // m/s the gust pattern travels

/** Gust strength 0..1 at (x, z), time t, scaled by the day's breeze `calm` (0 still .. 1 blustery). */
export function gustAt(x, z, t, calm = 1) {
  const ax = x - WIND_DIR[0] * SPEED * t, az = z - WIND_DIR[1] * SPEED * t;
  const g = vnoise(ax / 70, az / 70) * 0.65 + vnoise(ax / 19 + 7.1, az / 19 - 3.3) * 0.35;
  return Math.min(1, Math.max(0, (g - 0.35) * 1.8)) ** 1.5 * calm;
}

// needs NOISE_GLSL (detail.js) before it
export const WIND_GLSL = /* glsl */ `
uniform float uTime, uCalm;
const vec2 WIND_DIR = vec2(${WIND_DIR[0].toFixed(5)}, ${WIND_DIR[1].toFixed(5)});
float gustAt(vec2 xz) {
  vec2 a = xz - WIND_DIR * ${SPEED.toFixed(1)} * uTime;
  float g = vnoise(a / 70.0) * 0.65 + vnoise(a / 19.0 + vec2(7.1, -3.3)) * 0.35;
  return pow(clamp((g - 0.35) * 1.8, 0.0, 1.0), 1.5) * uCalm;
}
`;
