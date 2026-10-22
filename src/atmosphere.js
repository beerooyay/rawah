import * as THREE from 'three';

// Two cheap touches of light, shared by the terrain, water, trees and grass:
// fog that glows toward the sun (aerial perspective at golden hour), and
// light bleeding through leaves and grass blades when they're backlit.

export const atmosphere = {
  uSunView: { value: new THREE.Vector3(0, 1, 0) },  // sun direction in view space
  uSunFog: { value: new THREE.Color() },            // haze colour looking into the sun
  uSunCol: { value: new THREE.Color() },            // sunlight for translucency (0 at night)
};

const _v = new THREE.Vector3();

export function updateAtmosphere(sky, camera) {
  atmosphere.uSunView.value.copy(_v.copy(sky.sunDir).transformDirection(camera.matrixWorldInverse));
  const day = Math.max(0, Math.min(1, (sky.sunDir.y + 0.04) / 0.2));
  atmosphere.uSunFog.value.copy(sky.uniforms.uGlow.value).lerp(sky.uniforms.uHorizon.value, 0.35).multiplyScalar(0.55 + 0.45 * day);
  atmosphere.uSunCol.value.copy(sky.sun.color).multiplyScalar(day * 0.9);
}

/** Inject sunward haze into a material's fog (call inside onBeforeCompile). */
export function withAtmosphere(shader, { translucency = 0 } = {}) {
  Object.assign(shader.uniforms, atmosphere);
  shader.vertexShader = shader.vertexShader
    .replace('#include <fog_pars_vertex>', '#include <fog_pars_vertex>\nvarying vec3 vFogView;')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\nvFogView = mvPosition.xyz;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <fog_pars_fragment>', '#include <fog_pars_fragment>\nvarying vec3 vFogView;\nuniform vec3 uSunView, uSunFog, uSunCol;')
    .replace('#include <fog_fragment>', `
      #ifdef USE_FOG
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        float toSun = max(dot(normalize(vFogView), uSunView), 0.0);
        vec3 haze = mix(fogColor, uSunFog, pow(toSun, 7.0) * 0.75);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, fogFactor);
      #endif`);
  if (translucency > 0) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float backlit = pow(max(dot(normalize(vFogView), uSunView), 0.0), 5.0);
      outgoingLight += diffuseColor.rgb * uSunCol * backlit * ${translucency.toFixed(2)};
      #include <opaque_fragment>`);
  }
}
