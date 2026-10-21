import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from './noise.js';

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

export function buildLakes(world) {
  const normalMap = waterNormals();
  normalMap.repeat.set(1 / 9, 1 / 9);
  const mat = new THREE.MeshPhongMaterial({
    color: 0x173c48, specular: 0xffffff, shininess: 160, normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55), transparent: true, opacity: 0.9,
  });
  const uniforms = { uSky: { value: new THREE.Color(0x9cc0e0) }, uDeep: { value: new THREE.Color(0x0d2a36) } };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSky;\nuniform vec3 uDeep;')
      .replace('#include <opaque_fragment>', `#include <opaque_fragment>
        float facing = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
        float fres = pow(1.0 - facing, 3.0);
        gl_FragColor.rgb = mix(mix(uDeep, gl_FragColor.rgb, 0.75), uSky, 0.12 + fres * 0.7);
        gl_FragColor.a = mix(0.82, 0.98, fres);`);
  };
  const group = new THREE.Group();
  const cell = world.cell, half = world.N / 2;
  for (const lake of world.lakes) {
    const pos = [], uv = [], idx = [];
    for (const [r, c0, c1] of lake.runs) {
      const x0 = (c0 - half - 0.5) * cell, x1 = (c1 - half + 0.5) * cell;
      const z0 = (r - half - 0.5) * cell, z1 = (r - half + 0.5) * cell;
      const b = pos.length / 3;
      pos.push(x0, lake.level, z0, x1, lake.level, z0, x1, lake.level, z1, x0, lake.level, z1);
      uv.push(x0, -z0, x1, -z0, x1, -z1, x0, -z1);
      idx.push(b, b + 3, b + 2, b, b + 2, b + 1);
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
  }
  return {
    group, uniforms,
    update(t) { normalMap.offset.set(t * 0.004, t * 0.0025); },
  };
}

// ------------------------------------------------------------------ trails
/** Material that nudges geometry toward the camera with distance, so ribbons
 *  stay on top of coarse far-LOD terrain without z-fighting up close. */
