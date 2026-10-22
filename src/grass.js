import * as THREE from 'three';
import { NOISE_GLSL } from './detail.js';
import { WIND_GLSL } from './wind.js';
import { HEIGHT_GLSL } from './cdlod.js';
import { withAtmosphere } from './atmosphere.js';

// Grass with no CPU-side data at all. One blade mesh is instanced W x W times;
// each blade derives its own spot from gl_InstanceID on a grid that follows
// the camera (snapped, so blades never swim), stands on the lidar + relief,
// grows only where the satellite land cover says meadow or tundra, takes its
// colour from the satellite pixel it stands in, bends in the shared wind,
// parts around the hiker's legs, and carries frost at dawn. Each instance is
// a tuft of three blades of different heights and leans, some still green and
// most cured gold, as a Rawah meadow is at the end of September.

const TUFT = 3;

function bladeGeometry() {
  // per blade: three segments tapering to a point; x = side, y = 0..1 up the blade, z = blade index
  const pos = [], idx = [];
  const rows = [0, 0.38, 0.72];
  for (let b = 0; b < TUFT; b++) {
    const o = pos.length / 3;
    rows.forEach((y) => { const w = 1 - y * 0.85; pos.push(-0.5 * w, y, b, 0.5 * w, y, b); });
    pos.push(0, 1, b);
    for (let r = 0; r < rows.length - 1; r++) { const a = o + r * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    idx.push(o + 4, o + 5, o + 6);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

export class Grass {
  constructor(terrain, { radius = 26, spacing = 0.2 } = {}, uniforms) {
    this.spacing = spacing;
    this.W = Math.round((radius * 2) / spacing);
    this.uniforms = {
      ...terrain.uniforms,
      uCenter: { value: new THREE.Vector2() }, uPlayer: { value: new THREE.Vector3() },
      uSpacing: { value: spacing }, uW: { value: this.W }, uRadius: { value: radius },
      uFrost: { value: 0 }, uTime: uniforms.uTime, uCalm: uniforms.uCalm,
    };
    const geo = bladeGeometry();
    geo.instanceCount = this.W * this.W;
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.uniforms.uColorMap = { value: terrain.colorMap };
      shader.uniforms.uCover = { value: terrain.coverMap };
      shader.uniforms.uExtent = { value: terrain.extent };
      withAtmosphere(shader, { translucency: 0.7, weather: 0.8 });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uColorMap, uCover;
          uniform float uExtent, uSpacing, uW, uRadius, uFrost;
          uniform vec2 uCenter;
          uniform vec3 uPlayer;
          varying vec3 vGrass;
          ${HEIGHT_GLSL}
          ${WIND_GLSL}`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', `
          int W = int(uW);
          ivec2 cell = ivec2(floor(uCenter / uSpacing)) - W / 2 + ivec2(gl_InstanceID % W, gl_InstanceID / W);
          float h1 = ihash(cell), h2 = ihash(cell + ivec2(7919, 104729)), h3 = ihash(cell * 3 + ivec2(17, 3));
          vec2 root = (vec2(cell) + vec2(h1, h2)) * uSpacing;
          float r = distance(root, uCenter);
          vec4 cov = texture2D(uCover, root / uExtent + 0.5);   // live, burned, aspen, rock
          float mask = maskAt(root);
          float grow = (1.0 - cov.a) * (1.0 - mask) * (1.0 - cov.r * 0.8) * (1.0 - cov.g * 0.25);
          float y0 = baseH(root);
          grow *= smoothstep(3960.0, 3700.0, y0);
          float alpine = smoothstep(3330.0, 3560.0, y0);
          float fade = 1.0 - smoothstep(uRadius * 0.65, uRadius, r);
          float tall = mix(0.6, 0.2, alpine) * (0.55 + h3 * 0.9) * fade * step(h1 * 0.85 + h2 * 0.15, grow);
          float t = position.y;
          // this blade of the tuft: its own spot, height, facing and lean
          float bi = position.z;
          ivec2 bc = cell * 3 + ivec2(int(bi) * 7 + 1, int(bi) * 13 + 2);
          float b1 = ihash(bc), b2 = ihash(bc + ivec2(5, 3)), b3 = ihash(bc + ivec2(11, 29));
          vec2 base = root + (vec2(b1, b2) - 0.5) * uSpacing * 0.6;
          tall *= 0.65 + b3 * 0.55;
          float ang = (h3 + b1) * 6.2832;
          vec2 face = vec2(cos(ang), sin(ang));
          vec2 side = face * position.x * 0.045 * (0.6 + tall);
          vec2 lean = vec2(-face.y, face.x) * (b2 - 0.5) * 0.5 * t * t * tall;
          vec3 p = vec3(base.x + side.x + lean.x, groundH(root, 0.0) - 0.02 + t * tall, base.y + side.y + lean.y);
          // wind: steady lean downwind plus the travelling gusts; bend grows with height squared
          float g = gustAt(root);
          float bend = (0.12 + g * 0.9 + sin(uTime * 2.3 + root.x * 0.4 + root.y * 0.3) * 0.08) * t * t * tall;
          p.xz += WIND_DIR * bend;
          p.y -= bend * bend * 0.6;
          // part around the hiker
          vec2 away = root - uPlayer.xz;
          float near = 1.0 - smoothstep(0.15, 0.85, length(away));
          p.xz += normalize(away + 1e-4) * near * t * tall * 0.9;
          p.y -= near * t * tall * 0.35;
          vec3 transformed = p;
          // colour: the satellite pixel it grows in, dark at the root, sun-bleached tips, frost at dawn
          vec3 sat = texture2D(uColorMap, root / uExtent + 0.5).rgb;
          float green = clamp((sat.g - sat.r) * 6.0 + 0.25, 0.0, 1.0) * step(b2, 0.55);   // a few blades still alive
          vec3 cured = mix(vec3(0.66, 0.55, 0.33), vec3(0.52, 0.44, 0.3), b3);
          vec3 tip = mix(mix(sat * 1.3, cured, 0.45 + h2 * 0.2), mix(sat, vec3(0.36, 0.45, 0.2), 0.6), green);
          vGrass = mix(sat * 0.42, tip, smoothstep(0.0, 0.7, t)) * (0.85 + b1 * 0.3);
          vGrass = mix(vGrass, vec3(0.85, 0.88, 0.92), uFrost * t * (0.6 + h1 * 0.4));`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrass;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vGrass;')
        // both faces of a blade catch the sky the same way
        .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;');
    };
    mat.customProgramCacheKey = () => 'rawah-grass';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 0;
  }

  update(camera, hiker, frost) {
    this.uniforms.uCenter.value.set(camera.position.x, camera.position.z);
    this.uniforms.uPlayer.value.copy(hiker.pos);
    this.uniforms.uFrost.value = frost;
  }
}
