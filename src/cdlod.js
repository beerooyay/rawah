import * as THREE from 'three';
import { NOISE_GLSL, RELIEF_GLSL } from './detail.js';
import { ALBEDO, ALBEDO_UNIFORMS, albedoUniforms, WORLEY_GLSL, NEAR_NORMAL, NEAR_COLOR } from './terrain.js';
import { withAtmosphere } from './atmosphere.js';
import { Sculpt, SCULPT_GLSL, LIMIT } from './sculpt.js';

// Continuous distance-dependent level of detail (CDLOD, after Strugar 2010).
// A quadtree over the whole map picks, every frame, which nodes to draw and
// at which level; every node is the same 32x32 grid, stretched to its size.
// The vertex shader reads heights straight from the lidar texture, adds the
// fractal micro-relief (detail.js) at whatever resolution that node can show,
// and morphs odd vertices onto the next-coarser grid as a node nears the edge
// of its range, so levels blend instead of popping. Normals are per pixel.
// No terrain geometry is ever rebuilt on the CPU.

const GRID = 32;           // quads per node side
const LEVELS = 10;         // leaf nodes are extent / 2^9 (~29 m, ~0.9 m vertex spacing)
let RANGE_K = 2.3;         // a level-l node is used out to RANGE_K * its size (quality sets it)
export function setRangeK(k) { RANGE_K = k; }
const MAX_NODES = 3000;

function quadrantGeometries() {
  const n = GRID + 1;
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = (j * n + i) * 3;
      pos[k] = i / GRID; pos[k + 2] = j / GRID;
    }
  }
  const position = new THREE.BufferAttribute(pos, 3);
  const half = GRID / 2;
  return [0, 1, 2, 3].map((q) => {
    const i0 = (q & 1) * half, j0 = (q >> 1) * half;
    const idx = [];
    for (let j = j0; j < j0 + half; j++) {
      for (let i = i0; i < i0 + half; i++) {
        const A = j * n + i, D = A + 1, B = A + n, C = B + 1;
        idx.push(A, B, C, A, C, D); // same diagonal as World.baseHeight
      }
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', position);
    g.setIndex(idx);
    const node = new THREE.InstancedBufferAttribute(new Float32Array(MAX_NODES * 4), 4);
    node.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('nodeA', node);
    g.instanceCount = 0;
    return g;
  });
}

export const HEIGHT_GLSL = /* glsl */ `
uniform highp usampler2D uHeight;
uniform sampler2D uMask;
uniform float uN, uCell, uHScale, uHOffset;
float gridH(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(int(uN) - 1));
  return float(texelFetch(uHeight, p, 0).r) * uHScale + uHOffset;
}
float baseH(vec2 xz) {
  vec2 u = xz / uCell + uN * 0.5;
  vec2 c = floor(u), f = u - c;
  ivec2 i = ivec2(c);
  float ha = gridH(i), hc = gridH(i + ivec2(1, 1));
  if (f.x > f.y) { float hd = gridH(i + ivec2(1, 0)); return ha + f.x * (hd - ha) + f.y * (hc - hd); }
  float hb = gridH(i + ivec2(0, 1));
  return ha + f.y * (hb - ha) + f.x * (hc - hb);
}
${SCULPT_GLSL}
float maskAt(vec2 xz) { return texture2D(uMask, (xz / uCell + uN * 0.5 + 0.5) / uN).r; }
float rockAt(vec2 xz) { return texture2D(uCover, xz / uExtent + 0.5).a; }
${NOISE_GLSL}
${RELIEF_GLSL}
float groundH(vec2 xz, float spacing) {
  float rock = rockAt(xz);
  return baseH(xz) + relief(xz, reliefAmp(rock, maskAt(xz)), rock, spacing) + editH(xz);
}
`;

