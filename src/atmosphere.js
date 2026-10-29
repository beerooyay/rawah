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
  uSnowLine: { value: 4500 },
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

// Cloud density: where and how much comes from the live weather field (cloudsim.js, packed into the G and B
// channels of the noise texture over 64 km around the map), the shapes from the tiling noise in R: four octaves
// for the sky, two for shadows.
export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D uCloudTex;
uniform vec2 uCloudOff;
uniform float uCloudCover, uCloudAlt;
// the weather field at a point: cover (0 clear to 1 solid) and how tall the cloud there grows
vec2 cloudWx(vec2 p) { return texture2D(uCloudTex, clamp(p / 64000.0 + 0.5, 0.002, 0.998)).gb; }
// each octave is turned by a different angle, and the whole field is domain-warped, so
// no two octaves line up and the noise tile never shows as a grid
vec2 cloudRot1(vec2 q) { return mat2(0.8, 0.6, -0.6, 0.8) * q; }
vec2 cloudRot2(vec2 q) { return mat2(0.6, -0.8, 0.8, 0.6) * q; }
vec2 cloudRot3(vec2 q) { return mat2(-0.68, 0.73, -0.73, -0.68) * q; }
vec2 cloudWarp(vec2 q) {
  vec2 w = vec2(texture2D(uCloudTex, q * 0.61 + vec2(0.23, 0.41)).r, texture2D(uCloudTex, q * 0.61 + vec2(0.71, 0.13)).r) - 0.5;
  return q + w * 0.2;
}
float cloudFbm(vec2 p, int oct, float cover) {
  vec2 q = cloudWarp((p + uCloudOff) / 20000.0);
  q.y *= 1.05;    // a slight pull along the drift, so banks have a grain
  float f = texture2D(uCloudTex, q).r * 0.56 + texture2D(uCloudTex, cloudRot1(q) * 2.73 + 0.31).r * 0.24;
  if (oct > 2) f += texture2D(uCloudTex, cloudRot2(q) * 7.1 + 0.57).r * 0.12 + texture2D(uCloudTex, cloudRot3(q) * 11.3 + 0.11).r * 0.06;
  else f += 0.1;
  // clouds gather into banks: a low field decides where they mass, so the same cover
  // reads as clumps with blue between, not an even spread. relaxes toward real overcast.
  // the field drifts slower than the layer, so banks gather and dissolve as clouds pass — shapes live, not just slide
  float bank = texture2D(uCloudTex, cloudRot3((p + uCloudOff * 0.37) / 5200.0)).r;
  f *= mix(1.0, 0.5 + bank, 0.55 * (1.0 - cover * 0.6));
  return f;
}
float cloudDensity(vec2 p, int oct) {
  float cover = cloudWx(p).x;
  float th = mix(0.74, 0.2, cover);
  return smoothstep(th, th + 0.13, cloudFbm(p, oct, cover));
}
`;

/** CPU twin of cloudDensity (two octaves), for the light reaching the hiker. */
export function cloudDensityAt(x, z) {
  const tex = atmosphere.uCloudTex.value;
  if (!tex) return 0;
  const { data, width: n } = tex.image;
  const at = (u, v, ch = 0) => {
    const fx = u * n - 0.5, fy = v * n - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const px = (i) => ((i % n) + n) % n;
    const s = (i, j) => data[(px(j) * n + px(i)) * 4 + ch] / 255;
    const a = s(x0, y0), b = s(x0 + 1, y0), c = s(x0, y0 + 1), d = s(x0 + 1, y0 + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const off = atmosphere.uCloudOff.value;
  // the same warp and octave turns as CLOUD_GLSL
  const ux = (x + off.x) / 20000, uy = (z + off.y) / 20000;
  const wx = at(ux * 0.61 + 0.23, uy * 0.61 + 0.41) - 0.5, wy = at(ux * 0.61 + 0.71, uy * 0.61 + 0.13) - 0.5;
  const u = ux + wx * 0.2, v = (uy + wy * 0.2) * 1.05;
  const bx = (x + off.x * 0.37) / 5200, by = (z + off.y * 0.37) / 5200;
  const bank = at(-0.68 * bx - 0.73 * by, 0.73 * bx - 0.68 * by);
  const cover = at(Math.min(0.998, Math.max(0.002, x / 64000 + 0.5)), Math.min(0.998, Math.max(0.002, z / 64000 + 0.5)), 1);   // cloudWx
  const f = (at(u, v) * 0.56 + at((0.8 * u - 0.6 * v) * 2.73 + 0.31, (0.6 * u + 0.8 * v) * 2.73 + 0.31) * 0.24 + 0.1)
    * (1 + (0.5 + bank - 1) * 0.55 * (1 - cover * 0.6));
  const th = 0.74 + (0.2 - 0.74) * cover;
  const t = Math.min(1, Math.max(0, (f - th) / 0.13));
  return t * t * (3 - 2 * t);
}

const _v = new THREE.Vector3();

export function updateAtmosphere(sky, camera) {
  atmosphere.uSunView.value.copy(_v.copy(sky.sunDir).transformDirection(camera.matrixWorldInverse));
  atmosphere.uSunWorld.value.copy(sky.sunDir);
  atmosphere.uViewInv.value.copy(camera.matrixWorld);
  const day = Math.max(0, Math.min(1, (sky.sunDir.y + 0.04) / 0.2));
  atmosphere.uSunFog.value.copy(sky.uniforms.uGlow.value).lerp(sky.uniforms.uHorizon.value, 0.35).multiplyScalar((0.3 + 0.2 * day) * (1 - 0.7 * sky.overcast));
  atmosphere.uSunCol.value.copy(sky.sun.color).multiplyScalar(day * 0.9 * (1 - 0.8 * sky.overcast) * (1 - 0.85 * sky.sunBlock) * (1 - sky.terrainBlock));
  atmosphere.uCloudShade.value = 0.85 * day;
}

/**
 * Inject the shared atmosphere into a material (call inside onBeforeCompile).
 * `translucency`: backlit glow; `weather`: how strongly rain and snow mark it (0 = not at all).
 */
export function withAtmosphere(shader, { translucency = 0, weather = 0, occlusion = 1 } = {}) {
  Object.assign(shader.uniforms, atmosphere);
  shader.vertexShader = shader.vertexShader
    .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying vec3 vFogView;')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\nvFogView = mvPosition.xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', `#include <fog_pars_fragment>
      varying vec3 vFogView;
      uniform vec3 uSunView, uSunFog, uSunCol, uSunWorld;
      uniform mat4 uViewInv;
      uniform float uCloudShade, uWet, uSnow, uSnowLine, uSkyExtent, uGreen, uValley;
      uniform sampler2D uTerrShadow;
      uniform float uTSOn;
      ${CLOUD_GLSL}
      ${PRESS_GLSL}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      {
        vec3 wp = (uViewInv * vec4(vFogView, 1.0)).xyz;
        vec2 cp = wp.xz + uSunWorld.xz / max(uSunWorld.y, 0.15) * (uCloudAlt - wp.y);
        float shade = 1.0 - uCloudShade * cloudDensity(cp, 2);
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
        if (uSnow > 0.0) {
          float drift = texture2D(uCloudTex, wp.xz / 340.0).r * 0.45 + texture2D(uCloudTex, wp.xz / 37.0).r * 0.35 + texture2D(uCloudTex, wp.xz / 4.1).r * 0.2;
          float line = smoothstep(uSnowLine - 90.0, uSnowLine + 60.0, wp.y + (drift - 0.5) * 120.0);
          float cover = clamp(uSnow * 1.6 - (1.0 - drift) * 0.7, 0.0, 1.0) * line * smoothstep(0.3, 0.75, wn.y);
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
