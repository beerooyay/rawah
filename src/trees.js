import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NOISE_GLSL } from './detail.js';
import { WIND_GLSL } from './wind.js';
import { withAtmosphere } from './atmosphere.js';

// Procedural trees. Everything is generated at startup: an atlas of painted
// foliage sprays and bark strips, card-based tree meshes built from them
// (branch whorls of drooping sprays, not cones), and an impostor atlas made by
// rendering each tree once, so distant trees cost a single crossed quad.
//
// Species follow the Rawah: Engelmann spruce and subalpine fir in the
// spruce-fir belt, lodgepole pine lower down, aspen, fire-killed snags,
// wind-pruned krummholz at treeline, and willow along the valley floor.

const ATLAS = 2048, CELL = 512;          // foliage cells on the top half, bark strips below
const SLOTS = {
  spruce: [0, 0], fir: [1, 0], pine: [2, 0], aspenLeaf: [3, 0],
  willowLeaf: [0, 1], deadTwig: [1, 1], krumm: [2, 1],
};
const BARK = { spruce: 0, pine: 1, aspen: 2, snag: 3 };   // 512x1024 strips across the bottom half

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296);
}

// ------------------------------------------------------------------ painting
function paintAtlas(season = 'autumn') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = ATLAS;
  const g = cv.getContext('2d');
  const R = rng(7);
  const cell = (name) => { const [i, j] = SLOTS[name]; return [i * CELL, j * CELL]; };
  const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

  // conifer spray: a drooping twig with side twigs, dense short needles all round
  const spray = (name, { hue, sat, light, needle, density, droop, width }) => {
    const [ox, oy] = cell(name);
    g.save();
    g.translate(ox, oy);
    g.beginPath(); g.rect(0, 0, CELL, CELL); g.clip();
    const twig = (x0, y0, ang, len, depth) => {
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12, a = ang + droop * t * t;
        const prev = pts[i - 1] || [x0, y0];
        pts.push(i ? [prev[0] + Math.cos(a) * len / 12, prev[1] + Math.sin(a) * len / 12] : [x0, y0]);
      }
      g.strokeStyle = hsl(25, 30, 22, 0.9); g.lineWidth = depth === 0 ? 4 : 2;
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      for (let i = 1; i < pts.length; i++) {
        const [x, y] = pts[i], [px, py] = pts[i - 1];
        const a = Math.atan2(y - py, x - px);
        for (let k = 0; k < density; k++) {
          const side = R() < 0.5 ? -1 : 1, na = a + side * (0.5 + R() * 0.9), nl = needle * (0.6 + R() * 0.6) * (1 - i / 16);
          const t = R();
          const sx = px + (x - px) * t, sy = py + (y - py) * t;
          g.strokeStyle = hsl(hue + R() * 14 - 7, sat + R() * 10, light + R() * 14 - 4, 0.95);
          g.lineWidth = 2.6 + R() * 1.6;
          g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + Math.cos(na) * nl, sy + Math.sin(na) * nl); g.stroke();
        }
        if (depth === 0 && i % 2 === 0 && i < 11) {
          const side = (i / 2) % 2 ? -1 : 1;
          twig(x, y, a + side * (0.65 + R() * 0.3), len * 0.42 * (1 - i / 14), 1);
        }
      }
    };
    for (let k = 0; k < 2; k++) twig(10, CELL * (0.42 + k * 0.08), -0.08 + k * 0.1, CELL * width, 0);
    g.restore();
  };
  spray('spruce', { hue: 172, sat: 20, light: 27, needle: 24, density: 16, droop: 0.55, width: 0.95 });
  spray('fir', { hue: 150, sat: 28, light: 22, needle: 20, density: 18, droop: 0.25, width: 0.95 });
  spray('krumm', { hue: 140, sat: 24, light: 22, needle: 18, density: 20, droop: 0.15, width: 0.9 });

  // lodgepole: long paired needles bursting from the twig tips
  {
    const [ox, oy] = cell('pine');
    g.save(); g.translate(ox, oy);
    const tufts = 15;
    for (let t = 0; t < tufts; t++) {
      const cx = 80 + R() * 360, cy = 90 + R() * 330;
      g.strokeStyle = hsl(28, 30, 25, 0.9); g.lineWidth = 4;
      g.beginPath(); g.moveTo(10, CELL * 0.55); g.quadraticCurveTo(cx * 0.5, cy + 30, cx, cy); g.stroke();
      for (let k = 0; k < 150; k++) {
        const a = R() * Math.PI * 2, l = 38 + R() * 60;
        g.strokeStyle = hsl(80 + R() * 18, 30, 26 + R() * 14, 0.97); g.lineWidth = 2.8;
        g.beginPath(); g.moveTo(cx, cy); g.quadraticCurveTo(cx + Math.cos(a) * l * 0.5, cy + Math.sin(a) * l * 0.5 - 6, cx + Math.cos(a) * l, cy + Math.sin(a) * l); g.stroke();
      }
    }
    g.restore();
  }

  // broadleaf clusters: aspen gold, willow rust
  const leaves = (name, hues) => {
    const [ox, oy] = cell(name);
    g.save(); g.translate(ox, oy);
    g.strokeStyle = hsl(30, 20, 30, 0.9); g.lineWidth = 3;
    for (let b = 0; b < 6; b++) {
      g.beginPath(); g.moveTo(CELL / 2, CELL - 10); g.quadraticCurveTo(CELL * R(), CELL * 0.6, CELL * (0.1 + R() * 0.8), CELL * (0.1 + R() * 0.5)); g.stroke();
    }
    for (let k = 0; k < 420; k++) {
      const x = CELL * (0.08 + R() * 0.84), y = CELL * (0.06 + R() * 0.8);
      const dx = x - CELL / 2, dy = (y - CELL * 0.45) * 1.25;
      if (dx * dx + dy * dy > (CELL * 0.45) ** 2) continue;
      const [h, s, l] = hues[Math.floor(R() * hues.length)];
      g.fillStyle = hsl(h + R() * 8 - 4, s, l + R() * 12 - 6, 0.97);
      g.save(); g.translate(x, y); g.rotate(R() * Math.PI * 2);
      const r = 9 + R() * 8;
      g.beginPath(); g.moveTo(0, -r * 1.2); g.quadraticCurveTo(r, -r * 0.2, 0, r); g.quadraticCurveTo(-r, -r * 0.2, 0, -r * 1.2); g.fill();
      g.restore();
    }
    g.restore();
  };
  // the season picks the deciduous palette: fresh spring green, deep summer green, gold, or bare twigs
  const ASPEN = {
    spring: [[88, 62, 52], [84, 58, 48], [92, 55, 58], [80, 60, 44]],
    summer: [[100, 42, 34], [96, 46, 30], [104, 38, 38], [92, 40, 28]],
    autumn: [[46, 88, 52], [42, 90, 46], [50, 80, 58], [38, 85, 42], [70, 40, 40]],
  };
  const WILLOW = {
    spring: [[80, 50, 46], [74, 46, 40]],
    summer: [[96, 32, 32], [90, 30, 28], [100, 26, 36]],
    autumn: [[30, 60, 38], [36, 66, 44], [24, 50, 32], [44, 50, 42]],
  };
  const bareTwigs = (name) => {
    const [ox, oy] = cell(name);
    g.save(); g.translate(ox, oy);
    const fork = (x, y, a, len, w, depth) => {
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      g.strokeStyle = hsl(30, 8, 46 + R() * 14, 0.95); g.lineWidth = w;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      if (depth < 4) for (let k = 0; k < 2; k++) fork(x2, y2, a + (k ? 1 : -1) * (0.3 + R() * 0.4), len * 0.68, w * 0.7, depth + 1);
    };
    for (let b = 0; b < 5; b++) fork(CELL / 2, CELL - 10, -Math.PI / 2 + (R() - 0.5) * 1.2, CELL * 0.22, 5, 0);
    g.restore();
  };
  if (ASPEN[season]) leaves('aspenLeaf', ASPEN[season]); else bareTwigs('aspenLeaf');
  if (WILLOW[season]) leaves('willowLeaf', WILLOW[season]); else bareTwigs('willowLeaf');

  // fire-killed twigs: bare grey forks
  {
    const [ox, oy] = cell('deadTwig');
    g.save(); g.translate(ox, oy);
    const fork = (x, y, a, l, w) => {
      if (l < 12) return;
      const x2 = x + Math.cos(a) * l, y2 = y + Math.sin(a) * l;
      g.strokeStyle = hsl(30, 6, 42 + R() * 14, 1); g.lineWidth = w;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      fork(x2, y2, a - 0.4 - R() * 0.3, l * 0.68, w * 0.7);
      fork(x2, y2, a + 0.3 + R() * 0.3, l * 0.62, w * 0.7);
    };
    fork(6, CELL * 0.5, -0.05, 170, 7);
    g.restore();
  }

  // bark strips (512 x 1024 each)
  const bark = (idx, paint) => { g.save(); g.translate(idx * CELL, CELL * 2); paint(); g.restore(); };
  bark(BARK.spruce, () => {
    g.fillStyle = '#4b3f37'; g.fillRect(0, 0, CELL, CELL * 2);
    for (let k = 0; k < 2600; k++) { g.fillStyle = hsl(20 + R() * 12, 12, 18 + R() * 22, 0.8); g.fillRect(R() * CELL, R() * CELL * 2, 6 + R() * 18, 3 + R() * 6); }
  });
  bark(BARK.pine, () => {
    g.fillStyle = '#6a4a35'; g.fillRect(0, 0, CELL, CELL * 2);
    for (let k = 0; k < 1400; k++) { g.fillStyle = hsl(18 + R() * 14, 30, 22 + R() * 26, 0.85); g.fillRect(R() * CELL, R() * CELL * 2, 14 + R() * 26, 6 + R() * 10); }
  });
  bark(BARK.aspen, () => {
    const gr = g.createLinearGradient(0, 0, CELL, 0);
    gr.addColorStop(0, '#c9c6b8'); gr.addColorStop(0.5, '#ebe8dc'); gr.addColorStop(1, '#cfcbbd');
    g.fillStyle = gr; g.fillRect(0, 0, CELL, CELL * 2);
    for (let k = 0; k < 90; k++) { // dark lenticels and branch scars ("eyes")
      g.fillStyle = hsl(30, 10, 12 + R() * 14, 0.85);
      const x = R() * CELL, y = R() * CELL * 2;
      g.beginPath(); g.ellipse(x, y, 6 + R() * 26, 2 + R() * 6, 0, 0, Math.PI * 2); g.fill();
    }
    const base = g.createLinearGradient(0, CELL * 2, 0, CELL * 1.6);
    base.addColorStop(0, 'rgba(40,34,28,0.9)'); base.addColorStop(1, 'rgba(40,34,28,0)');
    g.fillStyle = base; g.fillRect(0, CELL * 1.6, CELL, CELL * 0.4);
  });
  bark(BARK.snag, () => {
    g.fillStyle = '#9a948b'; g.fillRect(0, 0, CELL, CELL * 2);
    for (let k = 0; k < 400; k++) { g.fillStyle = hsl(35, 6, 45 + R() * 30, 0.6); g.fillRect(R() * CELL, R() * CELL * 2, 2 + R() * 3, 30 + R() * 90); }
    const ch = g.createLinearGradient(0, CELL * 2, 0, CELL * 1.25);
    ch.addColorStop(0, 'rgba(18,15,13,1)'); ch.addColorStop(0.6, 'rgba(25,21,18,0.85)'); ch.addColorStop(1, 'rgba(25,21,18,0)');
    g.fillStyle = ch; g.fillRect(0, CELL * 1.25, CELL, CELL * 0.75);
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// ------------------------------------------------------------------ geometry
// the canvas texture is flipped (v = 1 at the top row), so cell row j sits at v = 1 - (j + 1) / 4
const slotUV = (name) => { const [i, j] = SLOTS[name]; return [i / 4, 1 - (j + 1) / 4, 1 / 4, 1 / 4]; };
const barkUV = (name) => [BARK[name] / 4, 0, 1 / 4, 1 / 2];

/** Builder that collects cards and trunks into one geometry with rounded crown normals. */
class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; }

  vert(p, n, u, v, shade) {
    this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z); this.uv.push(u, v);
    this.col.push(shade, shade, shade);
    return this.pos.length / 3 - 1;
  }

  /** A spray card from `base` along `dir`, `len` long, `wid` wide, rolled by `roll`, bent down by `droop`. */
  card(base, dir, len, wid, roll, droop, slot, centre, shade = 1) {
    const [u0, v0, du, dv] = slotUV(slot);
    const d = dir.clone().normalize();
    const side = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize().applyAxisAngle(d, roll);
    const segs = 3, ids = [];
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const p = base.clone().addScaledVector(d, len * t);
      p.y -= droop * len * t * t;
      for (const k of [-0.5, 0.5]) {
        const q = p.clone().addScaledVector(side, wid * k);
        const n = q.clone().sub(centre).setY((q.y - centre.y) * 0.6 + 0.35).normalize();
        ids.push(this.vert(q, n, u0 + du * t * 0.98 + 0.002, v0 + dv * (0.5 + k * 0.96), shade * (0.72 + 0.28 * t)));
      }
    }
    for (let s = 0; s < segs; s++) {
      const a = ids[s * 2], b = ids[s * 2 + 1], c = ids[s * 2 + 2], e = ids[s * 2 + 3];
      this.idx.push(a, b, c, b, e, c);
    }
  }

  /** Upright card centred on `c` (leaf clusters). */
  flat(c, w, h, rot, slot, centre, shade = 1) {
    const [u0, v0, du, dv] = slotUV(slot);
    const ax = new THREE.Vector3(Math.cos(rot), 0, Math.sin(rot));
    const ids = [];
    for (const [i, j] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const p = c.clone().addScaledVector(ax, w * i); p.y += h * j;
      const n = p.clone().sub(centre).normalize();
      ids.push(this.vert(p, n, u0 + du * (i + 0.5), v0 + dv * (0.5 + j), shade));
    }
    this.idx.push(ids[0], ids[1], ids[2], ids[1], ids[3], ids[2]);
  }

  trunk(h, r0, r1, bark, seg = 7, lean = null) {
    const [u0, v0, du, dv] = barkUV(bark);
    const rows = 4, base = this.pos.length / 3;
    for (let j = 0; j <= rows; j++) {
      const t = j / rows, r = r0 + (r1 - r0) * t, y = h * t;
      const lx = lean ? lean.x * t * t : 0, lz = lean ? lean.z * t * t : 0;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const n = new THREE.Vector3(Math.cos(a), 0.15, Math.sin(a)).normalize();
        this.vert(new THREE.Vector3(Math.cos(a) * r + lx, y, Math.sin(a) * r + lz), n, u0 + du * (i / seg), v0 + dv * t, 0.9);
      }
    }
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < seg; i++) {
        const a = base + j * (seg + 1) + i, b = a + 1, c = a + seg + 1, d = c + 1;
        this.idx.push(a, c, b, b, c, d);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function conifer(seed, { height, radius, clear, whorl, branches, droop, slot, bark, shape, rise, density = 1 }) {
  const R = rng(seed), b = new Builder();
  b.trunk(height, radius * 0.11, 0.02, bark);
  const centre = V(0, height * 0.45, 0);
  for (let y = clear; y < height - 0.4; y += whorl * (0.85 + R() * 0.3)) {
    const t = (y - clear) / (height - clear);
    const L = radius * shape(t) * (0.8 + R() * 0.35);
    if (L < 0.15) continue;
    const off = R() * Math.PI * 2;
    for (let k = 0; k < branches; k++) {
      const a = off + (k / branches) * Math.PI * 2 + (R() - 0.5) * 0.6;
      const dir = V(Math.cos(a), rise + (R() - 0.5) * 0.15, Math.sin(a));
      b.card(V(0, y, 0), dir, L, L * 0.75, (R() - 0.5) * 0.9, droop * (1 - t * 0.6), slot, V(0, y + 0.3, 0), 0.85 + t * 0.2);
      // a second, steeper spray fills the silhouette seen from the side
      if (density > 1) b.card(V(0, y + 0.15, 0), V(dir.x, dir.y - 0.35, dir.z), L * 0.8, L * 0.6, Math.PI / 2 + (R() - 0.5) * 0.6, droop * 0.5, slot, V(0, y, 0), 0.8 + t * 0.2);
    }
  }
  // the leader: a few upright sprays at the tip
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    b.card(V(0, height - 1.4, 0), V(Math.cos(a) * 0.25, 1, Math.sin(a) * 0.25), 1.6, 0.7, a, 0, slot, centre, 1.05);
  }
  return b.geometry();
}

