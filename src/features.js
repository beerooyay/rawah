import { ALPINE } from './alpine.js';
import { treadDetail } from './tread.js';
import { LOWPOLY } from './lowpoly.js';
import * as THREE from 'three';
import { WAVE, WAVE_GLSL, WATER, AMBIENT_GLSL } from './waves.js';
import { WATERBOX, WATERBOX_GLSL } from './waterbox.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from './noise.js';
import { withAtmosphere } from './atmosphere.js';
import { NOISE_GLSL } from './detail.js';
import { ChunkSet } from './culling.js';
import { BASE_HEIGHT_GLSL, HEIGHT_GLSL } from './cdlod.js';

// Lakes, trail ribbons, cairns, trail signs and the car at the trailhead.

// ------------------------------------------------------------------ water
function waterNormals(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const waves = [];
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2, f = 1 + Math.floor(Math.random() * 7);
    waves.push([Math.cos(a) * f, Math.sin(a) * f, Math.random() * 6.28, 1 / f]);
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0, dy = 0;
      for (const [kx, ky, ph, amp] of waves) {
        const t = ((x * Math.round(kx) + y * Math.round(ky)) / size) * Math.PI * 2 + ph;
        const c = Math.cos(t) * amp;
        dx += c * Math.round(kx); dy += c * Math.round(ky);
      }
      const nx = -dx * 0.05, ny = -dy * 0.05, inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      data[i] = (nx * inv * 0.5 + 0.5) * 255; data[i + 1] = (ny * inv * 0.5 + 0.5) * 255; data[i + 2] = (inv * 0.5 + 0.5) * 255; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function buildLakes(world, mirrorU = null, terrainU = {}) {
  const normalMap = waterNormals();
  normalMap.repeat.set(1 / 9, 1 / 9);
  const mat = new THREE.MeshPhongMaterial({
    color: 0x173c48, specular: 0xffffff, shininess: 160, normalMap,
    normalScale: new THREE.Vector2(0.3, 0.3), transparent: true, opacity: 0.9,
  });
  // uIceLine: lakes whose surface is above it are frozen over (the calendar moves it)
  const uniforms = { uSky: { value: new THREE.Color(0x9cc0e0) }, uDeep: { value: new THREE.Color(0x0d2a36) }, uIceLine: { value: 9999 },
    uT: { value: 0 }, uRings: { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, 0, -99, 0)) } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, WAVE, WATER, WATERBOX, terrainU, mirrorU || {}, { uAlpine: LOWPOLY.uAlpine });
    withAtmosphere(shader, { occlusion: 0.5 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLevel;\nvarying vec2 vIceUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLevel = position.y;\nvIceUv = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uAlpine;\nuniform vec3 uSky;\nuniform vec3 uDeep;\nuniform float uIceLine;\nuniform float uT;\nuniform vec4 uRings[10];\nuniform sampler2D uMirror;\nuniform mat4 uMirrorVP;\nuniform float uMirrorY, uMirrorOn;\nvarying float vLevel;\nvarying vec2 vIceUv;\n' + BASE_HEIGHT_GLSL + WAVE_GLSL + AMBIENT_GLSL + WATERBOX_GLSL)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        float ice = step(uIceLine, vLevel);
        vec2 mPush = vec2(0.0);
        if (ice < 0.5) {
          // rings spread from whatever has touched the water; rain dimples the surface while it falls
          float vdist = length(vViewPosition);
          vec2 push = vec2(0.0);
          for (int i = 0; i < 10; i++) {
            vec4 rg = uRings[i];
            float age = uT - rg.z;
            if (rg.w <= 0.0 || age < 0.0 || age > 4.0) continue;
            vec2 rel = vIceUv - rg.xy;
            float d = length(rel);
            float ring = exp(-pow((d - age * 1.15) * 2.6, 2.0)) * exp(-age * 1.0) * exp(-d * 0.1) * rg.w;
            push += (rel / max(d, 0.05)) * ring * cos((d - age * 1.15) * 16.0) * 0.55;
          }
          // the wind sea, its gust patches and the rain's random rings: nothing here repeats
          push -= (windSea(vIceUv, uWT) + rainRings(vIceUv, uWT, uRainAmt)) * exp(-vdist * 0.012);
          push -= waveSlope(vIceUv) * uWaveGain;   // the live ripple field: wading, rain, fish, wakes
          mPush = push;
          if (dot(push, push) > 1e-6) {
            vec3 wn = (viewMatrix * vec4(push.x, 0.0, push.y, 0.0)).xyz;
            normal = normalize(normal - normalize(wn) * clamp(length(push), 0.0, 0.5));
          }
        }
        if (ice > 0.5) {
          // snow-dusted lake ice: wind-scoured grey-blue patches and pressure cracks
          normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.9));
          float n = texture2D(uCloudTex, vIceUv / 23.0).r * 0.6 + texture2D(uCloudTex, vIceUv / 4.0).r * 0.4;
          vec3 iceCol = mix(vec3(0.42, 0.52, 0.58), vec3(0.85, 0.88, 0.92), smoothstep(0.38, 0.58, n));
          iceCol *= 1.0 - smoothstep(0.49, 0.5, abs(fract(n * 9.0) - 0.5)) * 0.3;
          diffuseColor.rgb = iceCol;
        }`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        float facing = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
        float fres = pow(1.0 - facing, 3.0);
        float depth = max(0.0, vLevel - baseH(vIceUv));
        float opticalDepth = depth / max(facing, 0.22);
        float absorption = 1.0 - exp(-opticalDepth * 0.32);
        float mirK = uMirrorOn * (1.0 - smoothstep(1.0, 2.5, abs(vLevel - uMirrorY))) * (1.0 - ice);
        gl_FragColor.rgb = mix(mix(uDeep, gl_FragColor.rgb, 0.75), uSky, 0.12 + fres * 0.7 * (1.0 - 0.85 * mirK));
        gl_FragColor.a = mix(0.82, 0.98, fres);
        if (uAlpine > 0.5 && ice < 0.5) {
          // Shallow water exposes the bed; depth absorbs light before reflection.
          vec3 body = mix(vec3(0.055, 0.145, 0.12), uDeep, absorption);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, body, 0.56);
          gl_FragColor.a = mix(0.12, 0.96, absorption);
        }
        vec4 silt = waterTint(vIceUv, gl_FragColor.rgb, uWT, waterState(vIceUv));   // what the water remembers: silt and foam
        if (ice < 0.5) { gl_FragColor.rgb = silt.rgb; gl_FragColor.a = max(gl_FragColor.a, silt.a); }
        if (mirK > 0.0) {
          // the lake as a mirror: the world above the water, found by projecting this water point through the reflected camera,
          // shaken by the surface slope (ripples, wind sea, rain rings) and softened where the water is rough
          vec3 wpos = vec3(vIceUv.x, vLevel, vIceUv.y);
          float dist = length(wpos - cameraPosition);
          vec3 wd = wpos + vec3(mPush.x, 0.0, mPush.y) * (0.5 + dist * 0.008);
          vec4 mc = uMirrorVP * vec4(wd, 1.0);
          vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
          float rough = clamp(length(mPush) * 2.0 + uWind * 0.2 + uRainAmt * 0.4, 0.0, 1.0);
          vec2 px = vec2(0.0035, 0.006) * (0.5 + rough * 2.5);
          vec3 refl = texture2D(uMirror, muv).rgb * 0.4
            + (texture2D(uMirror, muv + vec2(px.x, 0.0)).rgb + texture2D(uMirror, muv - vec2(px.x, 0.0)).rgb
             + texture2D(uMirror, muv + vec2(0.0, px.y)).rgb + texture2D(uMirror, muv - vec2(0.0, px.y)).rgb) * 0.15;
          vec2 edge = smoothstep(0.0, 0.025, muv) * (1.0 - smoothstep(0.975, 1.0, muv));
          float F = clamp(0.03 + 0.97 * pow(1.0 - facing, 5.0), 0.0, 1.0);
          F = clamp(F * 1.8 + 0.06, 0.0, 0.92) * (1.0 - 0.4 * rough) * edge.x * edge.y * step(0.0, mc.w);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, refl, F * mirK);
          gl_FragColor.a = mix(gl_FragColor.a, 1.0, F * mirK);
        }

        if (ice > 0.5) gl_FragColor = vec4(reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular * 0.12, 1.0);`);
  };
  // every lake in one mesh: one draw call for all the water
  const group = new THREE.Group();
  const cell = world.cell, half = world.N / 2;
  const pos = [], uv = [], idx = [];
  for (const lake of world.lakes) {
    for (const [r, c0, c1] of lake.runs) {
      const x0 = (c0 - half - 0.5) * cell, x1 = (c1 - half + 0.5) * cell;
      const z0 = (r - half - 0.5) * cell, z1 = (r - half + 0.5) * cell;
      const b = pos.length / 3;
      pos.push(x0, lake.level, z0, x1, lake.level, z0, x1, lake.level, z1, x0, lake.level, z1);
      uv.push(x0, -z0, x1, -z0, x1, -z1, x0, -z1);
      idx.push(b, b + 3, b + 2, b, b + 2, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  mesh.receiveShadow = true;
  group.add(mesh);
  let ripI = 0;
  return {
    group, uniforms,
    update(t) { uniforms.uT.value = t; normalMap.offset.set(t * 0.004, t * 0.0025); },
    /** A ring spreading from something touching the water: footsteps, splashes, fish. */
    ripple(x, z, amp = 1) { uniforms.uRings.value[ripI++ % 10].set(x, z, uniforms.uT.value, amp); },
  };
}

// ------------------------------------------------------------------ trails
/** Trail tread. The ribbon is laid on the ground by its own vertex shader, from the same function the terrain draws
 *  (`groundH`: lidar, micro-relief, sculpting and the worn-in tread of channels.js), at about a metre along and five
 *  points across, so it follows the dip and the banks and never hovers; its normals come from that surface too. The
 *  fragment adds ragged edges where the meadow creeps in, a worn line, scuffs along the way, lighter packed soil down
 *  the middle and darker duff at the edges, and gravel up close. `aSide` runs 0..1 across the ribbon, `aLat` is the
 *  way across it on the ground. */
function draped(params, terrain) {
  const mat = new THREE.MeshLambertMaterial(params);
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  const detail = { value: treadDetail() };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTreadDetail = detail;
    if (terrain) {
      Object.assign(shader.uniforms, terrain.uniforms);
      shader.uniforms.uCover = { value: terrain.coverMap };
      shader.uniforms.uExtent = { value: terrain.extent };
    }
    withAtmosphere(shader, { weather: 0.7 });
    // without a terrain (the graded pad at a trailhead) the heights and normals are baked into the mesh
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
      attribute vec2 aSide;
      varying vec2 vSide;
      varying vec2 vLat;
      varying vec3 vTW;
      ${terrain ? `attribute vec2 aLat;
      uniform sampler2D uCover;
      uniform float uExtent;
      ${HEIGHT_GLSL}` : ''}`)
      .replace('#include <beginnormal_vertex>', terrain ? `
      vec3 objectNormal;
      {
        const float e = 0.3;
        float hx0 = groundH(position.xz - vec2(e, 0.0), 1.0), hx1 = groundH(position.xz + vec2(e, 0.0), 1.0);
        float hz0 = groundH(position.xz - vec2(0.0, e), 1.0), hz1 = groundH(position.xz + vec2(0.0, e), 1.0);
        objectNormal = normalize(vec3(hx0 - hx1, 2.0 * e, hz0 - hz1));
      }` : '#include <beginnormal_vertex>')
      .replace('#include <begin_vertex>', terrain ? `
      vec3 transformed = vec3(position.x, groundH(position.xz, 1.0) + mix(0.06, 0.22, 1.0 - abs(aSide.x * 2.0 - 1.0)), position.z);` : '#include <begin_vertex>')
      // the tread lies in a dip below the coarser terrain triangles, which would shade it in stripes: look the shadow up 12 cm higher
      .replace('#include <shadowmap_vertex>', terrain ? `{
        vec4 wp0 = worldPosition;
        worldPosition.y += 0.12;
        #include <shadowmap_vertex>
        worldPosition = wp0;
      }` : '#include <shadowmap_vertex>')
      .replace('#include <project_vertex>', `
      vSide = aSide;
      vLat = ${terrain ? 'aLat' : 'vec2(1.0, 0.0)'};
      vTW = transformed;
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
      float dCam = length(mvPosition.xyz);
      mvPosition.xyz -= normalize(mvPosition.xyz) * (0.11 + dCam * 0.004);   // depth only (along the view ray): lets the tread show inside its dip, under the coarser terrain triangles
      gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vSide;
        varying vec2 vLat;
        varying vec3 vTW;
        ${NOISE_GLSL}
        uniform sampler2D uTreadDetail;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // bump from the screen-space slope of treadBump (the usual derivative trick), fading out with distance
          float nk = treadNear;
          vec3 sp = -vViewPosition, sdx = dFdx(sp), sdy = dFdy(sp);
          vec3 r1 = cross(sdy, normal), r2 = cross(normal, sdx);
          float det = dot(sdx, r1);
          float bh = tread.r * 0.017;
          vec3 grad = sign(det) * (dFdx(bh) * r1 + dFdy(bh) * r2);
          normal = normalize(abs(det) * normal - grad * nk);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 p = vTW.xz;
        float camD = distance(vTW, cameraPosition);
        float e = abs(vSide.x - 0.5) * 2.0;
        float edge = vnoise(p * 2.6);
        if (e > 0.75 + edge * 0.25) discard;
        float road = vSide.y;
        ${ALPINE && terrain ? 'if (road < 0.5 && camD < 175.0) discard;' : ''}
        vec2 across = normalize(vLat + 1e-5), along = vec2(-across.y, across.x);
        float streak = vnoise(vec2(dot(p, along) * 0.68, dot(p, across) * 9.0));
        float mid = 1.0 - smoothstep(0.0, 0.85, e);
        float worn = road > 0.5 ? 1.0 - smoothstep(0.0, 0.16, abs(e - 0.5)) : mid;
        float patches = vnoise(p * 0.86 + 23.1);
        float treadNear = 1.0 - smoothstep(9.0, 34.0, camD);
        // Rotate the tile out of the world axes. Patch colour hides its boundaries and mipmaps soften grit at range.
        vec2 gritUV = mat2(0.8, 0.6, -0.6, 0.8) * p * 1.2;
        vec2 tread = texture2D(uTreadDetail, gritUV).rg;
        float grit = (tread.r - 0.45) * 0.44 + (tread.g - 0.5) * 0.82;
        float shade = 0.79 + 0.28 * patches + 0.18 * worn + 0.18 * (streak - 0.5);
        diffuseColor.rgb *= shade + grit * treadNear;
        vec3 edgeTint = mix(vec3(0.82, 0.87, 0.68), vec3(0.97, 0.96, 0.91), road);
        diffuseColor.rgb *= mix(vec3(1.0), edgeTint, smoothstep(0.55, 0.96, e));
      `);
  };
  mat.customProgramCacheKey = () => (terrain ? 'rawah-draped2' : 'rawah-draped-flat');
  return mat;
}

const CHUNK_M = 1000;
const ROAD = [0.26, 0.225, 0.17];   // linear space: reads as packed grey-brown gravel
const ACROSS = 5;                   // vertices across a ribbon, so the tread's dip and banks show in it

export function buildTrails(world, terrain) {
  const group = new THREE.Group();
  const mat = draped({ vertexColors: true }, terrain);
  const geos = [];
  const tones = { road: ROAD, track: [0.40, 0.30, 0.20], trail: [0.45, 0.31, 0.185] }   // trail: pale sandy decomposed-granite tan, like a real alpine path;
  for (const t of world.trails) {
    if (!t.width) continue;
    // about a metre between rows: the dense line (2.5 m, 4 m on roads) halved
    const src = t.dense, pts = [];
    for (let i = 0; i < src.length; i++) {
      pts.push(src[i]);
      if (i < src.length - 1) pts.push([(src[i][0] + src[i + 1][0]) / 2, (src[i][1] + src[i + 1][1]) / 2]);
    }
    const half = t.width / 2, n = pts.length, V = n * ACROSS;
    const pos = new Float32Array(V * 3), col = new Float32Array(V * 3), side = new Float32Array(V * 2), lat = new Float32Array(V * 2);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const wob = 1 + (hash2(i >> 1, 3, 9) - 0.5) * 0.35;
      const y = world.height(pts[i][0], pts[i][1]);   // only for the chunk bounds: the shader lays the real height
      for (let s = 0; s < ACROSS; s++) {
        const f = s / (ACROSS - 1), o = (f - 0.5) * 2;
        const k = (i * ACROSS + s);
        pos[k * 3] = pts[i][0] - dz * half * wob * o; pos[k * 3 + 1] = y; pos[k * 3 + 2] = pts[i][1] + dx * half * wob * o;
        side[k * 2] = f; side[k * 2 + 1] = t.kind === 'road' ? 1 : 0;
        lat[k * 2] = -dz; lat[k * 2 + 1] = dx;
        const v = 0.9 + hash2(i, s, 5) * 0.2, base = tones[t.kind];
        col[k * 3] = base[0] * v; col[k * 3 + 1] = base[1] * v; col[k * 3 + 2] = base[2] * v;
      }
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      for (let s = 0; s < ACROSS - 1; s++) {
        const a = i * ACROSS + s, b = a + 1, c = a + ACROSS, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 2));
    geo.setAttribute('aLat', new THREE.BufferAttribute(lat, 2));
    geo.setIndex(idx);
    geos.push(geo);
  }
  // all the trails and roads as ~1 km chunks, so the ones off screen or behind a ridge cost nothing
  const chunks = new ChunkSet(mergeGeometries(geos), mat, CHUNK_M, (m) => { m.receiveShadow = true; });
  group.add(chunks.group);
  group.add(buildCairns(world));
  if (ALPINE) {
    group.stones = buildTrailStones(world, terrain);
    group.add(group.stones.group);
  }
  group.chunks = chunks;
  return group;
}

function buildTrailStones(world, terrain) {
  const rock = new THREE.OctahedronGeometry(1, 0);
  const pos = [], centers = [], colors = [];
  const source = rock.attributes.position;
  for (const [id, t] of world.trails.entries()) {
    if (t.kind !== 'trail' || !t.width) continue;
    let next = 5 + hash2(id, 1) * 10, distance = 0;
    for (let i = 1; i < t.dense.length; i++) {
      const [ax, az] = t.dense[i - 1], [bx, bz] = t.dense[i];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-4) continue;
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      while (next < distance + len) {
        const d = next - distance;
        const side = (hash2(i, id, 72) < 0.5 ? -1 : 1) * t.width * 0.32;
        const x = ax + dx * d - dz * side, z = az + dz * d + dx * side;
        const count = hash2(i, id, 73) < 0.52 ? 1 : 3 + Math.floor(hash2(i, id, 74) * 3);
        for (let j = 0; j < count; j++) {
          const cx = x + dx * (hash2(i, id, 81 + j) - 0.5) * 0.62;
          const cz = z + dz * (hash2(i, id, 89 + j) - 0.5) * 0.62;
          const radius = 0.032 + 0.115 * hash2(i, id, 97 + j) ** 2;
          const angle = hash2(i, id, 105 + j) * Math.PI * 2;
          const c = Math.cos(angle), q = Math.sin(angle);
          const y = world.height(cx, cz);
          const tint = 0.83 + 0.34 * hash2(i, id, 114 + j);
          for (let k = 0; k < source.count; k++) {
            const u = source.getX(k) * radius, v = source.getZ(k) * radius * 0.72;
            pos.push(cx + c * u - q * v, y + source.getY(k) * radius * 0.52 + radius * 0.15, cz + q * u + c * v);
            centers.push(cx, y, cz);
            colors.push(0.37 * tint, 0.305 * tint, 0.23 * tint);
          }
        }
        next += 9 + hash2(i, id, 77) * 14;
      }
      distance += len;
    }
  }
  rock.dispose();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aStoneRoot', new THREE.Float32BufferAttribute(centers, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(Array.from({ length: pos.length / 3 }, (_, i) => i));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, terrain.uniforms, {
      uCover: { value: terrain.coverMap }, uExtent: { value: terrain.extent },
    });
    withAtmosphere(shader, { weather: 0.7 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aStoneRoot;
        uniform sampler2D uCover;
        uniform float uExtent;
        ${HEIGHT_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.y += groundH(aStoneRoot.xz, 1.0) - aStoneRoot.y + 0.025;`);
  };
  mat.customProgramCacheKey = () => 'rawah-trail-stones';
  const chunks = new ChunkSet(geo, mat, 48, (mesh) => { mesh.receiveShadow = true; });
  geo.dispose();
  return chunks;
}

