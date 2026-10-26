import * as THREE from 'three';

// Mountain ground from the user's terrain pack: five photographic sets, one array layer each, in the order
//   0 alpine talus / scree    steep-to-moderate rubble slopes under the cliffs, above treeline
//   1 glacial till            the unsorted gravel and cobbles of cirque floors and moraines
//   2 weathered alpine bedrock  cliffs and ledges: steep faces and the rock the land cover maps
//   3 subalpine meadow ground   open, vegetated ground (tundra and the clearings between the trees)
//   4 wet creekside alluvium    damp ground by streams and lakes, and wherever the boxels hold moisture
// (assets/mountain, made by tools/pack_mountain.py: `_albedo.jpg`, and `_nh.webp` holding the slope the tile adds to the
// surface normal in R, G already in the terrain's own convention, and the height in B.)
//
// Which set goes where is read from what the game already knows: the slope of the surface (`wn`), the Sentinel-2 land cover
// (forest, aspen, burn, rock), height against the treeline, the stream/lake mask, a slow noise that mosaics till and
// meadow, and the boxel field. Moisture in the ground boxels brings the creekside alluvium up and darkens the rock, so ground
// that rain or a creek has soaked turns dark and muddy, then dries back as the field fades.
//
// Tiling: a plain repeat shows up as a pattern from any ridge. Three things break it. (1) hex tiling (Mikkelsen, "Practical
// Real-Time Hex-Tiling"): space is cut into overlapping hexagonal cells, each cell reads the texture at its own random
// offset and rotation, and the three cells that meet at a point are blended with their weights so the contrast is kept;
// the slope vectors are turned back by each cell's rotation. (2) a second, much larger and differently turned copy of the
// albedo is mixed in, so the small pattern does not repeat at the scale of the large one. (3) slow noise on brightness. Far
// away (past 450 m) a tile is smaller than a pixel and a single tap is enough: the mip chain averages it.
// The albedo is applied as a relative detail over the satellite colour at a distance (the imagery's big light and dark
// patches, snow and vegetation stay), and as the photograph's own colour up close.

export const MTN = {
  uMtnA: { value: null }, uMtnN: { value: null },
  uMtnOn: { value: 0 }, uMtnStrength: { value: 0.92 }, uMtnNormal: { value: 0.3 },
};

const FILES = ['alpine_talus_scree', 'glacial_till_diamicton', 'weathered_alpine_bedrock', 'subalpine_meadow_ground', 'wet_creekside_alluvium'];

export async function loadMountain(base = './assets/mountain/') {
  try {
    const S = 1024, n = FILES.length, A = new Uint8Array(S * S * 4 * n), N = new Uint8Array(S * S * 4 * n);
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const load = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error(url)); im.src = url; });
    for (let i = 0; i < n; i++) {
      for (const [file, arr] of [['albedo.jpg', A], ['nh.webp', N]]) {
        const im = await load(`${base}${FILES[i]}_${file}`);
        g.clearRect(0, 0, S, S); g.drawImage(im, 0, 0, S, S);
        arr.set(g.getImageData(0, 0, S, S).data, i * S * S * 4);
      }
    }
    const make = (data, srgb) => {
      const t = new THREE.DataArrayTexture(data, S, S, n);
      t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true;
      return t;
    };
    MTN.uMtnA.value = make(A, true);
    MTN.uMtnN.value = make(N, false);
    MTN.uMtnOn.value = 1;
  } catch (e) { console.warn('mountain textures not loaded, keeping the satellite ground:', e.message); }
}

