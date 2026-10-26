import * as THREE from 'three';
import { carModel } from './features.js';

// The opening cinematic of a new game: the truck and the car come down the real road to the trailhead and park where the
// two cars always stand, and the friends climb out. An aerial shot follows the pair from above and behind (the camera
// swings round and sinks as they come in), then a low shot from ahead of the lot watches them pull up, and the three step out.
//
// It is all done on the road data: `world.starts[trailhead]` holds the road's points in driving order (the way the parked cars
// face), where the cars stand and which side of the road they are on. The drive is resampled at 1 m, smoothed, and each
// vehicle follows it at a speed that comes from where it must stop (cruise, then a steady brake), swinging out of the lane
// into its parking place over the last few metres and ending exactly where the parked car stands (the parked copy is hidden
// until the drive ends, then the real one takes over unnoticed).
//
// This module makes no decisions about the game: main.js owns the characters (it is told when each person steps out and
// where to) and the camera belongs to this module only while it runs.

const CRUISE = 15;        // m/s on the road
const BRAKE = 2.3;        // m/s^2
const ACCEL = 2.8;
const DRIVE = 215;        // metres of road driven on camera
const GAP = 13;           // metres from the truck to the car behind it, at speed
const CUT_AT = 66;        // the low shot takes over when the truck is this close to its place
const SHOT_MAX = 15;      // seconds: the aerial shot never lasts longer than this
const SETTLE = 0.9;       // seconds of stillness after the engines stop, before the first door opens
const EXITS = [0, 0.75, 1.35];   // when each of the three steps out (after SETTLE)
const WALK = 4.4;         // seconds they walk before you have the controls
const FADE = 0.42;        // seconds of fade to black at the cut and at the end

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const angleLerp = (a, b, t) => { let d = b - a; d = Math.atan2(Math.sin(d), Math.cos(d)); return a + d * t; };

export class Intro {
  constructor(world, scene, camera, models) {
    this.world = world; this.scene = scene; this.camera = camera; this.models = models;
    this.active = false;
    this.cars = [];
    this.focus = new THREE.Vector3();
    this.engine = 0;
    this._look = new THREE.Vector3(); this._p = new THREE.Vector3();
    // the overlays: letterbox bars, a fade to black, the title and the skip hint
    const el = document.createElement('div');
    el.id = 'cine';
    el.innerHTML = '<div class="cine-bar top"></div><div class="cine-bar bottom"></div><div id="cine-fade"></div>' +
      '<div id="cine-title"><div id="cine-place"></div><div id="cine-sub"></div></div><div id="cine-skip">Press any key to skip</div>';
    document.body.appendChild(el);
    this.el = el;
    this.fadeEl = el.querySelector('#cine-fade');
  }

