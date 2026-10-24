import * as THREE from 'three';

// A campfire you'd want to sit at: a ring of stones, a pile of logs that glow
// at the cracks, a bed of coals, and flames drawn the way real ones look:
// a handful of upright tongues, each a camera-facing strip whose fragment
// shader runs scrolling noise through a taper and a blackbody colour ramp
// (blue at the root, red edges, orange body, white-yellow core, wisps at the
// tips). Sparks drift up and wink out, a little smoke rises, and a warm light
// flickers across the camp. Everything animates from one clock, so a fire
// costs next to nothing.
const UNIT = 0.68;   // the whole fire is built at this fraction of a full-size campfire

const SPRITE = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  return t;
})();

const FLAME_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aFlame;      // x, z offset; width; height
attribute vec2 aPh;         // seed, speed
uniform float uTime, uFuel, uUnit;
varying vec2 vUv;
varying float vSeed;
void main() {
  vec3 wc = (modelMatrix * vec4(aFlame.x, 0.04, aFlame.y, 1.0)).xyz;
  vec3 toCam = cameraPosition - wc; toCam.y = 0.0;
  toCam = normalize(toCam + vec3(1e-5, 0.0, 0.0));
  vec3 right = vec3(toCam.z, 0.0, -toCam.x);          // always faces the camera, upright
  float breathe = 1.0 + 0.14 * sin(uTime * (2.6 + aPh.y) + aPh.x * 30.0) + 0.08 * sin(uTime * 7.1 + aPh.x * 11.0);
  float h = mix(0.3, 1.0, sqrt(uFuel)) * breathe;
  vec3 wp = wc + right * position.x * aFlame.z * uUnit + vec3(0.0, 1.0, 0.0) * position.y * aFlame.w * uUnit * h;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
  vUv = vec2(position.x, position.y);
  vSeed = aPh.x;
}`;

const FLAME_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform float uTime, uFuel;
varying vec2 vUv;
varying float vSeed;
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vn(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  #include <logdepthbuf_fragment>
  float x = vUv.x, h = vUv.y, t = uTime;
  // noise rising up the tongue, finer and faster the higher it goes
  vec2 p = vec2(x * 0.9 + vSeed * 13.0, h * 1.5 - t * 1.4 - vSeed * 7.0);
  float n1 = fbm(p * vec2(2.0, 1.6));
  float n2 = fbm(p * vec2(5.2, 3.6) + vec2(4.3, -t * 0.8));
  float turb = n1 * 0.62 + n2 * 0.38;
  // the tongue leans and licks sideways more toward its tip
  float sway = (n1 - 0.5) * 1.0 * h + sin(t * 2.3 + vSeed * 20.0) * 0.14 * h * h;
  float width = (1.0 - pow(h, 0.75)) * (0.8 + 0.4 * turb);
  float d = abs(x - sway) / max(width, 0.02);
  float body = smoothstep(1.0, 0.05, d);
  float top = 1.0 - smoothstep(0.3, 1.0, h + (turb - 0.5) * 0.7);       // broken, wispy tips
  float I = body * top * (0.55 + 1.05 * turb);
  I *= smoothstep(0.0, 0.05, h);
  // blackbody: red edge, orange body, yellow, white-hot core
  vec3 col = mix(vec3(0.5, 0.03, 0.0), vec3(1.0, 0.36, 0.03), smoothstep(0.06, 0.42, I));
  col = mix(col, vec3(1.0, 0.76, 0.26), smoothstep(0.38, 0.85, I));
  col = mix(col, vec3(1.0, 0.96, 0.78), smoothstep(0.85, 1.35, I));
  col = mix(col, vec3(0.22, 0.38, 1.0), smoothstep(0.1, 0.0, h) * 0.5 * body);   // blue where it meets the wood
  float a = smoothstep(0.03, 0.5, I) * clamp(uFuel * 1.4, 0.0, 1.0);
  gl_FragColor = vec4(col * 1.3, a);
}`;

