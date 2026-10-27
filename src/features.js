import * as THREE from 'three';
import { WAVE, WAVE_GLSL, WATER, AMBIENT_GLSL } from './waves.js';
import { WATERBOX, WATERBOX_GLSL } from './waterbox.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from './noise.js';
import { withAtmosphere } from './atmosphere.js';
import { NOISE_GLSL } from './detail.js';
import { WORLEY_GLSL } from './terrain.js';
import { ChunkSet } from './culling.js';

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
      const n = new THREE.Vector3(-dx * 0.05, -dy * 0.05, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255; data[i + 1] = (n.y * 0.5 + 0.5) * 255; data[i + 2] = (n.z * 0.5 + 0.5) * 255; data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

export function buildLakes(world, mirrorU = null) {
  const normalMap = waterNormals();
  normalMap.repeat.set(1 / 9, 1 / 9);
  const mat = new THREE.MeshPhongMaterial({
    color: 0x173c48, specular: 0xffffff, shininess: 160, normalMap,
    normalScale: new THREE.Vector2(0.3, 0.3), transparent: true, opacity: 0.9,
  });
  // uIceLine: lakes whose surface is above it are frozen over (the calendar moves it)
  const uniforms = { uSky: { value: new THREE.Color(0x9cc0e0) }, uDeep: { value: new THREE.Color(0x0d2a36) }, uIceLine: { value: 9999 },
    uRain: { value: 0 }, uT: { value: 0 }, uRings: { value: Array.from({ length: 10 }, () => new THREE.Vector4(0, 0, -99, 0)) } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, WAVE, WATER, WATERBOX, mirrorU || {});
    withAtmosphere(shader, { occlusion: 0.5 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLevel;\nvarying vec2 vIceUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLevel = position.y;\nvIceUv = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSky;\nuniform vec3 uDeep;\nuniform float uIceLine;\nuniform float uRain;\nuniform float uT;\nuniform vec4 uRings[10];\nuniform sampler2D uMirror;\nuniform mat4 uMirrorVP;\nuniform float uMirrorY, uMirrorOn;\nvarying float vLevel;\nvarying vec2 vIceUv;\n' + WAVE_GLSL + AMBIENT_GLSL + WATERBOX_GLSL)
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
        float mirK = uMirrorOn * (1.0 - smoothstep(1.0, 2.5, abs(vLevel - uMirrorY))) * (1.0 - ice);
        gl_FragColor.rgb = mix(mix(uDeep, gl_FragColor.rgb, 0.75), uSky, 0.12 + fres * 0.7 * (1.0 - 0.85 * mirK));
        gl_FragColor.a = mix(0.82, 0.98, fres);
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
          gl_FragColor.a = max(gl_FragColor.a, F * mirK);
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
/** Trail tread: nudged toward the camera with distance so ribbons stay on top
 *  of coarse far-LOD terrain without z-fighting, with ragged edges where the
 *  meadow creeps in, a worn line down the middle (wheel ruts on roads), and
 *  gravel and pebbles up close. `aSide` runs 0..1 across the ribbon. */
function draped(params) {
  const mat = new THREE.MeshLambertMaterial(params);
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  mat.onBeforeCompile = (shader) => {
    withAtmosphere(shader, { weather: 0.7 });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aSide;\nvarying vec2 vSide;\nvarying vec3 vTW;')
      .replace('#include <project_vertex>', `
      vSide = aSide;
      vTW = transformed;
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
      float dCam = length(mvPosition.xyz);
      mvPosition.xyz -= normalize(mvPosition.xyz) * (0.04 + dCam * 0.0045);
      gl_Position = projectionMatrix * mvPosition;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vSide;
        varying vec3 vTW;
        ${NOISE_GLSL}
        ${WORLEY_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 p = vTW.xz;
          float camD = distance(vTW, cameraPosition);
          float e = abs(vSide.x - 0.5) * 2.0;
          float n = vnoise(p * 1.7) * 0.6 + vnoise(p * 6.0) * 0.4;
          if (e > 0.72 + n * 0.32) discard;                     // ragged edges
          float road = vSide.y;
          // worn tread: a dark line down the middle of a trail, two ruts on a road
          float worn = road > 0.5 ? smoothstep(0.16, 0.0, abs(e - 0.5)) : smoothstep(0.5, 0.0, e);
          diffuseColor.rgb *= 1.0 - worn * 0.14 + (n - 0.5) * 0.25;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.8, 0.9, 0.7), smoothstep(0.55, 0.95, e) * 0.6);
          float nearK = 1.0 - smoothstep(10.0, 45.0, camD);
          if (nearK > 0.0) {
            // grit and scattered gravel, sizes all over the place, low contrast like real tread
            vec4 w = worley(p / 0.07);
            vec4 v = worley(p / 0.19 + 3.3);
            float grit = smoothstep(0.45 * w.y + 0.1, 0.05, w.x) * step(w.y, 0.6);
            float peb = smoothstep(0.32 * v.y + 0.08, 0.04, v.x) * step(v.y, mix(0.22, 0.4, road));
            diffuseColor.rgb *= 1.0 + (grit * (w.y - 0.4) * 0.35 + peb * (v.y - 0.15) * 0.6) * nearK;
          }
        }`);
  };
  mat.customProgramCacheKey = () => 'rawah-draped';
  return mat;
}

const CHUNK_M = 1000;

export function buildTrails(world) {
  const group = new THREE.Group();
  const mat = draped({ vertexColors: true });
  const geos = [];
  const tones = { road: [0.2, 0.185, 0.16], track: [0.15, 0.12, 0.085], trail: [0.13, 0.095, 0.06] };
  for (const t of world.trails) {
    if (!t.width) continue;
    const pts = t.dense, half = t.width / 2;
    const pos = new Float32Array(pts.length * 2 * 3), col = new Float32Array(pts.length * 2 * 3), nor = new Float32Array(pts.length * 2 * 3);
    const side = new Float32Array(pts.length * 2 * 2);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      const wob = 1 + (hash2(i, 3, 9) - 0.5) * 0.35;
      for (let s = 0; s < 2; s++) {
        const sign = s ? 1 : -1;
        const x = pts[i][0] - dz * half * wob * sign, z = pts[i][1] + dx * half * wob * sign;
        const k = (i * 2 + s) * 3;
        pos[k] = x; pos[k + 1] = world.height(x, z) + 0.05; pos[k + 2] = z;
        nor[k + 1] = 1;
        side[(i * 2 + s) * 2] = s; side[(i * 2 + s) * 2 + 1] = t.kind === 'road' ? 1 : 0;
        const v = 0.9 + hash2(i, s, 5) * 0.2, base = tones[t.kind];
        col[k] = base[0] * v; col[k + 1] = base[1] * v; col[k + 2] = base[2] * v;
      }
    }
    const idx = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geos.push(geo);
  }
  // all the trails and roads as ~1 km chunks, so the ones off screen or behind a ridge cost nothing
  const chunks = new ChunkSet(mergeGeometries(geos), mat, CHUNK_M, (m) => { m.receiveShadow = true; });
  group.add(chunks.group);
  group.add(buildCairns(world));
  group.chunks = chunks;
  return group;
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
      const brook = world.nearestStream(rp[0] + px * 15, rp[1] + pz * 15);
      const lake = world.lakeAt(rp[0] + px * 15, rp[1] + pz * 15);
      if ((!brook.stream || brook.d > brook.stream.width / 2 + 9) && !lake) {
        spot.lot = { px, pz, cx: rp[0] + px * 15, cz: rp[1] + pz * 15 };
        spot.x = spot.lot.cx - px * 9; spot.z = spot.lot.cz - pz * 9;
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
      // the gravel loop itself: an oval ring of road tread around a worn island
      const L = spot.lot, N = 30, pos = [], col = [], sid = [], idx = [];
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
        const qx = L.cx + spot.rx * ct * 22 + L.px * st * 9, qz = L.cz + spot.rz * ct * 22 + L.pz * st * 9;
        const tx = spot.rx * -st * 22 + L.px * ct * 9, tz = spot.rz * -st * 22 + L.pz * ct * 9;
        const tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
        for (let s = 0; s < 2; s++) {
          const off = (s - 0.5) * 4.6, x = qx + nx * off, z = qz + nz * off;
          pos.push(x, world.height(x, z) + 0.06, z); sid.push(s, 1);
          const v = 0.9 + hash2(i, s, 5) * 0.2;
          col.push(0.2 * v, 0.185 * v, 0.16 * v);
        }
      }
      for (let i = 0; i < N; i++) { const b = i * 2; idx.push(b, b + 3, b + 2, b, b + 2, b + 1); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aSide', new THREE.Float32BufferAttribute(sid, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(idx);
      const m = new THREE.Mesh(g, draped({ vertexColors: true }));
      m.receiveShadow = true;
      group.add(m);
      // keep the tread bare of grass: two clear circles along the loop's long axis
      world.lot = { clear: [[L.cx - spot.rx * 9, L.cz - spot.rz * 9, 13], [L.cx + spot.rx * 9, L.cz + spot.rz * 9, 13]] };
    }
    if (th === main) {
      // the vault toilet sits inside the loop on the trail side, or behind the cars at other trailheads
      const ox = spot.lot ? spot.lot.cx + spot.lot.px * 4.5 : spot.x - spot.rx * (CAR_SPACING * CAR_ORDER.length + 3);
      const oz = spot.lot ? spot.lot.cz + spot.lot.pz * 4.5 : spot.z - spot.rz * (CAR_SPACING * CAR_ORDER.length + 3);
      place(landmark(models.outhouse, 2.5), ox, oz, spot.lot ? -spot.lot.px : spot.rx, spot.lot ? -spot.lot.pz : spot.rz);
    }
    if (th === main) {
      // the sign stands where the trail leaves, on dry ground beside it
      const sx = th.x + (tp[0] - th.x) * 0.25, sz = th.z + (tp[1] - th.z) * 0.25;
      const fx = tp[0] - th.x, fz = tp[1] - th.z, fl = Math.hypot(fx, fz) || 1;
      for (const off of [4, 6, 8, -4, -6, 10]) {
        const gx = sx - (fz / fl) * off, gz = sz + (fx / fl) * off;
        const bk = world.nearestStream(gx, gz);
        if ((bk.stream && bk.d < bk.stream.width / 2 + 1.2) || world.lakeAt(gx, gz)) continue;
        place(landmark(models.wildernessSign, 2.4), gx, gz, -fx / fl, -fz / fl);
        break;
      }
      // the trailhead sign stands at the lot, on the car side
      place(landmark(models.trailheadSign, 2.2), th.x + (fz / fl) * 6, th.z - (fx / fl) * 6, -fx / fl, -fz / fl);
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
        vec2 amb = flowDetail(uFlowMap, vWaveXZ, uWT, fl, 1.15) * 1.25 + windSea(vWaveXZ, uWT) * 0.7 + rainRings(vWaveXZ, uWT, uRainAmt);
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
    const p = st.pts, half = st.width / 2;
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
        flow[(i * 2 + s) * 2] = dx * down; flow[(i * 2 + s) * 2 + 1] = dz * down;
        pos[k] = p[i][0] + dz * half * sign; pos[k + 1] = p[i][2]; pos[k + 2] = p[i][1] - dx * half * sign;
        uv[(i * 2 + s) * 2] = along / 3; uv[(i * 2 + s) * 2 + 1] = s * st.width / 3;
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
  return { group, chunks, update(t) { normalMap.offset.set(-t * 0.5, Math.sin(t * 0.7) * 0.05); } };
}

/** The two cars, nose to tail along the road. Anyone can drive either. */
export const CAR_ORDER = ['civic', 'maverick'];
const CAR_LENGTH = 4.6, CAR_SPACING = 5.7;   // nose to tail with a gap (the cars were 3.4 m apart, shorter than a car, so they overlapped)

/** A landmark model from assets/landmarks, scaled to `height` metres tall and standing on the origin. */
function landmark(template, height) {
  const box = new THREE.Box3().setFromObject(template);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = height / size.y;
  const inner = template.clone(true);
  inner.scale.setScalar(s);
  inner.position.set(-c.x * s, -box.min.y * s, -c.z * s);
  const g = new THREE.Group();
  g.add(inner);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
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
