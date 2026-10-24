import * as THREE from 'three';
import { withAtmosphere } from './atmosphere.js';
import { chunkGeometry } from './culling.js';

// Terrain helpers: textures, the albedo shader shared by near and far terrain,
// and the distant horizon mesh. The near terrain itself is cdlod.js.


export function makeNoiseTexture(size = 512) {
  const data = new Uint8Array(size * size * 4);
  // tileable value noise, two octaves
  const lattice = (n) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = Math.random();
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const at = (a, b) => g[((b % n + n) % n) * n + ((a % n + n) % n)];
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  };
  // prime lattice sizes: the cells never line up with the power-of-two tile, so no grid shows
  const n1 = lattice(23), n2 = lattice(41);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = n1(x / size * 23, y / size * 23) * 0.6 + n2(x / size * 41, y / size * 41) * 0.4;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Albedo texture from an image (satellite colour) or raw RGBA bytes. */
export function colorTexture(data, size) {
  const tex = data instanceof Uint8Array ? new THREE.DataTexture(data, size, size) : new THREE.Texture(data);
  tex.flipY = false; // row 0 is north, at uv.y = 0
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Albedo shared by the near (CDLOD) and far terrain: satellite colour, grain,
// forest floor under the modelled trees, and rock strata on steep faces.
// Expects vWPos (world position), wn (world normal) and camD in scope.
export const ALBEDO = /* glsl */ `
        vec3 albedo = texture2D(uColorMap, vWPos.xz / uExtent + 0.5).rgb;
        float grain = texture2D(uNoise, vWPos.xz / 31.0).r * 0.55 + texture2D(uNoise, vWPos.xz / 6.7).r * 0.45;
        float fine = texture2D(uNoise, vWPos.xz / 1.3).r;
        float k = mix(0.3, 0.06, smoothstep(40.0, 700.0, camD));
        albedo *= 1.0 - k * 0.5 + grain * k;
        albedo *= 1.0 + (fine - 0.5) * 0.22 * (1.0 - smoothstep(10.0, 60.0, camD));
        // the imagery is from late September: green the cured meadows back up for spring and summer
        float lumA = dot(albedo, vec3(0.3, 0.55, 0.15));
        float meadow = smoothstep(0.012, 0.06, albedo.r - albedo.b) * (1.0 - smoothstep(0.32, 0.5, lumA));
        albedo = mix(albedo, vec3(0.33, 0.45, 0.19) * lumA * 1.75, uGreen * meadow * 0.65);
        // tufts and the dark gaps between them, at three scales. The noise is mipmapped, so each scale
        // fades to its average on its own as it gets smaller than a pixel: close up the meadow is
        // mottled, and from a ridge it is one even colour, with no hard change at any distance
        float tufts = texture2D(uNoise, vWPos.xz / 0.9).r * 0.45 + texture2D(uNoise, vWPos.xz / 3.1 + 0.27).r * 0.35 + texture2D(uNoise, vWPos.xz / 11.0 + 0.61).r * 0.2;
        float tuftK = mix(0.1, 0.34, meadow) * (1.0 - 0.6 * uHasCover * (1.0 - smoothstep(0.02, 0.1, lumA)));
        albedo *= 1.0 + (tufts - 0.5) * tuftK * (0.6 + 0.4 * lumA * 2.0);
        // from orbit you only see canopy; up close, under the modelled trees, show the floor
        if (uHasCover > 0.5) {
          vec4 cov = texture2D(uCover, vWPos.xz / uExtent + 0.5);
          float nearK = 1.0 - smoothstep(120.0, 420.0, camD);
          vec3 duff = vec3(0.16, 0.12, 0.075) * (0.75 + grain * 0.5);
          vec3 ash = mix(vec3(0.2, 0.17, 0.12), vec3(0.15, 0.2, 0.09), fine) * (0.8 + grain * 0.4);
          albedo = mix(albedo, duff, clamp(cov.r * 1.3, 0.0, 1.0) * nearK * 0.85);
          albedo = mix(albedo, ash, clamp(cov.g * 1.2, 0.0, 1.0) * nearK * 0.6);
        }
        // far forest: no trees are modelled out here, so paint the canopy: crowns up close, groves and gaps
        // further out (the finer octaves mip away on their own). It fades in as the tree impostors thin and
        // out again into the haze
        float canopyK = smoothstep(450.0, 1500.0, camD) * (1.0 - smoothstep(12000.0, 24000.0, camD));
        if (canopyK > 0.0) {
          float forestW = uHasCover > 0.5 ? clamp(texture2D(uCover, vWPos.xz / uExtent + 0.5).r * 1.25, 0.0, 1.0) : smoothstep(0.12, 0.04, lumA);
          forestW *= smoothstep(0.3, 0.6, wn.y);
          float crowns = texture2D(uNoise, vWPos.xz / 230.0 + 0.37).r * 0.3 + texture2D(uNoise, vWPos.xz / 700.0 + 0.11).r * 0.4 + texture2D(uNoise, vWPos.xz / 2200.0 + 0.62).r * 0.3;
          float crown = smoothstep(0.36, 0.64, crowns);
          float gold = smoothstep(0.58, 0.76, crowns) * 0.5;
          vec3 canopy = mix(albedo * vec3(0.42, 0.6, 0.4), albedo * vec3(1.12, 1.36, 0.82), crown) * mix(vec3(1.0), vec3(1.35, 1.12, 0.6), gold);
          albedo = mix(albedo, canopy, canopyK * forestW * 0.95);
        }
        // steep faces: granite strata and cracks projected sideways
        float faceK = smoothstep(0.8, 0.55, wn.y) * (1.0 - smoothstep(150.0, 900.0, camD));
        if (faceK > 0.0) {
          vec3 an = abs(wn) + 1e-4;
          float wx = an.x / (an.x + an.z);
          // horizontal bedding plus vertical joints, like weathered gneiss
          float bed = mix(texture2D(uNoise, vec2(vWPos.x / 37.0, vWPos.y / 2.6)).r, texture2D(uNoise, vec2(vWPos.z / 37.0, vWPos.y / 2.6)).r, wx);
          float joint = mix(texture2D(uNoise, vec2(vWPos.x / 1.9, vWPos.y / 19.0)).r, texture2D(uNoise, vec2(vWPos.z / 1.9, vWPos.y / 19.0)).r, wx);
          float chips = mix(texture2D(uNoise, vWPos.xy / 0.9).r, texture2D(uNoise, vWPos.zy / 0.9).r, wx);
          float crack = smoothstep(0.62, 0.7, joint) * 0.8 + smoothstep(0.66, 0.74, bed) * 0.5;
          vec3 photo = mix(texture2D(uRock, vWPos.xy / 34.0).rgb, texture2D(uRock, vWPos.zy / 34.0).rgb, wx);
          vec3 rock = photo * vec3(1.08, 0.98, 0.86) * (0.9 + bed * 0.2) * (1.0 - clamp(crack, 0.0, 1.0) * 0.35);
          albedo = mix(albedo, rock, faceK);
        }
        diffuseColor.rgb = albedo;`;

// Cellular noise: distance to the nearest jittered point, that cell's hash, and
// the offset to it. Needs NOISE_GLSL (ihash). Pebbles, cobbles, trail gravel.
export const WORLEY_GLSL = /* glsl */ `
vec4 worley(vec2 x) {
  vec2 i = floor(x), f = x - i;
  float d1 = 8.0, id = 0.0;
  vec2 off = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int k = -1; k <= 1; k++) {
      vec2 g = vec2(float(k), float(y));
      ivec2 c = ivec2(i + g);
      vec2 r = g + vec2(ihash(c), ihash(c + ivec2(31, 17))) - f;
      float d = dot(r, r);
      if (d < d1) { d1 = d; id = ihash(c + ivec2(5, 91)); off = r; }
    }
  }
  return vec4(sqrt(d1), id, off);
}
// the same cell measured as a rotated, rounded square instead of a circle, so stones read as blocks
float blocky(vec4 w) {
  float a = w.y * 6.2832, c = cos(a), s = sin(a);
  vec2 q = vec2(c * w.z - s * w.w, s * w.z + c * w.w);
  return mix(w.x, max(abs(q.x), abs(q.y)) * 1.12, 0.7);
}
`;

// The ground at your feet, finer than any data: pebbles everywhere, cobbles
// and blocks on rocky ground, each one a little dome that catches the light
// with a dark contact line around it; dry grass thatch between the blades in
// meadows and a needle litter under the trees. Fades out by ~60 m, where the
// satellite colour takes over. NEAR_NORMAL runs before lighting (expects p,
// camD, wn), NEAR_COLOR after ALBEDO.
export const NEAR_NORMAL = /* glsl */ `
        // nothing of this shows through snow cover
        float nearK = (1.0 - smoothstep(18.0, 60.0, camD)) * (1.0 - uSnow * smoothstep(uSnowLine - 60.0, uSnowLine + 40.0, vWPos.y));
        float gStone = 0.0, gId = 0.0, gRing = 0.0, gRocky = 0.0, gForest = 0.0;
        if (nearK > 0.0) {
          vec4 gCov = texture2D(uCover, p / uExtent + 0.5);
          float steep = 1.0 - smoothstep(0.55, 0.9, wn.y);
          gRocky = clamp(gCov.a * 1.4 + steep, 0.0, 1.0);
          gForest = clamp(gCov.r * 1.3, 0.0, 1.0) * (1.0 - gRocky);
          float bare = 1.0 - maskAt(p); // no stones on trails, in streams or at the waterline
          vec4 w1 = worley(p / 0.45);
          float r1 = mix(0.2, 0.4, gRocky) * (0.6 + w1.y * 0.6);
          float keep1 = step(w1.y, mix(0.28, 0.62, gRocky) * (1.0 - gForest * 0.6) * bare);
          float b1 = blocky(w1);
          float s1 = smoothstep(r1, r1 * 0.7, b1) * keep1;
          vec4 w2 = worley(p / 1.7 + 13.7);
          float r2 = 0.42 * (0.6 + w2.y * 0.6);
          float keep2 = step(w2.y, gRocky * 0.8);
          float b2 = blocky(w2);
          float s2 = smoothstep(r2, r2 * 0.8, b2) * keep2;
          vec2 tilt = -w1.zw / r1 * s1 * 0.9 - w2.zw / r2 * s2 * 0.8;
          wn = normalize(wn + vec3(tilt.x, 0.0, tilt.y) * nearK);
          gStone = max(s1, s2);
          gId = s2 > s1 ? w2.y : w1.y;
          gRing = smoothstep(r1 * 1.35, r1, b1) * keep1 * (1.0 - s1) + smoothstep(r2 * 1.25, r2, b2) * keep2 * (1.0 - s2);
        }`;

export const NEAR_COLOR = /* glsl */ `
        if (nearK > 0.0) {
          vec3 base = diffuseColor.rgb;
          float streak = texture2D(uNoise, p * 0.9).r * 0.5 + texture2D(uNoise, p * 3.7 + 0.3).r * 0.5;
          vec3 soil = base * 0.72;
          vec3 thatch = mix(base * 1.2, vec3(0.5, 0.43, 0.28), 0.45);
          vec3 litter = mix(soil, thatch, smoothstep(0.38, 0.62, streak));
          vec3 needles = mix(vec3(0.2, 0.13, 0.07), vec3(0.38, 0.24, 0.12), smoothstep(0.4, 0.65, streak)) * (0.8 + fine * 0.4);
          vec3 ground = mix(litter, needles, gForest);
          ground = mix(ground, base, gRocky * 0.6);
          diffuseColor.rgb = mix(base, ground, nearK * 0.75);
          vec3 stoneCol = mix(vec3(0.4, 0.38, 0.36), vec3(0.6, 0.54, 0.49), gId) * (0.8 + fine * 0.35);
          float lichen = step(fract(gId * 7.3), 0.35) * smoothstep(0.5, 0.65, texture2D(uNoise, p * 1.7).r);
          stoneCol = mix(stoneCol, mix(vec3(0.56, 0.6, 0.36), vec3(0.72, 0.46, 0.2), step(fract(gId * 3.1), 0.3)), lichen * 0.7);
          diffuseColor.rgb = mix(diffuseColor.rgb, stoneCol, gStone * nearK);
          diffuseColor.rgb *= 1.0 - gRing * 0.28 * nearK;
        }`;

export const ROCK = { value: null };   // rock albedo (assets/terrain/rock.jpg), set once it has loaded
export const BOXEL = { value: null };  // the living boxel field (src/boxels.js): R wetness, G wear

// the ground remembers: wet cells darken like soaked soil, worn cells lighten into trail
export const BOXEL_COLOR = /* glsl */ `
        vec4 bx = texture2D(uBoxel, p / uExtent + 0.5);
        diffuseColor.rgb *= 1.0 - bx.r * 0.34;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 1.07, 0.9), bx.g * 0.6);`;

export const ALBEDO_UNIFORMS = 'uniform sampler2D uColorMap;\nuniform sampler2D uCover;\nuniform float uHasCover;\nuniform sampler2D uNoise;\nuniform float uExtent;\nuniform sampler2D uRock;\nuniform sampler2D uBoxel;\n';

export function albedoUniforms(shader, colorMap, extent, noise, coverMap) {
  shader.uniforms.uColorMap = { value: colorMap };
  shader.uniforms.uCover = { value: coverMap || colorMap };
  shader.uniforms.uHasCover = { value: coverMap ? 1 : 0 };
  shader.uniforms.uNoise = { value: noise };
  shader.uniforms.uExtent = { value: extent };
  shader.uniforms.uRock = ROCK;
  shader.uniforms.uBoxel = BOXEL;
}

/** Lambert for the far horizon mesh: geometry normals, satellite albedo. */
export function terrainMaterial(colorMap, extent, noise, coverMap = null) {
  const mat = new THREE.MeshLambertMaterial();
  mat.onBeforeCompile = (shader) => {
    albedoUniforms(shader, colorMap, extent, noise, coverMap);
    withAtmosphere(shader, { weather: 1 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = mat3(modelMatrix) * objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\n${ALBEDO_UNIFORMS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float camD = length(vWPos - cameraPosition);
        vec3 wn = normalize(vWNrm);
        ${ALBEDO}
        // past the baked map the satellite colour has run out: paint invented ground, rock on the crests
        // and dark timber in the folds, fading in over the first few km
        float outK = smoothstep(0.0, 1500.0, max(abs(vWPos.x), abs(vWPos.z)) - uExtent * 0.5);
        if (outK > 0.0) {
          float n1 = texture2D(uNoise, vWPos.xz / 2600.0).r, n2 = texture2D(uNoise, vWPos.xz / 240.0).r;
          vec3 timber = vec3(0.16, 0.3, 0.14) * (0.8 + n2 * 0.4);
          vec3 rock = texture2D(uRock, vWPos.xz / 700.0).rgb * vec3(1.08, 0.98, 0.86);
          vec3 tone = mix(timber, rock, smoothstep(0.42, 0.62, n1 + (1.0 - wn.y) * 0.6));
          tone = mix(tone, vec3(0.8, 0.82, 0.86), smoothstep(0.7, 0.85, wn.y) * smoothstep(0.55, 0.75, n1) * uSnow);
          diffuseColor.rgb = mix(diffuseColor.rgb, tone, outK);
        }
        {
          vec2 p = vWPos.xz;
          ${BOXEL_COLOR}
        }`);
  };
  mat.customProgramCacheKey = () => 'rawah-far-terrain';
  return mat;
}

/** Land-cover bytes (RGBA: live, burned, aspen, rock) as a linear texture. */
export function coverTexture(data, size) {
  const tex = new THREE.DataTexture(data, size, size);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Distant ground, as nested square rings that double in size (a clipmap, the same idea as cdlod.js).
// The innermost ring is the baked far heightmap, about 30 km square. Past its edge the relief is
// invented: a ridged fractal that eases in from the edge, so it reads as the next range over. Beyond
// about 10 km nothing is measured in detail anyway, and the haze in atmosphere.js does most of the work.
const RING_HALF = [0, 30000, 60000];   // outer half-sizes (m) of the rings after the baked one
const RING_M = 256;                    // quads per side of every ring

const smooth = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };
function hash2(i, j, s) {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, z, s) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
// ridges: each octave folds the noise into a crest, so the range has sharp spines rather than rounded hills
function ridged(x, z) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let o = 0; o < 6; o++) {
    const n = 1 - Math.abs(2 * valueNoise(x * f, z * f, o + 7) - 1);
    sum += amp * n * n; norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

/** The distant ground: baked heights inside, invented ridges past their edge. */
export function farTerrain(world, material) {
  const { N, cell, h } = world.far;
  const dataHalf = (N * cell) / 2;
  const at = (c, r) => h[Math.min(Math.max(r, 0), N - 1) * N + Math.min(Math.max(c, 0), N - 1)];
  const ground = (x, z) => {
    const u = Math.min(Math.max((x + dataHalf) / cell, 0), N - 1.001), v = Math.min(Math.max((z + dataHalf) / cell, 0), N - 1.001);
    const c = Math.floor(u), r = Math.floor(v), fx = u - c, fz = v - r;
    const a = at(c, r), b = at(c + 1, r), d = at(c, r + 1), e = at(c + 1, r + 1);
    const base = a + (b - a) * fx + (d - a) * fz + (a - b - d + e) * fx * fz;
    const out = Math.hypot(Math.max(0, Math.abs(x) - dataHalf), Math.max(0, Math.abs(z) - dataHalf));
    if (out === 0) return base;
    // zero at the baked edge, so the rings join without a seam
    const w = smooth(0, 3000, out);
    return base + w * (900 * ridged(x / 5000 + 17.3, z / 5000 - 4.1) + 120 * valueNoise(x / 700, z / 700, 3));
  };

  const group = new THREE.Group();
  const rings = [dataHalf, ...RING_HALF.slice(1)];
  const n = RING_M + 1;
  for (let k = 0; k < rings.length; k++) {
    const half = rings[k], sp = (2 * half) / RING_M;
    // the inner ring covers everything under it, so each ring sinks where the one inside it is
    const sink = k === 0 ? world.half - cell : rings[k - 1] - sp;
    const pos = new Float32Array(n * n * 3);
    const nor = new Float32Array(n * n * 3);
    const e = sp * 0.5;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = -half + i * sp, z = -half + j * sp, q = (j * n + i) * 3;
        const inside = Math.abs(x) < sink && Math.abs(z) < sink;
        pos[q] = x; pos[q + 2] = z;
        pos[q + 1] = ground(x, z) - (inside ? 400 : 0);
        const gx = (ground(x + e, z) - ground(x - e, z)) / (2 * e);
        const gz = (ground(x, z + e) - ground(x, z - e)) / (2 * e);
        const len = Math.hypot(gx, 1, gz);
        nor[q] = -gx / len; nor[q + 1] = 1 / len; nor[q + 2] = -gz / len;
      }
    }
    const idx = new Uint32Array(RING_M * RING_M * 6);
    let t = 0;
    for (let b = 0; b < RING_M; b++) {
      for (let a = 0; a < RING_M; a++) {
        const A = b * n + a, D = A + 1, B = A + n, Cc = B + 1;
        idx[t++] = A; idx[t++] = B; idx[t++] = Cc;
        idx[t++] = A; idx[t++] = Cc; idx[t++] = D;
      }
    }
    // the squares that lie wholly under the inner rings (all three corners sunk) can never be seen
    const sunk = (v) => Math.abs(pos[v * 3]) < sink && Math.abs(pos[v * 3 + 2]) < sink;
    const keep = [];
    for (let i = 0; i < idx.length; i += 3) if (!(sunk(idx[i]) && sunk(idx[i + 1]) && sunk(idx[i + 2]))) keep.push(idx[i], idx[i + 1], idx[i + 2]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(keep), 1));
    // cut into chunks so the engine can reject the ones outside the view
    for (const g of chunkGeometry(geo, (half * 2) / 12)) {
      const mesh = new THREE.Mesh(g, material);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  return group;
}
