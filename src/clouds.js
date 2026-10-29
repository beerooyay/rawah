import * as THREE from 'three';
import { CLOUD_GLSL } from './atmosphere.js';

// The cumulus, drawn the way Horizon Zero Dawn's Nubis does it, in a pass of their own before the frame:
//
//   * where: the live weather field (cloudsim.js) gives each spot a cover and how tall its clouds grow; the
//     footprint inside it is the same noise that throws the ground's cloud shadows, so shadows and clouds agree.
//   * shape: a tileable 3D noise volume baked once at load (`bakeCloudNoise`): R is Perlin-Worley, the billowy
//     cauliflower; G, B, A are Worley at rising frequencies for the fine erosion. Bases are flat, tops domed,
//     wispy at the bottom and billowing up top, towers lean with the wind shear.
//   * light: Beer-Lambert toward the sun or moon over a few samples, a two-lobe phase for the silver lining,
//     a powder term that darkens the thin edges facing you, sky light from above and below.
//   * cost: drawn at a fraction of the screen's resolution into a half-float target with a fresh jitter every
//     frame, and blended with last frame's result reprojected by view direction (the clouds are kilometres
//     away, so turning the camera is all that moves them on screen). Many steps per pixel for little cost, and
//     no grain: the jitter averages out over frames.
//
// The sky dome (sky.js) composites the result by direction, so the lake mirror's sky finds it too.

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = /* glsl */ `precision highp sampler3D;
varying vec2 vUv;
uniform sampler3D uNoise3D;
uniform sampler2D uHistory;
uniform mat4 uInvVP, uPrevVP;
uniform vec3 uCam;
uniform float uFrame, uBlend, uSlabH;
uniform vec3 uSun, uMoon, uZenith, uHorizon, uCloudLit, uCloudDark;
uniform float uNight, uThick, uFlash;
uniform vec4 uBoltDir[3];
uniform vec3 uBoltCol[3];
// noise read inside a jittered march: neighbouring pixels sample far-apart points, so the automatic mip choice
// would jump per pixel quad and turn the sky to sand. pick the level from distance instead.
float cloudLod = 0.0;
#undef texture2D
#define texture2D(s, uv) textureLod(s, uv, cloudLod)
${CLOUD_GLSL}
uint pcg(uint v) { uint st = v * 747796405u + 2891336453u; uint w = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u; return (w >> 22u) ^ w; }
float hgPhase(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5); }
float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

// density at p, hf its height in the slab (0 base, 1 top). detail 0 for the cheap form the light samples use
float cloudAt(vec3 p, float hf, float detail) {
  if (hf < 0.0 || hf > 1.0) return 0.0;
  vec2 P = p.xz - vec2(hf * 420.0, hf * -260.0);              // wind shear: towers lean downwind as they climb
  vec2 wx = cloudWx(P);                                      // cover and how tall, from the weather field
  if (wx.x < 0.01) return 0.0;
  // local cover decides how much of the noise footprint fills in — soft, wide edges
  float th = mix(0.85, 0.25, wx.x);
  float foot = clamp((cloudFbm(P, 2, wx.x) - th) / 0.25, 0.0, 1.0);
  if (foot <= 0.0) return 0.0;
  float top = mix(0.25, 0.95, wx.y);                         // puffs stay squat, towers climb the slab
  float h01 = hf / top;
  if (h01 > 1.0) return 0.0;
  // cumulus: a flat floor, dense low, doming off toward the top — squat when thin
  float d = foot * smoothstep(0.0, 0.1, h01) * pow(1.0 - h01, 0.3 + 0.5 * (1.0 - wx.y));
  vec3 w = p + vec3(uCloudOff.x, 0.0, uCloudOff.y);
  float n = textureLod(uNoise3D, w / vec3(4600.0, 2600.0, 4600.0), cloudLod).r;
  // the noise carves the dome into cauliflower, taking bigger bites the higher it goes
  d = clamp((d - (1.0 - n) * (0.2 + 0.45 * h01)) / 0.35, 0.0, 1.0);
  if (d <= 0.0) return 0.0;
  if (detail > 0.0) {
    vec4 hi = textureLod(uNoise3D, w / 820.0, cloudLod);
    float f = dot(hi.gba, vec3(0.625, 0.25, 0.125));
    f = mix(1.0 - f, f, smoothstep(0.05, 0.4, h01));        // wispy at the base, billowing higher up
    d = clamp((d - f * 0.3 * detail) / 0.7, 0.0, 1.0);
  }
  return d;
}

vec4 march(vec3 d) {
  float h = d.y;
  float base = max(uCloudAlt, uCam.y + 350.0);
  float hh = max(h, 0.012);
  float t0 = (base - uCam.y) / hh;
  float t1 = min((base + uSlabH - uCam.y) / hh, t0 + 34000.0);
  float fade = smoothstep(0.0, 0.05, h) * exp(-t0 / 90000.0);
  if (t0 > 150000.0 || fade < 0.002) return vec4(0.0, 0.0, 0.0, 1.0);
  vec3 L = uSun.y > -0.045 ? uSun : uMoon;   // matches the switch in Sky.update
  float mu = dot(d, L);
  float phase = mix(hgPhase(mu, 0.7), hgPhase(mu, -0.2), 0.4) * 0.6 + 0.4;
  vec3 ambTop = mix(uHorizon, uZenith, 0.55);
  float sigma = 0.0065 * (1.0 + 0.8 * uThick);
  uvec2 px = uvec2(gl_FragCoord.xy);
  float jit = float(pcg(px.x + pcg(px.y + pcg(uint(uFrame)))) >> 8u) / 16777216.0;
  float dt0 = (t1 - t0) / float(CLOUD_STEPS), dt = dt0;
  float t = t0 + dt0 * jit;
  float detail = 1.0 - smoothstep(14000.0, 30000.0, t0);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  bool inCloud = false;
  for (int i = 0; i < CLOUD_STEPS; i++) {
    vec3 p = uCam + d * t;
    cloudLod = max(0.0, log2(t * 0.0011 / 39.0));
    float hf = (p.y - base) / uSlabH;
    float dn = cloudAt(p, hf, detail);
    // stride through clear air, step finely inside; on the way in, back up and come in again finely
    if (dn > 0.004 && !inCloud) { inCloud = true; t -= dt0 * 0.7; continue; }
    inCloud = dn > 0.004;
    dt = inCloud ? dt0 * 0.45 : dt0 * 1.35;
    if (inCloud) {
      float od = 0.0, s = 60.0;
      for (int k = 0; k < 5; k++) {   // toward the light, each step longer than the last
        vec3 q = p + L * s;
        od += cloudAt(q, (q.y - base) / uSlabH, 0.0) * min(s, 420.0);
        s *= 2.1;
      }
      float tl = exp(-od * 0.011) * 0.8 + exp(-od * 0.0028) * 0.2;   // the second term stands in for light bouncing around inside
      float powder = 1.0 - exp(-dn * 5.0);
      vec3 c = uCloudLit * tl * phase * mix(0.6, 1.0, powder)
             + mix(uCloudDark, ambTop, smoothstep(0.0, 0.8, hf)) * (0.3 + 0.35 * hf + 1.0 * uThick * uCloudCover);
      c += vec3(0.7, 0.75, 0.95) * uFlash * (0.5 + dn);
      for (int q = 0; q < 3; q++) {   // a flash inside the cloud lights the cloud around it, broad and blue-white
        float bw = uBoltDir[q].w;
        if (bw > 0.0) { float bg = max(dot(d, uBoltDir[q].xyz), 0.0); c += uBoltCol[q] * bw * (pow(bg, 4.0) * 0.8 + pow(bg, 36.0) * 1.2 + 0.05) * (0.3 + dn); }
      }
      c = mix(c, uHorizon, 1.0 - exp(-t / 60000.0));   // far clouds sink into the haze
      float a = 1.0 - exp(-dn * sigma * dt);
      acc += trans * a * c;
      trans *= 1.0 - a;
      if (trans < 0.015) break;
    }
    t += dt;
    if (t > t1) break;
  }
  return vec4(acc * fade, mix(1.0, trans, fade));
}

void main() {
  vec4 wd = uInvVP * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 d = normalize(wd.xyz / wd.w);
  vec4 res = d.y > 0.0 ? march(d) : vec4(0.0, 0.0, 0.0, 1.0);
  // last frame, found by direction (feathered at edges so turns don't seam)
  vec4 pc = uPrevVP * vec4(d, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float edge = smoothstep(0.0, 0.08, puv.x) * smoothstep(1.0, 0.92, puv.x) * smoothstep(0.0, 0.08, puv.y) * smoothstep(1.0, 0.92, puv.y);
  float blend = uBlend * edge;
  if (blend > 0.005 && pc.w > 0.0 && puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0) {
    vec4 hist = textureLod(uHistory, puv, 0.0);
    res = mix(res, hist, blend);
  }
  gl_FragColor = res;
}
`;