/** Declarations and the hex-tiled sampler. Shared by every terrain shader (they all take ALBEDO_UNIFORMS). */
export const MTN_PARS = /* glsl */ `
uniform highp sampler2DArray uMtnA, uMtnN;
uniform float uMtnOn, uMtnStrength, uMtnNormal;
// metres per tile: talus, till, bedrock, meadow, creekside
const float MTN_TILE[5] = float[5](5.0, 6.5, 13.0, 3.4, 3.2);
const float MTN_K = 1.55;                       // hex cells per tile (the cells are about 0.6 of a tile across)
vec2 mtnHash(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
// one set at tile coordinate uv, hex-tiled; alb is the albedo, nh holds the surface slope (xy) and the height (z)
void mtnSample(float layer, vec2 uv, vec2 dx, vec2 dy, float doN, out vec3 alb, out vec3 nh) {
  vec2 sk = mat2(1.0, -0.57735027, 0.0, 1.15470054) * (uv * MTN_K);
  vec2 bid = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  float s = step(0.0, -t.z), s2 = 2.0 * s - 1.0;
  vec3 w = vec3(-t.z * s2, s - t.y * s2, s - t.x * s2);
  vec2 vtx[3] = vec2[3](bid + vec2(s, s), bid + vec2(s, 1.0 - s), bid + vec2(1.0 - s, s));
  vec3 avg = textureLod(uMtnA, vec3(0.5, 0.5, layer), 10.0).rgb;
  vec3 aSum = vec3(0.0);
  vec2 nSum = vec2(0.0);
  float hSum = 0.0, w2 = 0.0;
  for (int i = 0; i < 3; i++) {
    float wi = i == 0 ? w.x : (i == 1 ? w.y : w.z);
    vec2 h = mtnHash(vtx[i]);
    float ang = (h.x - 0.5) * 5.4;
    float cs = cos(ang), sn = sin(ang);
    mat2 R = mat2(cs, sn, -sn, cs);
    vec2 cen = (mat2(1.0, 0.0, 0.5, 0.8660254) * vtx[i]) / MTN_K;
    vec2 q = R * (uv - cen) + cen + h * 31.7;
    vec3 a = textureGrad(uMtnA, vec3(q, layer), R * dx, R * dy).rgb;
    aSum += wi * (a - avg);
    w2 += wi * wi;
    if (doN > 0.5) {
      vec3 n = textureGrad(uMtnN, vec3(q, layer), R * dx, R * dy).rgb;
      vec2 so = (n.rg - 0.5) * 4.0;
      nSum += wi * (so * R);                       // back from the cell's turned frame
      hSum += wi * n.b;
    }
  }
  float k = inversesqrt(max(w2, 1e-4));            // keeps the contrast the blend would otherwise average away
  alb = max(avg + aSum * k, 0.0);
  nh = vec3(nSum * k, hSum);
}
// a set on a surface of any slope: the flat plane (hex-tiled when hex is set) for the part facing up, and the two vertical planes
// for the part facing sideways, so cliffs get the photograph undistorted instead of the ground tile smeared down them.
// tw: the triplanar weights (x: the plane across x, y: the ground plane, z: the plane across z).
// noff: the normal offset in world axes; ht: the height channel.
void mtnTri(float layer, float tile, vec3 wp, vec2 pdx, vec2 pdy, vec3 wdx, vec3 wdy, vec3 tw, float hex, float doN, out vec3 alb, out vec3 noff, out float ht) {
  alb = vec3(0.0); noff = vec3(0.0); ht = 0.0;
  if (tw.y > 0.01) {
    vec3 a, nh;
    vec2 uv = wp.xz / tile;
    if (hex > 0.5) mtnSample(layer, uv, pdx / tile, pdy / tile, doN, a, nh);
    else { a = textureGrad(uMtnA, vec3(uv, layer), pdx / tile, pdy / tile).rgb; nh = vec3(0.0, 0.0, 0.5); }
    alb += a * tw.y; noff += vec3(nh.x, 0.0, nh.y) * tw.y; ht += nh.z * tw.y;
  }
  if (tw.x > 0.01) {
    vec2 uv = vec2(wp.z, wp.y) / tile + vec2(0.17, 0.41), dx = vec2(wdx.z, wdx.y) / tile, dy = vec2(wdy.z, wdy.y) / tile;
    vec2 so = vec2(0.0); float h = 0.5;
    vec3 a = textureGrad(uMtnA, vec3(uv, layer), dx, dy).rgb;
    if (doN > 0.5) { vec3 n = textureGrad(uMtnN, vec3(uv, layer), dx, dy).rgb; so = (n.rg - 0.5) * 4.0; h = n.b; }
    alb += a * tw.x; noff += vec3(0.0, so.y, so.x) * tw.x; ht += h * tw.x;
  }
  if (tw.z > 0.01) {
    vec2 uv = vec2(wp.x, wp.y) / tile + vec2(0.53, 0.29), dx = vec2(wdx.x, wdx.y) / tile, dy = vec2(wdy.x, wdy.y) / tile;
    vec2 so = vec2(0.0); float h = 0.5;
    vec3 a = textureGrad(uMtnA, vec3(uv, layer), dx, dy).rgb;
    if (doN > 0.5) { vec3 n = textureGrad(uMtnN, vec3(uv, layer), dx, dy).rgb; so = (n.rg - 0.5) * 4.0; h = n.b; }
    alb += a * tw.z; noff += vec3(so.x, so.y, 0.0) * tw.z; ht += h * tw.z;
  }
}`;

