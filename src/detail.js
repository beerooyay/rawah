// Fractal micro-relief layered on top of the lidar. The lidar gives the true
// shape of the land down to ~3.6 m; below that, seeded value noise adds the
// lumps, steps and hummocks you feel underfoot, rougher on rock, gentler in
// meadows, and switched off on trails, roads, streams and lake shores.
//
// The same function exists twice, in JS for collision and placement and in
// GLSL for the terrain shader, and the two must stay in lock-step: integer
// hashing on 32-bit unsigned arithmetic (Math.imul / uint), identical lattice
// offsets, octaves and weights.

export const OCTAVES = [
  // wavelength (m), amplitude (relative), lattice offset
  [11.0, 0.55, 17.31],
  [5.3, 0.3, -9.13],
  [2.4, 0.17, 4.77],
  [1.15, 0.09, -21.4],
];

export function ihash(x, y) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = ihash(xi, zi), b = ihash(xi + 1, zi), c = ihash(xi, zi + 1), d = ihash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Relief in metres at (x, z). `amp` from land cover and mask; `spacing` fades octaves the mesh can't show. */
export function relief(x, z, amp, rock, spacing = 0) {
  if (amp <= 0) return 0;
  let sum = 0;
  for (const [len, w, off] of OCTAVES) {
    const fade = 1 - smooth(len * 0.25, len * 0.5, spacing);
    if (fade <= 0) continue;
    let n = vnoise(x / len + off, z / len - off) - 0.5;
    n = n + (0.25 - Math.abs(n)) * rock * 1.2; // ridged, blocky on rock
    sum += n * w * fade;
  }
  return sum * amp;
}

/** Relief amplitude in metres from rockiness (0..1) and the smoothing mask (0..1). */
export function reliefAmp(rock, mask) {
  return (0.32 + 0.9 * rock) * (1 - mask);
}

function smooth(a, b, v) {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export const GLSL = /* glsl */ `
float ihash(ivec2 p) {
  uint x = uint(p.x), y = uint(p.y);
  uint h = (x * 0x27d4eb2du) ^ (y * 0x165667b1u);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h ^= h >> 12u;
  return float(h) / 4294967296.0;
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  ivec2 c = ivec2(i);
  float a = ihash(c), b = ihash(c + ivec2(1, 0)), d = ihash(c + ivec2(0, 1)), e = ihash(c + ivec2(1, 1));
  return a + (b - a) * u.x + (d - a) * u.y + (a - b - d + e) * u.x * u.y;
}
float relief(vec2 xz, float amp, float rock, float spacing) {
  if (amp <= 0.0) return 0.0;
  float sum = 0.0;
  ${OCTAVES.map(([len, w, off]) => `{
    float fade = 1.0 - smoothstep(${(len * 0.25).toFixed(4)}, ${(len * 0.5).toFixed(4)}, spacing);
    float n = vnoise(vec2(xz.x / ${len.toFixed(4)} + ${off.toFixed(4)}, xz.y / ${len.toFixed(4)} - ${off.toFixed(4)})) - 0.5;
    n = n + (0.25 - abs(n)) * rock * 1.2;
    sum += n * ${w.toFixed(4)} * fade;
  }`).join('\n  ')}
  return sum * amp;
}
float reliefAmp(float rock, float mask) { return (0.32 + 0.9 * rock) * (1.0 - mask); }
`;