export function buildSpecies() {
  const spruce = (s) => conifer(s, { height: 17, radius: 2.4, clear: 0.6, whorl: 0.55, branches: 5, droop: 0.45, slot: 'spruce', bark: 'spruce', rise: -0.18,
    shape: (t) => Math.pow(1 - t, 0.85), density: 2 });
  const fir = (s) => conifer(s, { height: 15, radius: 1.5, clear: 0.4, whorl: 0.5, branches: 5, droop: 0.15, slot: 'fir', bark: 'spruce', rise: -0.05,
    shape: (t) => Math.pow(1 - t, 0.75) * (t < 0.1 ? 0.8 + t * 2 : 1), density: 2 });
  const lodge = (s) => {
    const R = rng(s), b = new Builder(), H = 19;
    b.trunk(H, 0.24, 0.04, 'pine');
    const centre = V(0, H * 0.8, 0);
    for (let y = H * 0.5; y < H - 0.5; y += 0.55 * (0.8 + R() * 0.4)) {
      const t = (y - H * 0.5) / (H * 0.5), L = 2.3 * Math.sin(Math.PI * (0.22 + t * 0.78)) * (0.75 + R() * 0.4);
      const off = R() * 6.28;
      for (let k = 0; k < 5; k++) {
        const a = off + k * 1.257 + (R() - 0.5) * 0.7;
        b.card(V(0, y, 0), V(Math.cos(a), 0.1 + R() * 0.3, Math.sin(a)), L, L * 1.0, (R() - 0.5) * 1.4, 0.12, 'pine', centre, 0.9 + t * 0.15);
      }
    }
    b.card(V(0, H - 1.2, 0), V(0.1, 1, 0), 1.6, 1.1, 0, 0, 'pine', centre, 1.05);
    return b.geometry();
  };
  const aspen = (s) => {
    const R = rng(s), b = new Builder(), H = 11;
    const lean = V((R() - 0.5) * 0.8, 0, (R() - 0.5) * 0.8);
    b.trunk(H * 0.85, 0.17, 0.05, 'aspen', 7, lean);
    const centre = V(lean.x, H * 0.68, lean.z);
    for (let k = 0; k < 34; k++) {
      const a = R() * 6.28, rr = Math.sqrt(R()) * 2.2, y = H * (0.45 + R() * 0.5);
      const shrink = 1 - Math.abs(y / H - 0.72) * 1.4;
      const c = V(lean.x + Math.cos(a) * rr * shrink, y, lean.z + Math.sin(a) * rr * shrink);
      b.flat(c, 1.9, 1.9, R() * 3.14, 'aspenLeaf', centre, 0.85 + (y / H) * 0.25);
      b.flat(c, 1.9, 1.9, R() * 3.14 + 1.57, 'aspenLeaf', centre, 0.85 + (y / H) * 0.25);
    }
    return b.geometry();
  };
  const snag = (s) => {
    const R = rng(s), b = new Builder(), H = 15 + R() * 4;
    b.trunk(H, 0.22, 0.03, 'snag', 6);
    const centre = V(0, H * 0.5, 0);
    for (let y = 2.5; y < H - 1; y += 0.9 + R() * 1.1) {
      if (R() < 0.45) continue;
      const a = R() * 6.28, L = 0.4 + (1 - y / H) * 1.2 * R();
      b.card(V(0, y, 0), V(Math.cos(a), -0.2 + R() * 0.3, Math.sin(a)), L + 0.3, 0.5, (R() - 0.5) * 2, 0.1, 'deadTwig', centre, 0.95);
    }
    return b.geometry();
  };
  const krumm = (s) => {
    const R = rng(s), b = new Builder();
    const centre = V(0, 0.3, 0);
    for (let k = 0; k < 22; k++) {
      const a = R() * 6.28, y = 0.15 + R() * 0.7;
      b.card(V((R() - 0.5) * 0.6, y, (R() - 0.5) * 0.6), V(Math.cos(a), 0.1 + R() * 0.2, Math.sin(a)), 1 + R() * 0.8, 0.9, R() * 3, 0.05, 'krumm', centre, 0.8 + y * 0.3);
    }
    // one flagged stem pushing above the mat, pruned on the windward side
    b.trunk(2.2, 0.06, 0.02, 'spruce', 5);
    for (let y = 1.0; y < 2.1; y += 0.3) b.card(V(0, y, 0), V(0.9, 0.05, 0.2), 0.7, 0.45, 0, 0.1, 'krumm', centre, 1);
    return b.geometry();
  };
  const willow = (s) => {
    const R = rng(s), b = new Builder();
    const centre = V(0, 0.9, 0);
    for (let k = 0; k < 16; k++) {
      const a = R() * 6.28, rr = R() * 1.0;
      const c = V(Math.cos(a) * rr, 0.6 + R() * 1.0, Math.sin(a) * rr);
      b.flat(c, 1.3, 1.5, R() * 3.14, 'willowLeaf', centre, 0.9);
    }
    return b.geometry();
  };
  return {
    spruce: [spruce(11), spruce(23), fir(37)],
    lodgepole: [lodge(41), lodge(53)],
    aspen: [aspen(61), aspen(73)],
    snag: [snag(81), snag(97), snag(101)],
    krumm: [krumm(111), krumm(127)],
    willow: [willow(131)],
  };
}

