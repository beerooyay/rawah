import * as THREE from 'three';

// Light and air shared by the terrain, water, trees and grass: fog that glows
// toward the sun (aerial perspective at golden hour), light bleeding through
// leaves and grass blades when they're backlit, the shadows of the clouds
// drifting across the ground, and the weather's mark on surfaces: ground
// darkened by rain, and fresh snow on whatever faces the sky above the snow line.

// Footprints and pressed grass: a ring of recent pressings (the hiker's walk, a lying body) shared by
// the grass and by the snow on the ground, so the snow is pushed aside where something has stood.
export const TRAMPLE = 40;            // pressed patches remembered at once
export const HOLD = 3, SPRING = 16;   // s a patch stays flat, and the time it's fully sprung back by

export const atmosphere = {
  uPlantSeason: { value: new THREE.Vector4() },
  uTime: { value: 0 },
  uTrA: { value: Array.from({ length: TRAMPLE }, () => new THREE.Vector4()) },   // x, z, direction x, z
  uTrB: { value: Array.from({ length: TRAMPLE }, () => new THREE.Vector4()) },   // length, radius, power, time pressed
  uSunView: { value: new THREE.Vector3(0, 1, 0) },  // sun direction in view space
  uSunFog: { value: new THREE.Color() },            // haze colour looking into the sun
  uSunCol: { value: new THREE.Color() },            // sunlight for translucency (0 at night)
  uSunWorld: { value: new THREE.Vector3(0, 1, 0) },
  uViewInv: { value: new THREE.Matrix4() },
  // clouds (weather.js drives these; the sky draws them, the ground gets their shadows)
  uCloudTex: { value: null },
  uCloudOff: { value: new THREE.Vector2() },
  uCloudCover: { value: 0 },
  uCloudShade: { value: 0 },
  uCloudAlt: { value: 4200 },
  // surfaces
  uWet: { value: 0 },
  uSnow: { value: 0 },
  uSnowLine: { value: 5000 },
  uPackLine: { value: 4600 },
  uGreen: { value: 0 },     // how much greener the meadows are than the late-September satellite image
  uValley: { value: 0.00005 }, // extra haze per metre in low air, thinning with height (heaviest at dawn)
  // sky view (skyview.js): how much skylight reaches each spot
  uSkyView: { value: null },
  uSkyExtent: { value: 1 },
  // terrainbake.js: where the mountains' own shadows fall (the sun's shadow map only reaches ~220 m)
  uTerrShadow: { value: null },
  uTSOn: { value: 0 },
};

// how much a point on the ground is pressed down right now (0 untouched, 1 flat)
const PRESS_GLSL = /* glsl */ `
uniform vec4 uTrA[${TRAMPLE}];
uniform vec4 uTrB[${TRAMPLE}];
uniform float uTime;
float pressAt(vec2 p) {
  float press = 0.0;
  for (int i = 0; i < ${TRAMPLE}; i++) {
    vec4 a = uTrA[i], b = uTrB[i];
    if (b.z <= 0.0) continue;
    vec2 rel = p - a.xy;
    vec2 off = rel - a.zw * clamp(dot(rel, a.zw), 0.0, b.x);
    float d = length(off);
    float k = b.z * (1.0 - smoothstep(b.y * 0.5, b.y, d)) * (1.0 - smoothstep(${HOLD.toFixed(1)}, ${SPRING.toFixed(1)}, uTime - b.w));
    press = max(press, k);
  }
  return press;
}
`;

