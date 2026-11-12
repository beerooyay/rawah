import * as THREE from 'three';
import { hash2 } from './noise.js';

let treadTexture;
export function treadDetail() {
  if (treadTexture) return treadTexture;
  const size = 256, data = new Uint8Array(size * size * 4);
  const wrap = (x, period) => (x + period) % period;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    const grain = hash2(x, y, 397);
    data[i] = 82 + grain * 74;
    data[i + 1] = 128;
    data[i + 3] = 255;
  }
  // Stamp irregular gravel into a tile once. Red is height, green is stone colour.
  for (const cell of [9, 24]) {
    const n = Math.ceil(size / cell), step = size / n;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      if (hash2(x, z, cell) > (cell === 9 ? 0.71 : 0.42)) continue;
      const cx = (x + hash2(x, z, cell + 1)) * step, cy = (z + hash2(x, z, cell + 2)) * step;
      const rx = step * (0.12 + 0.23 * hash2(x, z, cell + 3)), ry = rx * (0.5 + hash2(x, z, cell + 4) * 0.65);
      const tone = 70 + hash2(x, z, cell + 5) * 180;
      const a = hash2(x, z, cell + 6) * Math.PI, c = Math.cos(a), s = Math.sin(a);
      const r = Math.ceil(Math.max(rx, ry)) + 1;
      for (let j = Math.floor(cy) - r; j <= cy + r; j++) for (let k = Math.floor(cx) - r; k <= cx + r; k++) {
        const dx = k - cx, dy = j - cy;
        const u = (c * dx + s * dy) / rx, v = (c * dy - s * dx) / ry;
        const d = u * u + v * v + 0.28 * Math.abs(u * v);
        if (d >= 1) continue;
        const i = (wrap(j, size) * size + wrap(k, size)) * 4;
        const dome = Math.sqrt(1 - d);
        data[i] = Math.max(data[i], 148 + 102 * dome);
        data[i + 1] = 128 + (tone - 128) * Math.min(1, 4 * dome);
      }
    }
  }
  const map = new THREE.DataTexture(data, size, size);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.anisotropy = 4;
  map.needsUpdate = true;
  return (treadTexture = map);
}