// ------------------------------------------------------------------ materials
// World-space sway driven by the shared wind field: the whole tree leans
// downwind as gusts pass, oscillates gently around that lean, branches flutter,
// and aspen leaves quake on their own (their atlas cell is the top-right one).
const SWAY = /* glsl */ `
  vec4 mvPosition = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    mvPosition = instanceMatrix * mvPosition;
    vec3 ip = instanceMatrix[3].xyz;
    float hgt = max(mvPosition.y - ip.y, 0.0);
    float g = gustAt(ip.xz);
    float lean = (0.15 + g * 1.3) * hgt * hgt * 0.0011;
    float osc = sin(uTime * (1.7 - min(hgt, 20.0) * 0.03) + ip.x * 0.13 + ip.z * 0.07) * (0.25 + g) * hgt * hgt * 0.0006;
    mvPosition.xz += WIND_DIR * (lean + osc);
    float flutter = sin(uTime * 4.3 + dot(transformed, vec3(1.7, 2.3, 1.1)) + ip.x) * 0.035 * (0.25 + g) * min(hgt * 0.15, 1.0);
    mvPosition.xyz += vec3(flutter, flutter * 0.4, -flutter);
    float aspen = step(0.75, uv.x) * step(0.75, uv.y);
    mvPosition.y += aspen * sin(uTime * 14.0 + dot(transformed.xz, vec2(9.1, 7.3))) * 0.045 * (0.35 + g);
  #endif
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`;

