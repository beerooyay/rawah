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
    withAtmosphere(shader);
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