function buildCairns(world) {
  const parts = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.IcosahedronGeometry(0.42 - i * 0.08, 0);
    g.scale(1.2, 0.55, 1);
    g.rotateY(i * 1.3);
    g.translate((i % 2) * 0.05, 0.18 + i * 0.3, 0);
    parts.push(g);
  }
  const geo = mergeGeometries(parts);
  const spots = [];
  for (const t of world.trails) {
    if (t.kind === 'road') continue;
    if (t.kind !== 'trail') continue;
    const every = 70;
    let acc = 0;
    for (let i = 1; i < t.dense.length; i++) {
      const [x, z] = t.dense[i];
      acc += Math.hypot(x - t.dense[i - 1][0], z - t.dense[i - 1][1]);
      if (acc < every) continue;
      const e = world.height(x, z);
      if (e < world.treeline(x, z) + 30) continue;
      acc = 0;
      const off = 1.6;
      spots.push([x + off, world.height(x + off, z), z, 1]);
    }
  }
  // a big summit cairn on every named peak
  for (const p of world.places) if (p.kind === 'peak') spots.push([p.x + 4, world.height(p.x + 4, p.z), p.z, 1.8]);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0x8f8a84 }), Math.max(1, spots.length));
  const m = new THREE.Matrix4();
  spots.forEach(([x, y, z, k], i) => mesh.setMatrixAt(i, m.makeScale(k, k, k).setPosition(x, y - 0.05 * k, z)));
  mesh.count = spots.length;
  mesh.castShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

