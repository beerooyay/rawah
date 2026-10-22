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
// parts around the hiker's legs, and carries frost at dawn.

function bladeGeometry() {
  // three segments, tapering to a point; x = side, y = 0..1 up the blade
  const pos = [], idx = [];
  const rows = [0, 0.38, 0.72];
  rows.forEach((y) => { const w = 1 - y * 0.85; pos.push(-0.5 * w, y, 0, 0.5 * w, y, 0); });
  pos.push(0, 1, 0);
  for (let r = 0; r < rows.length - 1; r++) { const a = r * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  idx.push(4, 5, 6);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
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
      withAtmosphere(shader, { translucency: 0.7 });
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
          float ang = h3 * 6.2832;
          vec2 side = vec2(cos(ang), sin(ang)) * position.x * 0.05 * (0.6 + tall);
          vec3 p = vec3(root.x + side.x, groundH(root, 0.0) - 0.02 + t * tall, root.y + side.y);
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
          vec3 tip = mix(sat * 1.35, vec3(0.62, 0.52, 0.3), 0.35 + h2 * 0.2);
          vGrass = mix(sat * 0.55, tip, t);
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
