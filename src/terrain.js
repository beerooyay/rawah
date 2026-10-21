import * as THREE from 'three';

// Chunked terrain with distance-based level of detail. Each 128-cell chunk
// rebuilds at a coarser vertex step as it falls away from the camera; skirts
// hide the cracks between neighbours at different steps. Colour comes from a
// full-resolution colour map sampled per pixel, so near and far chunks match.

const CHUNKS = 16;          // chunks per side
const STEPS = [[320, 1], [800, 2], [1900, 4], [4200, 8], [Infinity, 16]];
const BUILD_BUDGET_MS = 5;

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

/** Lambert terrain that takes its albedo from a world-space colour map plus fine grain. */
export function terrainMaterial(colorMap, extent, noise, coverMap = null) {
  const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uColorMap = { value: colorMap };
    shader.uniforms.uCover = { value: coverMap || colorMap };
    shader.uniforms.uHasCover = { value: coverMap ? 1 : 0 };
    shader.uniforms.uNoise = { value: noise };
    shader.uniforms.uExtent = { value: extent };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = mat3(modelMatrix) * objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nuniform sampler2D uColorMap;\nuniform sampler2D uCover;\nuniform float uHasCover;\nuniform sampler2D uNoise;\nuniform float uExtent;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 albedo = texture2D(uColorMap, vWPos.xz / uExtent + 0.5).rgb;
        float camD = length(vWPos - cameraPosition);
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
        vec3 wn = normalize(vWNrm);
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
        diffuseColor.rgb = albedo;`);
  };
  mat.customProgramCacheKey = () => 'rawah-terrain';
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

export class Terrain {
  constructor(world, material) {
    this.world = world;
    this.material = material;
    this.group = new THREE.Group();
    const CHUNK = this.chunk = world.N / CHUNKS;
    this.nc = CHUNKS;
    this.chunks = [];
    for (let j = 0; j < this.nc; j++) {
      for (let i = 0; i < this.nc; i++) {
        let lo = Infinity, hi = -Infinity;
        for (let r = j * CHUNK; r <= (j + 1) * CHUNK; r++) {
          for (let c = i * CHUNK; c <= (i + 1) * CHUNK; c++) {
            const h = world.gridH(c, r);
            if (h < lo) lo = h; if (h > hi) hi = h;
          }
        }
        const x0 = (i * CHUNK - world.N / 2) * world.cell, z0 = (j * CHUNK - world.N / 2) * world.cell;
        const size = CHUNK * world.cell;
        this.chunks.push({ i, j, lo, hi, step: 0, want: 16, mesh: null,
          box: new THREE.Box3(new THREE.Vector3(x0, lo, z0), new THREE.Vector3(x0 + size, hi, z0 + size)) });
      }
    }
  }

  /** Pick a vertex step per chunk and rebuild a few of the most urgent ones. */
  update(cam, force = false) {
    const queue = [];
    for (const ch of this.chunks) {
      const d = ch.box.distanceToPoint(cam);
      ch.want = STEPS.find(([lim]) => d < lim)[1];
      if (ch.want !== ch.step) queue.push([d, ch]);
    }
    queue.sort((a, b) => a[0] - b[0]);
    const t0 = performance.now();
    let n = 0;
    while (n < queue.length && (force || n === 0 || performance.now() - t0 < BUILD_BUDGET_MS)) this.#build(queue[n++][1]);
    return queue.length - n;
  }

  #build(ch) {
    const geo = this.#geometry(ch.i, ch.j, ch.want);
    if (ch.mesh) {
      ch.mesh.geometry.dispose();
      ch.mesh.geometry = geo;
    } else {
      ch.mesh = new THREE.Mesh(geo, this.material);
      ch.mesh.receiveShadow = true;
      ch.mesh.matrixAutoUpdate = false;
      this.group.add(ch.mesh);
    }
    ch.step = ch.want;
  }

  #geometry(ci, cj, step) {
    const w = this.world, cell = w.cell, half = w.N / 2;
    const CHUNK = this.chunk;
    const n = CHUNK / step;           // quads per side
    const m = n + 3;                  // vertices per side incl. skirt ring
    const skirt = 6 + step * 5;
    const pos = new Float32Array(m * m * 3);
    const nor = new Float32Array(m * m * 3);
    const c0 = ci * CHUNK, r0 = cj * CHUNK;
    for (let b = 0; b < m; b++) {
      const rb = Math.min(Math.max(b - 1, 0), n);
      const r = r0 + rb * step;
      for (let a = 0; a < m; a++) {
        const ra = Math.min(Math.max(a - 1, 0), n);
        const c = c0 + ra * step;
        const edge = a === 0 || b === 0 || a === m - 1 || b === m - 1;
        const k = (b * m + a) * 3;
        pos[k] = (c - half) * cell;
        pos[k + 1] = w.gridH(c, r) - (edge ? skirt : 0);
        pos[k + 2] = (r - half) * cell;
        const gx = (w.gridH(c + step, r) - w.gridH(c - step, r)) / (2 * step * cell);
        const gz = (w.gridH(c, r + step) - w.gridH(c, r - step)) / (2 * step * cell);
        const len = Math.hypot(gx, 1, gz);
        nor[k] = -gx / len; nor[k + 1] = 1 / len; nor[k + 2] = -gz / len;
      }
    }
    const idx = new Uint32Array((m - 1) * (m - 1) * 6);
    let t = 0;
    for (let b = 0; b < m - 1; b++) {
      for (let a = 0; a < m - 1; a++) {
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
    return geo;
  }
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