export class CloudPass {
  constructor(sky, { steps = 64, scale = 0.5 } = {}) {
    this.noise = bakeCloudNoise(64);
    this.scale = scale;
    this.targets = [0, 1].map(() => new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    this.cur = 0;
    this.frame = 0;
    this.prevVP = new THREE.Matrix4();
    this.fresh = true;
    const u = sky.uniforms;
    this.uniforms = {
      uNoise3D: { value: this.noise }, uHistory: { value: null },
      uInvVP: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
      uCam: { value: new THREE.Vector3() }, uFrame: { value: 0 }, uBlend: { value: 0 }, uSlabH: { value: 2500 },
      uSun: u.uSun, uMoon: u.uMoon, uZenith: u.uZenith, uHorizon: u.uHorizon, uCloudLit: u.uCloudLit, uCloudDark: u.uCloudDark,
      uNight: u.uNight, uThick: u.uThick, uFlash: u.uFlash, uBoltDir: u.uBoltDir, uBoltCol: u.uBoltCol,
      uCloudTex: u.uCloudTex, uCloudOff: u.uCloudOff, uCloudCover: u.uCloudCover, uCloudAlt: u.uCloudAlt,
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, defines: { CLOUD_STEPS: steps }, depthTest: false, depthWrite: false });
    this.scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    // what the sky composites
    u.uCloudRT = { value: this.targets[0].texture };
    u.uCloudVP = { value: new THREE.Matrix4() };
    u.uCloudOn = { value: 0 };
    this.sky = sky;
    this._v = new THREE.Matrix4(); this._s = new THREE.Vector2();
  }

