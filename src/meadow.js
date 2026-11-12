// The open meadow ground of the high Rawah is not one carpet: short wiry turf in tufts with patches of bare pale sandy soil
// between them (decomposed granite, the same soil the trails are worn into). The patch mask is a pure function of the world
// position, so the terrain's fragment shader (sand colour) and the grass vertex shader (no tufts rooted in a patch) agree
// without sharing a texture. Needs nothing else in scope.
export const MEADOW_GLSL = /* glsl */ `
// an integer hash: a sine hash loses all its precision at world coordinates in the thousands (the noise went flat)
float mdHash(vec2 c) {
  ivec2 i = ivec2(c);
  uint h = uint(i.x) * 1597334673u ^ uint(i.y) * 3812015801u;
  h = (h ^ (h >> 15)) * 2246822519u;
  h = (h ^ (h >> 13)) * 3266489917u;
  h ^= h >> 16;
  return float(h) * (1.0 / 4294967295.0);
}
float mdNoise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mdHash(i), mdHash(i + vec2(1.0, 0.0)), f.x), mix(mdHash(i + vec2(0.0, 1.0)), mdHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// 0 turf .. 1 bare sand, patches of a few tens of centimetres to a metre with ragged edges, barer higher up and in some stretches more than others
float meadowBare(vec2 p, float alt) {
  float n = mdNoise(p * 1.25) * 0.4 + mdNoise(p * 3.7 + 7.3) * 0.33 + mdNoise(p * 9.3 + 3.1) * 0.27;
  float big = mdNoise(p / 41.0 + 11.0);
  float thr = mix(0.64, 0.55, smoothstep(2500.0, 3300.0, alt)) - (big - 0.5) * 0.2;
  return smoothstep(thr, thr + 0.06, n);
}
// how much of the ground is open meadow (not under forest, rock or a burn), from the cover map (live conifer, burned, aspen, rock)
float meadowOpen(vec4 cov) { return (1.0 - cov.r) * (1.0 - cov.a) * (1.0 - cov.g * 0.5); }
`;

/** After the near colour: the bare sandy patches, in the soil the trails use. Needs gx, gz (the ground's slope), p, camD, vWPos, uCover, uHasCover, uNoise, uExtent, uSnow, uSnowLine. */
export const MEADOW_COLOR = /* glsl */ `
        {
          float mdK = (1.0 - smoothstep(60.0, 240.0, camD)) * (1.0 - snowAt(vWPos.y));
          if (mdK > 0.0 && uHasCover > 0.5) {
            float open = meadowOpen(texture2D(uCover, p / uExtent + 0.5)) * smoothstep(0.62, 0.86, inversesqrt(gx * gx + gz * gz + 1.0));   // the lidar's own slope: wn has the pebble and photo normals in it by now
            float bare = meadowBare(p, vWPos.y) * open;
            float n1 = texture2D(uNoise, p * 6.0).r, n2 = texture2D(uNoise, p * 27.0).r, n3 = texture2D(uNoise, p * 13.0 + 0.4).r, n4 = texture2D(uNoise, p * 2.3 + 0.7).r;
            // between the patches the ground is turf: the photographed gravel and the satellite colour are laid over with dull olive and straw
            // and a little russet, keeping their light and dark so it stays mottled
            float turfW = open * (1.0 - smoothstep(0.0, 0.5, bare)) * mdK * smoothstep(2500.0, 2900.0, vWPos.y);
            if (turfW > 0.002) {
              float lumT = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
              vec3 tcol = mix(vec3(0.12, 0.18, 0.064), vec3(0.26, 0.229, 0.099), smoothstep(0.3, 0.65, n4));
              tcol = mix(tcol, vec3(0.28, 0.16, 0.08), smoothstep(0.7, 0.85, n1) * 0.6);
              diffuseColor.rgb = mix(diffuseColor.rgb, tcol * (0.55 + lumT * 1.5), turfW * 0.7);
            }
            if (bare > 0.002) {
              vec3 sand = vec3(0.42, 0.302, 0.168) * (0.74 + n1 * 0.4) * (0.8 + n2 * 0.4);
              sand = mix(sand, sand * 1.45 + 0.02, smoothstep(0.74, 0.84, n3) * 0.75);   // a pebble here and there
              sand = mix(sand, sand * 0.62, smoothstep(0.8, 0.9, texture2D(uNoise, p * 41.0).r) * 0.7);   // and dark grit
              float rim = smoothstep(0.0, 0.5, bare) * (1.0 - smoothstep(0.5, 1.0, bare));
              sand *= 1.0 - rim * 0.25;                                                   // the tufts shade the edge of the patch
              diffuseColor.rgb = mix(diffuseColor.rgb, sand, smoothstep(0.0, 0.6, bare) * mdK * 0.96);
            }
          }
        }`;
