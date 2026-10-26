import * as THREE from 'three';

// Real ground under your boots. Seven soils from the user's soil pack, in two atlases (4 x 2 cells of 512 px with an
// 8 px gutter; the albedo atlas is `assets/soil/soil_albedo.jpg`, the other `soil_nh.webp` holds the tangent normal in R, G
// and the height in B): 0 conifer duff, 1 lodgepole gravel (the lower mineral soil), 2 aspen litter, 3 burn scar,
// 4 alpine granite grit, 5 wet riparian, 6 compacted trail tread. Within about 48 m the close terrain shows them.
// Which soil is the land cover (the same raster as everything else) and the height; and the boxel field decides the two
// that no map can: the wet soil comes up where the ground boxels hold moisture (rain, a creek, a drying fire), and the trail
// tread where they hold wear (footsteps, tyres): paths you walk and drive become packed tread, and puddled ground turns to
// riparian mud, then goes back as it dries. The pack's roughness map is nearly constant (the terrain is Lambert), so it
// isn't used.
// Atlas coordinates run from the top-left, row by row (the textures load with flipY off). The tiles are sampled with
// textureGrad on the continuous tile coordinate, so the fract() seam never shows up in the mip selection.

export const SOIL = {
  uSoilA: { value: null }, uSoilS: { value: null },
  uSoilOn: { value: 0 }, uSoilTile: { value: 2.6 }, uSoilRange: { value: 48 }, uSoilNormal: { value: 0.8 }, uSoilStrength: { value: 0.88 },
};

export function loadSoil(base = './assets/soil/') {
  const load = (file, srgb) => new Promise((res) => {
    new THREE.TextureLoader().load(base + file, (t) => {
      t.flipY = false;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8;
      res(t);
    }, undefined, () => res(null));
  });
  return Promise.all([load('soil_albedo.jpg', true), load('soil_nh.webp', false)]).then(([a, n]) => {
    if (!a || !n) { console.warn('soil textures not loaded, keeping the painted ground'); return; }
    SOIL.uSoilA.value = a; SOIL.uSoilS.value = n;
    SOIL.uSoilOn.value = 1;
  });
}

export const SOIL_PARS = /* glsl */ `
uniform sampler2D uSoilA, uSoilS;
uniform float uSoilOn, uSoilTile, uSoilRange, uSoilNormal, uSoilStrength;
const vec2 SOIL_ATLAS = vec2(2112.0, 1056.0);
// one tile of the atlas at tile coordinate q (continuous), with the gradients taken from the continuous coordinate
vec4 soilTap(sampler2D T, vec2 q, vec2 dqx, vec2 dqy, float id) {
  vec2 origin = vec2(mod(id, 4.0), floor(id / 4.0)) * 528.0 + 8.0;
  vec2 uv = (origin + fract(q) * 511.0 + 0.5) / SOIL_ATLAS;
  return textureGrad(T, uv, dqx * (511.0 / SOIL_ATLAS), dqy * (511.0 / SOIL_ATLAS));
}`;

