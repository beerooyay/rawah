import * as THREE from 'three';
import { Boxels } from './boxels.js';
import { atmosphere, CLOUD_GLSL } from './atmosphere.js';

// God rays that come from the world's own state.
//
// A shaft of sunlight is visible only where there is something in the air to
// scatter it, so the rays here are a volume, not a smear painted on the screen:
// a stack of camera-facing slices (back to front, depth-tested against the
// scene so a trunk or a ridge hides the air behind it) in which every fragment
// asks two questions about the air at its own point in space:
//   * is the sun reaching it? the sun's shadow map says so near you (leaves,
//     trunks, ridges, the lot, with the leafy alpha-tested casters), and the
//     cloud deck's shadow says so far away (so broken cloud throws crepuscular
//     rays across the valley);
//   * how much is there to scatter it? That is the boxel field: a `Mist` field
//     the same certified-window machinery as the ground and water memory,
//     fed by what the world is doing (ground the rain has soaked steams when
//     the sun comes onto it, lakes smoke at dawn, a campfire's plume, spray),
//     plus a thin base haze that thickens with rain and thins with height.
// The in-scatter is Henyey-Greenstein, so the shafts are brightest looking
// toward the sun, in the sun's own colour (gold at low sun).
// Nothing here moves the framebuffer into a post chain: the scene still tone
// maps in its own shaders, so the shaft light is added with a gain that stands
// in for that curve.

export const SHAFT = {
  uMist: { value: null }, uMistExt: { value: 4096 },
  uSmoke: { value: null }, uSmokeBox: { value: new THREE.Vector3(0, 0, 96) },
  uShadow: { value: null }, uShadowMat: { value: new THREE.Matrix4() },
  uGround: { value: 3000 }, uGain: { value: 1 }, uFog: { value: 0 }, uHaze: { value: 1.1e-3 }, uMistK: { value: 0.02 }, uRainK: { value: 0 },
  uSlices: { value: 24 }, uNear: { value: 2.5 }, uFar: { value: 900 }, uShT: { value: 0 },
};

const VERT = /* glsl */ `
uniform float uSlices, uNear, uFar;
varying vec3 vW;
varying float vD, vDz;
void main() {
  float i = float(gl_InstanceID);
  float q = pow(uFar / uNear, 1.0 / max(uSlices - 1.0, 1.0));
  float d = uFar / pow(q, i);                     // slice 0 is the farthest: the stack is drawn back to front
  float dz = d * (1.0 - 1.0 / q);                 // the slab between this slice and the next one in
  vec3 v = vec3(position.x / projectionMatrix[0][0] * d, position.y / projectionMatrix[1][1] * d, -d);
  vW = (inverse(viewMatrix) * vec4(v, 1.0)).xyz;
  vD = d; vDz = dz;
  gl_Position = projectionMatrix * vec4(v, 1.0);
}`;

