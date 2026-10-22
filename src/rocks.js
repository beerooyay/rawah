import * as THREE from 'three';
import { withAtmosphere } from './atmosphere.js';
import { rng } from './trees.js';
import { valueNoise } from './noise.js';

// Rock for the Rawah: pale pink-grey Precambrian granite and gneiss that
// weathers into angular blocks, flat slabs and teeth. Three shapes, a few
// variants each, are instanced by flora.js, which also assembles them into
// outcrops, tors, talus fans and lone glacial erratics. Each is an icosphere
// shaved flat against a handful of random planes, so it reads as cut stone,
// then painted per vertex with banding and a little lichen.

// hex is read as sRGB; vertex colours are linear, so these are converted once here
const GRANITE = [new THREE.Color(0x7d716a), new THREE.Color(0x6a6866), new THREE.Color(0x86766a)];
const LICHEN = [new THREE.Color(0x76803f), new THREE.Color(0xb27a2c)];

/** A faceted stone: `sx, sy, sz` stretch it, `planes` shaves it, `cut` is how far in the first planes bite. */
function stone(seed, { sx = 1, sy = 0.75, sz = 1, planes = 9, cut = 0.72, flat = -0.5, tilt = 0 }) {
  const R = rng(seed);
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position;
  const cuts = [];
  for (let k = 0; k < planes; k++) {
    // the first plane is a roughly flat top, the rest are random faces
    const n = k === 0
      ? new THREE.Vector3((R() - 0.5) * tilt, 1, (R() - 0.5) * tilt).normalize()
      : new THREE.Vector3(R() - 0.5, (R() - 0.5) * 1.2, R() - 0.5).normalize();
    cuts.push([n, (k === 0 ? 0.8 : cut) + R() * 0.2]);
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    for (const [n, d] of cuts) { const o = v.dot(n) - d; if (o > 0) v.addScaledVector(n, -o); }
    if (v.y < flat) v.y = flat;
    const jit = 1 + (valueNoise(v.x * 3 + seed, v.z * 3, seed) - 0.5) * 0.22;
    p.setXYZ(i, v.x * sx * jit, v.y * sy, v.z * sz * jit);
  }
  const flatGeo = g;                   // an icosphere is already unindexed, so every face gets its own normal: hard edges
  flatGeo.deleteAttribute('uv');
  flatGeo.computeVertexNormals();
  // paint: horizontal banding, lighter up top, a few lichen patches
  const pos = flatGeo.attributes.position, nor = flatGeo.attributes.normal, col = new Float32Array(pos.count * 3);
  const base = GRANITE[seed % GRANITE.length], c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const band = 0.5 + 0.5 * Math.sin(y * 7 + valueNoise(x * 2, z * 2, seed + 3) * 4);
    const mottled = valueNoise(x * 6 + seed, z * 6, seed + 9);
    c.copy(base).multiplyScalar(0.62 + band * 0.22 + mottled * 0.3 + Math.max(0, nor.getY(i)) * 0.1);
    if (nor.getY(i) > 0.3 && valueNoise(x * 4, z * 4, seed + 21) > 0.55) c.lerp(LICHEN[(seed >> 1) & 1], 0.55);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  flatGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  flatGeo.computeBoundingBox();
  flatGeo.computeBoundingSphere();
  return flatGeo;
}

/** Unit-ish geometry for every rock kind; scale in flora to the size wanted. */
export function rockGeometries() {
  return {
    boulder: [stone(1, { sy: 0.8 }), stone(2, { sx: 1.15, sy: 0.7, sz: 0.9, planes: 11 }), stone(3, { sy: 0.9, planes: 8, cut: 0.66 }), stone(4, { sx: 0.9, sy: 0.65, sz: 1.2, planes: 10 })],
    slab: [stone(5, { sx: 1.5, sy: 0.3, sz: 1.1, planes: 6, cut: 0.9, flat: -0.28, tilt: 0.3 }), stone(6, { sx: 1.2, sy: 0.4, sz: 1.5, planes: 7, cut: 0.86, flat: -0.38, tilt: 0.4 })],
    tooth: [stone(7, { sx: 0.5, sy: 2.1, sz: 0.55, planes: 8, cut: 0.7, flat: -0.8 }), stone(8, { sx: 0.65, sy: 1.6, sz: 0.5, planes: 9, cut: 0.66, flat: -0.8 })],
  };
}

export function rockMaterial() {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  mat.onBeforeCompile = (shader) => withAtmosphere(shader, { weather: 1, occlusion: 0.8 });
  mat.customProgramCacheKey = () => 'rawah-rock';
  return mat;
}
