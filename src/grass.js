import { VEGETATION_GLSL } from './vegetation-grade.js';
import * as THREE from 'three';
import { WIND_GLSL } from './wind.js';
import { HEIGHT_GLSL } from './cdlod.js';
import { withAtmosphere, atmosphere, TRAMPLE, HOLD, SPRING, SNOW_GLSL } from './atmosphere.js';
import { CULL } from './culling.js';
import { BOXEL } from './terrain.js';
import { MEADOW_GLSL } from './meadow.js';
import { ALPINE } from './alpine.js';

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

let paintedAtlas;
function paintGrass(alpine = false) {
  if (paintedAtlas) return paintedAtlas;
  const cv = document.createElement('canvas');
  cv.width = CW * CELLS; cv.height = CH;
  const g = cv.getContext('2d');
  const R = rng(11);
  const gauss = () => (R() + R() + R() - 1.5) / 1.5;
  const kinds = [
    { n: 150, hMin: 0.5, hMax: 0.98, spread: 0.2, w: [3, 6], lean: 0.32, seeds: 0.28 },   // tall meadow grass
    { n: 300, hMin: 0.3, hMax: 0.72, spread: 0.28, w: [1.8, 4.2], lean: 0.5, seeds: 0.1 }, // mixed bunchgrass
    { n: 560, hMin: 0.16, hMax: 0.52, spread: 0.36, w: [1.2, 2.7], lean: 0.62, seeds: 0.03 }, // alpine turf and wiry sedge: many fine blades
    { n: 170, hMin: 0.4, hMax: 0.92, spread: 0.24, w: [4, 8], lean: 0.3, seeds: 0 },       // lush sedge by water
  ];
  // Keep the tapered blades and seed heads of the original meadow atlas.
  if (alpine) kinds.forEach((k, i) => Object.assign(k, {
    n: [144, 224, 332, 164][i], w: [[3, 8], [2.7, 6], [1.8, 4.5], [4, 8]][i],
    lean: k.lean * 0.72, spread: k.spread * 1.09,
    hMin: i === 2 ? 0.22 : k.hMin, hMax: i === 2 ? 0.59 : k.hMax,
    seeds: [0.13, 0.05, 0.012, 0][i],
  }));
  kinds.forEach((k, ci) => {
    g.save();
    g.translate(ci * CW, 0);
    g.beginPath(); g.rect(0, 0, CW, CH); g.clip();
    for (let i = 0; i < k.n; i++) {
      const x0 = CW / 2 + gauss() * CW * k.spread;
      const h = CH * (k.hMin + (k.hMax - k.hMin) * Math.pow(R(), 0.8));
      // Sink each blade to a slightly different depth so the clump never ends in a straight cut.
      const base = CH - (alpine ? 16 * (0.5 + 0.5 * gauss()) : 0);
      const a = gauss() * k.lean + (x0 - CW / 2) / CW * 0.6;   // outer blades splay out
      const tipX = Math.max(8, Math.min(CW - 8, x0 + Math.sin(a) * h)), tipY = Math.max(6, base - Math.cos(a) * h);
      const cx = x0 + Math.sin(a * 0.35) * h * 0.55, cy = base - h * 0.62;
      const w = k.w[0] + R() * (k.w[1] - k.w[0]);
      const bright = 120 + R() * 135, cure = R() * 255;
      const grad = g.createLinearGradient(x0, base, tipX, tipY);
      grad.addColorStop(0, `rgb(${bright | 0},${cure | 0},0)`);
      grad.addColorStop(1, `rgb(${bright | 0},${cure | 0},255)`);
      g.fillStyle = grad;
      g.beginPath();
      g.moveTo(x0 - w * (alpine ? 0.24 : 0.5), base);
      g.quadraticCurveTo(cx - w * 0.3, cy, tipX, tipY);
      g.quadraticCurveTo(cx + w * 0.3, cy, x0 + w * (alpine ? 0.24 : 0.5), base);
      g.fill();
      if (R() < k.seeds) {
        // a seed head along the top of the stem: always cured
        for (let s = 0; s < 7; s++) {
          const t = 0.84 + s * 0.022;
          const px = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * tipX;
          const py = (1 - t) * (1 - t) * base + 2 * (1 - t) * t * cy + t * t * tipY;
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
  return (paintedAtlas = tex);
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

// The three layers drawn by this class: the grass clumps, the wildflowers (patches of one or two kinds) and the shrubs (willow
// thickets where it is wet, understory shrubs at forest edges and in burns, dwarf shrubs on the tundra and the forest floor).
// Each picks a category of the cut-out pack (vegetation.json) and a plant in it, sized in metres from the pack's real sizes.
const LAYERS = {
  grass: {
    grow: '(1.0 - cov.a) * (1.0 - mask) * (1.0 - cov.r * 0.8) * (1.0 - cov.g * 0.25)',
    place: `
      float cat = alpine > 0.5 ? 0.0 : (vLush > 0.55 && h2 > 0.4) ? 3.0 : (h3 > 0.55 ? 2.0 : 1.0);
      float pr = fract(h1 * 7.31 + h2 * 3.7);
      float sz = (0.88 + h3 * 0.3) * mix(1.0, 0.85, alpine) * mix(1.0, 0.35, smoothstep(0.3, 0.75, bx.g));   // walked ground wears the tufts down
      float dens = 1.0 - 0.5 * smoothstep(0.55, 0.9, bx.g);`,
    wind: '1.0', near: '1.0', press: true,
  },
  forbs: {
    grow: '(1.0 - cov.a) * (1.0 - mask) * (1.0 - cov.r * 0.85)',
    place: `
      vec2 pc = floor(root / 11.0);
      float ph = ihash(ivec2(pc)), pid = ihash(ivec2(pc) + ivec2(31, 57));
      vec2 pf = fract(root / 11.0) - 0.5;
      float edge = 1.0 - smoothstep(0.22, 0.52, length(pf) + (h3 - 0.5) * 0.3);
      float season = 1.0 - 0.75 * smoothstep(0.6, 0.95, uCure);
      float dens = smoothstep(0.34, 0.62, ph) * edge * season * 0.62 * (1.0 - smoothstep(3900.0, 4100.0, y0))
        * (0.75 + 0.7 * bx.r) * (1.0 - smoothstep(0.15, 0.5, bx.g));   // damp ground flowers more, a path or a camp not at all
      float cat = alpine > 0.5 ? 0.0 : (vLush > 0.5 || bx.r > 0.4) ? 1.0 : (pid > 0.62 ? 2.0 : (pid < 0.25 ? 0.0 : 1.0));
      float pr = h2 > 0.8 ? ihash(ivec2(pc) + ivec2(99, 5)) : pid;
      float sz = 0.85 + h3 * 0.35;`,
    wind: '0.55', near: '0.6', press: true,
  },
  shrubs: {
    grow: '(1.0 - cov.a) * (1.0 - mask)',
    place: `
      float moist = clamp(vLush * 1.2 + bx.r * 0.6, 0.0, 1.0);
      float wet = smoothstep(0.5, 0.8, moist) * (1.0 - alpine);
      float zone = ihash(ivec2(floor(root / 24.0)) + ivec2(7, 13));
      float dW = wet * smoothstep(0.3, 0.6, zone) * 0.95;
      float dU = (0.05 + 0.5 * cov.g + 0.1 * (1.0 - cov.r)) * (1.0 - alpine) * smoothstep(2500.0, 2750.0, y0) * (1.0 - wet);
      float dD = (0.08 + 0.3 * cov.r + 0.45 * alpine) * (1.0 - wet * 0.8);
      float tot = dW + dU + dD, pick = h2 * tot;
      float cat = pick < dW ? 2.0 : (pick < dW + dU ? 1.0 : 0.0);
      float pr = fract(h1 * 5.17 + h3 * 2.3);
      float sz = 0.85 + h3 * 0.35;
      float dens = min(1.0, tot) * (1.0 - cov.r * 0.15) * (1.0 - smoothstep(0.12, 0.4, bx.g));   // shrubs do not stand on a path`,
    wind: '0.16', near: '0.0', press: false,
  },
};

const BLOCKS = 6;   // the clump grid is drawn as BLOCKS x BLOCKS pieces so the ones off screen can be skipped

export class Grass {
  constructor(terrain, { radius = 30, spacing = 0.5, layer = 'grass', veg = null, shared = null, inner = 0 } = {}, uniforms) {
    if (ALPINE) veg = null;   // the alpine look paints its own blades
    this.terrain = terrain;
    this.layer = layer;
    const L = LAYERS[layer];
    this.painted = !veg;
    this.spacing = spacing;
    this.W = Math.round((radius * 2) / spacing);
    this.uniforms = {
      ...terrain.uniforms,
      uCenter: { value: new THREE.Vector2() }, uPlayer: { value: new THREE.Vector3() },
      uSpacing: { value: spacing }, uW: { value: this.W }, uRadius: { value: radius }, uInner: { value: inner },
      uTrA: atmosphere.uTrA, uTrB: atmosphere.uTrB,   // the shared ring of pressings (atmosphere.js)
      uRing: { value: new THREE.Vector2(radius * RING_A, radius * RING_B) },
      uPressC: shared ? shared.uniforms.uPressC : { value: new THREE.Vector2() }, uPressS: { value: PRESS_SIZE },
      uFrost: { value: 0 }, uCure: { value: 0.75 }, uTime: uniforms.uTime, uCalm: uniforms.uCalm,
      uClearA: shared ? shared.uniforms.uClearA : { value: Array.from({ length: 6 }, () => new THREE.Vector4(1e6, 1e6, 1e6, 1e6)) }, uClearR: shared ? shared.uniforms.uClearR : { value: new Array(6).fill(1) },   // strips of ground kept bare: a to b, radius (the fire, the tent, a felled tree)
    };
    this.press = shared ? shared.press : new PressMap(this.uniforms);
    if (veg) {
      const pl = veg.meta.plants, tab = Array.from({ length: 64 }, (_, i) => (pl[i] ? new THREE.Vector4(pl[i].x, pl[i].y, pl[i].cardW, pl[i].cardH) : new THREE.Vector4()));
      const cats = Array.from({ length: 4 }, (_, i) => { const c = Object.values(veg.meta.cats)[i] || [0, 0]; return new THREE.Vector4(c[0], c[1], 0, 0); });
      Object.assign(this.uniforms, { uPlants: { value: tab }, uCats: { value: cats }, uAtlas: { value: new THREE.Vector2(veg.meta.cols, veg.meta.rows) } });
      this.pad0 = Math.max(2.2, ...pl.map((p) => p.cardW)) * (layer === 'grass' ? 1.4 : 1.1);
    }
    const clumps = { 3: clumpGeometry(3), 2: clumpGeometry(2) };
    const mat = new THREE.MeshLambertMaterial({ map: veg ? veg.tex : paintGrass(ALPINE), alphaTest: ALPINE ? 0.35 : 0.42, alphaToCoverage: true, side: THREE.DoubleSide });
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
          uniform float uExtent, uSpacing, uW, uRadius, uInner;
          uniform vec2 uCenter;
          uniform vec3 uPlayer;
          uniform sampler2D uPress;
          uniform vec2 uPressC, uRing;
          uniform float uPressS;
          attribute vec4 aBlock;   // this piece's first cell in the grid, and its width and height in cells
          attribute float aStride; // 1, 2 or 4: it draws every Nth cell
          ${SNOW_GLSL}
          uniform vec4 uClearA[6];
          uniform float uClearR[6];
          varying vec3 vSat, vTone;
          varying float vLush, vTurf, vAlpFar;
          ${ALPINE ? 'varying float vGrassFade;' : ''}
          ${ALPINE ? VEGETATION_GLSL : MEADOW_GLSL}
          ${veg ? 'uniform vec4 uPlants[64]; uniform vec4 uCats[4]; uniform vec2 uAtlas; uniform float uCure; varying float vT, vR, vK;' : ''}
          ${HEIGHT_GLSL}
          ${WIND_GLSL}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', `
          // which cell this instance is: the block's cells, every S-th one, lined up on the world grid so a clump keeps its place as the grid follows the camera
          int W = int(uW), S = int(aStride), BW = int(aBlock.z), BH = int(aBlock.w);
          ivec2 org = ivec2(floor(uCenter / uSpacing)) - W / 2 + ivec2(aBlock.xy);
          ivec2 al = ivec2(mod(float(S) - mod(vec2(org), float(S)), float(S)));
          int NX = (BW + S - 1) / S;
          ivec2 cell = org + al + S * ivec2(gl_InstanceID % NX, gl_InstanceID / NX);
          vec3 transformed = vec3(0.0);
          // leave at once, off screen, for the clumps that will not be drawn: the block's other cells,
          // the corners outside the circle, the ones the detail ring has thinned out, the ones that cannot grow
          if (cell.x >= org.x + BW || cell.y >= org.y + BH) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float h1 = ihash(cell), h2 = ihash(cell + ivec2(7919, 104729)), h3 = ihash(cell * 3 + ivec2(17, 3));
          // The surviving cells keep their roots through every stride.
          vec2 c2 = mod(vec2(cell), 2.0), c4 = mod(vec2(cell), 4.0);
          float align = (c4.x + c4.y == 0.0) ? 4.0 : ((c2.x + c2.y == 0.0) ? 2.0 : 1.0);
          ${ALPINE ? `
          // Independent offsets keep sparse patches from revealing rows when low growth rejects a tuft.
          vec2 jitter = vec2(ihash(cell + ivec2(1193, 6053)), ihash(cell + ivec2(2377, 3217))) - 0.5;
          jitter *= mix(1.52, 2.55, (align - 1.0) / 3.0);` : `
          vec2 jit = vec2(h1, h2) - 0.5;
          float ja = h3 * 6.2832, jc = cos(ja), js = sin(ja);
          vec2 jitter = vec2(jit.x * jc - jit.y * js, jit.x * js + jit.y * jc);`}
          vec2 root = (vec2(cell) + 0.5 + jitter) * uSpacing;
          float r = distance(root, uCenter);
          // stagger the boundary per clump: without it the whole ring resizes in one visible wave
          float rr = r + (h3 - 0.5) * 6.0;
          float f1 = smoothstep(uRing.x - 7.0, uRing.x + 2.0, rr), f2 = smoothstep(uRing.y - 7.0, uRing.y + 2.0, rr);
          float lodW = align > 3.5 ? 1.0 : (align > 1.5 ? 1.0 - f2 : 1.0 - f1);
          float wm = ${ALPINE ? '1.0 + 0.3 * f1 + 0.5 * f2' : '1.0 + 0.87 * f1 + 1.63 * f2'};      // the thinner the field, the wider each clump, so it still covers
          float fade = 1.0 - smoothstep(uRadius * ${ALPINE ? '0.45' : '0.72'}, uRadius, r);   // the alpine field fades over a longer ring
          vAlpFar = smoothstep(uRadius * 0.35, uRadius * 0.9, r);
          if (uInner > 0.0) {   // a far ring (alpine): empty inside the near field, fading in as the near field fades out, and its clumps as wide as its cells
            fade *= smoothstep(uInner * 0.5, uInner, r);
            vAlpFar = smoothstep(uInner * 0.55, mix(uInner, uRadius, 0.45), r);
          }
          ${ALPINE ? 'vGrassFade = smoothstep(0.04, 0.82, fade * lodW);' : ''}
          // A faded card below alphaTest cannot contribute any pixels.
          if (${ALPINE ? `vGrassFade < ${mat.alphaTest.toFixed(2)}` : 'fade * lodW < 0.01'}) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec4 cov = texture2D(uCover, root / uExtent + 0.5);   // live, burned, aspen, rock
          float mask = maskAt(root);
          float grow = ${ALPINE ? 'smoothstep(0.028, 0.19, turfPotential(cov)) * (1.0 - mask * mask * mask)' : L.grow};
          ${ALPINE ? 'grow *= 1.0 - smoothstep(0.35, 0.82, -chanCut(root));' : 'grow *= 1.0 - smoothstep(0.025, 0.06, -chanCut(root));'}   // nothing grows in a worn tread (channels.js digs it)
          // metres from the edge of the nearest trail or road: nothing roots on or beside the tread, and tufts shrink toward it so no blade lies across it
          ${ALPINE ? 'vec2 trail = trailDistances(root); float trE = trail.y < 1.8 ? max(0.0, trail.y) : trail.x;' : 'float trE = trailEdge(root);'}
          grow *= ${ALPINE ? 'smoothstep(0.13, 0.31, trE)' : 'smoothstep(0.5, 0.8, trE)'};
          float trK = ${ALPINE ? 'mix(0.29, 1.0, smoothstep(0.16, 1.15, trE))' : '0.45 + 0.55 * smoothstep(0.8, 2.0, trE)'};
          if (step(h1 * 0.8 + h3 * 0.2, grow * 2.0) < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // the height below can only lower this
          float y0 = groundH(root, 0.0);
          // open montane and alpine meadow is short wiry turf in tufts with patches of bare sand between (meadow.js; the terrain paints the sand)
          ${ALPINE ? '' : 'float openM = meadowOpen(cov);'}
          float turf = ${ALPINE ? '0.0' : 'openM * smoothstep(2500.0, 2900.0, y0)'};   // the alpine look is one full field: no wiry turf, no bare sand
          ${ALPINE ? '' : 'grow *= 1.0 - meadowBare(root, y0) * openM;'}
          vTurf = turf;
          grow *= 1.0 - smoothstep(3700.0, 3960.0, y0);
          float alpine = smoothstep(3330.0, 3560.0, y0);
          vSat = ${ALPINE ? 'vec3(0.0)' : 'texture2D(uColorMap, root / uExtent + 0.5).rgb'};
          vec4 bx = texture2D(uBoxel, root / uExtent + 0.5);
          vLush = ${ALPINE ? 'bx.r' : 'clamp((vSat.g - vSat.r) * 8.0 + bx.r * 0.35, 0.0, 1.0)'};
          float live = step(h1 * 0.8 + h3 * 0.2, grow * 2.0);
          // each clump its own shade: some straw-pale, some russet, some dun
          vTone = mix(vec3(1.08, 0.98, 0.86), vec3(0.88, 0.78, 0.7), h3) * (0.85 + h1 * 0.3);
          // snow buries the tufts gradually: they shrink under it, and only the deepest vanish
          float buried = snowAt(y0) * (1.3 - h3 * 0.5);
          live *= 1.0 - step(1.25, buried);
          for (int ci = 0; ci < 6; ci++) {
            vec2 ca = uClearA[ci].xy, cab = uClearA[ci].zw - ca;
            float ct = clamp(dot(root - ca, cab) / max(dot(cab, cab), 1e-4), 0.0, 1.0);
            live *= smoothstep(uClearR[ci] * 0.75, uClearR[ci], distance(root, ca + cab * ct));
          }
          ${veg ? `
          ${L.place}
          float h4 = ihash(cell * 5 + ivec2(3, 11));
          if (h4 > dens) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float size = sz * trK * fade * lodW * live * (1.0 - 0.5 * smoothstep(0.3, 1.1, buried));
          if (size < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          vec4 cc = uCats[int(cat)];
          int pi = int(cc.x) + min(int(floor(pr * cc.y)), max(int(cc.y) - 1, 0));
          vec4 pl = uPlants[pi];
          float cardW = pl.z, cardH = pl.w;
          vMapUv = vec2((pl.x + uv.x) / uAtlas.x, 1.0 - (pl.y + 1.0 - uv.y) / uAtlas.y);
          vT = uv.y; vR = h1; vK = cat;
          float wk = min(cardH, 1.5) * ${L.wind}, nk = cardH * ${L.near};` : `
          float size = mix(1.0, 0.6, alpine) * mix(1.0, 0.85, turf) * trK * (0.75 + h3 * 0.6) * ${ALPINE ? '1.0' : 'fade * lodW'} * live * (1.0 - 0.5 * smoothstep(0.3, 1.1, buried));
          if (size < 0.004) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          // which clump: turf up high, sedge where it's green and wet, meadow grass elsewhere
          float kind = alpine > 0.5 ? 2.0 : vLush > 0.55 && h2 > 0.4 ? 3.0 : step(0.55, h3);
          kind = turf > 0.5 && kind != 3.0 ? (h3 > 0.28 ? 2.0 : 1.0) : kind;
          vMapUv = vec2((kind + uv.x) / 4.0, uv.y);
          float wk = ${ALPINE ? '0.64' : '1.0'}, nk = 1.0;
          ${ALPINE ? `
          float heightK = mix(0.53, 1.38, h2 * h2);
          float habitatH = kind == 3.0 ? 1.16 : (kind == 2.0 ? 0.82 : 1.0);
          float cardH = mix(0.91, 0.53, alpine) * habitatH * heightK * mix(1.0, 1.28, step(0.5, uInner));
          float cardW = mix(1.34, 1.86, h1) * mix(1.0, 1.19, step(0.5, uInner));
          // Short tufts still spread sideways, with an upper bound on overhang into the tread.
          cardW *= mix(1.31, 1.0, h2);
          cardW = min(cardW, (0.09 + trE * 1.15) / max(size * wm, 0.01));` : `
          float cardW = mix(1.6, 0.85, turf), cardH = mix(mix(0.72, 0.42, alpine), kind > 2.5 ? 0.45 : 0.34, turf);`}`}
          float cv = float(gl_VertexID / 4) * 0.5 - 0.5;   // each card leans a little differently, never one flat sprite
          float ang = h2 * 6.2832 + cv * (h1 - 0.5) * 0.7, ca = cos(ang), sa = sin(ang);
          vec3 lp = vec3(position.x * ca - position.z * sa, position.y, position.x * sa + position.z * ca);
          float t = position.y;
          ${ALPINE ? 'lp.xz *= mix(0.62, 0.93 + 0.23 * h2, t);' : ''}
          // pressed down by what has walked or lain here, read from the press map around the camera
          vec4 pm = ${inner ? 'vec4(0.0, 0.5, 0.5, 0.0)' : 'texture2D(uPress, (root - uPressC) / uPressS + 0.5)'};
          // the boxel's ~30 m wear blob reads as a walked path only at range; near, only real prints press
          float press = ${ALPINE ? 'pm.a' : 'max(pm.a, bx.g * 0.7 * smoothstep(50.0, 140.0, r))'};
          ${L.press ? '' : 'press = 0.0;'}
          vec2 lean = (pm.gb - 0.5) * 4.0;
          float bendDown = ${ALPINE ? 'press * mix(0.18, 0.8, smoothstep(0.4, 0.88, press))' : 'press * 0.8'};
          vec3 p = vec3(root.x + lp.x * cardW * size * wm, y0 - 0.03 + t * cardH * size * (1.0 - bendDown), root.y + lp.z * cardW * size * wm);
          ${ALPINE ? `
          // Bury the ends of a wide card on sloping ground. The upper edge stays at blade height.
          p.y -= (1.0 - t) * (0.045 + abs(position.x) * cardW * size * wm * 0.38);
          ` : ''}
          // wind: steady lean downwind plus the travelling gusts; bend grows with height squared.
          // and even when the air is still the blades are not frozen: a small shimmer rides under the gusts
          float g = ${inner ? '0.35 + 0.25 * sin(dot(root, vec2(0.07, 0.04)) - uTime * 1.2)' : 'gustAt(root)'};
          float flut = sin(uTime * 3.7 + root.x * 2.3 + root.y * 1.7) * sin(uTime * 2.9 + root.y * 3.1 - root.x * 1.3);
          float bend = (0.1 + g * 0.8 + flut * 0.06 + sin(uTime * 2.3 + root.x * 0.4 + root.y * 0.3) * 0.07) * t * t * size * wk;
          bend *= 1.0 + cv * (h2 - 0.5) * 0.9;
          vec2 wdir = WIND_DIR;
          p.xz += wdir * bend + vec2(-wdir.y, wdir.x) * flut * 0.07 * t * t * size * wk;
          p.y -= bend * bend * 0.5;
          ${inner ? '' : `// part around the hiker
          vec2 away = root - uPlayer.xz;
          float near = 1.0 - smoothstep(0.2, 1.0, length(away));
          p.xz += away / max(length(away), 0.35) * near * t * size * 0.18 * nk;
          p.y -= near * t * size * 0.09 * nk;
          p.xz += lean * press * t * size * 0.32 * nk;
`}
          ${ALPINE ? `
          if (trE < 1.5) {
            vec2 spread = p.xz - root;
            p.xz = root + spread * min(1.0, max(0.0, trE - 0.025) / max(length(spread), 0.001));
          }` : ''}
          transformed = p;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform float uFrost, uCure;
          varying vec3 vSat, vTone;
          varying float vLush, vTurf, vAlpFar;
          ${ALPINE ? 'varying float vGrassFade;' : ''}
          ${ALPINE ? VEGETATION_GLSL : ''}
          #define uAlpFar vAlpFar
          ${veg ? 'varying float vT, vR, vK;' : ''}`)
        .replace('#include <map_fragment>', veg ? `
          vec4 gs = texture2D(map, vMapUv);
          vec3 photo = gs.rgb * 0.85;
          float lum = dot(photo, vec3(0.3, 0.59, 0.11));
          vec3 col; float shade;
          ${layer === 'grass' ? `
          float alive = step(uCure - vLush * 0.35, vR);
          vec3 straw = vec3(0.62, 0.48, 0.26) * (lum * 1.9 + 0.05) * vTone;
          col = mix(straw, photo, alive);
          col *= mix(vec3(1.0), clamp(vSat * 2.0, 0.6, 1.3), 0.22);
          shade = mix(0.55, 1.0, smoothstep(0.0, 0.42, vT));` : layer === 'forbs' ? `
          float dry = smoothstep(0.62, 0.95, uCure) * (0.6 + 0.4 * fract(vR * 9.7));
          vec3 straw = vec3(0.5, 0.4, 0.24) * (lum * 1.8 + 0.04);
          col = mix(photo, straw, dry * 0.85);
          col *= mix(vec3(1.0), clamp(vSat * 2.0, 0.6, 1.3), 0.12);
          shade = mix(0.6, 1.0, smoothstep(0.0, 0.3, vT));` : `
          float aut = smoothstep(0.58, 0.95, uCure) * (0.5 + 0.5 * fract(vR * 13.1));
          vec3 tint = vK < 0.5 ? vec3(0.78, 0.22, 0.12) : vec3(0.95, 0.7, 0.18);
          col = mix(photo, tint * (lum * 1.6 + 0.05), aut * 0.75);
          col *= mix(vec3(1.0), clamp(vSat * 2.0, 0.6, 1.3), 0.1);
          shade = mix(0.7, 1.0, smoothstep(0.0, 0.5, vT));`}
          col = mix(col, vec3(0.86, 0.89, 0.93), uFrost * smoothstep(0.3, 1.0, vT) * 0.85);
          diffuseColor.rgb = col * shade;
          diffuseColor.a *= gs.a;` : `
          vec4 gs = texture2D(map, vMapUv);
          // gs.r brightness, gs.g when this blade cures, gs.b root to tip
          // turf (open meadow) keeps a good share of its blades green, dull olive, the rest straw and a little russet, as on the real Rawah meadows
          float alive = step(mix(uCure, uCure * 0.68, vTurf) - vLush * 0.35, gs.g);
          vec3 cured = mix(vec3(0.44, 0.34, 0.19), vSat * 1.1, 0.35) * vTone;
          cured = mix(cured, vec3(0.285, 0.25, 0.135) * mix(vec3(1.0), vTone, 0.5), vTurf * 0.7);   // pale dry straw, as in the photograph
          cured = mix(cured, vec3(0.235, 0.13, 0.075) * mix(vec3(1.0), vTone, 0.5), vTurf * 0.5 * step(0.74, fract(gs.g * 7.3 + gs.r * 3.1)));
          vec3 green = mix(vec3(0.17, 0.27, 0.08), vSat * vec3(0.75, 1.05, 0.6), 0.3);
          green = mix(green, vec3(0.105, 0.125, 0.045), vTurf * 0.9);   // dull olive, not lime
          vec3 col = mix(cured, green, alive) * (0.45 + gs.r * 0.6);
          col *= mix(0.38, 1.05, smoothstep(0.0, 0.75, gs.b));   // shade at the root
          col = mix(col, vec3(0.82, 0.85, 0.9), uFrost * smoothstep(0.3, 1.0, gs.b) * 0.62);
          ${ALPINE ? `
          // Turf-coloured roots and a light yellow-green tip.
          col = mix(turfBase(), vec3(0.108, 0.236, 0.061), smoothstep(0.0, 0.92, gs.b));
          float seedHead = (1.0 - smoothstep(0.0, 0.045, gs.g)) * smoothstep(0.63, 0.86, gs.b);
          col = mix(col, vec3(0.31, 0.27, 0.087), max(seedHead * 0.72, smoothstep(0.55, 1.0, gs.b) * uCure * 0.35));
          col *= (0.75 + gs.r * 0.35) * mix(vec3(1.0), vTone, 0.35);
          // Blend the foot of a card into turf early; preserve some blade contrast even at range.
          col = mix(col, turfBase(), uAlpFar * mix(0.96, 0.68, gs.b));
          col = plantGrade(col, vLush, 0.65);
          col = mix(col, vec3(0.82, 0.85, 0.9), uFrost * smoothstep(0.5, 1.0, gs.b) * 0.3);` : ''}
          diffuseColor.rgb = col;
          diffuseColor.a *= gs.a ${ALPINE ? '* smoothstep(0.015, 0.15, vMapUv.y) * vGrassFade' : ''};`)
        // both faces of a card catch the sky the same way
        .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;');
    };
    mat.customProgramCacheKey = () => `rawah-grass-clumps-${layer}-${veg ? 'photo' : ALPINE ? 'alpine' : 'painted'}-${inner ? 'far' : 'near'}`;
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
        const dmax = Math.hypot(Math.max(Math.abs(lo[0]), Math.abs(hi[0])), Math.max(Math.abs(lo[1]), Math.abs(hi[1])));
        const jitterMargin = spacing * 8;
        if (dmin > radius + jitterMargin || dmax < inner * 0.5 - jitterMargin) continue;
        // A block stays dense until every root in it is beyond the finer fade.
        const lodMargin = 6 + spacing * 2;
        const stride = dmin < radius * RING_A + lodMargin ? 1 : dmin < radius * RING_B + lodMargin ? 2 : 4;
        const geo = clumps[!inner && layer === 'grass' ? 3 : 2].clone();
        const nv = geo.attributes.position.count;
        geo.setAttribute('aBlock', new THREE.BufferAttribute(new Float32Array(nv * 4).map((_, n) => [i, j, bw, bh][n % 4]), 4));
        geo.setAttribute('aStride', new THREE.BufferAttribute(new Float32Array(nv).fill(stride), 1));
        geo.instanceCount = Math.ceil(bw / stride) * Math.ceil(bh / stride);
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
    this.uniforms.uPlayer.value.copy(hiker.pos);
    this.#trample(hiker, heading);
    if (renderer) {
      // redraw at ~30 Hz and when the camera has crossed a texel, not every frame:
      // footprints are quasi-static, and the fbo switch is a pipeline stall
      const now = this.uniforms.uTime.value, pc = this.uniforms.uPressC.value;
      if (now - (this._pressAt ?? -1) > 0.033 || Math.hypot(camera.position.x - pc.x, camera.position.z - pc.y) > 0.24) {
        this._pressAt = now;
        pc.set(camera.position.x, camera.position.z);
        this.press.render(renderer, pc.x, pc.y);
      }
    }
    this.uniforms.uFrost.value = frost;
    if (cure !== undefined) this.uniforms.uCure.value = cure;
    this.#cull(camera);
  }

  /** The extra layers (wildflowers, shrubs) follow the camera; the grass layer owns the press map and the trampling. */
  follow(camera, hiker, frost, cure) {
    this.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
    this.uniforms.uPlayer.value.copy(hiker.pos);
    this.uniforms.uFrost.value = frost;
    if (cure !== undefined) this.uniforms.uCure.value = cure;
    this.#cull(camera);
  }

  /** Draw only the pieces of the clump grid that can be seen. */
  #cull(camera) {
    const s = this.spacing, W = this.W, T = this.terrain;
    this.frustum.setFromProjectionMatrix(this._pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const c0x = Math.floor(camera.position.x / s) - W / 2, c0z = Math.floor(camera.position.z / s) - W / 2;
    const pad0 = this.pad0 || 2.2;   // a clump leans and spreads about this far from its root
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