const FRAG = /* glsl */ `
#include <packing>
uniform sampler2D uMist, uSmoke, uShadow;
uniform mat4 uShadowMat;
uniform vec3 uSmokeBox, uSunCol, uSunWorld;
uniform float uMistExt, uGround, uGain, uHaze, uMistK, uRainK, uShT, uCloudShade, uFog;
varying vec3 vW;
varying float vD, vDz;
${CLOUD_GLSL}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
float shadowTap(vec2 uv, float z) { return step(z, unpackRGBAToDepth(texture2D(uShadow, uv))); }
void main() {
  vec3 V = vW - cameraPosition;
  float dist = length(V);
  vec3 rd = V / dist;
  float delta = vDz * dist / vD;                                   // the slab's length along this ray
  // a different point in the slab for each pixel and frame, so the slices never show as layers
  float jit = hash(gl_FragCoord.xy + uShT) - 0.5;
  vec3 P = vW + rd * (jit * delta);
  float h = max(P.y - uGround, 0.0);
  // the air: a thin haze, the mist the boxels hold, smoke from the fire, and the rain itself
  float dens = uHaze * exp(-h / 260.0) + uRainK * 0.003 + uFog * 0.011 * exp(-h / 55.0);   // a thin haze, the rain, and the morning's ground fog
  float mist = texture2D(uMist, P.xz / uMistExt + 0.5).r;
  dens += mist * uMistK * exp(-h / 22.0);
  vec2 sp = (P.xz - uSmokeBox.xy) / uSmokeBox.z + 0.5;
  if (sp.x > 0.0 && sp.y > 0.0 && sp.x < 1.0 && sp.y < 1.0) dens += texture2D(uSmoke, sp).r * 0.02 * exp(-max(h - 4.0, 0.0) / 14.0);
  // is the sun reaching this point?
  float lit = 1.0;
  vec4 sc = uShadowMat * vec4(P, 1.0);
  if (sc.x > 0.0 && sc.x < 1.0 && sc.y > 0.0 && sc.y < 1.0 && sc.z < 1.0) {
    float z = sc.z - 0.0012, e = 1.0 / 2048.0;
    float v = shadowTap(sc.xy + vec2(-e, -e), z) + shadowTap(sc.xy + vec2(e, -e), z) + shadowTap(sc.xy + vec2(-e, e), z) + shadowTap(sc.xy + vec2(e, e), z);
    vec2 ed = min(sc.xy, 1.0 - sc.xy);
    lit = mix(1.0, v * 0.25, smoothstep(0.0, 0.12, min(ed.x, ed.y)));    // past the edge of the shadow map the air is simply lit
  }
  vec2 cp = P.xz + uSunWorld.xz / max(uSunWorld.y, 0.15) * (uCloudAlt - P.y);
  lit *= 1.0 - uCloudShade * cloudDensity(cp, 2);                       // and the cloud deck's shadow
  float cs = dot(rd, uSunWorld);
  float phase = hg(cs, 0.68) * 0.75 + hg(cs, 0.93) * 0.25;                 // a broad forward lobe and a tight glow around the sun itself
  vec3 S = uSunCol * (lit * phase * dens * delta * 6.0 * uGain);
  float fade = 1.0 - smoothstep(0.6, 1.0, vD / 900.0);              // the far slices thin out
  float a = (1.0 - exp(-dens * delta * 0.7)) * 0.5;
  gl_FragColor = vec4(S * fade, a * fade);
}`;

export class Shafts {
  constructor(scene, world, { slices = 24 } = {}) {
    this.world = world;
    SHAFT.uSlices.value = slices;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { ...SHAFT, uSunCol: atmosphere.uSunCol, uSunWorld: atmosphere.uSunWorld, uCloudTex: atmosphere.uCloudTex, uCloudOff: atmosphere.uCloudOff, uCloudCover: atmosphere.uCloudCover, uCloudAlt: atmosphere.uCloudAlt, uCloudShade: atmosphere.uCloudShade },
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      fog: false,
    });
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    g.instanceCount = slices;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 8;
    scene.add(this.mesh);
    // a 96 m square of smoke from the plume field, uploaded as a float texture
    this.smokeTex = new THREE.DataTexture(new Float32Array(96 * 96), 96, 96, THREE.RedFormat, THREE.FloatType);
    this.smokeTex.magFilter = this.smokeTex.minFilter = THREE.LinearFilter;
    SHAFT.uSmoke.value = this.smokeTex;
    this.dummy = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType); this.dummy.needsUpdate = true;
    SHAFT.uShadow.value = this.dummy;
    this.on = true; this.groundY = null;
  }

  /** ctx: { camera, sky, weather, plume, mist, ground (the player's ground y), t, sun (the DirectionalLight), shadows (bool) } */
  update(ctx) {
    const { camera, sky, weather, plume, mist, t } = ctx;
    const sunUp = Math.max(0, sky.sunDir.y), day = Math.min(1, Math.max(0, (sunUp - 0.005) / 0.045));
    // shafts need a sun, and they want the shadows (without them the air is evenly lit and shows nothing)
    const power = (ctx.shadows ? 1 : 0.0) * day;
    this.mesh.visible = this.on && power > 0.02;
    if (!this.mesh.visible) return;
    this.groundY = this.groundY === null ? ctx.ground : this.groundY + (ctx.ground - this.groundY) * 0.05;
    SHAFT.uGround.value = this.groundY;
    SHAFT.uShT.value = (t * 61.7) % 97;
    SHAFT.uMist.value = mist.b.texture; SHAFT.uMistExt.value = this.world.extent;
    // low sun, long and gold; under a thick deck there is less direct sun to make a shaft with
    const low = 1 - Math.min(1, sunUp / 0.5);
    SHAFT.uGain.value = power * (1.1 + 1.6 * low) * (1 - 0.7 * sky.overcast);
    SHAFT.uRainK.value = weather.precip * (1 - weather.snowK);
    // ground fog: what the weather puts down, and the cool of the early morning on damp country
    const hr = ctx.hour, dawn = Math.min(1, Math.max(0, (9.5 - hr) / 4)) * Math.min(1, Math.max(0, (hr - 4.5) / 1.5));
    SHAFT.uFog.value = Math.min(1, weather.fog * 0.8 + dawn * 0.85 * (0.55 + 0.45 * Math.min(1, ctx.dampness || 0)));
    const map = ctx.sun.shadow.map;
    if (map) { SHAFT.uShadow.value = map.texture; SHAFT.uShadowMat.value = ctx.sun.shadow.matrix; }
    // the plume's smoke
    if (plume.active) {
      this.smokeTex.image.data.set(plume.smoke.u); this.smokeTex.needsUpdate = true;
      SHAFT.uSmokeBox.value.set(plume.ox, plume.oz, plume.smoke.n * plume.smoke.cell);
    } else SHAFT.uSmokeBox.value.z = 1e-3;
  }
}

