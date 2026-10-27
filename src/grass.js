import * as THREE from 'three';
import { WIND_GLSL } from './wind.js';
import { HEIGHT_GLSL } from './cdlod.js';
import { withAtmosphere, atmosphere, TRAMPLE, HOLD, SPRING } from './atmosphere.js';
import { CULL } from './culling.js';
import { BOXEL } from './terrain.js';

// Grass, as clumps rather than blades. A canvas atlas holds four painted
// clumps (tall meadow grass with seed heads, mixed bunchgrass, alpine turf,
// lush sedge), each a few hundred fine curved blades, and every instance
// is three crossed cards showing one of them. That reads as thousands of
// blades for a tenth of the triangles that real blade geometry needs.
//
// The atlas stores data instead of colour: R is the blade's brightness, G
// says when in the season the blade cures from green to gold, and B runs
// from root to tip. The shader colours each blade from the satellite pixel
// it stands in and the season (`uCure`), so a meadow turns blade by blade
// from July green to September gold, not as one uniform fade.
//
// Three things keep that cheap. Each clump's spot is checked first and the ones that cannot
// grow (forest floor, rock, snow-bound, outside the circle) leave the vertex shader at once.
// Detail falls off in rings: near the camera every cell has a three-card clump, further out
// only every second (then fourth) cell is drawn, as wider two-card clumps, so the far field is
// a fraction of the vertices at about the same coverage. And what has walked on the grass is
// not looped over per vertex: it is drawn into a small camera-following texture once a frame
// (`PressMap`) that the shader reads with one fetch.
//
// As before there is no CPU-side data: each clump takes its spot from
// gl_InstanceID on a grid that follows the camera (snapped, so nothing swims),
// grows only where the land cover says meadow or tundra, sways in the shared
// wind, parts around the hiker, and frosts at dawn.

const CELLS = 4, CW = 512, CH = 512;
const PRESS_N = 256, PRESS_SIZE = 64;      // the press map: 256 texels over 64 m around the camera (25 cm texels)
const RING_A = 0.27, RING_B = 0.55;       // where the clump grid thins to every 2nd and 4th cell, as fractions of the radius

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296);
}

