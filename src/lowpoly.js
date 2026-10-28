// Low-poly look: the same lidar valley, chiselled. Two things change, both in
// the terrain shaders and both behind one uniform so the toggle is instant:
//
//   1. Shading. The ground is lit by the plane through three lidar heights on
//      a world-fixed triangular lattice, not by the per-pixel gradient, so it
//      reads as cut facets. The facet size steps up by 4x with distance so a
//      facet always covers a handful of pixels (no shimmer far out), and the
//      step cross-fades instead of popping. The lattice is in world space, so
//      a facet you saw from the ridge is the same facet when you walk onto it:
//      no near/mid/far seam, which is the whole point.
//   2. Colour. Each facet takes one colour — the satellite image averaged over
//      the facet (a mip chosen from its size), pulled toward a small hand-picked
//      Rawah palette. No grain, tufts, pebbles or strata textures: those are the
//      detail layers that each die at their own distance.
//
// The geometry, World.height() and everything the hiker stands on are
// untouched; this is shading only.

export const LOWPOLY = {
  uLowPoly: { value: 0 },   // 0 = photographic, 1 = low poly
  uFacet: { value: 5 },     // nearest facet edge, metres
};

// sRGB palette (converted to linear in the shader, where diffuseColor lives)
const PALETTE = [
  [0x23, 0x3d, 0x26],   // spruce-fir timber
  [0x3e, 0x59, 0x30],   // lodgepole
  [0x6d, 0x86, 0x3e],   // green meadow
  [0x96, 0x8b, 0x5e],   // cured meadow
  [0x6c, 0x68, 0x3a],   // willow carr
  [0x8a, 0x6a, 0x45],   // tundra rust
  [0x5e, 0x4b, 0x3a],   // bare earth, burn
  [0x58, 0x52, 0x4a],   // dark rock
  [0x8c, 0x84, 0x77],   // talus
  [0xaa, 0xa2, 0x92],   // granite slab
  [0xe8, 0xec, 0xf0],   // snowfield
  [0x36, 0x55, 0x66],   // tarn
];
const lin = (c) => ((c / 255) ** 2.2).toFixed(4);
const PAL_GLSL = PALETTE.map((c) => `vec3(${lin(c[0])}, ${lin(c[1])}, ${lin(c[2])})`).join(',\n  ');

/** Uniforms and palette helpers. Needs uColorMap, uCover, uHasCover, uExtent in scope (ALBEDO_UNIFORMS); callers pass uGreen, which is declared later. */
export const LOWPOLY_PARS = /* glsl */ `
uniform float uLowPoly, uFacet;
const vec3 LP_PAL[${PALETTE.length}] = vec3[](
  ${PAL_GLSL}
);
float lpHash(vec2 c) { return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453); }
// nearest palette entry, measured on luminance and chroma separately so a dim green stays green
vec3 lpPalette(vec3 c) {
  float lc = dot(c, vec3(0.3, 0.55, 0.15));
  vec3 cc = c / max(lc, 1e-3);
  vec3 best = c; float bd = 1e9;
  for (int i = 0; i < ${PALETTE.length}; i++) {
    vec3 p = LP_PAL[i];
    float lp = dot(p, vec3(0.3, 0.55, 0.15));
    float dl = log2((lc + 0.004) / (lp + 0.004));
    vec3 dc = cc - p / max(lp, 1e-3);
    float d = dl * dl * 0.6 + dot(dc, dc);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
// one colour for a facet: the satellite colour averaged over it, greened for the season, pulled to the palette
vec3 lpColor(vec2 cen, float F, vec3 n, float green) {
  vec2 uv = cen / uExtent + 0.5;
  float texel = uExtent / float(textureSize(uColorMap, 0).x);
  vec3 c = textureLod(uColorMap, uv, max(0.0, log2(F / texel))).rgb;
  float lumA = dot(c, vec3(0.3, 0.55, 0.15));
  float meadow = smoothstep(0.012, 0.06, c.r - c.b) * (1.0 - smoothstep(0.32, 0.5, lumA));
  c = mix(c, vec3(0.33, 0.45, 0.19) * lumA * 1.75, green * meadow * 0.65);
  if (uHasCover > 0.5) {
    vec4 cov = textureLod(uCover, uv, 0.0);
    c = mix(c, LP_PAL[0] * 1.15, clamp(cov.r * 1.2 - 0.25, 0.0, 0.7));   // timber reads as timber, not as satellite mush
    c = mix(c, LP_PAL[8], clamp(cov.a * 1.2 - 0.3, 0.0, 0.6) * smoothstep(0.95, 0.6, n.y));
  }
  vec3 col = mix(c, lpPalette(c), 0.6);
  return col * (0.94 + 0.12 * lpHash(floor(cen * 7.31 / F)));   // a little per-facet variation, like cut stone
}
`;

/**
 * Facet normal and centroid on a triangular (simplex-skewed) lattice. Needs baseH() in scope (cdlod.js HEIGHT_GLSL).
 * lpNormal() picks the facet size from distance and cross-fades between sizes.
 */
export const LOWPOLY_FACET = /* glsl */ `
vec3 lpFacet(vec2 p, float F, out vec2 cen) {
  const float K = 0.36602540378, G = 0.21132486540;   // (sqrt3 - 1) / 2, (3 - sqrt3) / 6
  vec2 off = vec2(17.31, 5.77) * F / uFacet;          // each size gets its own lattice offset, so edges never stack
  vec2 q = p / F + off;
  vec2 s = floor(q + (q.x + q.y) * K);
  vec2 f = q - (s - (s.x + s.y) * G);
  vec2 o = f.x > f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 c0 = s, c1 = s + o, c2 = s + 1.0;
  vec2 P0 = (c0 - (c0.x + c0.y) * G - off) * F;
  vec2 P1 = (c1 - (c1.x + c1.y) * G - off) * F;
  vec2 P2 = (c2 - (c2.x + c2.y) * G - off) * F;
  vec3 A = vec3(P0.x, baseH(P0), P0.y), B = vec3(P1.x, baseH(P1), P1.y), C = vec3(P2.x, baseH(P2), P2.y);
  vec3 n = normalize(cross(C - A, B - A));
  n = n.y < 0.0 ? -n : n;
  cen = (P0 + P1 + P2) / 3.0;
  // a few degrees of tilt per facet, the way low-poly art cuts it, so even a smooth slope reads as facets
  vec2 j = vec2(lpHash(cen * 0.173), lpHash(cen * 0.291 + 7.7)) - 0.5;
  return normalize(n + vec3(j.x, 0.0, j.y) * 0.22);
}
// facets stay at least ~12 px wide: level l has edge uFacet * 4^l
// cA/F is the facet at this size, cB/4F the next one up, t how far the cross-fade has gone
vec3 lpNormal(vec2 p, float camD, out vec2 cA, out vec2 cB, out float F, out float t) {
  float L = clamp(log2(max(camD * 0.0013 * 12.0 / uFacet, 1.0)) * 0.5, 0.0, 3.0);
  float l0 = min(floor(L), 2.0);
  t = smoothstep(0.65, 1.0, L - l0);
  F = uFacet * exp2(2.0 * l0);
  vec3 n0 = lpFacet(p, F, cA);
  cB = cA;
  if (t <= 0.0) return n0;
  vec3 n1 = lpFacet(p, F * 4.0, cB);
  return normalize(mix(n0, n1, t));
}
`;
