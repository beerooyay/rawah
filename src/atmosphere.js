import * as THREE from 'three';

// Light and air shared by the terrain, water, trees and grass: fog that glows
// toward the sun (aerial perspective at golden hour), light bleeding through
// leaves and grass blades when they're backlit, the shadows of the clouds
// drifting across the ground, and the weather's mark on surfaces: ground
// darkened by rain, and fresh snow on whatever faces the sky above the snow line.

export const atmosphere = {
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
  uCloudAlt: { value: 4700 },
  // surfaces
  uWet: { value: 0 },
  uSnow: { value: 0 },
  uSnowLine: { value: 4500 },
  uGreen: { value: 0 },     // how much greener the meadows are than the late-September satellite image
  uValley: { value: 0.00005 }, // extra haze per metre in low air, thinning with height (heaviest at dawn)
  // sky view (skyview.js): how much skylight reaches each spot
  uSkyView: { value: null },
  uSkyExtent: { value: 1 },
};

// Cloud density from a tiling noise texture: four octaves for the sky, two for shadows.
export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D uCloudTex;
uniform vec2 uCloudOff;
uniform float uCloudCover, uCloudAlt;
float cloudFbm(vec2 p, int oct) {
  vec2 q = (p + uCloudOff) / 20000.0;
  float f = texture2D(uCloudTex, q).r * 0.56 + texture2D(uCloudTex, q * 2.73 + 0.31).r * 0.24;
  if (oct > 2) f += texture2D(uCloudTex, q * 7.1 + 0.57).r * 0.13 + texture2D(uCloudTex, q * 19.3 + 0.11).r * 0.07;
  else f += 0.1;
  return f;
}
float cloudDensity(vec2 p, int oct) {
  float th = mix(0.74, 0.2, uCloudCover);
  return smoothstep(th, th + 0.13, cloudFbm(p, oct));
}
`;

/** CPU twin of cloudDensity (two octaves), for the light reaching the hiker. */
export function cloudDensityAt(x, z) {
  const tex = atmosphere.uCloudTex.value;
  if (!tex) return 0;
  const { data, width: n } = tex.image;
  const at = (u, v) => {
    const fx = u * n - 0.5, fy = v * n - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const px = (i) => ((i % n) + n) % n;
    const s = (i, j) => data[(px(j) * n + px(i)) * 4] / 255;
    const a = s(x0, y0), b = s(x0 + 1, y0), c = s(x0, y0 + 1), d = s(x0 + 1, y0 + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const off = atmosphere.uCloudOff.value;
  const u = (x + off.x) / 20000, v = (z + off.y) / 20000;
  const f = at(u, v) * 0.56 + at(u * 2.73 + 0.31, v * 2.73 + 0.31) * 0.24 + 0.1;
  const th = 0.74 + (0.2 - 0.74) * atmosphere.uCloudCover.value;
  const t = Math.min(1, Math.max(0, (f - th) / 0.13));
  return t * t * (3 - 2 * t);
}

const _v = new THREE.Vector3();

export function updateAtmosphere(sky, camera) {
  atmosphere.uSunView.value.copy(_v.copy(sky.sunDir).transformDirection(camera.matrixWorldInverse));
  atmosphere.uSunWorld.value.copy(sky.sunDir);
  atmosphere.uViewInv.value.copy(camera.matrixWorld);
  const day = Math.max(0, Math.min(1, (sky.sunDir.y + 0.04) / 0.2));
  atmosphere.uSunFog.value.copy(sky.uniforms.uGlow.value).lerp(sky.uniforms.uHorizon.value, 0.35).multiplyScalar((0.55 + 0.45 * day) * (1 - 0.7 * sky.overcast));
  atmosphere.uSunCol.value.copy(sky.sun.color).multiplyScalar(day * 0.9 * (1 - 0.8 * sky.overcast) * (1 - 0.85 * sky.sunBlock));
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
      uniform sampler2D uSkyView;
      ${CLOUD_GLSL}`)
    .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      {
        vec3 wp = (uViewInv * vec4(vFogView, 1.0)).xyz;
        vec2 cp = wp.xz + uSunWorld.xz / max(uSunWorld.y, 0.15) * (uCloudAlt - wp.y);
        float shade = 1.0 - uCloudShade * cloudDensity(cp, 2);
        reflectedLight.directDiffuse *= shade;
        reflectedLight.directSpecular *= shade;
        float skyView = texture2D(uSkyView, wp.xz / uSkyExtent + 0.5).r;
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
        vec3 haze = mix(fogColor, uSunFog, pow(toSun, 7.0) * 0.75);
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
          float drift = texture2D(uCloudTex, wp.xz / 37.0).r * 0.6 + texture2D(uCloudTex, wp.xz / 4.1).r * 0.4;
          float line = smoothstep(uSnowLine - 90.0, uSnowLine + 60.0, wp.y + (drift - 0.5) * 120.0);
          float cover = clamp(uSnow * 1.6 - (1.0 - drift) * 0.7, 0.0, 1.0) * line * smoothstep(0.3, 0.75, wn.y);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.86, 0.92), cover * ${weather.toFixed(2)});
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
