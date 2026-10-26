import * as THREE from 'three';

// A ripple field that follows you. Ported from jeantimex/threejs-water (MIT; see
// THIRD_PARTY_NOTICES.md), itself a port of Evan Wallace's WebGL Water: the 2D
// wave equation solved on the GPU in a ping-pong pair of float textures
// (R height, G velocity), a Hann-profile drop that pushes the surface up, and a
// pass that turns the height into slopes for the water shaders. What changed for
// open water: the pool optics are gone, the field is a 38 m window that scrolls
// with whoever it follows (whole-cell shifts, so nothing blurs), edges absorb,
// a stream's current carries the ripples downstream, the wave speed is set in
// metres per second, and the solver sleeps once everything that was dropped in
// has decayed under what the eye can see.
//
// Lakes and streams sample it through WAVE_GLSL: `waveSlope(xz)` is the
// surface's slope (-dh/dx, -dh/dz) at a world point.

export const WAVE = {
  uWaveTex: { value: new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType) },
  uWaveBox: { value: new THREE.Vector3(0, 0, 1) },   // window origin x, z and size, metres
  uWaveGain: { value: 1.7 },
  uWaveOn: { value: 0 },
};
WAVE.uWaveTex.value.needsUpdate = true;

export const WAVE_GLSL = /* glsl */ `
uniform sampler2D uWaveTex;
uniform vec3 uWaveBox;
uniform float uWaveGain, uWaveOn;
vec2 waveSlope(vec2 xz) {
  if (uWaveOn < 0.5) return vec2(0.0);
  vec2 uv = (xz - uWaveBox.xy) / uWaveBox.z;
  vec2 e = min(uv, 1.0 - uv);
  float f = smoothstep(0.0, 0.08, min(e.x, e.y));
  return f > 0.0 ? texture2D(uWaveTex, uv).ba * f : vec2(0.0);
}
`;

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DROPS = 12;
const DROP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tIn; uniform vec4 uDrops[${DROPS}]; uniform int uCount; uniform float uSize;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tIn, vUv);
  for (int i = 0; i < ${DROPS}; i++) {
    if (i >= uCount) break;
    vec4 d = uDrops[i];                                   // x, z (metres in the window), radius, strength (metres)
    float t = max(0.0, 1.0 - length(vUv * uSize - d.xy) / d.z);
    c.r += (0.5 - 0.5 * cos(t * 3.14159265)) * d.w;       // Hann profile, as in the original
  }
  gl_FragColor = c;
}`;

const STEP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tIn; uniform vec2 texel; uniform float c2, damp; uniform vec2 flow;   // flow: texels per step
varying vec2 vUv;
void main() {
  vec2 s = vUv - flow * texel;                             // a stream carries the ripples with it
  vec4 c = texture2D(tIn, s);
  float h = c.r;
  float lap = texture2D(tIn, s - vec2(texel.x, 0.0)).r + texture2D(tIn, s + vec2(texel.x, 0.0)).r
            + texture2D(tIn, s - vec2(0.0, texel.y)).r + texture2D(tIn, s + vec2(0.0, texel.y)).r - 4.0 * h;
  float v = (c.g + c2 * lap) * damp;
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, 0.07, min(e.x, e.y));       // the rim soaks waves up instead of bouncing them back
  v *= mix(0.55, 1.0, edge);
  h *= mix(0.92, 1.0, edge);
  gl_FragColor = vec4(h + v, v, 0.0, 0.0);
}`;

const NORMAL_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tIn; uniform vec2 texel; uniform float cell;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tIn, vUv);
  float hl = texture2D(tIn, vUv - vec2(texel.x, 0.0)).r, hr = texture2D(tIn, vUv + vec2(texel.x, 0.0)).r;
  float hd = texture2D(tIn, vUv - vec2(0.0, texel.y)).r, hu = texture2D(tIn, vUv + vec2(0.0, texel.y)).r;
  c.ba = vec2(hl - hr, hd - hu) / (2.0 * cell);            // slope -grad h
  gl_FragColor = c;
}`;

const SHIFT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tIn; uniform vec2 texel; uniform vec2 shift;   // whole texels
varying vec2 vUv;
void main() {
  vec2 s = vUv + shift * texel;
  gl_FragColor = (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) ? vec4(0.0) : texture2D(tIn, s);
}`;