/** The air the boxels hold: mist and the like, over the whole valley. */
export class Mist {
  constructor(world) {
    this.world = world;
    // cells are about 29 m; the decay length 1/acosh(1 + k/2d) is about 7 cells, long enough for the continuum windows to hold
    this.b = new Boxels(world, { n: 512, d: 0.5, k: 0.012, kWear: 0.5, eps: 0.01 });
    const tx = this.b.texture;
    tx.magFilter = THREE.LinearFilter; tx.minFilter = THREE.LinearFilter; tx.generateMipmaps = false;
    tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
    this.tick = 0;
  }

  /**
   * ctx: { p (you), moisture(x, z) 0..1 (the ground boxels), sunUp (sun elevation, sine), hour, lakeAt(x, z), fire: {x, z} | null, wind: [x, z], precip }
   * What rises: ground that is wet steams when the sun comes onto it (most in the cool of the morning), lakes smoke
   * at dawn, a fire sends up smoke downwind, heavy rain leaves a low haze over everything it touches.
   */
  update(dt, ctx) {
    const { p } = ctx;
    this.tick -= dt;
    if (this.tick <= 0) {
      this.tick = 0.4;
      const warm = Math.min(1, Math.max(0, ctx.sunUp * 3.5)), morning = Math.min(1, Math.max(0, (11.5 - ctx.hour) / 5)) * Math.min(1, Math.max(0, (ctx.hour - 4.5) / 2));
      for (let k = 0; k < 14; k++) {
        const x = p.x + (Math.random() - 0.5) * 1400, z = p.z + (Math.random() - 0.5) * 1400;
        const m = ctx.moisture(x, z);
        if (warm > 0.02 && m > 0.1) this.b.wet(x, z, 0.5 * m * warm * (0.35 + 0.65 * morning), 0);          // wet ground steams in the sun
        if (morning > 0.05 && ctx.lakeAt(x, z)) this.b.wet(x, z, 0.35 * morning, 0);                          // cold water under warmer air smokes at dawn
      }
      if (ctx.precip > 0.4) { const x = p.x + (Math.random() - 0.5) * 900, z = p.z + (Math.random() - 0.5) * 900; this.b.wet(x, z, 0.15 * ctx.precip, 0); }   // rain leaves a haze
    }
    this.b.update(dt, 1);
  }
}
