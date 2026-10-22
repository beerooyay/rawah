import * as THREE from 'three';
import { NOISE_GLSL } from './detail.js';
import { WIND_GLSL } from './wind.js';
import { HEIGHT_GLSL } from './cdlod.js';
import { withAtmosphere } from './atmosphere.js';

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
// As before there is no CPU-side data: each clump takes its spot from
// gl_InstanceID on a grid that follows the camera (snapped, so nothing swims),
// grows only where the land cover says meadow or tundra, sways in the shared
// wind, parts around the hiker, and frosts at dawn.

const CELLS = 4, CW = 512, CH = 512;
const TRAMPLE = 40;                 // pressed patches remembered at once
const HOLD = 3, SPRING = 16;        // s a patch stays flat, and the time it's fully sprung back by

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

function clumpGeometry() {
  // three crossed cards at 60 degrees; x = across (-0.5..0.5), y = up (0..1)
  const pos = [], uv = [], idx = [];
  for (let q = 0; q < 3; q++) {
    const a = (q * Math.PI) / 3, c = Math.cos(a), s = Math.sin(a), o = pos.length / 3;
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

export class Grass {
  constructor(terrain, { radius = 30, spacing = 0.5 } = {}, uniforms) {
    this.spacing = spacing;
    this.W = Math.round((radius * 2) / spacing);
    this.uniforms = {
      ...terrain.uniforms,
      uCenter: { value: new THREE.Vector2() }, uPlayer: { value: new THREE.Vector3() },
      uSpacing: { value: spacing }, uW: { value: this.W }, uRadius: { value: radius },
      uTrA: { value: Array.from({ length: TRAMPLE }, () => new THREE.Vector4()) },   // x, z, direction x, z
      uTrB: { value: Array.from({ length: TRAMPLE }, () => new THREE.Vector4()) },   // length, radius, power, time pressed
      uFrost: { value: 0 }, uCure: { value: 0.75 }, uTime: uniforms.uTime, uCalm: uniforms.uCalm,
    };
    const geo = clumpGeometry();
    geo.instanceCount = this.W * this.W;
    const mat = new THREE.MeshLambertMaterial({ map: paintGrass(), alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.uniforms.uColorMap = { value: terrain.colorMap };
      shader.uniforms.uCover = { value: terrain.coverMap };
      shader.uniforms.uExtent = { value: terrain.extent };
      withAtmosphere(shader, { translucency: 0.7, weather: 0.8 });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uColorMap, uCover;
          uniform float uExtent, uSpacing, uW, uRadius;
          uniform vec2 uCenter;
          uniform vec3 uPlayer;
          uniform vec4 uTrA[${TRAMPLE}], uTrB[${TRAMPLE}];
          uniform float uSnow, uSnowLine;
          varying vec3 vSat, vTone;
          varying float vLush;
          ${HEIGHT_GLSL}
          ${WIND_GLSL}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', `
          int W = int(uW);
          ivec2 cell = ivec2(floor(uCenter / uSpacing)) - W / 2 + ivec2(gl_InstanceID % W, gl_InstanceID / W);
          float h1 = ihash(cell), h2 = ihash(cell + ivec2(7919, 104729)), h3 = ihash(cell * 3 + ivec2(17, 3));
          vec2 root = (vec2(cell) + vec2(h1, h2)) * uSpacing;
          float r = distance(root, uCenter);
          vec4 cov = texture2D(uCover, root / uExtent + 0.5);   // live, burned, aspen, rock
          float mask = maskAt(root);
          float grow = (1.0 - cov.a) * (1.0 - mask) * (1.0 - cov.r * 0.8) * (1.0 - cov.g * 0.25);
          float y0 = baseH(root);
          grow *= smoothstep(3960.0, 3700.0, y0);
          float alpine = smoothstep(3330.0, 3560.0, y0);
          vSat = texture2D(uColorMap, root / uExtent + 0.5).rgb;
          vLush = clamp((vSat.g - vSat.r) * 8.0, 0.0, 1.0);
          float fade = 1.0 - smoothstep(uRadius * 0.6, uRadius, r);
          float live = step(h1 * 0.8 + h3 * 0.2, grow * 1.7);
          // each clump its own shade: some straw-pale, some russet, some dun
          vTone = mix(vec3(1.08, 0.98, 0.86), vec3(0.88, 0.78, 0.7), h3) * (0.85 + h1 * 0.3);
          // buried under the snowpack (only the tallest tufts poke through the edges)
          live *= 1.0 - step(0.5, uSnow * smoothstep(uSnowLine - 40.0, uSnowLine + 40.0, y0) * (1.3 - h3 * 0.5));
          float size = mix(1.0, 0.6, alpine) * (0.75 + h3 * 0.6) * fade * live;
          // which clump: turf up high, sedge where it's green and wet, meadow grass elsewhere
          float kind = alpine > 0.5 ? 2.0 : vLush > 0.55 && h2 > 0.4 ? 3.0 : step(0.55, h3);
          vMapUv = vec2((kind + uv.x) / 4.0, uv.y);
          float ang = h2 * 6.2832, ca = cos(ang), sa = sin(ang);
          vec3 lp = vec3(position.x * ca - position.z * sa, position.y, position.x * sa + position.z * ca);
          float t = position.y;
          // pressed down by what has walked or lain here: capsules from the trample ring, springing back with time
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
          vec3 p = vec3(root.x + lp.x * size * 1.6, groundH(root, 0.0) - 0.03 + t * size * mix(0.72, 0.42, alpine) * (1.0 - press * 0.8), root.y + lp.z * size * 1.6);
          // wind: steady lean downwind plus the travelling gusts; bend grows with height squared
          float g = gustAt(root);
          float bend = (0.1 + g * 0.8 + sin(uTime * 2.3 + root.x * 0.4 + root.y * 0.3) * 0.07) * t * t * size;
          p.xz += WIND_DIR * bend;
          p.y -= bend * bend * 0.5;
          // part around the hiker
          vec2 away = root - uPlayer.xz;
          float near = 1.0 - smoothstep(0.2, 1.0, length(away));
          p.xz += normalize(away + 1e-4) * near * t * size * 0.7;
          p.y -= near * t * size * 0.3;
          p.xz += normalize(lean + vec2(1e-4)) * press * t * size * 0.9;
          vec3 transformed = p;`);
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
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 0;
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

  update(camera, hiker, frost, cure, heading = 0) {
    this.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
    this.uniforms.uPlayer.value.copy(hiker.pos);
    this.#trample(hiker, heading);
    this.uniforms.uFrost.value = frost;
    if (cure !== undefined) this.uniforms.uCure.value = cure;
  }
}
