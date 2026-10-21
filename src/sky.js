import * as THREE from 'three';
import { clamp, smoothstep, lerp } from './noise.js';

// Sky dome, sun, moon, stars and the Milky Way, plus the lights and fog that
// follow them. The sun runs on a real ephemeris for the trailhead's latitude in
// late September, so sunrise over the Laramie valley lands just before 7 am.

const LAT = 40.65 * Math.PI / 180;
const DECL = -1.6 * Math.PI / 180;   // ~Sep 26
const SOLAR_NOON = 12.93;             // MDT at 105.9 W, with the equation of time

export function sunDirection(hour, out = new THREE.Vector3()) {
  const H = (hour - SOLAR_NOON) * 15 * Math.PI / 180;
  const sinAlt = Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H);
  const alt = Math.asin(sinAlt);
  const cosAz = (Math.sin(DECL) - Math.sin(alt) * Math.sin(LAT)) / (Math.cos(alt) * Math.cos(LAT));
  let az = Math.acos(clamp(cosAz, -1, 1)); // from north, through east
  if (H > 0) az = Math.PI * 2 - az;
  // x east, z south, y up
  return out.set(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt));
}

// palette keyed on sun altitude (sin)
const KEYS = [
  [-0.35, 0x02040a, 0x070b16, 0x000000],
  [-0.18, 0x050a18, 0x121a30, 0x1a1020],
  [-0.08, 0x13203f, 0x4a3d58, 0x6a3a40],
  [0.0, 0x2a4a7c, 0xe39a6c, 0xff8a4a],
  [0.09, 0x3a6aa6, 0xdcc3a2, 0xffb070],
  [0.3, 0x2f6cbf, 0xa8c6e4, 0xfff0d0],
  [1.0, 0x2a64b8, 0x9fc0e2, 0xffffff],
];

const VERT = `varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // pin to the far plane
}`;

const FRAG = `varying vec3 vDir;
uniform vec3 uSun, uMoon, uZenith, uHorizon, uGlow;
uniform float uNight, uTime;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.25, h));
  float sd = max(dot(d, uSun), 0.0);
  col += uGlow * (pow(sd, 6.0) * 0.28 + pow(sd, 48.0) * 0.45) * (1.0 - 0.5 * smoothstep(0.0, 0.5, h));
  col += vec3(1.0, 0.96, 0.88) * smoothstep(0.99955, 0.9998, sd) * 6.0;
  if (uNight > 0.0) {
    // Milky Way: a soft noisy band across the sky
    vec3 bandN = normalize(vec3(0.5, 0.35, 0.8));
    float band = exp(-pow(dot(d, bandN) / 0.13, 2.0));
    float dust = noise(d * 38.0) * 0.55 + noise(d * 90.0) * 0.45;
    float lane = smoothstep(0.02, 0.0, abs(dot(d, bandN) + 0.02 * noise(d * 12.0))) * 0.6;
    col += vec3(0.5, 0.55, 0.7) * band * (0.35 + dust * 0.65) * (1.0 - lane) * 0.075 * uNight;
    vec3 p = d * 260.0;
    vec3 c = floor(p);
    float r = hash(c);
    float star = smoothstep(0.9965 - band * 0.004, 1.0, r) * smoothstep(0.5, 0.0, length(fract(p) - 0.5));
    star *= 0.7 + 0.3 * sin(uTime * (2.0 + r * 5.0) + r * 40.0);
    col += vec3(0.9, 0.93, 1.0) * star * 2.2 * uNight * smoothstep(-0.05, 0.15, h);
    float md = dot(d, uMoon);
    col += vec3(0.95, 0.93, 0.85) * smoothstep(0.99975, 0.99985, md) * 1.8 * uNight;
    col += vec3(0.2, 0.25, 0.35) * pow(max(md, 0.0), 30.0) * 0.25 * uNight;
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uSun: { value: new THREE.Vector3() }, uMoon: { value: new THREE.Vector3() },
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGlow: { value: new THREE.Color() },
      uNight: { value: 0 }, uTime: { value: 0 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 48, 24),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }),
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -110; sc.right = sc.top = 110; sc.near = 1; sc.far = 1200;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x5a5040, 0.9);
    scene.add(this.hemi);
    scene.fog = new THREE.FogExp2(0xa8c6e4, 0.000052);
    this.fog = scene.fog;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();
    this.light = 1; // 0 = deep night, 1 = full day (for gameplay)
    this._a = new THREE.Color(); this._b = new THREE.Color();
  }

  #palette(s, i) {
    let k = 0;
    while (k < KEYS.length - 2 && s > KEYS[k + 1][0]) k++;
    const [s0, ...c0] = KEYS[k], [s1, ...c1] = KEYS[k + 1];
    const t = clamp((s - s0) / (s1 - s0), 0, 1);
    return this._a.setHex(c0[i]).lerp(this._b.setHex(c1[i]), t);
  }

  update(hour, camPos, focus, t) {
    sunDirection(hour, this.sunDir);
    // a waxing gibbous moon trailing the sun by ~9.5 hours
    sunDirection((hour + 14.5) % 24, this.moonDir);
    this.moonDir.y = this.moonDir.y * 0.85 + 0.06;
    this.moonDir.normalize();
    const s = this.sunDir.y;
    const u = this.uniforms;
    u.uSun.value.copy(this.sunDir);
    u.uMoon.value.copy(this.moonDir);
    u.uZenith.value.copy(this.#palette(s, 0));
    u.uHorizon.value.copy(this.#palette(s, 1));
    u.uGlow.value.copy(this.#palette(s, 2));
    u.uNight.value = smoothstep(0.02, -0.16, s);
    u.uTime.value = t;
    this.dome.position.copy(camPos);

    const day = smoothstep(-0.06, 0.12, s);
    const moonUp = smoothstep(-0.02, 0.1, this.moonDir.y) * u.uNight.value;
    const useMoon = s < -0.03;
    const dir = useMoon ? this.moonDir : this.sunDir;
    this.sun.position.copy(focus).addScaledVector(dir, 500);
    this.sun.target.position.copy(focus);
    const warm = smoothstep(0.0, 0.35, s);
    if (useMoon) {
      this.sun.color.setRGB(0.62, 0.72, 1.0);
      this.sun.intensity = 0.32 * moonUp;
    } else {
      this.sun.color.setRGB(1, lerp(0.62, 0.96, warm), lerp(0.38, 0.9, warm));
      this.sun.intensity = 3.1 * day;
    }
    this.hemi.color.copy(u.uZenith.value).lerp(this._a.setRGB(1, 1, 1), 0.35);
    this.hemi.groundColor.setRGB(0.42, 0.38, 0.32).multiplyScalar(0.25 + day * 0.75);
    this.hemi.intensity = lerp(0.42, 1.25, day);
    this.fog.color.copy(u.uHorizon.value).lerp(u.uZenith.value, 0.15);
    this.light = clamp(day + moonUp * 0.25, 0, 1);
  }
}