const SPARK_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aSeed;
uniform float uTime, uScale, uFuel, uUnit;
varying vec4 vCol;
void main() {
  float life = 2.2 + aSeed.z * 2.0;
  float age = fract(uTime / life + aSeed.y);
  float t = age * life;
  vec3 p = vec3(cos(aSeed.y * 30.0) * 0.18, 0.4, sin(aSeed.y * 30.0) * 0.18);
  p.y += t * (0.9 + aSeed.x * 1.1);
  p.x += sin(t * 2.0 + aSeed.y * 40.0) * 0.5 * age + aSeed.w * age * 0.8;
  p.z += cos(t * 1.7 + aSeed.y * 33.0) * 0.5 * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  float alive = step(aSeed.y, uFuel * 0.95);
  gl_PointSize = alive * uScale * 0.012 * uUnit * (1.0 - age) / max(-mv.z, 0.1);
  float wink = 0.6 + 0.4 * sin(uTime * 24.0 + aSeed.y * 90.0);
  vCol = vec4(1.0, 0.55 + 0.3 * (1.0 - age), 0.15, (1.0 - age) * wink);
}`;

const SMOKE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aSeed;
uniform float uTime, uScale, uFuel, uUnit;
varying vec4 vCol;
void main() {
  float age = fract(uTime * 0.09 * (0.7 + aSeed.z * 0.6) + aSeed.y);
  vec3 p = vec3(cos(aSeed.y * 20.0) * 0.15, 1.1 + age * 3.4, sin(aSeed.y * 20.0) * 0.15);
  p.x += age * age * 1.4 + sin(uTime * 0.5 + aSeed.y * 10.0) * 0.3 * age;
  p.z += sin(uTime * 0.4 + aSeed.y * 8.0) * 0.4 * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  gl_PointSize = step(aSeed.y, uFuel) * uScale * (0.3 + age * 0.9) * uUnit / max(-mv.z, 0.1);
  vCol = vec4(0.45, 0.43, 0.42, smoothstep(0.0, 0.15, age) * (1.0 - age) * 0.14);
}`;

const FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec4 vCol;
void main() {
  #include <logdepthbuf_fragment>
  float a = texture2D(uMap, gl_PointCoord).a;
  gl_FragColor = vec4(vCol.rgb, vCol.a * a);
}`;

/** The flames: a dozen upright strips in a cluster, drawn as one mesh. */
function flameMesh() {
  const flames = [
    // x, z, width, height   (width is the half-width of the strip at its base)
    [0, 0, 0.5, 1.15], [0.12, 0.08, 0.38, 0.9], [-0.1, 0.1, 0.4, 0.95], [0.04, -0.14, 0.36, 0.8], [-0.15, -0.06, 0.3, 0.7],
    [0.17, -0.05, 0.3, 0.72], [-0.02, 0.17, 0.28, 0.6], [0.09, 0.0, 0.24, 1.3], [-0.06, -0.02, 0.22, 1.05], [0.2, 0.14, 0.22, 0.5], [-0.2, 0.12, 0.2, 0.5],
  ];
  const n = flames.length, pos = new Float32Array(n * 4 * 3), fl = new Float32Array(n * 4 * 4), ph = new Float32Array(n * 4 * 2), idx = [];
  flames.forEach(([x, z, w, h], i) => {
    const seed = (i * 0.37 + 0.11) % 1, speed = 0.4 + (i % 4) * 0.35;
    [[-1, 0], [1, 0], [-1, 1], [1, 1]].forEach(([px, py], k) => {
      const v = i * 4 + k;
      pos[v * 3] = px; pos[v * 3 + 1] = py;
      fl.set([x, z, w, h], v * 4);
      ph.set([seed, speed], v * 2);
    });
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFlame', new THREE.BufferAttribute(fl, 4));
  geo.setAttribute('aPh', new THREE.BufferAttribute(ph, 2));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.6, 0), 3);
  const mat = new THREE.ShaderMaterial({
    vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
    uniforms: { uTime: { value: 0 }, uFuel: { value: 1 }, uUnit: { value: UNIT } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return mesh;
}

function particles(count, vert, extra, blending, order, map = SPRITE) {
  const seed = new Float32Array(count * 4), pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    seed[i * 4] = Math.random();
    seed[i * 4 + 1] = (i + Math.random() * 0.8) / count;   // phase, spread evenly so the fire is full from the first frame
    seed[i * 4 + 2] = 0.55 + Math.random() * 0.9;
    seed[i * 4 + 3] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.5, 0), 6);
  const uniforms = { uMap: { value: map }, uTime: { value: 0 }, uScale: { value: 800 }, uFuel: { value: 1 }, uUnit: { value: UNIT }, ...extra };
  const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: FRAG, uniforms, transparent: true, depthWrite: false, blending, fog: false });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = order;
  return pts;
}

/** Bark: dark furrows lengthwise. */
export function barkTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#3a2a1f'; g.fillRect(0, 0, 128, 256);
  for (let i = 0; i < 160; i++) {
    g.fillStyle = `rgba(${10 + Math.random() * 30},${8 + Math.random() * 20},${6 + Math.random() * 14},${0.35 + Math.random() * 0.5})`;
    g.fillRect(Math.random() * 128, Math.random() * 256, 1 + Math.random() * 4, 14 + Math.random() * 70);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The glowing bed of coals and ash under the logs. */
function coalTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#120a06'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * 256, y = Math.random() * 256, d = Math.hypot(x - 128, y - 128) / 128;
    if (d > 1) continue;
    const hot = (1 - d) * (0.4 + Math.random() * 0.6);
    g.fillStyle = `rgba(${200 + hot * 55},${50 + hot * 110},${10 + hot * 20},${0.25 + hot * 0.6})`;
    g.beginPath(); g.ellipse(x, y, 2 + Math.random() * 7, 1 + Math.random() * 4, Math.random() * 3, 0, 6.3); g.fill();
  }
  return new THREE.CanvasTexture(cv);
}

export class Fire {
  constructor() {
    this.group = new THREE.Group();
    this.group.scale.setScalar(UNIT);
    const g = this.group;

    const stone = new THREE.MeshLambertMaterial({ color: 0x4e4a46 });
    for (let i = 0; i < 11; i++) {
      const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.15 + Math.random() * 0.06, 0), stone);
      const a = (i / 11) * Math.PI * 2 + Math.random() * 0.1;
      s.position.set(Math.cos(a) * 0.62, 0.07, Math.sin(a) * 0.62);
      s.scale.set(1, 0.65, 1);
      s.rotation.set(Math.random() * 3, Math.random() * 3, 0);
      s.castShadow = s.receiveShadow = true;
      g.add(s);
    }

    // the coal bed
    const bed = new THREE.Mesh(new THREE.CircleGeometry(0.48, 24), new THREE.MeshBasicMaterial({ map: coalTexture(), color: 0xffffff }));
    bed.rotation.x = -Math.PI / 2; bed.position.y = 0.025;
    this.bed = bed;
    g.add(bed);

    // logs: three leaning together in a teepee, three laid across the bottom
    const bark = barkTexture();
    this.logMat = new THREE.MeshLambertMaterial({ map: bark, color: 0xffffff, emissive: 0x3a0e00, emissiveIntensity: 1 });
    const charMat = new THREE.MeshLambertMaterial({ color: 0x120d0a, emissive: 0x6a1a00, emissiveIntensity: 1 });
    const addLog = (len, r, from, to, charred = false) => {
      const geo = new THREE.CylinderGeometry(r * 0.88, r, len, 8);
      geo.translate(0, len / 2, 0);
      const m = new THREE.Mesh(geo, charred ? charMat : this.logMat);
      const d = to.clone().sub(from);
      m.position.copy(from);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      m.castShadow = true;
      g.add(m);
      return m;
    };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    this.teepee = [];
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      this.teepee.push(addLog(0.95, 0.065, V(Math.cos(a) * 0.4, 0.06, Math.sin(a) * 0.4), V(Math.cos(a) * 0.04, 0.82, Math.sin(a) * 0.04), i === 1));
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 1.1;
      addLog(0.78, 0.07, V(Math.cos(a) * 0.36, 0.08, Math.sin(a) * 0.36), V(-Math.cos(a) * 0.3, 0.12, -Math.sin(a) * 0.3), i === 0);
    }

    // flames, sparks, smoke
    this.flames = flameMesh();
    this.sparks = particles(36, SPARK_VERT, {}, THREE.AdditiveBlending, 3);
    this.smoke = particles(16, SMOKE_VERT, {}, THREE.NormalBlending, 4);
    g.add(this.flames, this.sparks, this.smoke);

    this.light = new THREE.PointLight(0xff8a3a, 0, 24, 1.5);
    this.light.position.y = 0.7;
    g.add(this.light);
    this.glow = new THREE.PointLight(0xff5a1a, 0, 5, 2);   // a deeper red close in, off the coals
    this.glow.position.y = 0.2;
    g.add(this.glow);
  }

  /** The three logs leaning together come away when a grate goes over the fire. */
  setTeepee(on) { for (const m of this.teepee) m.visible = on; }

  /** `fuel` 0..1: how much of the fire is left; `px`: viewport height in device pixels over 2 tan(fov/2). */
  update(t, fuel, scale) {
    const f = Math.min(1, Math.max(0, fuel));
    for (const p of [this.flames, this.sparks, this.smoke]) {
      const u = p.material.uniforms;
      u.uTime.value = t; u.uFuel.value = f;
      if (u.uScale) u.uScale.value = scale;
    }
    const flick = 0.78 + Math.sin(t * 13) * 0.08 + Math.sin(t * 29 + 1) * 0.06 + Math.sin(t * 7.3) * 0.05 + Math.random() * 0.08;
    this.light.intensity = 26 * flick * f;
    this.glow.intensity = 7 * (0.8 + Math.sin(t * 5.1) * 0.2 + Math.random() * 0.1) * f;
    const hot = 0.65 + Math.sin(t * 3.3) * 0.15 + Math.sin(t * 9.1) * 0.1;
    this.logMat.emissiveIntensity = (1.1 + hot) * f;
    this.bed.material.color.setScalar(0.6 + hot * 0.7 * f);
  }

  set visible(v) { this.group.visible = v; if (!v) { this.light.intensity = 0; this.glow.intensity = 0; } }
}