  /** How deep the slab is: the tallest cloud the weather field holds. */
  set slab(h) { this.uniforms.uSlabH.value = h; }

  render(renderer, camera) {
    camera.updateMatrixWorld();
    renderer.getDrawingBufferSize(this._s);
    const w = Math.max(16, Math.round(this._s.x * this.scale)), h = Math.max(16, Math.round(this._s.y * this.scale));
    if (this.targets[0].width !== w || this.targets[0].height !== h) {
      for (const t of this.targets) t.setSize(w, h);
      this.fresh = true;
    }
    // the view turned but not moved: clouds are far enough that the camera's position on the trail does not shift them
    const v = this._v.copy(camera.matrixWorldInverse);
    v.elements[12] = v.elements[13] = v.elements[14] = 0;
    const vp = v.premultiply(camera.projectionMatrix);
    const U = this.uniforms;
    U.uInvVP.value.copy(vp).invert();
    U.uPrevVP.value.copy(this.fresh ? vp : this.prevVP);
    U.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    U.uFrame.value = this.frame++ % 1024;
    U.uBlend.value = this.fresh ? 0 : 0.78;
    U.uHistory.value = this.targets[this.cur].texture;
    this.cur ^= 1;
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targets[this.cur]);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prevTarget);
    this.prevVP.copy(vp);
    this.fresh = false;
    const S = this.sky.uniforms;
    S.uCloudRT.value = this.targets[this.cur].texture;
    S.uCloudVP.value.copy(vp);
    S.uCloudOn.value = 1;
  }
}