/** Before the normal is built: which soils, how wet, how worn, and their normals. Needs p, camD, wn, uCover, uBoxel, uSnow. */
export const SOIL_NORMAL = /* glsl */ `
        vec2 sq = p / uSoilTile;
        vec2 sqx = dFdx(sq), sqy = dFdy(sq);
        vec2 sq2 = mat2(0.8, -0.6, 0.6, 0.8) * (p / (uSoilTile * 2.7)) + 0.37;   // a larger, turned copy, so the tiles never line up
        vec2 sq2x = dFdx(sq2), sq2y = dFdy(sq2);
        float soilK = 0.0, sId0 = 0.0, sId1 = 1.0, sMix = 0.0, sWet = 0.0, sTrail = 0.0;
        if (uSoilOn > 0.5 && camD < uSoilRange) {
          soilK = (1.0 - smoothstep(uSoilRange * 0.4, uSoilRange, camD)) * (1.0 - uSnow * smoothstep(uSnowLine - 60.0, uSnowLine + 40.0, vWPos.y));
          vec4 sc = texture2D(uCover, p / uExtent + 0.5);
          float steepS = 1.0 - smoothstep(0.55, 0.9, wn.y);
          float wR = clamp(sc.a * 1.5 + steepS * 0.9 + smoothstep(3330.0, 3480.0, vWPos.y), 0.0, 1.0);
          float wB = clamp(sc.g * 1.5, 0.0, 1.0) * (1.0 - wR);
          float wA = clamp(sc.b * 1.5, 0.0, 1.0) * (1.0 - wR) * (1.0 - wB);
          float wF = clamp(sc.r * 1.3, 0.0, 1.0) * (1.0 - wR) * (1.0 - wB) * (1.0 - wA);
          float wO = max(0.0, 1.0 - wR - wB - wA - wF);
          float low = 1.0 - smoothstep(2900.0, 3150.0, vWPos.y);              // lodgepole country, below the spruce-fir belt
          float alp = smoothstep(3300.0, 3450.0, vWPos.y);
          float ws[5] = float[5](wF * (1.0 - low) + wO * (1.0 - low) * (1.0 - alp), wF * low + wO * low, wA, wB, wR + wO * (1.0 - low) * alp);
          int i0 = 0;
          for (int k = 1; k < 5; k++) if (ws[k] > ws[i0]) i0 = k;
          int i1 = i0 == 0 ? 1 : 0;
          for (int k = 0; k < 5; k++) if (k != i0 && ws[k] > ws[i1]) i1 = k;
          sId0 = float(i0); sId1 = float(i1);
          sMix = ws[i1] / (ws[i0] + ws[i1] + 1e-4);
          // the boxel field: moist ground turns to riparian mud, worn ground to packed tread
          vec4 sbx = texture2D(uBoxel, p / uExtent + 0.5);
          sWet = smoothstep(0.1, 0.5, sbx.r);
          sTrail = smoothstep(0.12, 0.65, sbx.g);
          vec2 n0 = soilTap(uSoilS, sq, sqx, sqy, sId0).rg, n1 = soilTap(uSoilS, sq, sqx, sqy, sId1).rg;
          vec2 sn = mix(n0, n1, sMix) * 2.0 - 1.0;
          if (sWet > 0.01) sn = mix(sn, soilTap(uSoilS, sq, sqx, sqy, 5.0).rg * 2.0 - 1.0, sWet * 0.8);
          if (sTrail > 0.01) sn = mix(sn, soilTap(uSoilS, sq, sqx, sqy, 6.0).rg * 2.0 - 1.0, sTrail * 0.9) * (1.0 - 0.4 * sTrail);
          wn = normalize(wn + vec3(sn.x, 0.0, sn.y) * uSoilNormal * soilK);
        }`;

/** Inside the near ground colour, before the stones: the soil's own colour for this spot. */
export const SOIL_COLOR = /* glsl */ `
          if (soilK > 0.0) {
            vec3 sc0 = soilTap(uSoilA, sq, sqx, sqy, sId0).rgb, sc1 = soilTap(uSoilA, sq, sqx, sqy, sId1).rgb;
            vec3 soilCol = mix(sc0, sc1, sMix);
            soilCol = mix(soilCol, soilTap(uSoilA, sq2, sq2x, sq2y, sId0).rgb, 0.3);
            if (sWet > 0.01) soilCol = mix(soilCol, soilTap(uSoilA, sq, sqx, sqy, 5.0).rgb, sWet * 0.85);
            if (sTrail > 0.01) soilCol = mix(soilCol, soilTap(uSoilA, sq, sqx, sqy, 6.0).rgb, sTrail * 0.9);
            soilCol *= 0.8 + 0.4 * grain;                                   // the satellite's own broad light and dark still show through
            ground = mix(ground, soilCol, soilK * uSoilStrength);
          }`;