export class CDLODTerrain {
  constructor(world, { colorMap, coverMap, noise, detail = true }) {
    this.world = world;
    this.colorMap = colorMap;
    this.coverMap = coverMap;
    const N = world.N;
    this.extent = world.extent;
    this.leaf = world.extent / 2 ** (LEVELS - 1);
    this.ranges = Array.from({ length: LEVELS }, (_, l) => RANGE_K * this.leaf * 2 ** l);

    const heightTex = new THREE.DataTexture(world.h, N, N, THREE.RedIntegerFormat, THREE.UnsignedShortType);
    heightTex.internalFormat = 'R16UI';
    heightTex.magFilter = heightTex.minFilter = THREE.NearestFilter;
    heightTex.generateMipmaps = false;
    heightTex.needsUpdate = true;
    const maskTex = new THREE.DataTexture(world.mask, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    maskTex.magFilter = maskTex.minFilter = THREE.LinearFilter;
    maskTex.generateMipmaps = false;
    maskTex.needsUpdate = true;

    this.sculpt = world.sculpt = new Sculpt(world);
    this.uniforms = {
      ...this.sculpt.uniforms,
      uHeight: { value: heightTex }, uMask: { value: maskTex },
      uN: { value: N }, uCell: { value: world.cell }, uHScale: { value: world.hScale }, uHOffset: { value: world.hOffset },
      uRanges: { value: this.ranges }, uGrid: { value: GRID }, uCam: { value: new THREE.Vector3() },
    };
    const mat = this.material = new THREE.MeshLambertMaterial();
    if (detail) mat.defines = { NEAR_DETAIL: '' };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      albedoUniforms(shader, colorMap, world.extent, noise, coverMap);
      withAtmosphere(shader, { weather: 1 });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 nodeA;
          uniform float uRanges[${LEVELS}];
          uniform float uGrid, uExtent;
          uniform vec3 uCam;
          uniform sampler2D uCover;
          varying vec3 vWPos;
          ${HEIGHT_GLSL}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', `
          float size = nodeA.z;
          int lvl = int(nodeA.w + 0.5);
          vec2 g = position.xz;
          vec2 wxz = nodeA.xy + g * size;
          float far = uRanges[lvl];
          float near = lvl > 0 ? uRanges[lvl - 1] : 0.0;
          float mStart = mix(near, far, 0.62);
          float d = distance(uCam, vec3(wxz.x, baseH(wxz), wxz.y));
          float morph = clamp((d - mStart) / (far - mStart), 0.0, 1.0);
          vec2 gd = g * uGrid;
          g = (gd - fract(gd * 0.5) * 2.0 * morph) / uGrid;
          wxz = nodeA.xy + g * size;
          float spacing = size / uGrid * (1.0 + morph);
          vec3 transformed = vec3(wxz.x, groundH(wxz, spacing), wxz.y);
          vWPos = transformed;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos;
          ${ALBEDO_UNIFORMS}
          ${HEIGHT_GLSL}
          ${WORLEY_GLSL}`)
        .replace('#include <normal_fragment_begin>', `
          float camD = length(vWPos - cameraPosition);
          float e = max(uCell * 0.55, camD * 0.0025);
          vec2 p = vWPos.xz;
          float gx = (baseH(p + vec2(e, 0.0)) - baseH(p - vec2(e, 0.0))) / (2.0 * e);
          float gz = (baseH(p + vec2(0.0, e)) - baseH(p - vec2(0.0, e))) / (2.0 * e);
          if (camD < 160.0) {
            float rock = rockAt(p), amp = reliefAmp(rock, maskAt(p)), sp = camD * 0.004, de = 0.35;
            float k = 1.0 - smoothstep(90.0, 160.0, camD);
            gx += k * (relief(p + vec2(de, 0.0), amp, rock, sp) - relief(p - vec2(de, 0.0), amp, rock, sp)) / (2.0 * de);
            gz += k * (relief(p + vec2(0.0, de), amp, rock, sp) - relief(p - vec2(0.0, de), amp, rock, sp)) / (2.0 * de);
          }
          if (uEditOn > 0.5) {
            float ee = max(0.5, camD * 0.0015);
            gx += (editH(p + vec2(ee, 0.0)) - editH(p - vec2(ee, 0.0))) / (2.0 * ee);
            gz += (editH(p + vec2(0.0, ee)) - editH(p - vec2(0.0, ee))) / (2.0 * ee);
          }
          vec3 wn = normalize(vec3(-gx, 1.0, -gz));
          #ifdef NEAR_DETAIL
          ${NEAR_NORMAL}
          #endif
          float faceDirection = 1.0;
          vec3 normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
          vec3 nonPerturbedNormal = normal;
          ${ALBEDO}
          #ifdef NEAR_DETAIL
          ${NEAR_COLOR}
          #endif`);
    };
    mat.customProgramCacheKey = () => 'rawah-cdlod';

    this.geos = quadrantGeometries();
    this.group = new THREE.Group();
    for (const g of this.geos) {
      const m = new THREE.Mesh(g, mat);
      m.frustumCulled = false;
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.#buildBounds();
    this.frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._sphere = new THREE.Sphere();
    this.nodes = 0;
  }

  /** Min/max height pyramid: level l holds one entry per level-l quadtree node. */
  #buildBounds() {
    const w = this.world, N = w.N;
    const leafCells = N / 2 ** (LEVELS - 1);
    this.minmax = [];
    let n = 2 ** (LEVELS - 1);
    let lo = new Float32Array(n * n), hi = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        let a = Infinity, b = -Infinity;
        for (let r = j * leafCells; r <= (j + 1) * leafCells; r++) {
          for (let c = i * leafCells; c <= (i + 1) * leafCells; c++) {
            const h = w.gridH(c, r);
            if (h < a) a = h; if (h > b) b = h;
          }
        }
        lo[j * n + i] = a - 2.5 - LIMIT; hi[j * n + i] = b + 2.5 + LIMIT;
      }
    }
    this.minmax.push([lo, hi, n]);
    while (n > 1) {
      const m = n / 2, lo2 = new Float32Array(m * m), hi2 = new Float32Array(m * m);
      for (let j = 0; j < m; j++) {
        for (let i = 0; i < m; i++) {
          const k = [(2 * j) * n + 2 * i, (2 * j) * n + 2 * i + 1, (2 * j + 1) * n + 2 * i, (2 * j + 1) * n + 2 * i + 1];
          lo2[j * m + i] = Math.min(...k.map((q) => lo[q]));
          hi2[j * m + i] = Math.max(...k.map((q) => hi[q]));
        }
      }
      lo = lo2; hi = hi2; n = m;
      this.minmax.push([lo, hi, n]);
    }
  }

  #box(level, i, j) {
    const [lo, hi, n] = this.minmax[level];
    const size = this.leaf * 2 ** level, x0 = i * size - this.extent / 2, z0 = j * size - this.extent / 2;
    return this._box.set(this._box.min.set(x0, lo[j * n + i], z0), this._box.max.set(x0 + size, hi[j * n + i], z0 + size));
  }

  #inRange(level, i, j, range) {
    this.#box(level, i, j);
    return this._box.distanceToPoint(this.cam) <= range;
  }

  #add(level, i, j, quads) {
    const size = this.leaf * 2 ** level;
    const x0 = i * size - this.extent / 2, z0 = j * size - this.extent / 2;
    for (let q = 0; q < 4; q++) {
      if (!(quads & (1 << q))) continue;
      const g = this.geos[q], k = g.instanceCount;
      if (k >= MAX_NODES) continue;
      const a = g.attributes.nodeA.array;
      a[k * 4] = x0; a[k * 4 + 1] = z0; a[k * 4 + 2] = size; a[k * 4 + 3] = level;
      g.instanceCount = k + 1;
    }
    this.nodes++;
  }

  /** CDLOD selection; returns false when the node is out of this level's range (the parent draws it). */
  #select(level, i, j) {
    if (!this.#inRange(level, i, j, this.ranges[level])) return false;
    this.#box(level, i, j);
    if (!this.frustum.intersectsBox(this._box)) return true;
    if (level === 0 || !this.#inRange(level, i, j, this.ranges[level - 1])) {
      this.#add(level, i, j, 15);
      return true;
    }
    let rest = 0;
    for (let q = 0; q < 4; q++) {
      if (!this.#select(level - 1, i * 2 + (q & 1), j * 2 + (q >> 1))) rest |= 1 << q;
    }
    if (rest) this.#add(level, i, j, rest);
    return true;
  }

  update(camera) {
    this.cam = camera.position;
    this.uniforms.uCam.value.copy(camera.position);
    this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._pm);
    for (const g of this.geos) g.instanceCount = 0;
    this.nodes = 0;
    this.#select(LEVELS - 1, 0, 0);
    for (const g of this.geos) g.attributes.nodeA.needsUpdate = true;
  }
}
