import * as THREE from 'three';

// How much of the sky each spot can see. In the mountains this is most of
// what makes light look natural: a cirque floor or a narrow valley only sees
// a slice of sky and stays cooler and dimmer in the shade, ridges and
// summits are wide open, and under a closed canopy the forest floor gets a
// fraction of the skylight. Baked once at load from the lidar (horizon
// angles in eight directions out to ~2 km) and the satellite land cover, and
// used to scale the ambient (sky) light everywhere: terrain, grass, trees.

const STEPS = [25, 45, 75, 120, 190, 300, 480, 760, 1200, 1900];

export function skyViewTexture(world, n = 512) {
  const out = new Uint8Array(n * n);
  const { N, cell, h, hScale, hOffset } = world;
  const at = (x, z) => {
    let c = Math.round(x / cell + N / 2), r = Math.round(z / cell + N / 2);
    c = c < 0 ? 0 : c >= N ? N - 1 : c;
    r = r < 0 ? 0 : r >= N ? N - 1 : r;
    return h[r * N + c] * hScale + hOffset;
  };
  const dirs = Array.from({ length: 8 }, (_, k) => [Math.cos((k * Math.PI) / 4), Math.sin((k * Math.PI) / 4)]);
  const step = world.extent / n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * step - world.half, z = (j + 0.5) * step - world.half;
      const h0 = at(x, z) + 1.5;
      let open = 0;
      for (const [dx, dz] of dirs) {
        let tan = 0;
        for (const d of STEPS) {
          const t = (at(x + dx * d, z + dz * d) - h0) / d;
          if (t > tan) tan = t;
        }
        open += 1 - tan / Math.sqrt(1 + tan * tan);   // 1 - sin(horizon angle)
      }
      const sky = open / 8;
      const canopy = world.coverAt(x, z, 0);
      out[j * n + i] = Math.round(255 * Math.max(0, Math.min(1, sky * (1 - canopy * 0.45))));
    }
  }
  const tex = new THREE.DataTexture(out, n, n, THREE.RedFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