/**
 * Start of NEAR_NORMAL (cdlod.js). Decides which two sets this spot is (`mtnId0/1`, `mtnMix`), how much of it they own
 * (`mtnW`), fetches both albedos (`mtnAlb0/1`, with a big turned copy mixed in) and, near, tilts `wn` by their slopes.
 * Needs p, camD, wn, vWPos, uCover, uBoxel, uNoise, uExtent, uWet, uSnow and maskAt() in scope, and `float mtnW = 0.0` declared.
 */
export const MTN_NORMAL = /* glsl */ `
        vec3 mtnAlb0 = vec3(0.5), mtnAlb1 = vec3(0.5), mtnAvg0 = vec3(0.5), mtnAvg1 = vec3(0.5);
        float mtnMix = 0.0, mtnWet = 0.0, mtnHt = 0.5;
        vec2 mpx = dFdx(p), mpy = dFdy(p);
        vec3 wdx = dFdx(vWPos), wdy = dFdy(vWPos);
        vec3 tw = pow(abs(wn), vec3(4.0));
        tw /= tw.x + tw.y + tw.z;
        if (uMtnOn > 0.5 && camD < 9000.0) {
          vec4 mc = texture2D(uCover, p / uExtent + 0.5);
          float forest = clamp(mc.r * 1.3 + mc.b, 0.0, 1.0), rock = clamp(mc.a * 1.4, 0.0, 1.0), burn = clamp(mc.g, 0.0, 1.0);
          float ny = wn.y, alt = vWPos.y;
          float alp = smoothstep(2900.0, 3350.0, alt);
          float nz1 = texture2D(uNoise, p / 410.0 + 0.21).r, nz2 = texture2D(uNoise, p / 97.0).r;
          float moist = texture2D(uBoxel, p / uExtent + 0.5).r;
          mtnWet = clamp(smoothstep(0.08, 0.45, moist) + uWet * 0.5, 0.0, 1.0);
          float open = 1.0 - forest * 0.9;
          float wBed = clamp((1.0 - smoothstep(0.5, 0.72, ny)) + rock * (1.0 - smoothstep(0.7, 0.9, ny)) * 0.75, 0.0, 1.0);
          float wTal = smoothstep(0.55, 0.7, ny) * (1.0 - smoothstep(0.82, 0.93, ny)) * clamp(rock * 1.3 + alp * 0.8, 0.0, 1.0) * open;
          float wTil = smoothstep(0.76, 0.9, ny) * clamp(rock * 1.1 + alp * 0.6 + burn * 0.4, 0.0, 1.0) * open * (0.2 + 0.8 * smoothstep(0.35, 0.65, nz1 + (nz2 - 0.5) * 0.3));
          float wMed = smoothstep(0.74, 0.9, ny) * open * (1.0 - rock) * smoothstep(2500.0, 2900.0, alt) * (1.0 - 0.7 * smoothstep(0.45, 0.7, nz1));
          float wCrk = clamp(maskAt(p) * 1.3 + smoothstep(0.1, 0.5, moist) * 1.2, 0.0, 1.0) * smoothstep(0.68, 0.9, ny) * (1.0 - forest * 0.5);
          float ws[5] = float[5](wTal, wTil, wBed, wMed, wCrk);
          int i0 = 0;
          for (int k = 1; k < 5; k++) if (ws[k] > ws[i0]) i0 = k;
          int i1 = i0 == 0 ? 1 : 0;
          for (int k = 0; k < 5; k++) if (k != i0 && ws[k] > ws[i1]) i1 = k;
          mtnMix = ws[i1] / (ws[i0] + ws[i1] + 1e-4);
          mtnW = clamp((ws[i0] + ws[i1] * 0.5) * 1.2, 0.0, 1.0) * (1.0 - smoothstep(4500.0, 9000.0, camD));
          if (mtnW > 0.003) {
            float t0 = MTN_TILE[i0], t1 = MTN_TILE[i1];
            float doN = camD < 110.0 ? 1.0 : 0.0, hexOn = camD < 220.0 ? 1.0 : 0.0;
            vec3 a0, a1 = vec3(0.5), no0, no1 = vec3(0.0);
            float h0v, h1v = 0.5;
            bool lite = camD > 1500.0;            // far: a tile is under a pixel, so one tap on the plane the ground mostly faces, one set
            if (lite) {
              bool isFlat = tw.y > 0.5, zy = tw.x > tw.z;
              vec2 fu = (isFlat ? p : (zy ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y))) / t0;
              vec2 fdx = (isFlat ? mpx : (zy ? vec2(wdx.z, wdx.y) : vec2(wdx.x, wdx.y))) / t0, fdy = (isFlat ? mpy : (zy ? vec2(wdy.z, wdy.y) : vec2(wdy.x, wdy.y))) / t0;
              a0 = textureGrad(uMtnA, vec3(fu, float(i0)), fdx, fdy).rgb;
              no0 = vec3(0.0); h0v = 0.5;
            } else mtnTri(float(i0), t0, vWPos, mpx, mpy, wdx, wdy, tw, hexOn, doN, a0, no0, h0v);
            bool second = !lite && mtnMix > 0.04;
            if (second) mtnTri(float(i1), t1, vWPos, mpx, mpy, wdx, wdy, tw, hexOn, doN, a1, no1, h1v);
            else { a1 = a0; no1 = no0; h1v = h0v; }
            mtnAvg0 = textureLod(uMtnA, vec3(0.5, 0.5, float(i0)), 10.0).rgb;
            mtnAvg1 = second ? textureLod(uMtnA, vec3(0.5, 0.5, float(i1)), 10.0).rgb : mtnAvg0;
            // a much larger, turned copy (on the plane the surface mostly faces), so the small tile never repeats at the scale of the big one
            vec3 big0 = mtnAvg0, big1 = mtnAvg1;
            if (camD < 900.0) {
              mat2 Rb = mat2(0.82, 0.57, -0.57, 0.82);
              vec2 bp = tw.y > 0.5 ? p : (tw.x > tw.z ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y));
              vec2 bdx = tw.y > 0.5 ? mpx : (tw.x > tw.z ? vec2(wdx.z, wdx.y) : vec2(wdx.x, wdx.y));
              vec2 bdy = tw.y > 0.5 ? mpy : (tw.x > tw.z ? vec2(wdy.z, wdy.y) : vec2(wdy.x, wdy.y));
              big0 = textureGrad(uMtnA, vec3(Rb * (bp / (t0 * 6.1)) + 0.31, float(i0)), Rb * bdx / (t0 * 6.1), Rb * bdy / (t0 * 6.1)).rgb;
              big1 = second ? textureGrad(uMtnA, vec3(Rb * (bp / (t1 * 6.1)) + 0.63, float(i1)), Rb * bdx / (t1 * 6.1), Rb * bdy / (t1 * 6.1)).rgb : big0;
            }
            float macro = texture2D(uNoise, p / 137.0 + 0.4).r * 0.55 + texture2D(uNoise, p / 43.0).r * 0.45;
            float bigK = 0.32 + 0.2 * smoothstep(60.0, 300.0, camD);
            mtnAlb0 = (a0 + (big0 - mtnAvg0) * bigK) * (0.84 + 0.32 * macro);
            mtnAlb1 = (a1 + (big1 - mtnAvg1) * bigK) * (0.84 + 0.32 * macro);
            if (doN > 0.5) {
              mtnHt = mix(h0v, h1v, mtnMix);
              wn = normalize(wn + mix(no0, no1, mtnMix) * uMtnNormal * mtnW * (1.0 - smoothstep(50.0, 110.0, camD)) * (1.0 - 0.35 * mtnWet));
            }
          }
        }`;

