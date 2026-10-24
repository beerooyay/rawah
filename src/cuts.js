import * as THREE from 'three';
import { barkUV } from './trees.js';

// Cutting into a standing tree. The trees' own trunks are seven-sided prisms, far too coarse to
// carve, so a tree that is being felled gets a finer trunk (28 sides, rows where the cuts go)
// in place of the prism; every stroke rebuilds it with the notches a little deeper. Each notch is
// two flat planes cut into a cylinder, as an axe leaves them: a level floor, and a roof that
// slopes up and out to the bark. The cut faces wear the pale aspen strip of the tree atlas.

const NA = 36;                       // sides
const BELOW = 3, ROOF = 8, ABOVE = 5;
const PALE = [1.0, 0.86, 0.6];       // fresh wood
const BARK = 0.9;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * `geo` is a species geometry from buildSpecies (with `userData.trunk`). `notches` is a list of
 * { ang, D, y0, slope } in the geometry's own units: the direction (about +Y, from +x toward +z), how
 * deep the wedge goes in, the height of its floor, and the rise of its roof per unit of depth.
 * Returns a new geometry with the trunk replaced, or null if the species has no trunk to carve.
 */
export function carvedTree(geo, notches) {
  const T = geo.userData.trunk;
  if (!T) return null;
  const { h: H, r0, r1, bark, lean } = T;
  const R = (y) => r0 + (r1 - r0) * (y / H);
  const [u0, v0, du, dv] = barkUV(bark), [pu0, pv0, pdu, pdv] = barkUV('aspen');

  const pos = [], nor = [], uv = [], col = [], idx = [];
  // strips[group][row][column] = vertex index; groups are joined by coincident rows, not shared vertices
  const strip = (rows, norm, tex, shade) => {
    const base = pos.length / 3;
    for (let j = 0; j < rows.length; j++) {
      for (let i = 0; i <= NA; i++) {
        const [r, y] = rows[j][i], a = (i / NA) * Math.PI * 2;
        const t = y / H, lx = lean ? lean.x * t * t : 0, lz = lean ? lean.z * t * t : 0;
        pos.push(Math.cos(a) * r + lx, y, Math.sin(a) * r + lz);
        const n = norm(i, j, a);
        nor.push(n[0], n[1], n[2]);
        const [u, v] = tex(i, j, y);
        uv.push(u, v);
        const sh = typeof shade === 'function' ? shade(i, j) : shade;
        col.push(sh[0], sh[1], sh[2]);
      }
    }
    for (let j = 0; j < rows.length - 1; j++) {
      for (let i = 0; i < NA; i++) {
        const a = base + j * (NA + 1) + i, b = a + 1, c = a + NA + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  };
  const radial = (i, j, a) => { const l = Math.hypot(Math.cos(a), 0.15, Math.sin(a)); return [Math.cos(a) / l, 0.15 / l, Math.sin(a) / l]; };
  const barkTex = (i, j, y) => [u0 + du * (i / NA), v0 + dv * (y / H)];
  const woodTex = (i, j, y) => [pu0 + pdu * ((i / NA) * 3 % 1), pv0 + pdv * (0.15 + 0.7 * ((y * 2.7) % 1))];

  // per column: the notch it falls in, if any
  const cols = [];
  for (let i = 0; i <= NA; i++) {
    const a = (i / NA) * Math.PI * 2;
    let cut = null;
    for (const n of notches) {
      if (n.D <= 1e-4) continue;
      const R0 = R(n.y0), dl = wrap(a - n.ang), dmax = Math.acos(Math.max(0, (R0 - n.D) / R0));
      if (Math.abs(dl) < dmax) { cut = { n, R0, dl, s0: R0 - n.D }; break; }
    }
    cols.push(cut);
  }
  const y0 = (i) => (cols[i] ? cols[i].n.y0 : notches[0]?.y0 ?? 0.8);

  // bark below the cut
  const below = [], floor = [[], []], roof = [], above = [];
  for (let j = 0; j <= BELOW; j++) below.push(Array.from({ length: NA + 1 }, (_, i) => { const y = (y0(i) * j) / BELOW; return [R(y), y]; }));
  for (let i = 0; i <= NA; i++) {
    const c = cols[i], y = y0(i);
    floor[0].push([R(y), y]);
    floor[1].push(c ? [c.s0 / Math.cos(c.dl), y] : [R(y), y]);
  }
  const yTop = [];
  for (let j = 0; j <= ROOF; j++) {
    roof.push(Array.from({ length: NA + 1 }, (_, i) => {
      const c = cols[i], y = y0(i);
      if (!c) return [R(y), y];
      const t = j / ROOF, cosd = Math.cos(c.dl), sTop = c.R0 * cosd;
      const s = c.s0 + t * (sTop - c.s0), yy = y + c.n.slope * (s - c.s0);
      if (j === ROOF) yTop[i] = yy;
      return [s / cosd, yy];
    }));
  }
  for (let i = 0; i <= NA; i++) if (yTop[i] === undefined) yTop[i] = y0(i);
  for (let j = 0; j <= ABOVE; j++) above.push(Array.from({ length: NA + 1 }, (_, i) => { const y = yTop[i] + (H - yTop[i]) * (j / ABOVE); return [R(y), y]; }));

  strip(below, radial, barkTex, [BARK, BARK, BARK]);
  // dark in the crease, paler toward the bark
  strip(floor, () => [0, 1, 0], woodTex, (i, j) => PALE.map((v) => v * (j ? 0.42 : 0.95)));
  // the roof faces down and out into the void: normal (rise, -1) in (outward, up), turned to each column's own direction
  strip(roof, (i, j, a) => {
    const c = cols[i];
    if (!c) return radial(i, j, a);
    const k = 1 / Math.hypot(c.n.slope, 1), ca = Math.cos(c.n.ang), sa = Math.sin(c.n.ang);
    return [ca * c.n.slope * k, -k, sa * c.n.slope * k];
  }, woodTex, (i, j) => PALE.map((v) => v * (0.38 + 0.45 * (j / ROOF))));
  strip(above, radial, barkTex, [BARK, BARK, BARK]);

  // the old trunk's triangles go; everything else (branches, crown) is kept as it was
  const A = geo.attributes, n0 = A.position.count, old = geo.index.array;
  const keep = [];
  for (let k = 0; k < old.length; k++) if (k < T.idxStart || k >= T.idxEnd) keep.push(old[k]);
  const out = new THREE.BufferGeometry();
  const cat = (a, b, size) => { const f = new Float32Array(a.length + b.length); f.set(a); f.set(b, a.length); return new THREE.BufferAttribute(f, size); };
  out.setAttribute('position', cat(A.position.array, pos, 3));
  out.setAttribute('normal', cat(A.normal.array, nor, 3));
  out.setAttribute('uv', cat(A.uv.array, uv, 2));
  out.setAttribute('color', cat(A.color.array, col, 3));

  // face every new triangle the way its vertex normals point, so the double-sided lighting never flips
  const P = out.attributes.position.array, N = out.attributes.normal.array;
  const fin = keep.slice();
  for (let k = 0; k < idx.length; k += 3) {
    let [a, b, c] = [idx[k] + n0, idx[k + 1] + n0, idx[k + 2] + n0];
    const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]], e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    if (nx * N[a * 3] + ny * N[a * 3 + 1] + nz * N[a * 3 + 2] < 0) [b, c] = [c, b];
    if (nx * nx + ny * ny + nz * nz < 1e-12) continue;      // collapsed where there is no notch
    fin.push(a, b, c);
  }
  out.setIndex(fin);
  out.computeBoundingBox();
  out.computeBoundingSphere();
  out.userData.trunk = T;
  return out;
}