// Twin Crater's three octave painted cloud field. CloudSim supplies local
// cover in the green channel; the same footprint shades ground and sky.
export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D uCloudTex;
uniform vec2 uCloudOff;
uniform float uCloudCover, uCloudAlt;
float cloudHash(ivec2 p) {
  uint n = uint(p.x) * 1597334677u ^ uint(p.y) * 3812015801u;
  n = (n ^ (n >> 16u)) * 2246822519u;
  return float(n >> 8u) / 16777216.0;
}
float cloudNoise(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + ivec2(1, 0)), f.x),
    mix(cloudHash(i + ivec2(0, 1)), cloudHash(i + ivec2(1, 1)), f.x), f.y);
}
float cloudDensity(vec2 p) {
  // the live field places the clouds; the weather's own cover is a floor, so a cloudy day is never an empty sky while the field catches up
  float cover = max(texture2D(uCloudTex, clamp(p / 64000.0 + 0.5, 0.002, 0.998)).g, uCloudCover * 0.85);
  vec2 q = (p - uCloudOff) * 0.0017;
  float f = cloudNoise(q) * 0.57 + cloudNoise(q * 2.03 + 17.3) * 0.28 + cloudNoise(q * 4.11 - 31.0) * 0.15;
  float th = mix(0.93, 0.08, cover);
  return smoothstep(th, th + 0.22, f);
}
`;

const mix = (a, b, t) => a + (b - a) * t;
const cubic = (t) => t * t * (3 - 2 * t);
function cloudHash(x, y) {
  const n = Math.imul(x, 1597334677) ^ Math.imul(y, 3812015801);
  return (Math.imul(n ^ (n >>> 16), 2246822519) >>> 8) / 16777216;
}
function cloudNoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), u = cubic(x - i), v = cubic(y - j);
  return mix(mix(cloudHash(i, j), cloudHash(i + 1, j), u),
    mix(cloudHash(i, j + 1), cloudHash(i + 1, j + 1), u), v);
}

/** CPU twin of cloudDensity for the light reaching the hiker. */
export function cloudDensityAt(x, z) {
  const tex = atmosphere.uCloudTex.value;
  if (!tex) return 0;
  const { data, width: n } = tex.image;
  const uv = (p) => Math.min(0.998, Math.max(0.002, p / 64000 + 0.5)) * n - 0.5;
  const fx = uv(x), fy = uv(z), i = Math.floor(fx), j = Math.floor(fy);
  const at = (u, v) => data[(((v + n) % n) * n + (u + n) % n) * 4 + 1] / 255;
  const cover = Math.max(mix(mix(at(i, j), at(i + 1, j), fx - i), mix(at(i, j + 1), at(i + 1, j + 1), fx - i), fy - j), atmosphere.uCloudCover.value * 0.85);   // same floor as the shader
  const off = atmosphere.uCloudOff.value, u = (x - off.x) * 0.0017, v = (z - off.y) * 0.0017;
  const f = cloudNoise(u, v) * 0.57 + cloudNoise(u * 2.03 + 17.3, v * 2.03 + 17.3) * 0.28 + cloudNoise(u * 4.11 - 31, v * 4.11 - 31) * 0.15;
  return cubic(Math.min(1, Math.max(0, (f - mix(0.93, 0.08, cover)) / 0.22)));
}

const _v = new THREE.Vector3();

export function updateAtmosphere(sky, camera) {
  atmosphere.uSunView.value.copy(_v.copy(sky.sunDir).transformDirection(camera.matrixWorldInverse));
  atmosphere.uSunWorld.value.copy(sky.sunDir);
  atmosphere.uViewInv.value.copy(camera.matrixWorld);
  const day = Math.max(0, Math.min(1, (sky.sunDir.y + 0.04) / 0.2));
  atmosphere.uSunFog.value.copy(sky.uniforms.uGlow.value).lerp(sky.uniforms.uHorizon.value, 0.35).multiplyScalar((0.3 + 0.2 * day) * (1 - 0.7 * sky.overcast));
  atmosphere.uSunCol.value.copy(sky.sun.color).multiplyScalar(day * 0.9 * (1 - 0.8 * sky.overcast) * (1 - 0.85 * sky.sunBlock) * (1 - sky.terrainBlock));
  atmosphere.uCloudShade.value = 0.38 * day;
}

export const SNOW_GLSL = /* glsl */ `
uniform float uSnow, uSnowLine, uPackLine;
float snowAt(float altitude) {
  float pack = smoothstep(uPackLine - 60.0, uPackLine + 60.0, altitude);
  float fresh = uSnow * smoothstep(uSnowLine - 60.0, uSnowLine + 60.0, altitude);
  return max(pack, fresh);
}
`;

/**
 * Inject the shared atmosphere into a material (call inside onBeforeCompile).
 * `translucency`: backlit glow; `weather`: how strongly rain and snow mark it (0 = not at all).
 */
export function withAtmosphere(shader, { translucency = 0, weather = 0, occlusion = 1, sharedNoise = false } = {}) {
  Object.assign(shader.uniforms, atmosphere);
  shader.vertexShader = shader.vertexShader
    .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying vec3 vFogView;')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\nvFogView = mvPosition.xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>
      varying vec3 vFogView;
      uniform vec3 uSunView, uSunFog, uSunCol, uSunWorld;
      uniform mat4 uViewInv;
      uniform float uCloudShade, uWet, uSkyExtent, uGreen, uValley;
      ${SNOW_GLSL}
      uniform sampler2D uTerrShadow;
      uniform float uTSOn;
      ${sharedNoise ? '#define uCloudTex uNoise\n' + CLOUD_GLSL.replace('uniform sampler2D uCloudTex;', '') : CLOUD_GLSL}
      ${PRESS_GLSL}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      {
        vec3 wp = (uViewInv * vec4(vFogView, 1.0)).xyz;
        vec2 cp = wp.xz + uSunWorld.xz / max(uSunWorld.y, 0.15) * (uCloudAlt - wp.y);
        float shade = 1.0 - uCloudShade * cloudDensity(cp);
        vec4 tf = texture2D(uTerrShadow, wp.xz / uSkyExtent + 0.5);   // R sun shadow, GBA static (terrainbake.js); A the sky view
        // the mountains' shadows on whatever is far enough that the sun's own shadow map no longer covers it
        float tsh = mix(1.0, tf.r, smoothstep(150.0, 420.0, length(vFogView)) * uTSOn);
        shade *= tsh;
        reflectedLight.directDiffuse *= shade;
        reflectedLight.directSpecular *= shade;
        float skyView = tf.a;
        reflectedLight.indirectDiffuse *= mix(1.0, 0.25 + 0.95 * skyView, ${occlusion.toFixed(2)});
      }`)
    .replace('#include <fog_fragment>', `
      #ifdef USE_FOG
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        // valley air: haze pools low and thins with height, so far ridges stack in layers
        {
          float reach = length(vFogView);
          float midY = 0.5 * ((uViewInv * vec4(vFogView, 1.0)).y + uViewInv[3].y);
          float pool = 1.0 - exp(-uValley * reach * exp(-max(0.0, midY - 2450.0) / 650.0));
          fogFactor = 1.0 - (1.0 - fogFactor) * (1.0 - pool);
        }
        float toSun = max(dot(normalize(vFogView), uSunView), 0.0);
        vec3 haze = mix(fogColor, uSunFog, pow(toSun, 24.0) * 0.35);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, fogFactor);
      #endif`);
  if (weather > 0) {
    // after the normal is known and before lighting: darken with rain, whiten with snow
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      {
        vec3 wp = (uViewInv * vec4(vFogView, 1.0)).xyz;
        vec3 wn = normalize((uViewInv * vec4(normal, 0.0)).xyz);
        diffuseColor.rgb *= 1.0 - uWet * ${(0.32 * weather).toFixed(3)} * smoothstep(-0.2, 0.6, wn.y);
        if (uSnow > 0.0 || wp.y > uPackLine - 120.0) {
          float drift = texture2D(uCloudTex, wp.xz / 340.0).r * 0.45 + texture2D(uCloudTex, wp.xz / 37.0).r * 0.35 + texture2D(uCloudTex, wp.xz / 4.1).r * 0.2;
          float depth = snowAt(wp.y + (drift - 0.5) * 120.0);
          float cover = clamp(depth * 1.6 - (1.0 - drift) * 0.7, 0.0, 1.0) * smoothstep(0.3, 0.75, wn.y);
          // thin packs patch, they don't tint: snow owns drifts and hollows, bare ribs show through
          cover = smoothstep(0.18, 0.8, cover);
          // where something has stood the snow is pushed off: the ground under it shows, pressed darker
          float tp = length(vFogView) < 110.0 ? pressAt(wp.xz) : 0.0;
          cover *= 1.0 - tp * 0.95;
          diffuseColor.rgb *= 1.0 - tp * 0.4;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.91, 0.96), cover * ${weather.toFixed(2)});
        }
      }`);
  }
  if (translucency > 0) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float backlit = pow(max(dot(normalize(vFogView), uSunView), 0.0), 5.0);
      outgoingLight += diffuseColor.rgb * uSunCol * backlit * ${translucency.toFixed(2)};
      #include <opaque_fragment>`);
  }
}