// ------------------------------------------------------------------ signs
function signTexture(lines, w = 512, h = 256, big = false) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#4b3424';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 40; i++) { // wood grain
    g.strokeStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.08})`;
    g.beginPath(); const y = Math.random() * h; g.moveTo(0, y); g.bezierCurveTo(w / 3, y + 6, w * 0.6, y - 6, w, y + 2); g.stroke();
  }
  g.strokeStyle = '#2e2016'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
  g.fillStyle = '#efe6cf';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const lh = h / (lines.length + 0.6);
  lines.forEach((ln, i) => {
    let size = big && i === 0 ? lh * 0.8 : lh * 0.56;
    const font = () => (big && i === 0 ? `400 ${size}px "Paytone One", Gabarito, sans-serif` : `700 ${size}px Gabarito, sans-serif`);
    g.font = font();
    const fit = (w - 40) / g.measureText(ln).width;   // shrink long names to fit the board
    if (fit < 1) { size *= fit; g.font = font(); }
    g.fillText(ln, w / 2, lh * (i + 0.8));
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function post(h) {
  const g = new THREE.BoxGeometry(0.16, h, 0.16);
  g.translate(0, h / 2, 0);
  return g;
}

const WOOD = new THREE.MeshLambertMaterial({ color: 0x4b3424 });

/** A routed-wood trail sign: the board and posts in plain wood, both faces sharing one lettered texture. */
function sign(lines, width, height, postH, big) {
  const grp = new THREE.Group();
  const board = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.07), WOOD);
  board.position.y = postH - height / 2;
  board.castShadow = true;
  const faces = mergeGeometries([0, Math.PI].map((r) => {
    const f = new THREE.PlaneGeometry(width - 0.04, height - 0.04);
    f.rotateY(r);
    f.translate(0, postH - height / 2, r ? -0.036 : 0.036);
    return f;
  }));
  const face = new THREE.Mesh(faces, new THREE.MeshLambertMaterial({ map: signTexture(lines, 512, Math.round(512 * height / width), big) }));
  grp.add(board, face);
  const p = new THREE.Mesh(post(postH + 0.2), WOOD);
  p.position.set(-width / 2 + 0.15, -0.2, -0.08);
  const q = p.clone(); q.position.x = width / 2 - 0.15;
  grp.add(p, q);
  return grp;
}

/** Bake every plain-wood part of every sign into one mesh (one draw call). */
function mergeWood(group) {
  group.updateMatrixWorld(true);
  const parts = [];
  group.traverse((o) => { if (o.isMesh && o.material === WOOD) parts.push(o); });
  if (!parts.length) return;
  const geo = mergeGeometries(parts.map((o) => {
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
    return g;
  }));
  for (const o of parts) o.removeFromParent();
  const wood = new THREE.Mesh(geo, WOOD);
  wood.castShadow = wood.receiveShadow = true;
  group.add(wood);
}

const fmtDist = (m) => `${(m / 1609.34).toFixed(1)} mi`;

/** Grade a pull-off pad: every cell inside the loop eases to one level, like a
 *  real graded apron, through the sculpt grid so terrain, grass and feet agree.
 *  Returns the ring points; re-runnable after a save restores the sculpt atlas. */
export function gradeLot(world, L) {
  const N = 64, ring = [];
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
    const wwi = L.ww * (0.72 + 0.28 * ct);   // teardrop: wide far end, narrow neck at the road
    ring.push([L.cx + L.ax * ct * L.hw + L.px * st * wwi, L.cz + L.az * ct * L.hw + L.pz * st * wwi]);
  }
  if (L.level === undefined) L.level = ring.reduce((a, [x, z]) => a + world.height(x, z), 0) / N;
  if (!world.sculpt) return ring;
  const lift = (cur, wx, wz, wt) => cur + (L.level + (hash2(wx * 0.37, wz * 0.37, 7) - 0.5) * 0.06 - world.height(wx, wz)) * wt;
  for (const [x, z] of ring) world.sculpt.paint(x, z, 7.5, lift);
  for (const e of [-0.55, 0, 0.55]) world.sculpt.paint(L.cx + L.ax * L.hw * e, L.cz + L.az * L.hw * e, L.ww * 0.9, lift);   // the island, end to end
  for (const e of [-1, 1]) {
    for (let k = 0; k <= 4; k++) {                                       // the mouths
      world.sculpt.paint(L.cx + L.ax * e * L.hw - L.px * 3.2 * k, L.cz + L.az * e * L.hw - L.pz * 3.2 * k, 5.5, lift);
    }
  }
  return ring;
}

export function buildSigns(world, models) {
  const group = new THREE.Group();
  const place = (obj, x, z, faceX, faceZ) => {
    obj.position.set(x, world.height(x, z) - 0.05, z);
    obj.rotation.y = Math.atan2(faceX, faceZ);
    group.add(obj);
  };
  const named = world.trails.filter((t) => t.kind === 'trail' && t.name.endsWith('Trail') && t.dense.length > 6);
  const network = world.trails.filter((t) => t.name);
  const touches = (x, z, self) => network.some((o) => o.name !== self.name &&
    o.dense.some(([ox, oz]) => Math.abs(ox - x) < 12 && Math.abs(oz - z) < 12 && Math.hypot(ox - x, oz - z) < 12));
  // a post at every junction where a named trail starts or ends on another trail or road
  const done = [];
  for (const t of named) {
    for (const end of [0, t.dense.length - 1]) {
      const [x0, z0] = t.dense[end];
      if (done.some(([n, x, z]) => n === t.name && Math.hypot(x - x0, z - z0) < 60)) continue;
      if (!touches(x0, z0, t)) continue;
      done.push([t.name, x0, z0]);
      const [x1, z1] = t.dense[end === 0 ? 4 : t.dense.length - 5];
      const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1;
      const s = sign([t.name, fmtDist(world.trailLength.get(t.name) || 0)], 1.6, 0.48, 1.4);
      place(s, x0 + (dx / l) * 3 - (dz / l) * 1.8, z0 + (dz / l) * 3 + (dx / l) * 1.8, -dz / l, dx / l);
    }
  }
  // every trailhead parks the two cars nose to tail on the road and gives each a start spot beside it.
  // The default trailhead (West Branch) also gets the wilderness sign
  const trailheads = world.places.filter((p) => p.kind === 'trailhead');
  const main = trailheads.find((p) => p.trail === 'West Branch Trail') || trailheads[0];
  world.mainTrailhead = main;
  world.starts = {};
  for (const th of trailheads) {
    let road = null, best = 0, bd = Infinity;
    for (const t of world.trails) {
      if (t.kind === 'trail') continue;
      t.dense.forEach(([x, z], i) => { const d = Math.hypot(x - th.x, z - th.z); if (d < bd) { bd = d; best = i; road = t; } });
    }
    if (!road) continue;
    const trail = named.find((t) => t.name === th.trail);
    const tp = trail ? trail.dense[Math.min(12, trail.dense.length - 1)] : [th.x + 10, th.z];
    // park on flat ground beside the road, clear of water, trail and trees
    let spot = null, score = Infinity;
    for (let k = Math.max(1, best - 12); k < Math.min(road.dense.length - 1, best + 12); k++) {
      const [ax, az] = road.dense[k - 1], [bx, bz] = road.dense[k + 1];
      const rl = Math.hypot(bx - ax, bz - az) || 1, rx = (bx - ax) / rl, rz = (bz - az) / rl;
      for (const side of [1, -1]) {
        for (const off of [5.5, 7, 9]) {
          const [ox, oz] = road.dense[k];
          const x = ox - rz * off * side, z = oz + rx * off * side;
          const brook = world.nearestStream(x, z);
          const near = world.nearestTrail(x, z);
          if (world.localGrade(x, z) > 0.14 || world.localGrade(x + 2 * rx + CAR_LENGTH * rx, z + 2 * rz + CAR_LENGTH * rz) > 0.14) continue;
          if (brook.stream && brook.d < brook.stream.width / 2 + 7) continue;
          if (world.lakeAt(x, z) || (near.trail && near.d < 3.6)) continue;
          const sc = Math.hypot(x - th.x, z - th.z);
          if (sc < score) { score = sc; spot = { x, z, rx, rz, side }; }
        }
      }
    }
    if (!spot) continue;
    if (th === main) {
      // West Branch's real trailhead has a small gravel loop hanging off the road on the
      // trail side: move the pull-in onto the loop's near arm when it lands on dry ground
      const rp = road.dense[best];
      const sd = Math.sign((th.x - rp[0]) * spot.rz - (th.z - rp[1]) * spot.rx) || 1;
      const px = -spot.rz * sd, pz = spot.rx * sd;
      const wet = [15, 26].some((k) => {
        const b = world.nearestStream(rp[0] + px * k, rp[1] + pz * k);
        return (b.stream && b.d < b.stream.width / 2 + 4) || world.lakeAt(rp[0] + px * k, rp[1] + pz * k);
      });
      if (!wet) {
        spot.lot = { px, pz, cx: rp[0] + px * 15, cz: rp[1] + pz * 15 };
        spot.x = spot.lot.cx - px * 11; spot.z = spot.lot.cz - pz * 11;
      }
    }
    const cars = CAR_ORDER.map((model, i) => {
      const x = spot.x + spot.rx * i * CAR_SPACING, z = spot.z + spot.rz * i * CAR_SPACING;
      const obj = carModel(models[model]);
      place(obj, x, z, spot.rx, spot.rz);
      // the start spot is on the trail side of the car, a couple of metres off its door
      return { model, x, z, yaw: obj.rotation.y, obj, start: { x: x - spot.rz * 2.4 * -spot.side, z: z + spot.rx * 2.4 * -spot.side, toward: tp } };
    });
    // the road the cars pulled in from, for the opening drive (src/intro.js): its points in driving order and where they park
    world.starts[th.name] = { cars, road: road.dense, roadRef: road, k: best, spot };
    if (th === main && spot.lot) {
      // the gravel loop itself: an oval ring of road tread around a worn island,
      // on ground graded flat through the sculpt grid so it cannot read as warped
      const L = spot.lot, pos = [], col = [], sid = [], idx = [];
      L.ax = spot.rx; L.az = spot.rz; L.hw = 34; L.ww = 16;
      const ring = gradeLot(world, L);
      // the lot itself: one solid oval pad on the graded ground, the rim fraying
      // into meadow through the same ragged edge the trails wear (aSide.x runs
      // 0.5 at the centre to 0 at the rim, so e climbs like a ribbon edge)
      pos.push(L.cx, world.height(L.cx, L.cz) + 0.07, L.cz); sid.push(0.5, 1);
      col.push(ROAD[0], ROAD[1], ROAD[2]);
      const SEGS = 3, K = ring.length;
      for (let s = 1; s <= SEGS; s++) {
        const d = s / SEGS;
        for (let i = 0; i < K; i++) {
          const x = L.cx + (ring[i][0] - L.cx) * d, z = L.cz + (ring[i][1] - L.cz) * d;
          const h = Math.max(world.height(x, z), world.height(x + 1.2, z), world.height(x - 1.2, z), world.height(x, z + 1.2), world.height(x, z - 1.2));
          pos.push(x, h + 0.07, z); sid.push(0.5 - 0.5 * d, 1);
          const v = 0.9 + hash2(i, s, 5) * 0.2;
          col.push(ROAD[0] * v, ROAD[1] * v, ROAD[2] * v);
        }
      }
      for (let i = 0; i < K; i++) idx.push(0, 1 + ((i + 1) % K), 1 + i);   // centre fan
      for (let s = 0; s < SEGS - 1; s++) {
        for (let i = 0; i < K; i++) {
          const a = 1 + s * K + i, b = 1 + s * K + ((i + 1) % K), c = 1 + (s + 1) * K + i, d = 1 + (s + 1) * K + ((i + 1) % K);
          idx.push(a, c, b, b, c, d);
        }
      }
      const strip = (line) => {   // the mouths where the pad meets the road
        const b0 = pos.length / 3, n = line.length;
        for (let i = 0; i < n; i++) {
          const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
          const tx = b[0] - a[0], tz = b[1] - a[1], tl = Math.hypot(tx, tz) || 1;
          for (let s = 0; s < 2; s++) {
            const off = (s - 0.5) * 6.8, x = line[i][0] - (tz / tl) * off, z = line[i][1] + (tx / tl) * off;
            const h = Math.max(world.height(x, z), world.height(x + 1.2, z), world.height(x - 1.2, z), world.height(x, z + 1.2), world.height(x, z - 1.2));
            pos.push(x, h + 0.08, z); sid.push(s, 1);
            const v = 0.9 + hash2(i, s, 5) * 0.2;
            col.push(ROAD[0] * v, ROAD[1] * v, ROAD[2] * v);
          }
        }
        for (let i = 0; i < n - 1; i++) { const a = b0 + i * 2, c = b0 + (i + 1) * 2; idx.push(a, c + 1, c, a, c, a + 1); }
      };
      for (const e of [-1, 1]) {
        const line = [];
        for (let k = 0; k <= 5; k++) line.push([L.cx + L.ax * e * L.hw - L.px * 3.2 * k, L.cz + L.az * e * L.hw - L.pz * 3.2 * k]);
        strip(line);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aSide', new THREE.Float32BufferAttribute(sid, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, draped({ vertexColors: true }));
      m.receiveShadow = true;
      group.add(m);
      // keep the pad bare of grass out to the frayed rim
      world.lot = { cx: L.cx, cz: L.cz, ax: L.ax, az: L.az, px: L.px, pz: L.pz, hw: L.hw, ww: L.ww, level: L.level,
        clear: [[L.cx - L.ax * 30, L.cz - L.az * 30, L.cx + L.ax * 30, L.cz + L.az * 30, 13],
          [L.cx - L.ax * 33, L.cz - L.az * 33, 8], [L.cx + L.ax * 33, L.cz + L.az * 33, 8]] };
    }
    if (th === main) {
      // the vault toilet stands on the island well inside the loop, door toward the mouth, or behind the cars elsewhere
      const ox = spot.lot ? spot.lot.cx - spot.lot.ax * 19 - spot.lot.px * 7 : spot.x - spot.rx * (CAR_SPACING * CAR_ORDER.length + 3);
      const oz = spot.lot ? spot.lot.cz - spot.lot.az * 19 - spot.lot.pz * 7 : spot.z - spot.rz * (CAR_SPACING * CAR_ORDER.length + 3);
      place(landmark(models.outhouse, 2.5), ox, oz, spot.lot ? -spot.lot.ax : cars[0].start.x - ox, spot.lot ? -spot.lot.az : cars[0].start.z - oz);
      if (spot.lot) {   // the quad waits on the far arm, nose along the loop
        const L = spot.lot, qx = L.cx + L.px * 10.6 - spot.rx * 9, qz = L.cz + L.pz * 10.6 - spot.rz * 9;
        world.starts[th.name].quad = { x: qx, z: qz, yaw: Math.atan2(-spot.rx, -spot.rz) };
      }
    }
    if (th === main) {
      // the sign stands where the trail leaves, on dry ground beside it
      const sx = th.x + (tp[0] - th.x) * 0.3, sz = th.z + (tp[1] - th.z) * 0.3;
      const fx = tp[0] - th.x, fz = tp[1] - th.z, fl = Math.hypot(fx, fz) || 1;
      for (const off of [2.6, -2.6, 4, -4, 6, 8]) {
        const gx = sx - (fz / fl) * off, gz = sz + (fx / fl) * off;
        const bk = world.nearestStream(gx, gz);
        const near = world.nearestTrail(gx, gz);
        if ((bk.stream && bk.d < bk.stream.width / 2 + 1.2) || world.lakeAt(gx, gz) ||
            (near.trail && near.d < near.trail.width / 2 + 1.35)) continue;
        place(landmark(models.wildernessSign, 2.4), gx, gz, -fx / fl, -fz / fl);
        break;
      }
      // the trailhead sign stands at the lot, on the car side
      for (const off of [6, 8, -6, -8]) {
        const gx = th.x + (fz / fl) * off, gz = th.z - (fx / fl) * off;
        const near = world.nearestTrail(gx, gz);
        if (world.lakeAt(gx, gz) || (near.trail && near.d < near.trail.width / 2 + 1.25)) continue;
        place(landmark(models.trailheadSign, 2.2), gx, gz, -fx / fl, -fz / fl);
        break;
      }
    }
  }
  mergeWood(group);
  return group;
}

/** Streams as flowing water ribbons laid on their carved channels. */
export function buildStreams(world) {
  const normalMap = waterNormals(128);
  const mat = new THREE.MeshPhongMaterial({
    color: 0x2c5560, specular: 0xffffff, shininess: 120, normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
    transparent: true, opacity: 0.86, depthWrite: false,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WAVE, WATER, WATERBOX, { uFlowMap: { value: normalMap } });
    withAtmosphere(shader, { occlusion: 0.5 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaveXZ;\nvarying vec2 vFlow;\nattribute vec2 aFlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWaveXZ = position.xz;\nvFlow = aFlow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vWaveXZ;\nvarying vec2 vFlow;\nuniform sampler2D uFlowMap;\n' + WAVE_GLSL + AMBIENT_GLSL + WATERBOX_GLSL)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // the current carries the surface detail downstream; wind chop and rain ride on top
        vec2 fl = normalize(vFlow + vec2(1e-4));
        float fade = exp(-length(vViewPosition) * 0.02);
        vec2 amb = flowDetail(uFlowMap, vWaveXZ, uWT, fl, length(vFlow)) * 1.25 + windSea(vWaveXZ, uWT) * 0.7 + rainRings(vWaveXZ, uWT, uRainAmt);
        // riffles: where the surface is busiest the water picks up a little white
        diffuseColor.rgb += vec3(0.55) * smoothstep(0.28, 0.75, length(amb)) * 0.35 * fade;
        vec2 wavePush = -waveSlope(vWaveXZ) * uWaveGain - amb * fade;
        if (dot(wavePush, wavePush) > 1e-6) {
          vec3 wn = (viewMatrix * vec4(wavePush.x, 0.0, wavePush.y, 0.0)).xyz;
          normal = normalize(normal - normalize(wn) * clamp(length(wavePush), 0.0, 0.5));
        }`)
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        vec4 silt = waterTint(vWaveXZ, gl_FragColor.rgb, uWT, waterState(vWaveXZ));
        gl_FragColor.rgb = silt.rgb; gl_FragColor.a = max(gl_FragColor.a, silt.a);`);
  };
  const group = new THREE.Group(), geos = [];
  for (const st of world.streams) {
    const p = st.pts, half = st.hw || st.width / 2;
    const pos = new Float32Array(p.length * 6), uv = new Float32Array(p.length * 4), flow = new Float32Array(p.length * 4);
    const down = p[0][2] >= p[p.length - 1][2] ? 1 : -1;   // points are listed downstream when the first is higher
    let along = 0;
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      if (i) along += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      for (let s = 0; s < 2; s++) {
        const sign = s ? 1 : -1, k = (i * 2 + s) * 3;
        const spd = st.speed ? st.speed[i] : 0.5;
        flow[(i * 2 + s) * 2] = dx * down * spd; flow[(i * 2 + s) * 2 + 1] = dz * down * spd;
        pos[k] = p[i][0] + dz * half * sign; pos[k + 1] = p[i][2]; pos[k + 2] = p[i][1] - dx * half * sign;
        uv[(i * 2 + s) * 2] = along / 3; uv[(i * 2 + s) * 2 + 1] = s * half * 2 / 3;
      }
    }
    const idx = [];
    for (let i = 0; i < p.length - 1; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aFlow', new THREE.BufferAttribute(flow, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geos.push(geo);
  }
  const chunks = new ChunkSet(mergeGeometries(geos), mat, CHUNK_M, (m) => { m.renderOrder = 1; });
  group.add(chunks.group);
  return { group, chunks, update(t) { normalMap.offset.set(-t * 0.04, Math.sin(t * 0.3) * 0.02); } };
}

/** The two cars, nose to tail along the road. Anyone can drive either. */
export const CAR_ORDER = ['civic', 'maverick'];
const CAR_LENGTH = 4.6, CAR_SPACING = 5.7;   // nose to tail with a gap (the cars were 3.4 m apart, shorter than a car, so they overlapped)

/** A landmark model from assets/landmarks, scaled to `height` metres tall and standing on the origin. */
export function landmark(template, height) {
  const box = new THREE.Box3().setFromObject(template);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = height / size.y;
  const inner = template.clone(true);
  inner.scale.setScalar(s);
  inner.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  const g = new THREE.Group();
  g.add(inner);
  g.traverse((o) => {
    o.castShadow = true; o.receiveShadow = true;
    if (o.material && 'metalness' in o.material) o.material.metalness = 0;   // glTF defaults to metal; wood is not
  });
  return g;
}

/** A glTF car scaled to CAR_LENGTH metres, nose along +z, standing on its wheels at the origin. */
export function carModel(template) {
  const box = new THREE.Box3().setFromObject(template);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = CAR_LENGTH / size.z;
  const inner = template.clone(true);
  inner.scale.setScalar(s);
  inner.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  const g = new THREE.Group();
  g.add(inner);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return g;
}
