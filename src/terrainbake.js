import * as THREE from 'three';

// Far-mountain detail that costs next to nothing per frame, both made on the GPU from the lidar height texture
// (the same one the terrain draws from):
//
//  TerrainShadow  where the mountains' own shadows fall. The sun's shadow map only reaches about 220 m, so far ridges
//                 never shadowed the valleys below them and the ranges lit flat. This keeps a 1024^2 picture of the whole
//                 map (14.5 m texels) of how much sun reaches each spot: every texel marches toward the sun over the
//                 heightfield with a penumbra that widens with distance. The picture is redone in eight horizontal bands,
//                 one band a frame, whenever the sun has moved a third of a degree, so the whole cost is under a
//                 millisecond a frame. Everything lit through `withAtmosphere` reads it past ~150 m (one tap), so
//                 terrain, trees and grass in a mountain's shadow darken together.
//  bakeStatic     made once at load: G how much sky each spot sees at the scale of the ridges and gullies (8 horizons out to
//                 200 m), B convexity (bright spines, dark cuts), A the old sky-openness map (skyview.js) resampled. The terrain
//                 multiplies G and B into the albedo from the middle distance outward, which is what gives a far range its relief.
//  All four live in ONE texture (`uTerrShadow`: R the live sun shadow, GBA the static ones): a terrain shader already
//                 uses 16 texture units, the most a GPU gives a fragment shader.

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const HEIGHT = `
uniform highp usampler2D uHeight;
uniform float uN, uCell, uHScale, uHOffset, uExtent;
float gH(ivec2 p) { p = clamp(p, ivec2(0), ivec2(int(uN) - 1)); return float(texelFetch(uHeight, p, 0).r) * uHScale + uHOffset; }
float nearestH(vec2 xz) { return gH(ivec2(floor(xz / uCell + uN * 0.5 + 0.5))); }
float H(vec2 xz) {
  vec2 u = xz / uCell + uN * 0.5, f = fract(u);
  ivec2 i = ivec2(floor(u));
  return mix(mix(gH(i), gH(i + ivec2(1, 0)), f.x), mix(gH(i + ivec2(0, 1)), gH(i + ivec2(1, 1)), f.x), f.y);
}`;

const OUT = `layout(location = 0) out highp vec4 outColor;`;

const SHADOW_FRAG = `
${OUT}
varying vec2 vUv;
uniform vec3 uSun;
uniform sampler2D uStatic;
${HEIGHT}
void main() {
  vec2 xz = (vUv - 0.5) * uExtent;
  float h0 = H(xz) + 3.0;
  vec2 d = normalize(uSun.xz + 1e-5);
  float tanE = uSun.y / max(length(uSun.xz), 1e-4);
  float sh = 1.0, t = 10.0;
  for (int i = 0; i < 64; i++) {
    float ray = h0 + t * tanE;
    if (ray > 4300.0) break;                                      // above every summit: nothing left to cast a shadow
    float hq = nearestH(xz + d * t);
    float w = 5.0 + t * 0.035;                                    // the penumbra widens with distance
    sh = min(sh, smoothstep(-w, w, ray - hq));
    t = t * 1.075 + 6.0;
  }
  vec3 st = texture2D(uStatic, vUv).gba;
  outColor = vec4(sh, st.x, st.y, texture2D(uStatic, vUv).a);
}`;

const CAVITY_FRAG = `
${OUT}
varying vec2 vUv;
uniform sampler2D uSkyView;
${HEIGHT}
const float R[7] = float[7](6.0, 12.0, 22.0, 40.0, 70.0, 120.0, 200.0);
void main() {
  vec2 xz = (vUv - 0.5) * uExtent;
  float g = H(xz), h0 = g + 1.0;
  float open = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982;
    vec2 d = vec2(cos(a), sin(a));
    float tn = 0.0;
    for (int s = 0; s < 7; s++) tn = max(tn, (nearestH(xz + d * R[s]) - h0) / R[s]);
    open += 1.0 - tn / sqrt(1.0 + tn * tn);
  }
  open /= 8.0;
  // convexity at two scales: positive on spines and ridges, negative in gullies and cuts
  float r1 = 14.0, r2 = 45.0;
  float c1 = (4.0 * g - H(xz + vec2(r1, 0.0)) - H(xz - vec2(r1, 0.0)) - H(xz + vec2(0.0, r1)) - H(xz - vec2(0.0, r1))) / r1;
  float c2 = (4.0 * g - H(xz + vec2(r2, 0.0)) - H(xz - vec2(r2, 0.0)) - H(xz + vec2(0.0, r2)) - H(xz - vec2(0.0, r2))) / r2;
  float cv = clamp((c1 * 0.5 + c2 * 0.5) * 0.14, -1.0, 1.0);
  outColor = vec4(0.0, open, cv * 0.5 + 0.5, texture2D(uSkyView, vUv).r);
}`;