function paintGrass() {
  const cv = document.createElement('canvas');
  cv.width = CW * CELLS; cv.height = CH;
  const g = cv.getContext('2d');
  const R = rng(11);
  const gauss = () => (R() + R() + R() - 1.5) / 1.5;
  const kinds = [
    { n: 150, hMin: 0.5, hMax: 0.98, spread: 0.2, w: [3, 6], lean: 0.32, seeds: 0.28 },   // tall meadow grass
    { n: 190, hMin: 0.35, hMax: 0.8, spread: 0.26, w: [3, 6.5], lean: 0.42, seeds: 0.12 }, // mixed bunchgrass
    { n: 240, hMin: 0.14, hMax: 0.42, spread: 0.36, w: [2.5, 5], lean: 0.55, seeds: 0.04 }, // alpine turf and sedge
    { n: 170, hMin: 0.4, hMax: 0.92, spread: 0.24, w: [4, 8], lean: 0.3, seeds: 0 },       // lush sedge by water
  ];
  kinds.forEach((k, ci) => {
    g.save();
    g.translate(ci * CW, 0);
    g.beginPath(); g.rect(0, 0, CW, CH); g.clip();
    for (let i = 0; i < k.n; i++) {
      const x0 = CW / 2 + gauss() * CW * k.spread;
      const h = CH * (k.hMin + (k.hMax - k.hMin) * Math.pow(R(), 0.8));
      const a = gauss() * k.lean + (x0 - CW / 2) / CW * 0.6;   // outer blades splay out
      const tipX = x0 + Math.sin(a) * h, tipY = CH - Math.cos(a) * h;
      const cx = x0 + Math.sin(a * 0.35) * h * 0.55, cy = CH - h * 0.62;
      const w = k.w[0] + R() * (k.w[1] - k.w[0]);
      const bright = 120 + R() * 135, cure = R() * 255;
      const grad = g.createLinearGradient(x0, CH, tipX, tipY);
      grad.addColorStop(0, `rgb(${bright | 0},${cure | 0},0)`);
      grad.addColorStop(1, `rgb(${bright | 0},${cure | 0},255)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x0 - w / 2, CH);
      g.quadraticCurveTo(cx - w * 0.3, cy, tipX, tipY);
      g.quadraticCurveTo(cx + w * 0.3, cy, x0 + w / 2, CH);
      g.fill();
      if (R() < k.seeds) {
        // a seed head along the top of the stem: always cured
        for (let s = 0; s < 7; s++) {
          const t = 0.84 + s * 0.022;
          const px = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * tipX;
          const py = (1 - t) * (1 - t) * CH + 2 * (1 - t) * t * cy + t * t * tipY;
          g.fillStyle = `rgb(${(bright * 0.85) | 0},0,${(215 + s * 5) | 0})`;
          g.beginPath(); g.ellipse(px + (R() - 0.5) * 3, py, 2.2, 4.5, a, 0, Math.PI * 2); g.fill();
        }
      }
    }
    g.restore();
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function clumpGeometry(cards = 3) {
  // crossed cards (three at 60 degrees, or two at 90); x = across (-0.5..0.5), y = up (0..1)
  const pos = [], uv = [], idx = [];
  for (let q = 0; q < cards; q++) {
    const a = (q * Math.PI) / cards, c = Math.cos(a), s = Math.sin(a), o = pos.length / 3;
    for (const [x, y] of [[-0.5, 0], [0.5, 0], [-0.5, 1], [0.5, 1]]) {
      pos.push(x * c, y, x * s);
      uv.push(x + 0.5, y);
    }
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

/**
 * What has walked on the grass, drawn into a texture around the camera. The shared ring of pressings
 * (atmosphere.js: capsules with a start time, so they spring back) is read once per texel here rather than
 * once per grass vertex. R unused, G and B the lean direction (x4 around 0.5), A how far down it is pressed.
 * The picture is a pure function of the ring and the clock, so it needs no history and can follow the camera freely.
 */
class PressMap {
  constructor(uniforms) {
    this.rt = new THREE.WebGLRenderTarget(PRESS_N, PRESS_N, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
    this.uniforms = { uTrA: uniforms.uTrA, uTrB: uniforms.uTrB, uTime: uniforms.uTime, uC: { value: new THREE.Vector2() }, uS: { value: PRESS_SIZE } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        varying vec2 vUv;
        uniform vec4 uTrA[${TRAMPLE}], uTrB[${TRAMPLE}];
        uniform float uTime, uS;
        uniform vec2 uC;
        void main() {
          vec2 root = uC + (vUv - 0.5) * uS;
          float press = 0.0; vec2 lean = vec2(0.0);
          for (int i = 0; i < ${TRAMPLE}; i++) {
            vec4 a = uTrA[i], b = uTrB[i];
            if (b.z <= 0.0) continue;
            vec2 rel = root - a.xy;
            vec2 off = rel - a.zw * clamp(dot(rel, a.zw), 0.0, b.x);
            float d = length(off);
            float k = b.z * (1.0 - smoothstep(b.y * 0.5, b.y, d)) * (1.0 - smoothstep(${HOLD.toFixed(1)}, ${SPRING.toFixed(1)}, uTime - b.w));
            press = max(press, k);
            lean += (off / max(d, 0.05) + a.zw * 0.6) * k;
          }
          gl_FragColor = vec4(0.0, clamp(lean * 0.25 + 0.5, 0.0, 1.0), press);
        }`,
    });
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  render(renderer, x, z) {
    this.uniforms.uC.value.set(x, z);
    const prev = renderer.getRenderTarget(), shadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.autoUpdate = shadow;
  }
}

const BLOCKS = 6;   // the clump grid is drawn as BLOCKS x BLOCKS pieces so the ones off screen can be skipped

export class Grass {
  constructor(terrain, { radius = 30, spacing = 0.5 } = {}, uniforms) {
    this.terrain = terrain;
    this.spacing = spacing;
    this.W = Math.round((radius * 2) / spacing);
    this.uniforms = {
      ...terrain.uniforms,
      uCenter: { value: new THREE.Vector2() }, uPlayer: { value: new THREE.Vector3() },
      uSpacing: { value: spacing }, uW: { value: this.W }, uRadius: { value: radius },
      uTrA: atmosphere.uTrA, uTrB: atmosphere.uTrB,   // the shared ring of pressings (atmosphere.js)
      uRing: { value: new THREE.Vector2(radius * RING_A, radius * RING_B) },
      uPressC: { value: new THREE.Vector2() }, uPressS: { value: PRESS_SIZE },
      uFrost: { value: 0 }, uCure: { value: 0.75 }, uTime: uniforms.uTime, uCalm: uniforms.uCalm,
      uClearA: { value: Array.from({ length: 6 }, () => new THREE.Vector4(1e6, 1e6, 1e6, 1e6)) }, uClearR: { value: new Array(6).fill(1) },   // strips of ground kept bare: a to b, radius (the fire, the tent, a felled tree)
    };
    this.press = new PressMap(this.uniforms);
    const clumps = { 3: clumpGeometry(3), 2: clumpGeometry(2) };
    const mat = new THREE.MeshLambertMaterial({ map: paintGrass(), alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.uniforms.uColorMap = { value: terrain.colorMap };
      shader.uniforms.uCover = { value: terrain.coverMap };
      shader.uniforms.uExtent = { value: terrain.extent };
      shader.uniforms.uBoxel = BOXEL;
      shader.uniforms.uPress = { value: this.press.rt.texture };
      withAtmosphere(shader, { translucency: 0.7, weather: 0.8 });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uColorMap, uCover, uBoxel;
          uniform float uExtent, uSpacing, uW, uRadius;
          uniform vec2 uCenter;
          uniform vec3 uPlayer;
          uniform sampler2D uPress;
          uniform vec2 uPressC, uRing;
          uniform float uPressS;
          attribute vec4 aBlock;   // this piece's first cell in the grid, and its width and height in cells
          attribute float aStride; // 1, 2 or 4: it draws every Nth cell
          uniform float uSnow, uSnowLine;
          uniform vec4 uClearA[6];
          uniform float uClearR[6];
          varying vec3 vSat, vTone;
          varying float vLush;
          ${HEIGHT_GLSL}
          ${WIND_GLSL}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', `
          // which cell this instance is: the block's cells, every S-th one, lined up on the world grid so a clump keeps its place as the grid follows the camera
          int W = int(uW), S = int(aStride), BW = int(aBlock.z), BH = int(aBlock.w);
          ivec2 org = ivec2(floor(uCenter / uSpacing)) - W / 2 + ivec2(aBlock.xy);
          ivec2 al = ivec2(mod(float(S) - mod(vec2(org), float(S)), float(S)));
          int NX = (BW + S - 1) / S + 1;
          ivec2 cell = org + al + S * ivec2(gl_InstanceID % NX, gl_InstanceID / NX);
          vec3 transformed = vec3(0.0);
          // leave at once, off screen, for the clumps that will not be drawn: the block's other cells,
          // the corners outside the circle, the ones the detail ring has thinned out, the ones that cannot grow
          if (cell.x >= org.x + BW || cell.y >= org.y + BH) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float h1 = ihash(cell), h2 = ihash(cell + ivec2(7919, 104729)), h3 = ihash(cell * 3 + ivec2(17, 3));
          // jitter the root inside its cell, rotated per cell, so the lattice's rows stop reading at a grazing angle
          vec2 jit = vec2(h1, h2) - 0.5;
          float ja = h3 * 6.2832;
          vec2 root = (vec2(cell) + 0.5 + vec2(jit.x * cos(ja) - jit.y * sin(ja), jit.x * sin(ja) + jit.y * cos(ja))) * uSpacing;
          float r = distance(root, uCenter);
          vec2 c2 = mod(vec2(cell), 2.0), c4 = mod(vec2(cell), 4.0);
          float align = (c4.x + c4.y == 0.0) ? 4.0 : ((c2.x + c2.y == 0.0) ? 2.0 : 1.0);
          // stagger the boundary per clump: without it the whole ring resizes in one visible wave
          float rr = r + (h3 - 0.5) * 6.0;
          float f1 = smoothstep(uRing.x - 7.0, uRing.x + 2.0, rr), f2 = smoothstep(uRing.y - 7.0, uRing.y + 2.0, rr);
          float lodW = align > 3.5 ? 1.0 : (align > 1.5 ? 1.0 - f2 : 1.0 - f1);
          float wm = 1.0 + 0.87 * f1 + 1.63 * f2;      // the thinner the field, the wider each clump, so it still covers
          float fade = 1.0 - smoothstep(uRadius * 0.72, uRadius, r);
          if (fade * lodW < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec4 cov = texture2D(uCover, root / uExtent + 0.5);   // live, burned, aspen, rock
          float mask = maskAt(root);
          float grow = (1.0 - cov.a) * (1.0 - mask) * (1.0 - cov.r * 0.8) * (1.0 - cov.g * 0.25);
          if (step(h1 * 0.8 + h3 * 0.2, grow * 2.0) < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // the height below can only lower this
          float y0 = groundH(root, 0.0);
          grow *= smoothstep(3960.0, 3700.0, y0);
          float alpine = smoothstep(3330.0, 3560.0, y0);
          vSat = texture2D(uColorMap, root / uExtent + 0.5).rgb;
          vec4 bx = texture2D(uBoxel, root / uExtent + 0.5);
          vLush = clamp((vSat.g - vSat.r) * 8.0 + bx.r * 0.35, 0.0, 1.0);
          float live = step(h1 * 0.8 + h3 * 0.2, grow * 2.0);
          // each clump its own shade: some straw-pale, some russet, some dun
          vTone = mix(vec3(1.08, 0.98, 0.86), vec3(0.88, 0.78, 0.7), h3) * (0.85 + h1 * 0.3);
          // snow buries the tufts gradually: they shrink under it, and only the deepest vanish
          float buried = uSnow * smoothstep(uSnowLine - 40.0, uSnowLine + 40.0, y0) * (1.3 - h3 * 0.5);
          live *= 1.0 - step(1.25, buried);
          for (int ci = 0; ci < 6; ci++) {
            vec2 ca = uClearA[ci].xy, cab = uClearA[ci].zw - ca;
            float ct = clamp(dot(root - ca, cab) / max(dot(cab, cab), 1e-4), 0.0, 1.0);
            live *= smoothstep(uClearR[ci] * 0.75, uClearR[ci], distance(root, ca + cab * ct));
          }
          float size = mix(1.0, 0.6, alpine) * (0.75 + h3 * 0.6) * fade * lodW * live * (1.0 - 0.5 * smoothstep(0.3, 1.1, buried));
          if (size < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          // which clump: turf up high, sedge where it's green and wet, meadow grass elsewhere
          float kind = alpine > 0.5 ? 2.0 : vLush > 0.55 && h2 > 0.4 ? 3.0 : step(0.55, h3);
          vMapUv = vec2((kind + uv.x) / 4.0, uv.y);
          float cv = float(gl_VertexID / 4) * 0.5 - 0.5;   // each card leans a little differently, never one flat sprite
          float ang = h2 * 6.2832 + cv * (h1 - 0.5) * 0.7, ca = cos(ang), sa = sin(ang);
          vec3 lp = vec3(position.x * ca - position.z * sa, position.y, position.x * sa + position.z * ca);
          float t = position.y;
          // pressed down by what has walked or lain here, read from the press map around the camera
          vec4 pm = texture2D(uPress, (root - uPressC) / uPressS + 0.5);
          float press = max(pm.a, bx.g * 0.75);   // the boxel field's wear lies the grass down too: walked paths stay walked
          vec2 lean = (pm.gb - 0.5) * 4.0;
          vec3 p = vec3(root.x + lp.x * size * wm * 1.6, y0 - 0.03 + t * size * mix(0.72, 0.42, alpine) * (1.0 - press * 0.8), root.y + lp.z * size * wm * 1.6);
          // wind: steady lean downwind plus the travelling gusts; bend grows with height squared.
          // and even when the air is still the blades are not frozen: a small shimmer rides under the gusts
          float g = gustAt(root);
          float flut = sin(uTime * 3.7 + root.x * 2.3 + root.y * 1.7) * sin(uTime * 2.9 + root.y * 3.1 - root.x * 1.3);
          float bend = (0.1 + g * 0.8 + flut * 0.06 + sin(uTime * 2.3 + root.x * 0.4 + root.y * 0.3) * 0.07) * t * t * size;
          bend *= 1.0 + cv * (h2 - 0.5) * 0.9;
          vec2 wdir = WIND_DIR;
          p.xz += wdir * bend + vec2(-wdir.y, wdir.x) * flut * 0.07 * t * t * size;
          p.y -= bend * bend * 0.5;
          // part around the hiker
          vec2 away = root - uPlayer.xz;
          float near = 1.0 - smoothstep(0.2, 1.0, length(away));
          p.xz += normalize(away + 1e-4) * near * t * size * 0.7;
          p.y -= near * t * size * 0.3;
          p.xz += normalize(lean + vec2(1e-4)) * press * t * size * 0.9;
          transformed = p;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uFrost, uCure;
          varying vec3 vSat, vTone;
          varying float vLush;`)
        .replace('#include <map_fragment>', `
          vec4 gs = texture2D(map, vMapUv);
          // gs.r brightness, gs.g when this blade cures, gs.b root to tip
          float alive = step(uCure - vLush * 0.35, gs.g);
          vec3 cured = mix(vec3(0.44, 0.34, 0.19), vSat * 1.1, 0.35) * vTone;
          vec3 green = mix(vec3(0.17, 0.27, 0.08), vSat * vec3(0.75, 1.05, 0.6), 0.3);
          vec3 col = mix(cured, green, alive) * (0.45 + gs.r * 0.6);
          col *= mix(0.38, 1.05, smoothstep(0.0, 0.75, gs.b));   // shade at the root
          col = mix(col, vec3(0.86, 0.89, 0.93), uFrost * smoothstep(0.3, 1.0, gs.b) * 0.85);
          diffuseColor.rgb = col;
          diffuseColor.a *= gs.a;`)
        // both faces of a card catch the sky the same way
        .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;');
    };
    mat.customProgramCacheKey = () => 'rawah-grass-clumps';
    this.mesh = new THREE.Group();
    this.blocks = [];
    const step = Math.ceil(this.W / BLOCKS);
    for (let j = 0; j < this.W; j += step) {
      for (let i = 0; i < this.W; i += step) {
        const bw = Math.min(step, this.W - i), bh = Math.min(step, this.W - j);
        // the grid follows the camera, so a block is always the same distance from it: its detail ring is fixed
        const lo = [(i - this.W / 2) * spacing, (j - this.W / 2) * spacing], hi = [lo[0] + bw * spacing, lo[1] + bh * spacing];
        const gap = (a, b) => (a > 0 ? a : b < 0 ? -b : 0);
        const dmin = Math.hypot(gap(lo[0], hi[0]), gap(lo[1], hi[1]));
        const stride = dmin < radius * RING_A + 1 ? 1 : dmin < radius * RING_B + 1 ? 2 : 4;
        const geo = clumps[stride === 1 ? 3 : 2].clone();
        const nv = geo.attributes.position.count;
        geo.setAttribute('aBlock', new THREE.BufferAttribute(new Float32Array(nv * 4).map((_, n) => [i, j, bw, bh][n % 4]), 4));
        geo.setAttribute('aStride', new THREE.BufferAttribute(new Float32Array(nv).fill(stride), 1));
        geo.instanceCount = (Math.ceil(bw / stride) + 1) * (Math.ceil(bh / stride) + 1);
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        m.receiveShadow = true;
        m.renderOrder = 0;
        this.mesh.add(m);
        this.blocks.push({ mesh: m, i, j, bw, bh, stride });
      }
    }
    this.frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this.drawn = this.blocks.length;
  }

  /** Keep the ground bare: up to six circles [x, z, r] or strips [x0, z0, x1, z1, r]. */
  clear(...list) {
    const A = this.uniforms.uClearA.value, R = this.uniforms.uClearR.value;
    for (let i = 0; i < 6; i++) {
      const e = list[i];
      if (!e) { A[i].set(1e6, 1e6, 1e6, 1e6); R[i] = 1; }
      else if (e.length === 3) { A[i].set(e[0], e[1], e[0], e[1]); R[i] = e[2]; }   // a circle
      else { A[i].set(e[0], e[1], e[2], e[3]); R[i] = e[4]; }                         // a strip
    }
  }

  /**
   * Remember where the hiker has pressed the grass. Walking leaves a light
   * trail of footprints, crouching a heavier one, and lying or sitting a flat
   * nest the shape of the body that stays down for as long as you stay on it.
   * `heading` is the way the body faces.
   */
  #trample(h, heading) {
    if (!h.grounded || h.mode !== 'walk') { this.last = null; return; }
    const p = h.pos, now = this.uniforms.uTime.value;
    const sitting = h.resting && h.stance === 'stand' && h.moving < 0.2;
    const key = h.stance === 'prone' ? 'prone' : sitting ? 'sit' : h.stance;
    const spec = { stand: [0, 0.6, 0.4, 0.6], crouch: [0, 0.7, 0.55, 0.5], prone: [1.7, 0.6, 1, 0.6], sit: [0, 0.85, 0.9, 9] }[key];
    const last = this.last;
    if (last && last.key === key && Math.hypot(p.x - last.x, p.z - last.z) < spec[3]) {
      // still on the same patch: keep it flat while you're lying or sitting on it
      if (key === 'prone' || key === 'sit') this.uniforms.uTrB.value[last.i].w = now;
      return;
    }
    const i = this.slot = ((this.slot ?? -1) + 1) % TRAMPLE;
    const dx = -Math.sin(heading), dz = -Math.cos(heading), back = spec[0] / 2;
    this.uniforms.uTrA.value[i].set(p.x - dx * back, p.z - dz * back, dx, dz);
    this.uniforms.uTrB.value[i].set(spec[0], spec[1], spec[2], now);
    this.last = { key, x: p.x, z: p.z, i };
  }

  update(camera, hiker, frost, cure, heading = 0, renderer = null) {
    this.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
    this.uniforms.uPressC.value.set(camera.position.x, camera.position.z);
    this.uniforms.uPlayer.value.copy(hiker.pos);
    this.#trample(hiker, heading);
    if (renderer) this.press.render(renderer, camera.position.x, camera.position.z);
    this.uniforms.uFrost.value = frost;
    if (cure !== undefined) this.uniforms.uCure.value = cure;
    this.#cull(camera);
  }

  /** Draw only the pieces of the clump grid that can be seen. */
  #cull(camera) {
    const s = this.spacing, W = this.W, T = this.terrain;
    this.frustum.setFromProjectionMatrix(this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const c0x = Math.floor(camera.position.x / s) - W / 2, c0z = Math.floor(camera.position.z / s) - W / 2;
    const pad0 = 2.2;   // a clump leans and spreads about this far from its root
    let drawn = 0;
    for (const b of this.blocks) {
      const pad = pad0 * (1 + 0.6 * (b.stride - 1)) + b.stride * s;   // wider clumps further out, and the cells line up on the world grid
      const x0 = (c0x + b.i) * s - pad, x1 = (c0x + b.i + b.bw) * s + pad, z0 = (c0z + b.j) * s - pad, z1 = (c0z + b.j + b.bh) * s + pad;
      let seen = true;
      if (CULL.frustum) {
        const [lo, hi] = T.heightRange(x0, z0, x1, z1);
        seen = this.frustum.intersectsBox(this._box.set(this._box.min.set(x0, lo - 1, z0), this._box.max.set(x1, hi + 3, z1)));
      }
      b.mesh.visible = seen;
      if (seen) drawn++;
    }
    this.drawn = drawn;
  }
}
