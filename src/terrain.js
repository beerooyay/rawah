import * as THREE from 'three';
import { withAtmosphere } from './atmosphere.js';

// Terrain helpers: textures, the albedo shader shared by near and far terrain,
// and the distant horizon mesh. The near terrain itself is cdlod.js.


export function makeNoiseTexture(size = 256) {
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
  const n1 = lattice(16), n2 = lattice(64);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = n1(x / size * 16, y / size * 16) * 0.55 + n2(x / size * 64, y / size * 64) * 0.45;
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
        // from orbit you only see canopy; up close, under the modelled trees, show the floor
        if (uHasCover > 0.5) {
          vec4 cov = texture2D(uCover, vWPos.xz / uExtent + 0.5);
          float nearK = 1.0 - smoothstep(120.0, 420.0, camD);
          vec3 duff = vec3(0.16, 0.12, 0.075) * (0.75 + grain * 0.5);
          vec3 ash = mix(vec3(0.2, 0.17, 0.12), vec3(0.15, 0.2, 0.09), fine) * (0.8 + grain * 0.4);
          albedo = mix(albedo, duff, clamp(cov.r * 1.3, 0.0, 1.0) * nearK * 0.85);
          albedo = mix(albedo, ash, clamp(cov.g * 1.2, 0.0, 1.0) * nearK * 0.6);
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
          vec3 rock = albedo * (0.8 + bed * 0.45) * (0.85 + chips * 0.3) * (1.0 - clamp(crack, 0.0, 1.0) * 0.45);
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
`;

// The ground at your feet, finer than any data: pebbles everywhere, cobbles
// and blocks on rocky ground, each one a little dome that catches the light
// with a dark contact line around it; dry grass thatch between the blades in
// meadows and a needle litter under the trees. Fades out by ~60 m, where the
// satellite colour takes over. NEAR_NORMAL runs before lighting (expects p,
// camD, wn), NEAR_COLOR after ALBEDO.
export const NEAR_NORMAL = /* glsl */ `
        float nearK = 1.0 - smoothstep(18.0, 60.0, camD);
        float gStone = 0.0, gId = 0.0, gRing = 0.0, gRocky = 0.0, gForest = 0.0;
        if (nearK > 0.0) {
          vec4 gCov = texture2D(uCover, p / uExtent + 0.5);
          float steep = 1.0 - smoothstep(0.55, 0.9, wn.y);
          gRocky = clamp(gCov.a * 1.4 + steep, 0.0, 1.0);
          gForest = clamp(gCov.r * 1.3, 0.0, 1.0) * (1.0 - gRocky);
          float bare = 1.0 - maskAt(p); // no stones on trails, in streams or at the waterline
          vec4 w1 = worley(p / 0.45);
          float r1 = mix(0.2, 0.4, gRocky) * (0.6 + w1.y * 0.6);
          float keep1 = step(w1.y, mix(0.28, 0.9, gRocky) * (1.0 - gForest * 0.6) * bare);
          float s1 = smoothstep(r1, r1 * 0.7, w1.x) * keep1;
          vec4 w2 = worley(p / 1.7 + 13.7);
          float r2 = 0.42 * (0.6 + w2.y * 0.6);
          float keep2 = step(w2.y, gRocky * 0.8);
          float s2 = smoothstep(r2, r2 * 0.8, w2.x) * keep2;
          vec2 tilt = -w1.zw / r1 * s1 * 0.9 - w2.zw / r2 * s2 * 0.8;
          wn = normalize(wn + vec3(tilt.x, 0.0, tilt.y) * nearK);
          gStone = max(s1, s2);
          gId = s2 > s1 ? w2.y : w1.y;
          gRing = smoothstep(r1 * 1.35, r1, w1.x) * keep1 * (1.0 - s1) + smoothstep(r2 * 1.25, r2, w2.x) * keep2 * (1.0 - s2);
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
          diffuseColor.rgb *= 1.0 - gRing * 0.4 * nearK;
        }`;

export const ALBEDO_UNIFORMS = 'uniform sampler2D uColorMap;\nuniform sampler2D uCover;\nuniform float uHasCover;\nuniform sampler2D uNoise;\nuniform float uExtent;\n';

export function albedoUniforms(shader, colorMap, extent, noise, coverMap) {
  shader.uniforms.uColorMap = { value: colorMap };
  shader.uniforms.uCover = { value: coverMap || colorMap };
  shader.uniforms.uHasCover = { value: coverMap ? 1 : 0 };
  shader.uniforms.uNoise = { value: noise };
  shader.uniforms.uExtent = { value: extent };
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
        ${ALBEDO}`);
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

/** The distant horizon: a coarse ~60 km mesh, sunk out of sight under the play area. */
export function farTerrain(world, material) {
  const { N, cell, h } = world.far;
  const step = 2, n = N / step, m = n + 1;
  const half = (N * cell) / 2;
  const inner = world.half - cell;
  const pos = new Float32Array(m * m * 3);
  const nor = new Float32Array(m * m * 3);
  const at = (c, r) => h[Math.min(Math.max(r, 0), N - 1) * N + Math.min(Math.max(c, 0), N - 1)];
  for (let b = 0; b < m; b++) {
    for (let a = 0; a < m; a++) {
      const c = a * step, r = b * step, k = (b * m + a) * 3;
      const x = c * cell - half, z = r * cell - half;
      const inside = Math.abs(x) < inner && Math.abs(z) < inner;
      pos[k] = x; pos[k + 2] = z;
      pos[k + 1] = at(c, r) - (inside ? 400 : 0);
      const gx = (at(c + step, r) - at(c - step, r)) / (2 * step * cell);
      const gz = (at(c, r + step) - at(c, r - step)) / (2 * step * cell);
      const len = Math.hypot(gx, 1, gz);
      nor[k] = -gx / len; nor[k + 1] = 1 / len; nor[k + 2] = -gz / len;
    }
  }
  const idx = new Uint32Array(n * n * 6);
  let t = 0;
  for (let b = 0; b < n; b++) {
    for (let a = 0; a < n; a++) {
      const A = b * m + a, D = A + 1, B = A + m, Cc = B + 1;
      idx[t++] = A; idx[t++] = B; idx[t++] = Cc;
      idx[t++] = A; idx[t++] = Cc; idx[t++] = D;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.matrixAutoUpdate = false;
  return mesh;
}
