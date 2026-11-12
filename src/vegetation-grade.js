// The same seasonal and moisture grade for the Alpine ground and plant materials.
export const VEGETATION_GLSL = /* glsl */ `
uniform vec4 uPlantSeason; // spring flush, autumn, cold, low sun

float turfPotential(vec4 cover) {
  return (1.0 - cover.a) * (1.0 - cover.r * 0.52) * (1.0 - cover.g * 0.32);
}

vec3 turfBase() {
  return mix(vec3(0.049, 0.122, 0.031), vec3(0.11, 0.127, 0.044), uPlantSeason.y * 0.43);
}

vec3 plantGrade(vec3 color, float moisture, float seasonal) {
  float damp = smoothstep(0.04, 0.38, moisture);
  vec3 shift = vec3(1.0) + uPlantSeason.x * vec3(0.12, 0.14, -0.07)
    + uPlantSeason.y * vec3(0.18, -0.08, -0.13);
  color *= mix(vec3(1.0), shift, seasonal);
  color *= mix(vec3(1.0), vec3(0.8, 0.98, 0.87), damp);
  color = mix(color, color * vec3(0.82, 0.94, 1.18), uPlantSeason.z * 0.46);
  return color * mix(vec3(1.0), vec3(1.05, 0.98, 0.87), uPlantSeason.w * 0.35);
}
`;
