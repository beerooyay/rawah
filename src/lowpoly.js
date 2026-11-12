import { VEGETATION_GLSL } from './vegetation-grade.js';
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
  uFacet: { value: 6 },     // nearest facet edge, metres
  uAlpine: { value: 0 },    // with uLowPoly on: 1 = the painted alpine look (smooth ground, no facets)
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
uniform float uLowPoly, uFacet, uAlpine;
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
  vec3 c = textureLod(uColorMap, uv, max(0.0, log2(F / texel) + 1.0)).rgb;   // a mip wider than the facet, so neighbours agree more
  float lumA = dot(c, vec3(0.3, 0.55, 0.15));
  float meadow = smoothstep(0.012, 0.06, c.r - c.b) * (1.0 - smoothstep(0.32, 0.5, lumA));
  c = mix(c, vec3(0.33, 0.45, 0.19) * lumA * 1.75, green * meadow * 0.65);
  if (uHasCover > 0.5) {
    vec4 cov = textureLod(uCover, uv, 0.0);
    c = mix(c, LP_PAL[0] * 1.15, clamp(cov.r * 1.2 - 0.25, 0.0, 0.7));   // timber reads as timber, not as satellite mush
    c = mix(c, LP_PAL[8], clamp(cov.a * 1.2 - 0.3, 0.0, 0.6) * smoothstep(0.95, 0.6, n.y));
  }
  vec3 col = mix(c, lpPalette(c), 0.6);
  return col * (0.93 + 0.14 * lpHash(floor(cen * 7.31 / F)));   // a little per-facet variation, like cut stone
}
`;

// The alpine look, after the Twin Crater scene (land/Rawah V15, land/RawahTwinCrater/main.js): no satellite
// picture at all. Ground is either turf or mineral, chosen by slope and the land-cover map; the mineral runs
// between a blue-grey and a tan in broad bands, turf follows the season, timber is one dark fir green.
// Smooth normals, the game's own light. Needs uNoise as well as the cover uniforms.
export const ALPINE_GLSL = /* glsl */ `
${VEGETATION_GLSL}
vec3 alColor(vec3 wp, vec3 n, float turfY, float camD, vec2 boxel) {
  vec2 uv = wp.xz / uExtent + 0.5;
  float macro = texture2D(uNoise, wp.xz / 310.0 + wp.y / 900.0).r * 0.6 + texture2D(uNoise, wp.xz / 71.0 + wp.y / 55.0 + 0.37).r * 0.4;
  float mid = mix(texture2D(uNoise, wp.xz / 9.0 + wp.y / 17.0 + 0.61).r, macro, smoothstep(180.0, 1100.0, camD));
  float grit = mix(texture2D(uNoise, wp.xz / 0.7).r, 0.5, smoothstep(70.0, 240.0, camD));
  vec3 mineral = mix(vec3(0.21, 0.25, 0.29), vec3(0.39, 0.28, 0.173), smoothstep(0.34, 0.66, macro));
  mineral *= 0.82 + 0.33 * mid + (grit - 0.5) * 0.12;
  // drawn detail up close: on rock, bedding bands and dark joint lines projected sideways, and pale chips; on flat ground, pebble speckle
  float dK = 1.0 - smoothstep(60.0, 180.0, camD);
  if (dK > 0.0 && n.y < 0.79) {
    vec3 an = abs(n) + 1e-4; float wx = an.x / (an.x + an.z);
    float bed = mix(texture2D(uNoise, vec2(wp.x / 23.0, wp.y / 1.9)).r, texture2D(uNoise, vec2(wp.z / 23.0, wp.y / 1.9)).r, wx);
    float joint = mix(texture2D(uNoise, vec2(wp.x / 1.6, wp.y / 13.0)).r, texture2D(uNoise, vec2(wp.z / 1.6, wp.y / 13.0)).r, wx);
    float steep = 1.0 - smoothstep(0.6, 0.85, n.y);
    float crack = (smoothstep(0.64, 0.7, joint) * 0.7 + smoothstep(0.7, 0.76, bed) * 0.45) * steep;
    float chip = smoothstep(0.78, 0.84, texture2D(uNoise, wp.xz / 0.55 + wp.y * 0.3).r);
    float peb = smoothstep(0.72, 0.8, texture2D(uNoise, wp.xz / 0.32).r) * (1.0 - steep);
    mineral *= mix(1.0, (0.88 + bed * 0.24) * (1.0 - clamp(crack, 0.0, 1.0) * 0.55) * (1.0 + chip * 0.25) * (1.0 - peb * 0.3 + smoothstep(0.85, 0.9, grit) * 0.25), dK);
  }
  vec3 turf = plantGrade(turfBase(), boxel.r, 0.65);   // the grass field's average colour
  turf = mix(turf, turf * vec3(1.13, 1.17, 0.89), smoothstep(0.45, 0.66, macro));
  // Reuse the ground-grain sample for short blades, pockets of moss and exposed thatch.
  // The existing mip chain softens it at grazing angles and on distant slopes.
  float shortGrass = smoothstep(0.32, 0.69, grit);
  turf *= 0.77 + 0.29 * mid + shortGrass * 0.30;
  turf = mix(turf, turf * vec3(1.26, 1.07, 0.81), dK * (1.0 - smoothstep(0.07, 0.28, grit)) * 0.48);
  vec4 cov = uHasCover > 0.5 ? texture2D(uCover, uv) : vec4(0.0);
  // the ground follows how much grass grows here (grass.js grows by 1 - cover.a, the rock fraction): where the grass is
  // thinned by scattered rock the ground between the tufts is a darker turf, and only nearly bare rock reads as stone
  float growK = turfPotential(cov) * smoothstep(0.45, 0.65, turfY + (mid - 0.5) * 0.14) * (1.0 - smoothstep(3700.0, 3960.0, wp.y));
  float grassW = smoothstep(0.08, 0.3, growK);
  turf *= mix(0.6, 1.0, smoothstep(0.3, 0.8, growK));
  float litter = smoothstep(0.10, 0.74, boxel.g);
  vec3 duff = mix(vec3(0.128, 0.088, 0.047), vec3(0.224, 0.154, 0.080), grit);
  vec3 col = mix(mineral, mix(turf, duff, litter * 0.74), grassW);

  col = mix(col, vec3(0.15, 0.205, 0.085), (1.0 - grassW) * smoothstep(0.62, 0.91, n.y) * smoothstep(0.5, 0.62, mid) * 0.5);   // lichen on the flatter rock
  float farK = smoothstep(300.0, 1200.0, camD), up = smoothstep(0.3, 0.6, n.y);
  col = mix(col, vec3(0.25, 0.21, 0.16) * (0.8 + 0.4 * mid), clamp(cov.g * 1.2, 0.0, 1.0) * 0.55);                 // burn
  col = mix(col, vec3(0.30, 0.42, 0.08), clamp(cov.b * 1.2, 0.0, 1.0) * farK * up * 0.7);                           // aspen
  vec3 canopy = plantGrade(mix(vec3(0.034, 0.108, 0.051), vec3(0.08, 0.171, 0.06), smoothstep(0.32, 0.72, mid)), boxel.r, 0.28);
  col = mix(col, canopy, clamp(cov.r * 1.25, 0.0, 1.0) * mix(0.35, 0.9, farK) * up);               // timber
  return col;
}
`;

/**
 * Facet normal and centroid on a triangular (simplex-skewed) lattice. Needs baseH() in scope (cdlod.js HEIGHT_GLSL).
 * The facet is worked out per pixel, so its edges would stair-step like a texture with no filtering: near an edge
 * the facet across it is found too (the corner opposite, mirrored over the edge) and the two are blended over
 * one pixel. lpNormal() picks the facet size from distance and cross-fades between sizes.
 */
export const LOWPOLY_FACET = /* glsl */ `
vec3 lpPlane(vec2 P0, vec2 P1, vec2 P2, out vec2 cen) {
  vec3 A = vec3(P0.x, baseH(P0), P0.y), B = vec3(P1.x, baseH(P1), P1.y), C = vec3(P2.x, baseH(P2), P2.y);
  vec3 n = normalize(cross(C - A, B - A));
  n = n.y < 0.0 ? -n : n;
  cen = (P0 + P1 + P2) / 3.0;
  // a little tilt per facet so even a smooth slope reads as cut planes, and the slope itself pushed a bit
  // steeper so neighbouring facets part in light and shade (the low-poly look is all in that contrast)
  vec2 j = vec2(lpHash(cen * 0.173), lpHash(cen * 0.291 + 7.7)) - 0.5;
  return normalize(vec3(n.x * 1.7 + j.x * 0.22, n.y, n.z * 1.7 + j.y * 0.22));
}
// a lattice corner in world metres: the regular triangular lattice with every corner nudged by its own hash, so the
// triangles come out irregular like cut low-poly art instead of pairing up into a grid of diamonds (which reads as pixels)
vec2 lpVert(vec2 c, float F, vec2 off) {
  const float G = 0.21132486540;
  vec2 j = vec2(lpHash(c + off * 3.1), lpHash(c.yx + off * 1.7 + 4.3)) - 0.5;
  return (c - (c.x + c.y) * G - off + j * 0.42) * F;
}
// px: one pixel's footprint in metres. cenN/w: the facet across the nearest edge and how much of it to blend in
vec3 lpFacet(vec2 p, float F, float px, out vec2 cen, out vec2 cenN, out float w) {
  const float K = 0.36602540378, G = 0.21132486540;   // (sqrt3 - 1) / 2, (3 - sqrt3) / 6
  vec2 off = vec2(17.31, 5.77) * F / uFacet;          // each size gets its own lattice offset, so edges never stack
  vec2 q = p / F + off;
  vec2 s = floor(q + (q.x + q.y) * K);
  vec2 f = q - (s - (s.x + s.y) * G);
  vec2 c0 = s, c1 = s + (f.x > f.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0)), c2 = s + 1.0;
  // the regular triangle is a first guess; with nudged corners p can sit just over an edge, so step across it
  vec2 P0, P1, P2; float b0, b1, b2, den;
  for (int k = 0; k < 3; k++) {
    P0 = lpVert(c0, F, off); P1 = lpVert(c1, F, off); P2 = lpVert(c2, F, off);
    vec2 e1 = P1 - P0, e2 = P2 - P0, v = p - P0;
    den = e1.x * e2.y - e1.y * e2.x;
    b1 = (v.x * e2.y - v.y * e2.x) / den; b2 = (e1.x * v.y - e1.y * v.x) / den; b0 = 1.0 - b1 - b2;
    if (min(b0, min(b1, b2)) >= 0.0) break;
    if (b0 <= b1 && b0 <= b2) c0 = c1 + c2 - c0;
    else if (b1 <= b2) c1 = c0 + c2 - c1;
    else c2 = c0 + c1 - c2;
  }
  vec3 n = lpPlane(P0, P1, P2, cen);
  // the smallest barycentric weight says which edge is nearest; times that corner's altitude, how far it is
  vec2 cn, A, B; float bm;
  if (b0 <= b1 && b0 <= b2) { bm = b0; A = P1; B = P2; cn = c1 + c2 - c0; }
  else if (b1 <= b2) { bm = b1; A = P0; B = P2; cn = c0 + c2 - c1; }
  else { bm = b2; A = P0; B = P1; cn = c0 + c1 - c2; }
  w = 0.5 * (1.0 - smoothstep(0.0, px, max(bm, 0.0) * abs(den) / length(B - A)));
  cenN = cen;
  if (w <= 0.0) return n;
  vec3 nN = lpPlane(A, B, lpVert(cn, F, off), cenN);
  return normalize(mix(n, nN, w));
}
// facets stay at least ~36 px wide (smaller reads as noise, not as cut planes): level l has edge uFacet * 4^l
// cA/F is the facet at this size (cAN, wA its edge blend), cB/4F the next one up, t how far the cross-fade has gone
vec3 lpNormal(vec2 p, float camD, out vec2 cA, out vec2 cAN, out float wA, out vec2 cB, out float F, out float t) {
  float px = max(length(fwidth(p)), 1e-3);
  float L = clamp(log2(max(camD * 0.0013 * 36.0 / uFacet, 1.0)) * 0.5, 0.0, 3.0);
  float l0 = min(floor(L), 2.0);
  t = smoothstep(0.65, 1.0, L - l0);
  F = uFacet * exp2(2.0 * l0);
  vec3 n0 = lpFacet(p, F, px, cA, cAN, wA);
  cB = cA;
  if (t <= 0.0) return n0;
  vec2 cBN; float wB;
  vec3 n1 = lpFacet(p, F * 4.0, px, cB, cBN, wB);
  return normalize(mix(n0, n1, t));
}
`;