export class WaveField {
  /**
   * n texels a side of `cell` metres (a window of n * cell metres); `speed` the
   * wave speed in m/s. `eps` is the ripple height (m) below which the eye cannot
   * tell the water is moving.
   */
  constructor(renderer, { n = 256, cell = 0.15, speed = 1.1, eps = 0.0004 } = {}) {
    this.r = renderer; this.n = n; this.cell = cell; this.size = n * cell; this.speed = speed; this.eps = eps;
    const gl = renderer.getContext();
    this.enabled = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.t = 0; this.activeUntil = -1; this.acc = 0;
    this.ix = 0; this.iz = 0; this.placed = false;       // window corner, in cells
    this.queue = [];
    this.stats = { steps: 0, drops: 0, active: false };
    if (!this.enabled) return;
    const half = !gl.getExtension('OES_texture_float_linear');
    const opts = { type: half ? THREE.HalfFloatType : THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping };
    this.a = new THREE.WebGLRenderTarget(n, n, opts);
    this.b = new THREE.WebGLRenderTarget(n, n, opts);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    const mat = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms: { tIn: { value: null }, texel: { value: new THREE.Vector2(1 / n, 1 / n) }, ...uniforms }, depthTest: false, depthWrite: false, toneMapped: false });
    this.mDrop = mat(DROP_FRAG, { uDrops: { value: Array.from({ length: DROPS }, () => new THREE.Vector4()) }, uCount: { value: 0 }, uSize: { value: this.size } });
    this.mStep = mat(STEP_FRAG, { c2: { value: 0 }, damp: { value: 0.992 }, flow: { value: new THREE.Vector2() } });
    this.mNormal = mat(NORMAL_FRAG, { cell: { value: cell } });
    this.mShift = mat(SHIFT_FRAG, { shift: { value: new THREE.Vector2() } });
    // wave speed c = speed m/s over a fixed step of 1/60 s: (c dt / dx)^2, split over two sub-steps
    this.dtSim = 1 / 60;
    this.c2 = Math.pow(speed * (this.dtSim / 2) / cell, 2);
    this.damp = 0.9935;
    this.decay = -Math.log(this.damp) * 120 * 0.6;        // per second, the slower tail of a wave train
    for (const rt of [this.a, this.b]) { renderer.setRenderTarget(rt); renderer.clear(); }
    renderer.setRenderTarget(null);
  }

  /** The current texture (after the last pass). */
  get texture() { return this.a.texture; }

  /** One full-screen pass from the current texture into the spare one, then swap. */
  #pass(material) {
    material.uniforms.tIn.value = this.a.texture;
    this.quad.material = material;
    const r = this.r, prev = r.getRenderTarget(), ac = r.autoClear;
    r.autoClear = true;
    r.setRenderTarget(this.b); r.render(this.scene, this.cam); r.setRenderTarget(prev);
    r.autoClear = ac;
    const t = this.a; this.a = this.b; this.b = t;
  }

  /** A drop at a world point: radius in metres, strength the height it lifts the surface (m). */
  drop(x, z, radius = 0.3, strength = 0.02) {
    if (!this.enabled) return;
    this.queue.push([x, z, radius, strength]);
    // while anything lifted this much can still be seen, the field must run
    this.activeUntil = Math.max(this.activeUntil, this.t + Math.log(Math.max(1.001, Math.abs(strength) / this.eps)) / this.decay + 1.5);
    this.stats.drops++;
  }

  /** Several drops along a line (a wake): from (x0, z0) to (x1, z1). */
  line(x0, z0, x1, z1, radius, strength) {
    const d = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.ceil(d / (radius * 0.9)));
    for (let i = 0; i < n; i++) { const u = (i + 0.5) / n; this.drop(x0 + (x1 - x0) * u, z0 + (z1 - z0) * u, radius, strength); }
  }

  /**
   * Advance by `dt` seconds with the window following (fx, fz); `flow` is the
   * stream's current there in m/s (world x, z).
   */
  update(dt, fx, fz, flow) {
    if (!this.enabled) return;
    this.t += dt;
    const n = this.n;
    // scroll the window in whole cells, only once the focus is well off centre
    const cx = Math.floor(fx / this.cell), cz = Math.floor(fz / this.cell);
    if (!this.placed) { this.ix = cx - n / 2; this.iz = cz - n / 2; this.placed = true; }
    else {
      const sx = cx - (this.ix + n / 2), sz = cz - (this.iz + n / 2);
      if (Math.abs(sx) > 12 || Math.abs(sz) > 12) {
        this.ix += sx; this.iz += sz;
        this.mShift.uniforms.shift.value.set(sx, sz);
        this.#pass(this.mShift);
        this.activeUntil = Math.max(this.activeUntil, this.t + 0.5);
      }
    }
    const ox = this.ix * this.cell, oz = this.iz * this.cell;
    WAVE.uWaveBox.value.set(ox, oz, this.size);
    // inject the queued drops (the window-relative position in metres)
    if (this.queue.length) {
      const U = this.mDrop.uniforms.uDrops.value;
      const take = this.queue.splice(0, DROPS);
      take.forEach(([x, z, r, s], i) => U[i].set(x - ox, z - oz, r, s));
      this.mDrop.uniforms.uCount.value = take.length;
      this.#pass(this.mDrop);
    }
    this.stats.active = this.t < this.activeUntil;
    if (this.stats.active) {
      this.acc += dt;
      let steps = 0;
      const fl = flow || { x: 0, z: 0 };
      this.mStep.uniforms.c2.value = this.c2; this.mStep.uniforms.damp.value = this.damp;
      this.mStep.uniforms.flow.value.set(fl.x * this.dtSim / 2 / this.cell, fl.z * this.dtSim / 2 / this.cell);
      while (this.acc >= this.dtSim && steps < 3) {
        this.acc -= this.dtSim; steps++;
        for (let k = 0; k < 2; k++) this.#pass(this.mStep);
        this.stats.steps++;
      }
      if (this.acc > this.dtSim * 3) this.acc = 0;
      this.#pass(this.mNormal);
    }
    WAVE.uWaveTex.value = this.a.texture;
    WAVE.uWaveOn.value = this.stats.active || this.t < this.activeUntil + 0.5 ? 1 : 0;
  }

  /** Is (x, z) inside the window? */
  covers(x, z) { return this.placed && x > this.ix * this.cell + 2 && x < (this.ix + this.n) * this.cell - 2 && z > this.iz * this.cell + 2 && z < (this.iz + this.n) * this.cell - 2; }
}