/** After NEAR_COLOR: the photograph over the satellite colour. */
export const MTN_COLOR = /* glsl */ `
        if (mtnW > 0.003) {
          vec3 sat = diffuseColor.rgb;
          vec3 tex = mix(mtnAlb0, mtnAlb1, mtnMix), avg = mix(mtnAvg0, mtnAvg1, mtnMix);
          float lumS = dot(sat, vec3(0.3, 0.55, 0.15)), lumA = dot(avg, vec3(0.3, 0.55, 0.15));
          vec3 relative = sat * clamp(tex / max(avg, 0.02), 0.45, 2.2);                    // the photograph's detail over the imagery's colour
          vec3 native = tex * pow(clamp(lumS / max(lumA, 0.02), 0.5, 1.8), 0.6);           // the photograph's own colour, lit like the land
          vec3 col = mix(relative, native, (1.0 - smoothstep(30.0, 380.0, camD)) * 0.85);
          col *= 0.78 + 0.44 * mtnHt;                                                      // crevices and gaps between stones are darker
          col *= 1.0 - 0.4 * mtnWet;                                                       // soaked rock and soil: darker, richer
          col = mix(col, col * vec3(0.9, 0.97, 1.04), mtnWet * 0.4);
          diffuseColor.rgb = mix(diffuseColor.rgb, col, mtnW * uMtnStrength);
        }`;