function windy(shader, uniforms) {
  shader.uniforms.uTime = uniforms.uTime;
  shader.uniforms.uCalm = uniforms.uCalm;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${WIND_GLSL}`)
    .replace('#include <project_vertex>', SWAY);
}

/** Each tree a slightly different green: brightness and hue jittered by where it stands. */
function tinted(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec2 tp = instanceMatrix[3].xz;
        float tv = fract(sin(dot(tp, vec2(12.9898, 78.233))) * 43758.5453);
        float tw = fract(tv * 7.31);
        vTint = vec3(0.84 + tv * 0.3) * vec3(1.0 + (tw - 0.5) * 0.1, 1.0 + (tw - 0.5) * 0.04, 1.0 - (tw - 0.5) * 0.12);
      #else
        vTint = vec3(1.0);
      #endif`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTint;');
}

/** Foliage material: alpha-tested atlas, vertex shade, wind, light through the leaves. */
export function foliageMaterial(atlas, uniforms) {
  const mat = new THREE.MeshLambertMaterial({ map: atlas, alphaTest: 0.35, alphaToCoverage: true, side: THREE.DoubleSide, vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    windy(shader, uniforms);
    tinted(shader);
    withAtmosphere(shader, { translucency: 0.55, weather: 0.6, occlusion: 0.7 });
  };
  mat.customProgramCacheKey = () => 'rawah-foliage';
  return mat;
}

/** Depth material so cards cast leafy, not solid, shadows that sway with the trees. */
export function foliageDepth(atlas, uniforms) {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.42, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => windy(shader, uniforms);
  mat.customProgramCacheKey = () => 'rawah-foliage-depth';
  return mat;
}

// ------------------------------------------------------------------ impostors
// 8 x 4 cells

/**
 * Render every species variant once into an impostor atlas. Returns the
 * texture plus, per variant, its atlas cell and world-space width/height.
 */
export function bakeImpostors(renderer, species, material, IMP = 4096) {
  const IMP_W = IMP / 8, IMP_H = IMP / 4;
  const target = new THREE.WebGLRenderTarget(IMP, IMP, { samples: 0 });
  target.texture.generateMipmaps = true;
  target.texture.minFilter = THREE.LinearMipmapLinearFilter;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(0.3, 1, 1);
  scene.add(sun);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const cells = {};
  const prev = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), shadow: renderer.shadowMap.enabled };
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x2c3a24, 0);   // foliage-coloured background, so mipmaps fade to green, not black
  renderer.clear();
  renderer.shadowMap.enabled = false;
  let n = 0;
  for (const [kind, list] of Object.entries(species)) {
    cells[kind] = list.map((geo) => {
      const box = geo.boundingBox;
      const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + 0.4, h = box.max.y + 0.2;
      const scaleW = Math.max(w, h / 2);  // fit 1:2 cell
      const i = n % 8, j = Math.floor(n / 8); n++;
      const mesh = new THREE.Mesh(geo, material);
      scene.add(mesh);
      cam.left = -scaleW / 2; cam.right = scaleW / 2; cam.bottom = 0; cam.top = scaleW * 2;
      cam.position.set(0, 0, 30); cam.lookAt(0, 0, 0); cam.position.y = 0; cam.updateProjectionMatrix();
      target.viewport.set(i * IMP_W, IMP - (j + 1) * IMP_H, IMP_W, IMP_H);
      target.scissor.copy(target.viewport);
      target.scissorTest = true;
      renderer.setRenderTarget(target);
      renderer.render(scene, cam);
      scene.remove(mesh);
      return { u: i / 8, v: 1 - (j + 1) / 4, w: scaleW, h: scaleW * 2 };
    });
  }
  target.scissorTest = false;
  renderer.setRenderTarget(prev.target);
  renderer.setClearColor(prev.color, prev.alpha);
  renderer.shadowMap.enabled = prev.shadow;
  return { texture: target.texture, cells };
}