function draped(params) {
  const mat = new THREE.MeshLambertMaterial(params);
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
      float dCam = length(mvPosition.xyz);
      mvPosition.xyz -= normalize(mvPosition.xyz) * (0.04 + dCam * 0.0045);
      gl_Position = projectionMatrix * mvPosition;`);
  };
  mat.customProgramCacheKey = () => 'rawah-draped';
  return mat;
}

export function buildTrails(world) {
  const group = new THREE.Group();
  const mat = draped({ vertexColors: true });
  const tones = { road: [0.56, 0.5, 0.42], trail: [0.43, 0.35, 0.26] };
  for (const t of world.trails) {
    if (!t.width) continue;
    const pts = t.dense, half = t.width / 2;
    const pos = new Float32Array(pts.length * 2 * 3), col = new Float32Array(pts.length * 2 * 3), nor = new Float32Array(pts.length * 2 * 3);
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
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  group.add(buildCairns(world));
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
    const every = t.kind === 'route' ? 30 : 70;
    let acc = 0;
    for (let i = 1; i < t.dense.length; i++) {
      const [x, z] = t.dense[i];
      acc += Math.hypot(x - t.dense[i - 1][0], z - t.dense[i - 1][1]);
      if (acc < every) continue;
      const e = world.height(x, z);
      if (e < world.treeline(x, z) + 30) continue;
      acc = 0;
      const off = t.kind === 'route' ? 0 : 1.6;
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
    g.font = `${big && i === 0 ? 700 : 600} ${big && i === 0 ? lh * 0.8 : lh * 0.56}px "Trebuchet MS", sans-serif`;
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

function sign(lines, width, height, postH, big) {
  const grp = new THREE.Group();
  const wood = new THREE.MeshLambertMaterial({ color: 0x4b3424 });
  const board = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.07), [
    wood, wood, wood, wood,
    new THREE.MeshLambertMaterial({ map: signTexture(lines, 512, Math.round(512 * height / width), big) }),
    new THREE.MeshLambertMaterial({ map: signTexture(lines, 512, Math.round(512 * height / width), big) }),
  ]);
  board.position.y = postH - height / 2;
  board.castShadow = true;
  grp.add(board);
  const p = new THREE.Mesh(post(postH + 0.2), wood);
  p.position.set(-width / 2 + 0.15, -0.2, -0.08);
  const q = p.clone(); q.position.x = width / 2 - 0.15;
  grp.add(p, q);
  return grp;
}

const fmtDist = (m) => `${(m / 1000).toFixed(1)} km · ${(m / 1609.34).toFixed(1)} mi`;

function trailLength(t) {
  let len = 0;
  for (let i = 1; i < t.dense.length; i++) len += Math.hypot(t.dense[i][0] - t.dense[i - 1][0], t.dense[i][1] - t.dense[i - 1][1]);
  return len;
}

export function buildSigns(world) {
  const group = new THREE.Group();
  const place = (obj, x, z, faceX, faceZ) => {
    obj.position.set(x, world.height(x, z) - 0.05, z);
    obj.rotation.y = Math.atan2(faceX, faceZ);
    group.add(obj);
  };
  // junction signs where each trail leaves the network
  for (const t of world.trails) {
    if (t.kind === 'road' || t.dense.length < 4) continue;
    const [x0, z0] = t.dense[0], [x1, z1] = t.dense[3];
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1;
    const s = sign([t.to, fmtDist(trailLength(t))], 1.5, 0.5, 1.4);
    place(s, x0 + (dx / l) * 3 - (dz / l) * 2.2, z0 + (dz / l) * 3 + (dx / l) * 2.2, -dz / l, dx / l);
  }
  // the main trailhead gets the wilderness boundary sign and your car
  const th = world.places.find((p) => p.kind === 'trailhead');
  if (th) {
    const big = sign(['RAWAH WILDERNESS', 'Roosevelt National Forest', 'Leave No Trace'], 3.2, 1.6, 2.6, true);
    const road = world.trails.find((t) => t.kind === 'road');
    let best = 0, bd = Infinity;
    road.dense.forEach(([x, z], i) => { const d = Math.hypot(x - th.x, z - th.z); if (d < bd) { bd = d; best = i; } });
    const [ax, az] = road.dense[Math.max(0, best - 2)], [bx, bz] = road.dense[Math.min(road.dense.length - 1, best + 2)];
    const rx = bx - ax, rz = bz - az, rl = Math.hypot(rx, rz) || 1;
    // side of the road the trail leaves from
    const first = world.trails.find((t) => t.kind === 'trail');
    const side = first ? Math.sign((first.dense[6][0] - th.x) * (-rz / rl) + (first.dense[6][1] - th.z) * (rx / rl)) || 1 : 1;
    const nx = (-rz / rl) * side, nz = (rx / rl) * side;
    place(big, th.x + nx * 9 + (rx / rl) * 4, th.z + nz * 9 + (rz / rl) * 4, -nx, -nz);
    const car = buildCar();
    const cx = th.x + nx * 5.5 - (rx / rl) * 6, cz = th.z + nz * 5.5 - (rz / rl) * 6;
    place(car, cx, cz, rx / rl, rz / rl);
    world.carSpot = { x: cx, z: cz, faceX: -nx, faceZ: -nz };
    // where you step out: beside the car, on the trail side, by the sign
    world.startSpot = { x: th.x + nx * 7 + (rx / rl) * 0.5, z: th.z + nz * 7 + (rz / rl) * 0.5 };
  }
  return group;
}

function buildCar() {
  const g = new THREE.Group();
  const paint = new THREE.MeshLambertMaterial({ color: 0x2f5d50 });
  const glass = new THREE.MeshPhongMaterial({ color: 0x1b2730, shininess: 90, specular: 0x8899aa });
  const dark = new THREE.MeshLambertMaterial({ color: 0x1d1d1f });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.75, 4.5), paint);
  body.position.y = 0.75;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.62, 2.9), glass);
  cab.position.set(0, 1.42, -0.3);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 2.7), paint);
  roof.position.set(0, 1.76, -0.3);
  const rack = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 2.2), dark);
  rack.position.set(0, 1.86, -0.3);
  g.add(body, cab, roof, rack);
  for (const [x, z] of [[-0.85, 1.4], [0.85, 1.4], [-0.85, -1.4], [0.85, -1.4]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 12), dark);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.36, z);
    g.add(w);
  }
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return g;
}