  /** Build the drive for this trailhead. False when there is no road or parking for it (the game then starts as it always did). */
  prepare(th) {
    const st = this.world.starts?.[th.name];
    if (!st || !st.road || !st.spot || !st.cars || st.cars.length < 2) return false;
    // the road's points in driving order up to the lot, with the roads that join its start chained on in front of it, so the
    // drive begins far enough back to be worth watching (a mapped road can be cut into short pieces)
    let src = st.road.slice(0, Math.min(st.road.length, st.k + 14)), k = st.k;
    const used = new Set([st.roadRef]);
    const arc = (pts) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
    for (let guard = 0; guard < 10 && arc(src.slice(0, k + 1)) < DRIVE + 80; guard++) {
      const [fx, fz] = src[0];
      let best = null, bd = 30;
      for (const t of this.world.trails) {
        if (t.kind === 'trail' || used.has(t) || t.dense.length < 2) continue;
        const a = t.dense[0], b = t.dense[t.dense.length - 1];
        const da = Math.hypot(a[0] - fx, a[1] - fz), db = Math.hypot(b[0] - fx, b[1] - fz);
        if (db < bd) { bd = db; best = { t, pts: t.dense }; }            // it ends where this road starts: already in driving order
        if (da < bd) { bd = da; best = { t, pts: [...t.dense].reverse() }; }
      }
      if (!best) break;
      used.add(best.t);
      src = [...best.pts, ...src];
      k += best.pts.length;
    }
    if (src.length < 4) return false;
    // arc length along the source polyline
    const cum = [0];
    for (let i = 1; i < src.length; i++) cum.push(cum[i - 1] + Math.hypot(src[i][0] - src[i - 1][0], src[i][1] - src[i - 1][1]));
    const sPark = cum[Math.min(k, cum.length - 1)];
    // a straight run past the end, so the cars can swing in beyond the last road point
    const [ex, ez] = src[src.length - 1], [fx, fz] = src[src.length - 4];
    const el = Math.hypot(ex - fx, ez - fz) || 1, dx = (ex - fx) / el, dz = (ez - fz) / el;
    const total = cum[cum.length - 1] + 40;
    const at = (s) => {                                  // the source polyline at arc s, extended straight at both ends
      if (s >= cum[cum.length - 1]) return [ex + dx * (s - cum[cum.length - 1]), ez + dz * (s - cum[cum.length - 1])];
      if (s <= 0) { const [ax, az] = src[0], [bx, bz] = src[3]; const l = Math.hypot(bx - ax, bz - az) || 1; return [ax + ((ax - bx) / l) * -s, az + ((az - bz) / l) * -s]; }
      let i = 1; while (cum[i] < s) i++;
      const u = (s - cum[i - 1]) / Math.max(cum[i] - cum[i - 1], 1e-6);
      return [lerp(src[i - 1][0], src[i][0], u), lerp(src[i - 1][1], src[i][1], u)];
    };
    const s0 = Math.max(-60, sPark - DRIVE - 60);
    const n = Math.floor(total - s0);
    let P = Array.from({ length: n }, (_, j) => at(s0 + j));
    for (let pass = 0; pass < 2; pass++) {               // round the corners a vehicle could not take
      P = P.map((_, j) => { let x = 0, z = 0, c = 0; for (let m = -7; m <= 7; m++) { const q = P[clamp(j + m, 0, n - 1)]; x += q[0]; z += q[1]; c++; } return [x / c, z / c]; });
    }
    this.P = P;
    this.T = P.map((_, j) => { const a = P[Math.max(0, j - 1)], b = P[Math.min(n - 1, j + 1)]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; });
    this.N = this.T.map(([tx, tz]) => [-tz, tx]);
    // where each car stands, in road coordinates (arc index, signed sideways distance)
    const near = (x, z) => { let bj = 0, bd = Infinity; P.forEach(([px, pz], j) => { const d = (px - x) ** 2 + (pz - z) ** 2; if (d < bd) { bd = d; bj = j; } }); return bj; };
    this.stops = st.cars.map((c) => {
      const j = near(c.x, c.z), [px, pz] = P[j], [nx, nz] = this.N[j];
      return { j, side: (c.x - px) * nx + (c.z - pz) * nz, x: c.x, z: c.z, yaw: c.yaw, obj: c.obj, model: c.model, start: c.start };
    });
    this.st = st;
    this.th = th;
    return this.stops[0].j > 60 && this.stops[1].j > 60;
  }