/** Crossed-quad impostor geometry (unit size, base at origin) with a per-instance atlas cell. */
export function impostorGeometry(max) {
  const q = [];
  for (const rot of [0, Math.PI / 2]) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.translate(0, 0.5, 0);
    g.rotateY(rot);
    const n = g.attributes.normal;
    for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
    q.push(g);
  }
  const geo = mergeGeometries(q);
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2));
  return geo;
}

export function impostorMaterial(texture, uniforms) {
  const mat = new THREE.MeshLambertMaterial({ map: texture, alphaTest: 0.3, alphaToCoverage: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    windy(shader, uniforms);
    tinted(shader);
    withAtmosphere(shader, { translucency: 0.35, weather: 0.6, occlusion: 0.7 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aCell;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vMapUv = aCell + vec2(uv.x / 8.0, uv.y / 4.0);`)
      // impostors aren't in the leaf atlas: keep the quake off them
      .replace('float aspen = step(0.75, uv.x) * step(0.75, uv.y);', 'float aspen = 0.0;');
    // a flat card has no idea which way its crown faces: light it like a rounded crown,
    // half toward you and half toward the sun, so low sun doesn't turn far forests black
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `
      float faceDirection = 1.0;
      vec3 viewUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
      vec3 normal = normalize(normalize(-vViewPosition) * 0.55 + uSunView * 0.45 + viewUp * 0.35);
      vec3 nonPerturbedNormal = normal;`);
  };
  mat.customProgramCacheKey = () => 'rawah-impostor';
  return mat;
}

export { paintAtlas };
