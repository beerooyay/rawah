import * as THREE from 'three';

// A guided hike: pick a place on the map and the shortest walk over the real
// trail and road network (the baked OpenStreetMap lines) is drawn on the ground
// ahead of you as a soft peach line that pulses toward the destination. Junctions
// join wherever two ways pass within JOIN metres; the first and last legs cross
// open country in a straight line.

const JOIN = 8, HASH = 12, STEP = 2, AHEAD = 260, MAXPTS = AHEAD + 8;

export class Route {
  constructor(world, scene) {
    this.world = world;
    this.on = false;
    this.name = '';
    this.left = 0;
    this.line = [];
    this.onArrive = () => {};
    this.k = 0; this.clock = 0; this.lost = 0;
    this.uT = { value: 0 };
    const pos = new Float32Array(MAXPTS * 6), rt = new Float32Array(MAXPTS * 4), idx = [];
    for (let i = 0; i < MAXPTS - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aRt', new THREE.BufferAttribute(rt, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xf6d3bd, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -4;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uT = this.uT;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aRt;\nvarying vec2 vRt;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRt = aRt;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vRt;\nuniform float uT;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          float e = 1.0 - abs(vRt.x);
          float pulse = 0.6 + 0.4 * sin(vRt.y * 0.35 - uT * 3.2);
          float fade = smoothstep(0.0, 8.0, vRt.y) * (1.0 - smoothstep(AHEAD_FADE, ${(AHEAD * STEP).toFixed(1)}, vRt.y));
          diffuseColor.a = clamp((pow(e, 1.3) * 0.8 + smoothstep(0.55, 1.0, e) * 0.9) * pulse * fade, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.96, 0.9), smoothstep(0.75, 1.0, e));`.replace('AHEAD_FADE', (AHEAD * STEP * 0.6).toFixed(1)));
    };
    mat.customProgramCacheKey = () => 'rawah-route';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  #graph() {
    if (this.g) return this.g;
    const xs = [], zs = [], tid = [], adj = [], hash = new Map();
    const link = (a, b, d) => { adj[a].push(b, d); adj[b].push(a, d); };
    this.world.trails.forEach((t, ti) => {
      t.pts.forEach(([x, z], i) => {
        const n = xs.push(x) - 1;
        zs.push(z); tid.push(ti); adj.push([]);
        if (i) link(n - 1, n, Math.hypot(x - xs[n - 1], z - zs[n - 1]));
        const key = `${Math.floor(x / HASH)},${Math.floor(z / HASH)}`;
        if (!hash.has(key)) hash.set(key, []);
        hash.get(key).push(n);
      });
    });
    for (let i = 0; i < xs.length; i++) {
      const cx = Math.floor(xs[i] / HASH), cz = Math.floor(zs[i] / HASH), best = new Map();
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of hash.get(`${cx + dx},${cz + dz}`) || []) {
          if (tid[j] === tid[i]) continue;
          const d = Math.hypot(xs[j] - xs[i], zs[j] - zs[i]);
          if (d < JOIN && (!best.has(tid[j]) || d < best.get(tid[j])[1])) best.set(tid[j], [j, d]);
        }
      }
      for (const [j, d] of best.values()) if (i < j || !adj[j].includes(i)) link(i, j, d + 1);
    }
    return (this.g = { xs, zs, adj });
  }

  #nearest(x, z) {
    const { xs, zs } = this.#graph();
    let b = 0, bd = Infinity;
    for (let i = 0; i < xs.length; i++) { const d = (xs[i] - x) ** 2 + (zs[i] - z) ** 2; if (d < bd) { bd = d; b = i; } }
    return b;
  }

  #path(a, b) {
    const { xs, zs, adj } = this.#graph(), n = xs.length;
    const cost = new Float32Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const hf = [], hv = [];
    const push = (f, v) => {
      let i = hf.push(f) - 1; hv.push(v);
      while (i > 0) { const p = (i - 1) >> 1; if (hf[p] <= hf[i]) break; [hf[p], hf[i]] = [hf[i], hf[p]]; [hv[p], hv[i]] = [hv[i], hv[p]]; i = p; }
    };
    const pop = () => {
      const v = hv[0], lf = hf.pop(), lv = hv.pop();
      if (hf.length) {
        hf[0] = lf; hv[0] = lv;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1, r = l + 1; let m = i;
          if (l < hf.length && hf[l] < hf[m]) m = l;
          if (r < hf.length && hf[r] < hf[m]) m = r;
          if (m === i) break;
          [hf[m], hf[i]] = [hf[i], hf[m]]; [hv[m], hv[i]] = [hv[i], hv[m]]; i = m;
        }
      }
      return v;
    };
    const h = (i) => Math.hypot(xs[i] - xs[b], zs[i] - zs[b]);
    cost[a] = 0; push(h(a), a);
    while (hf.length) {
      const u = pop();
      if (done[u]) continue;
      done[u] = 1;
      if (u === b) break;
      const e = adj[u];
      for (let k = 0; k < e.length; k += 2) {
        const v = e[k], c = cost[u] + e[k + 1];
        if (c < cost[v]) { cost[v] = c; prev[v] = u; push(c + h(v), v); }
      }
    }
    if (!done[b]) return null;
    const out = [];
    for (let v = b; v >= 0; v = prev[v]) out.push([xs[v], zs[v]]);
    return out.reverse();
  }

  /** Plan a walk from `from` to the place `dest` ({ name, x, z }) and start drawing it. */
  go(from, dest) {
    const a = this.#nearest(from.x, from.z), b = this.#nearest(dest.x, dest.z);
    const path = this.#path(a, b) || [];
    const raw = [[from.x, from.z], ...path, [dest.x, dest.z]];
    const X = [], Z = [], S = [];
    let acc = 0;
    for (let i = 0; i < raw.length - 1; i++) {
      const [ax, az] = raw[i], [bx, bz] = raw[i + 1], l = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(l / STEP));
      for (let s = 0; s < n; s++) { X.push(ax + ((bx - ax) * s) / n); Z.push(az + ((bz - az) * s) / n); S.push(acc + (l * s) / n); }
      acc += l;
    }
    X.push(dest.x); Z.push(dest.z); S.push(acc);
    // sweep out wiggles from nearest-node snapping: smooth the polyline a little
    for (let p = 0; p < 2; p++) for (let i = 1; i < X.length - 1; i++) { X[i] = X[i] * 0.5 + (X[i - 1] + X[i + 1]) * 0.25; Z[i] = Z[i] * 0.5 + (Z[i - 1] + Z[i + 1]) * 0.25; }
    this.X = X; this.Z = Z; this.S = S;
    this.line = [];
    for (let i = 0; i < X.length; i += 5) this.line.push([X[i], Z[i]]);
    this.line.push([dest.x, dest.z]);
    this.dest = dest;
    this.name = dest.name;
    this.k = 0; this.clock = 1; this.lost = 0; this.on = true;
    this.left = acc;
    this.mesh.visible = true;
    return acc;
  }

  clear() {
    this.on = false; this.line = []; this.mesh.visible = false; this.mesh.geometry.setDrawRange(0, 0);
  }

  update(dt, pos, t) {
    this.uT.value = t;
    if (!this.on) return;
    const { X, Z, S } = this;
    let k = this.k, bd = Infinity;
    for (let i = Math.max(0, this.k - 4); i < Math.min(X.length, this.k + 90); i++) {
      const d = (X[i] - pos.x) ** 2 + (Z[i] - pos.z) ** 2;
      if (d < bd) { bd = d; k = i; }
    }
    this.k = k;
    this.left = S[S.length - 1] - S[k];
    if (this.left < 9) { const name = this.name; this.clear(); this.onArrive(name); return; }
    // wandered off the line for good: plan again from where you stand
    this.lost = bd > 55 * 55 ? this.lost + dt : 0;
    if (this.lost > 3) { this.go(pos, this.dest); return; }
    if ((this.clock += dt) < 0.3) return;
    this.clock = 0;
    const world = this.world, n = Math.min(MAXPTS, X.length - k);
    const P = this.mesh.geometry.attributes.position, R = this.mesh.geometry.attributes.aRt;
    for (let i = 0; i < n; i++) {
      const j = k + i, a = Math.max(0, j - 1), b = Math.min(X.length - 1, j + 1);
      const tx = X[b] - X[a], tz = Z[b] - Z[a], tl = Math.hypot(tx, tz) || 1, nx = -tz / tl, nz = tx / tl;
      for (let s = 0; s < 2; s++) {
        const o = s ? 1.4 : -1.4, x = X[j] + nx * o, z = Z[j] + nz * o, v = i * 2 + s;
        P.setXYZ(v, x, world.height(x, z) + 0.34, z);
        R.setXY(v, s ? 1 : -1, S[j] - S[k]);
      }
    }
    P.needsUpdate = R.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, Math.max(0, n - 1) * 6);
  }
}