  #road(s) {                                             // position, tangent and normal at arc s (fractional index)
    const P = this.P, i = clamp(Math.floor(s), 0, P.length - 2), u = clamp(s - i, 0, 1);
    return {
      x: lerp(P[i][0], P[i + 1][0], u), z: lerp(P[i][1], P[i + 1][1], u),
      tx: lerp(this.T[i][0], this.T[i + 1][0], u), tz: lerp(this.T[i][1], this.T[i + 1][1], u),
      nx: lerp(this.N[i][0], this.N[i + 1][0], u), nz: lerp(this.N[i][1], this.N[i + 1][1], u),
    };
  }

  /** Where a vehicle is at arc s: on the road, swung out into its place over the last metres. */
  #place(v, s) {
    const r = this.#road(s);
    const k = smooth(v.stop.j - 34, v.stop.j - 2, s);       // eases out of the lane, with no sideways speed left at the end
    return { x: r.x + r.nx * v.stop.side * k, z: r.z + r.nz * v.stop.side * k };
  }

  #pose(v) {
    const w = this.world, a = this.#place(v, v.s - 0.9), b = this.#place(v, v.s + 0.9), c = this.#place(v, v.s);
    let yaw = Math.atan2(b.x - a.x, b.z - a.z);
    yaw = angleLerp(yaw, v.stop.yaw, smooth(v.stop.j - 7, v.stop.j, v.s));
    const sx = Math.sin(yaw), cz = Math.cos(yaw);
    const hN = w.height(c.x + sx * 1.9, c.z + cz * 1.9), hT = w.height(c.x - sx * 1.9, c.z - cz * 1.9);
    const hL = w.height(c.x + cz * 0.9, c.z - sx * 0.9), hR = w.height(c.x - cz * 0.9, c.z + sx * 0.9);
    const bob = Math.sin(this.t * 7 + v.phase) * 0.012 * clamp(v.v / CRUISE, 0, 1);
    v.obj.position.set(c.x, (hN + hT + hL + hR) / 4 - 0.05 + bob, c.z);
    v.obj.rotation.set(Math.atan2(hT - hN, 3.8), yaw, Math.atan2(hL - hR, 1.8), 'YXZ');
    v.x = c.x; v.z = c.z; v.yaw = yaw;
  }

  /** Start: put the two vehicles on the road and take over the camera. */
  begin({ place = '', sub = 'Rawah Wilderness', onExit, onEnd } = {}) {
    const [civic, truck] = this.stops;
    this.cars = [truck, civic].map((stop, idx) => {
      const obj = carModel(this.models[stop.model]);
      this.scene.add(obj);
      return { stop, obj, v: 0, s: 0, phase: idx * 2.1, done: false };
    });
    const [tr, ci] = this.cars;
    tr.s = Math.max(10, truck.j - DRIVE);
    ci.s = Math.max(2, tr.s - GAP);
    for (const c of this.stops) if (c.obj) c.obj.visible = false;      // the parked pair, until these arrive
    this.t = 0; this.shot = 'air'; this.shotT = 0; this.stoppedAt = null; this.exited = 0; this.endAt = null;
    this.onExit = onExit; this.onEnd = onEnd;
    this.active = true; this.finished = false;
    this.el.classList.add('on');
    this.el.querySelector('#cine-place').textContent = place;
    this.el.querySelector('#cine-sub').textContent = sub;
    this.#fade(0, 0);
    for (const c of this.cars) this.#pose(c);
  }

  #fade(a, dur = FADE) { this.fadeEl.style.transition = `opacity ${dur}s`; this.fadeEl.style.opacity = String(a); }

  /** Where person `i` (0 you, 1 your friend from the car, 2 your friend from the truck) steps out, and where they head. */
  doors() {
    const [civic, truck] = this.stops;
    const out = [];
    const side = (stop, along) => {                       // beside the car, on the side toward the road
      const r = this.#road(stop.j), s = -Math.sign(stop.side) || 1;
      return { x: stop.x + r.nx * s * 1.35 + r.tx * along, z: stop.z + r.nz * s * 1.35 + r.tz * along, nx: r.nx * s, nz: r.nz * s, tx: r.tx, tz: r.tz };
    };
    const a = side(civic, 0.5), b = side(civic, -1.0), c = side(truck, 0.5);
    const sp = civic.start;
    out.push({ ...a, tx2: sp.x, tz2: sp.z });
    out.push({ ...b, tx2: sp.x - a.tx * 1.7 + a.nx * 0.5, tz2: sp.z - a.tz * 1.7 + a.nz * 0.5 });
    out.push({ ...c, tx2: sp.x + a.tx * 2.6 + a.nx * 0.4, tz2: sp.z + a.tz * 2.6 + a.nz * 0.4 });
    return out.map((d) => ({ x: d.x, z: d.z, yaw: Math.atan2(d.nx, d.nz), tx: d.tx2, tz: d.tz2 }));
  }

  skip() {
    if (!this.active || this.finished || this.endAt !== null) return;
    this.skipped = true;
    this.endAt = this.t;                                  // fade out now
    this.#fade(1, 0.3);
  }

  /** Advance one frame; returns { focus, engine, done }. The camera is set here. */
  update(dt) {
    if (!this.active) return { focus: this.focus, engine: 0, done: true };
    this.t += dt; this.shotT += dt;
    const [tr, ci] = this.cars;
    let moving = 0;
    for (const c of this.cars) {
      const left = c.stop.j - c.s;
      const target = left <= 0.03 ? 0 : Math.min(CRUISE, Math.sqrt(2 * BRAKE * left) + 0.35);
      c.v = Math.min(target, c.v + ACCEL * dt);
      c.s = Math.min(c.stop.j, c.s + c.v * dt);
      if (c.stop.j - c.s < 0.03) { c.s = c.stop.j; c.v = 0; }
      this.#pose(c);
      moving = Math.max(moving, c.v);
    }
    this.engine = moving;
    // the aerial shot gives way to the low shot as the truck nears its place
    if (this.shot === 'air' && (tr.stop.j - tr.s < CUT_AT || this.shotT > SHOT_MAX)) { this.shot = 'cutting'; this.shotT = 0; this.#fade(1, FADE); }
    if (this.shot === 'cutting' && this.shotT > FADE) { this.shot = 'front'; this.shotT = 0; this.#fade(0, FADE); }
    if (this.stoppedAt === null && tr.v === 0 && ci.v === 0 && tr.s === tr.stop.j && ci.s === ci.stop.j) this.stoppedAt = this.t;
    if (this.stoppedAt !== null) {
      const u = this.t - this.stoppedAt - SETTLE;
      while (this.exited < 3 && u >= EXITS[this.exited]) { this.onExit?.(this.exited, this.doors()[this.exited]); this.exited++; }
      if (this.endAt === null && u >= EXITS[2] + WALK) { this.endAt = this.t; this.#fade(1, FADE); }
    }
    this.#camera(dt);
    // the title: in over the first seconds, out before the cut; the skip hint after a moment
    const tt = this.t;
    this.el.querySelector('#cine-title').style.opacity = String(smooth(0.8, 1.8, tt) * (1 - smooth(5.6, 6.6, tt)));
    this.el.querySelector('#cine-skip').style.opacity = String(smooth(1.5, 2.5, tt) * (this.skipped ? 0 : 0.8));
    if (this.endAt !== null && this.t - this.endAt >= FADE + 0.05 && !this.finished) this.#finish();
    return { focus: this.focus, engine: this.engine, done: this.finished };
  }

  #camera(dt) {
    const cam = this.camera, w = this.world;
    const [tr, ci] = this.cars;
    let fov = 58;
    if (this.shot === 'air' || this.shot === 'cutting') {      // the aerial shot holds until the screen is black
      // high and behind, swinging round to the side and sinking as they drive: a drone following the pair
      const u = clamp(this.t / 11, 0, 1), e = u * u * (3 - 2 * u);
      const mid = this._p.set((tr.x + ci.x) / 2, 0, (tr.z + ci.z) / 2);
      const r = this.#road(tr.s), back = lerp(84, 27, e), up = lerp(46, 15, e), swing = lerp(0.05, 1.0, e);
      // behind along the road, then rotating toward the side the lot is on
      const sd = Math.sign(tr.stop.side) || 1;
      const bx = -r.tx * Math.cos(swing) + r.nx * sd * Math.sin(swing), bz = -r.tz * Math.cos(swing) + r.nz * sd * Math.sin(swing);
      cam.position.set(mid.x + bx * back, 0, mid.z + bz * back);
      cam.position.y = Math.max(w.height(mid.x, mid.z) + up, w.height(cam.position.x, cam.position.z) + 14);
      this._look.set(mid.x + r.tx * 6, w.height(mid.x, mid.z) + 0.8, mid.z + r.tz * 6);
      fov = lerp(64, 52, e);
    } else {
      // low, ahead of the lot, looking back along the road at them pulling in; a slow push in
      const [civic, truck] = this.stops;
      const j = truck.j, r = this.#road(j + 17), sd = Math.sign(truck.side) || 1;
      const k = clamp(this.shotT / 9, 0, 1);
      // on the road's edge, where the grass does not grow, at standing height
      const cx = r.x + r.nx * truck.side * 0.2 - r.tx * k * 1.8, cz = r.z + r.nz * truck.side * 0.2 - r.tz * k * 1.8;
      cam.position.set(cx, w.height(cx, cz) + 1.55, cz);
      // follow the lead vehicle, then settle on the middle of the two when they have stopped
      const settle = smooth(0, 1, this.stoppedAt === null ? 0 : (this.t - this.stoppedAt) / 1.2);
      const fx = lerp(tr.x, (tr.x + ci.x) / 2, settle), fz = lerp(tr.z, (tr.z + ci.z) / 2, settle);
      this._look.set(fx, w.height(fx, fz) + 1.0, fz);
      fov = lerp(60, 50, clamp(this.shotT / 10, 0, 1));
      void sd; void civic;
    }
    cam.up.set(0, 1, 0);
    cam.lookAt(this._look);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
    this.focus.set(this._look.x, this._look.y, this._look.z);
  }

  #finish() {
    this.finished = true;
    this.#cleanup();
    this.onEnd?.();
  }

  #cleanup() {
    for (const c of this.cars) this.scene.remove(c.obj);
    for (const c of this.stops) if (c.obj) c.obj.visible = true;
    this.cars = [];
    this.active = false;
    this.el.classList.add('ending');                       // the bars slide away and the picture fades back in
    this.#fade(0, 0.6);
    clearTimeout(this.hideT);
    this.hideT = setTimeout(() => this.el.classList.remove('on', 'ending'), 900);
  }

  /** Abandon at once (leaving the game, restarting) without the ceremony. */
  abort() {
    if (!this.active) return;
    this.finished = true;
    this.#cleanup();
  }
}