function pass(renderer, hu, extent, size, frag, extra = {}) {
  const uniforms = { uHeight: hu.uHeight, uN: hu.uN, uCell: hu.uCell, uHScale: hu.uHScale, uHOffset: hu.uHOffset, uExtent: { value: extent }, ...extra };
  const mat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader: VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
  const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  const rt = new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  rt.texture.generateMipmaps = false;
  return { mat, scene, cam, rt, uniforms };
}

export class TerrainShadow {
  constructor(renderer, heightUniforms, extent, staticTexture, size = 1536) {
    this.renderer = renderer;
    this.size = size;
    this.p = pass(renderer, heightUniforms, extent, size, SHADOW_FRAG, { uSun: { value: new THREE.Vector3(0, 1, 0) }, uStatic: { value: staticTexture } });
    this.texture = this.p.rt.texture;
    this.cur = new THREE.Vector3(0, 1, 0);   // the sun this cycle is drawing
    this.done = new THREE.Vector3(0, -1, 0); // the sun of the last finished cycle
    this.band = 8;                           // 8 = idle
    this.ms = 0;
    this.started = false;
  }

  #band(i) {
    const { renderer, p, size } = this, rows = size / 8;
    const prev = renderer.getRenderTarget(), auto = renderer.autoClear, st = p.rt.scissorTest;
    renderer.autoClear = false;
    p.rt.scissorTest = true;
    p.rt.scissor.set(0, i * rows, size, rows);
    p.rt.viewport.set(0, 0, size, size);
    renderer.setRenderTarget(p.rt);
    renderer.render(p.scene, p.cam);
    renderer.setRenderTarget(prev);
    p.rt.scissorTest = st;
    renderer.autoClear = auto;
  }

  /** `dir`: unit vector toward the light that is casting (the sun, or the moon at night). Call once a frame. */
  update(dir) {
    if (this.band >= 8 && (!this.started || dir.dot(this.done) < 0.99998)) {   // 0.35 degrees
      this.cur.copy(dir);
      this.p.uniforms.uSun.value.copy(dir);
      this.band = 0;
      if (!this.started) {                       // first picture: all of it now, behind the loading screen
        const t0 = performance.now();
        for (let i = 0; i < 8; i++) this.#band(i);
        this.ms = performance.now() - t0;
        this.band = 8; this.done.copy(dir); this.started = true;
        return;
      }
    }
    if (this.band < 8) {
      this.#band(this.band++);
      if (this.band >= 8) this.done.copy(this.cur);
    }
  }
}

/** One-time pass: sky openness and convexity at the scale of ridges and gullies, plus the old sky-view map. Returns the texture (G open, B convexity, A sky view). */
export function bakeStatic(renderer, heightUniforms, extent, skyView, size = 1536) {
  const t0 = performance.now();
  const p = pass(renderer, heightUniforms, extent, size, CAVITY_FRAG, { uSkyView: { value: skyView } });
  const prev = renderer.getRenderTarget(), auto = renderer.autoClear;
  renderer.autoClear = false;
  renderer.setRenderTarget(p.rt);
  p.rt.viewport.set(0, 0, size, size);
  p.rt.scissorTest = true;
  const bands = 16, rows = size / bands;
  for (let i = 0; i < bands; i++) {           // thin bands: no single draw runs long enough to trip a GPU watchdog
    p.rt.scissor.set(0, i * rows, size, rows);
    renderer.render(p.scene, p.cam);
    renderer.getContext().flush();
  }
  p.rt.scissorTest = false;
  renderer.autoClear = auto;
  renderer.setRenderTarget(prev);
  p.mat.dispose();
  p.rt.texture.userData.ms = performance.now() - t0;
  return p.rt.texture;
}
