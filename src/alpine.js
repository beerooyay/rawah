import * as THREE from 'three';
import { withAtmosphere } from './atmosphere.js';

/** True when this page was loaded with the alpine look. */
export const ALPINE = (() => {
  try { return JSON.parse(localStorage.getItem('rawah-settings') || '{}').look === 'alpine'; } catch { return false; }
})();

const KIT = {};

/** assets/alpine: per mesh, vertices of 28 bytes (position, normal, rgba bytes: linear colour and a wind weight), then uint32 indices. */
export async function loadAlpineKit(base = './assets/alpine/') {
  const meta = await fetch(base + 'kit.json').then((r) => r.json());
  await Promise.all(Object.entries(meta).filter(([name]) => name.startsWith('SM_Granite_')).map(async ([name, m]) => {
    const buf = await fetch(base + name + '.bin').then((r) => r.arrayBuffer());
    const v = m.vertices, dv = new DataView(buf);
    const pos = new Float32Array(v * 3), nor = new Float32Array(v * 3), col = new Float32Array(v * 3);
    for (let i = 0; i < v; i++) {
      for (let k = 0; k < 3; k++) {
        pos[i * 3 + k] = dv.getFloat32(i * 28 + k * 4, true);
        nor[i * 3 + k] = dv.getFloat32(i * 28 + 12 + k * 4, true);
        col[i * 3 + k] = dv.getUint8(i * 28 + 24 + k) / 255;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf.slice(v * 28, v * 28 + m.indices * 4)), 1));
    KIT[name.replace('SM_', '')] = g;
  }));
}

function hash(x, y, z) {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

/** The kit's six granite forms for the 'granite' kind (base at y = 0, two units across), painted between a cool and a warm grey with lichen on top. */
export function alpineRocks(rocks) {
  const granite = [1, 2, 3, 4, 5, 6].map((i) => {
    const g = KIT['Granite_0' + i].clone();
    g.computeBoundingBox();
    const b = g.boundingBox, k = 2 / Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    g.scale(k, k, k);
    const P = g.attributes.position, N = g.attributes.normal, C = g.attributes.color;
    for (let v = 0; v < P.count; v++) {
      const m = hash(Math.round(P.getX(v) * 2.3) + i, Math.round(P.getY(v) * 2.3), Math.round(P.getZ(v) * 2.3));
      let c = [0.24 + 0.16 * m, 0.26 + 0.11 * m, 0.24 + 0.07 * m];
      const li = Math.max(0, N.getY(v) - 0.55) * 2.2 * (hash(P.getX(v) * 3.1, i, P.getZ(v) * 3.1) > 0.5 ? 0.45 : 0);
      c = [c[0] + (0.17 - c[0]) * li, c[1] + (0.205 - c[1]) * li, c[2] + (0.105 - c[2]) * li];
      C.setXYZ(v, c[0] * 1.5, c[1] * 1.5, c[2] * 1.5);
    }
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
  return { ...rocks, granite, textured: false };
}

/** Faceted, vertex-coloured stone under the game's light and weather: no rock photograph. */
export function alpineStone() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mat.onBeforeCompile = (shader) => withAtmosphere(shader, { weather: 1, occlusion: 0.8 });
  mat.customProgramCacheKey = () => 'rawah-alpine-stone';
  return mat;
}
