import * as THREE from 'three';

// The shape you have made of the ground. The lidar grid is 3.6 m, far too
// coarse to carve, so edits live in their own 1 m grid of height offsets, kept
// sparse: 32 m chunks that exist only where you have worked, stored in a small
// atlas texture behind an index texture (a one-level page table). The terrain
// and grass vertex shaders add the offset to the ground they already draw
// (`editH`, from SCULPT_GLSL); `World.height` adds the same bilinear sample, so
// walking, trees and the camera agree with what is on screen.

export const CHUNK = 32;      // cells per chunk side (the shader hard-codes 32)
export const EC = 1;          // metres per cell (the shader hard-codes 1)
export const LIMIT = 14;      // most a cell may be lifted or cut from the lidar surface
const SIDE = 32;              // atlas is SIDE x SIDE chunks
const ATLAS = SIDE * CHUNK;

export const SCULPT_GLSL = /* glsl */ `
uniform highp usampler2D uEditIdx;
uniform highp sampler2D uEditAtlas;
uniform float uEditCn, uEditOn;
float editCell(ivec2 c) {
  if (c.x < 0 || c.y < 0) return 0.0;
  ivec2 ch = c / 32;
  if (ch.x >= int(uEditCn) || ch.y >= int(uEditCn)) return 0.0;
  uint s = texelFetch(uEditIdx, ch, 0).r;
  if (s == 0u) return 0.0;
  int k = int(s) - 1;
  return texelFetch(uEditAtlas, ivec2((k % 32) * 32, (k / 32) * 32) + (c - ch * 32), 0).r;
}
float editH(vec2 xz) {
  if (uEditOn < 0.5) return 0.0;
  vec2 u = xz + uN * uCell * 0.5;
  vec2 c = floor(u), f = u - c;
  ivec2 i = ivec2(c);
  float a = editCell(i), b = editCell(i + ivec2(1, 0)), d = editCell(i + ivec2(0, 1)), e = editCell(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
}
`;

const smooth = (t) => t * t * (3 - 2 * t);

export class Sculpt {
  constructor(world) {
    this.world = world;
    this.half = world.extent / 2;
    this.cn = Math.ceil(world.extent / (CHUNK * EC));
    this.index = new Uint16Array(this.cn * this.cn);   // slot + 1, or 0 for an untouched chunk
    this.atlas = new Float32Array(ATLAS * ATLAS);
    this.slots = new Map();                            // chunk key -> slot
    this.freeSlots = Array.from({ length: SIDE * SIDE }, (_, i) => SIDE * SIDE - 1 - i);
    this.count = 0;                                    // chunks in use
    this.touched = false;                              // a cell changed since the last flush
    this.rect = null;                                  // metres touched since `takeRect`

    const idx = new THREE.DataTexture(this.index, this.cn, this.cn, THREE.RedIntegerFormat, THREE.UnsignedShortType);
    idx.internalFormat = 'R16UI';
    idx.magFilter = idx.minFilter = THREE.NearestFilter;
    idx.generateMipmaps = false;
    idx.needsUpdate = true;
    const atlas = new THREE.DataTexture(this.atlas, ATLAS, ATLAS, THREE.RedFormat, THREE.FloatType);
    atlas.internalFormat = 'R32F';
    atlas.magFilter = atlas.minFilter = THREE.NearestFilter;
    atlas.generateMipmaps = false;
    atlas.needsUpdate = true;
    this.textures = { idx, atlas };
    this.uniforms = {
      uEditIdx: { value: idx }, uEditAtlas: { value: atlas },
      uEditCn: { value: this.cn }, uEditOn: { value: 0 },
    };
  }

  #base(slot) { return (Math.floor(slot / SIDE) * ATLAS + (slot % SIDE)) * CHUNK; }

  /** Offset of cell (ix, iz) in metres. */
  cell(ix, iz) {
    if (ix < 0 || iz < 0) return 0;
    const cx = Math.floor(ix / CHUNK), cz = Math.floor(iz / CHUNK);
    if (cx >= this.cn || cz >= this.cn) return 0;
    const s = this.index[cz * this.cn + cx];
    if (!s) return 0;
    return this.atlas[this.#base(s - 1) + (iz - cz * CHUNK) * ATLAS + (ix - cx * CHUNK)];
  }

  /** Bilinear offset at a world position: the twin of `editH`. */
  at(x, z) {
    if (!this.count) return 0;
    const u = (x + this.half) / EC, v = (z + this.half) / EC;
    const ix = Math.floor(u), iz = Math.floor(v), fx = u - ix, fz = v - iz;
    const a = this.cell(ix, iz), b = this.cell(ix + 1, iz), c = this.cell(ix, iz + 1), d = this.cell(ix + 1, iz + 1);
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
  }

  #claim(cx, cz) {
    const key = cz * this.cn + cx;
    let slot = this.slots.get(key);
    if (slot !== undefined) return slot;
    if (!this.freeSlots.length) return -1;
    slot = this.freeSlots.pop();
    this.slots.set(key, slot);
    this.index[key] = slot + 1;
    this.count++;
    this.textures.idx.needsUpdate = true;
    return slot;
  }