/**
 * The tileable 3D noise the clouds are carved from (size^3, RGBA8). R: Perlin-Worley (Perlin fbm remapped
 * by low-frequency Worley, so it billows), G, B, A: inverted Worley fbm at 4, 8 and 16 cells per tile.
 */
export function bakeCloudNoise(size = 64) {
  const data = new Uint8Array(size * size * size * 4);
  const worleys = {};
  const worleyAt = (f) => {
    if (worleys[f]) return worleys[f];
    const pts = new Float32Array(f * f * f * 3);
    for (let i = 0; i < f * f * f; i++) for (let k = 0; k < 3; k++) pts[i * 3 + k] = hash(i * 3 + k + f * 7919);
    return (worleys[f] = { f, pts });
  };
  const worley = ({ f, pts }, x, y, z) => {
    const X = x * f, Y = y * f, Z = z * f;
    const ix = Math.floor(X), iy = Math.floor(Y), iz = Math.floor(Z);
    let best = 9;
    for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const cx = ix + a, cy = iy + b, cz = iz + c;
      const wx = ((cx % f) + f) % f, wy = ((cy % f) + f) % f, wz = ((cz % f) + f) % f;
      const o = ((wz * f + wy) * f + wx) * 3;
      const dx = cx + pts[o] - X, dy = cy + pts[o + 1] - Y, dz = cz + pts[o + 2] - Z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
  const grads = {};
  const perlin = (f, x, y, z) => {
    let g = grads[f];
    if (!g) {
      g = grads[f] = new Float32Array(f * f * f * 3);
      for (let i = 0; i < f * f * f; i++) {
        const th = hash(i + f * 31) * Math.PI * 2, u = hash(i + f * 57) * 2 - 1, r = Math.sqrt(1 - u * u);
        g[i * 3] = r * Math.cos(th); g[i * 3 + 1] = u; g[i * 3 + 2] = r * Math.sin(th);
      }
    }
    const X = x * f, Y = y * f, Z = z * f;
    const ix = Math.floor(X), iy = Math.floor(Y), iz = Math.floor(Z);
    const fx = X - ix, fy = Y - iy, fz = Z - iz;
    const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10), sz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    const dot = (a, b, c) => {
      const o = (((((iz + c) % f) + f) % f * f + ((((iy + b) % f) + f) % f)) * f + ((((ix + a) % f) + f) % f)) * 3;
      return g[o] * (fx - a) + g[o + 1] * (fy - b) + g[o + 2] * (fz - c);
    };
    const l = (a, b, t) => a + (b - a) * t;
    return l(l(l(dot(0, 0, 0), dot(1, 0, 0), sx), l(dot(0, 1, 0), dot(1, 1, 0), sx), sy),
      l(l(dot(0, 0, 1), dot(1, 0, 1), sx), l(dot(0, 1, 1), dot(1, 1, 1), sx), sy), sz);
  };
  const W = [4, 8, 16, 32, 64].map(worleyAt);
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size, w = (z + 0.5) / size;
    const w4 = worley(W[0], u, v, w), w8 = worley(W[1], u, v, w), w16 = worley(W[2], u, v, w), w32 = worley(W[3], u, v, w), w64 = worley(W[4], u, v, w);
    const p = (perlin(4, u, v, w) * 0.6 + perlin(8, u, v, w) * 0.28 + perlin(16, u, v, w) * 0.12) * 0.75 + 0.5;
    const wl = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;
    const pw = Math.min(1, Math.max(0, (p - (wl - 1)) / (1 - (wl - 1))));   // remap(perlin, worley - 1, 1, 0, 1)
    const o = ((z * size + y) * size + x) * 4;
    data[o] = pw * 255;
    data[o + 1] = wl * 255;
    data[o + 2] = (w8 * 0.625 + w16 * 0.25 + w32 * 0.125) * 255;
    data[o + 3] = (w16 * 0.625 + w32 * 0.25 + w64 * 0.125) * 255;
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

function hash(n) {
  let x = (n | 0) * 374761393 + 668265263;
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}