  /**
   * Run `fn(current, wx, wz, weight)` over every cell within `radius` of
   * (x, z), weight easing from 1 at the centre to 0 at the edge, and keep what
   * it returns, within LIMIT. Returns false when the atlas had no room.
   */
  paint(x, z, radius, fn) {
    const u = (x + this.half) / EC, v = (z + this.half) / EC, r = radius / EC;
    const i0 = Math.max(0, Math.floor(u - r)), i1 = Math.min(this.cn * CHUNK - 1, Math.ceil(u + r));
    const j0 = Math.max(0, Math.floor(v - r)), j1 = Math.min(this.cn * CHUNK - 1, Math.ceil(v + r));
    let full = false;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - u, j - v) / r;
        if (d >= 1) continue;
        const cx = Math.floor(i / CHUNK), cz = Math.floor(j / CHUNK);
        const slot = this.#claim(cx, cz);
        if (slot < 0) { full = true; continue; }
        const k = this.#base(slot) + (j - cz * CHUNK) * ATLAS + (i - cx * CHUNK);
        const wx = i * EC - this.half, wz = j * EC - this.half;
        const next = Math.max(-LIMIT, Math.min(LIMIT, fn(this.atlas[k], wx, wz, smooth(1 - d))));
        if (next !== this.atlas[k]) { this.atlas[k] = next; this.touched = true; }
      }
    }
    if (this.touched) {
      const r2 = this.rect || (this.rect = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity });
      r2.x0 = Math.min(r2.x0, x - radius); r2.x1 = Math.max(r2.x1, x + radius);
      r2.z0 = Math.min(r2.z0, z - radius); r2.z1 = Math.max(r2.z1, z + radius);
    }
    return !full;
  }

  /** Send changed cells to the GPU. Call once a frame. */
  flush() {
    this.uniforms.uEditOn.value = this.count ? 1 : 0;
    if (!this.touched) return;
    this.touched = false;
    this.textures.atlas.needsUpdate = true;
  }

  /** The area changed since the last call, for things standing on it to re-settle; null when none. */
  takeRect() { const r = this.rect; this.rect = null; return r; }

  clear() {
    this.index.fill(0); this.atlas.fill(0); this.slots.clear();
    this.freeSlots = Array.from({ length: SIDE * SIDE }, (_, i) => SIDE * SIDE - 1 - i);
    this.count = 0;
    this.textures.idx.needsUpdate = true; this.textures.atlas.needsUpdate = true;
    this.uniforms.uEditOn.value = 0;
    this.rect = { x0: -Infinity, z0: -Infinity, x1: Infinity, z1: Infinity };
  }

  // chunks as centimetres in an Int16, base64, for the save
  save() {
    const out = [];
    for (const [key, slot] of this.slots) {
      const cx = key % this.cn, cz = Math.floor(key / this.cn), base = this.#base(slot);
      const q = new Int16Array(CHUNK * CHUNK);
      let any = false;
      for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) {
        const c = Math.round(this.atlas[base + j * ATLAS + i] * 100);
        q[j * CHUNK + i] = c; if (c) any = true;
      }
      if (!any) continue;
      let s = '';
      const bytes = new Uint8Array(q.buffer);
      for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
      out.push([cx, cz, btoa(s)]);
    }
    return out;
  }

  load(list) {
    this.clear();
    for (const [cx, cz, b64] of list || []) {
      try {
        const s = atob(b64), bytes = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
        const q = new Int16Array(bytes.buffer);
        const slot = this.#claim(cx, cz);
        if (slot < 0) break;
        const base = this.#base(slot);
        for (let j = 0; j < CHUNK; j++) for (let i = 0; i < CHUNK; i++) this.atlas[base + j * ATLAS + i] = q[j * CHUNK + i] / 100;
      } catch { /* a damaged chunk is just left flat */ }
    }
    this.touched = true;
  }
}
