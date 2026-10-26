import * as THREE from 'three';
import { clamp } from './noise.js';

// Fishing. Stand at a lake, [T] to cast where you're looking, wait for the
// bobber to go under, [Space] to set the hook, then fight the fish: it pulls
// to one side and then the other, and you lean the opposite way ([A]/[D], or
// swing the mouse) while holding [Space] to reel. Reel against a pull you
// haven't answered and the line tightens; let it go red and it snaps. Keep the
// line slack too long and the fish spits the hook. Species follow what lives in
// the Rawah lakes by elevation: brook, Colorado River cutthroat, rainbow and brown.
//
// The rod is a four-piece chain that bends with the line tension, the line
// sags into a curve that tightens as it loads, and the bobber, ripples and the
// fish itself are all drawn in the scene.

const SPECIES = {
  brook: { name: 'Brook trout', cm: [17, 38], back: 0x4a5a38, belly: 0xe0873a, fin: 0xe86a2a },
  cutthroat: { name: 'Colorado River cutthroat', cm: [24, 50], back: 0x8e8c4c, belly: 0xd9c58a, fin: 0xc9503a },
  rainbow: { name: 'Rainbow trout', cm: [24, 54], back: 0x687b63, belly: 0xe6dada, fin: 0xb8b8a8 },
  brown: { name: 'Brown trout', cm: [26, 60], back: 0x7a6234, belly: 0xe0c98b, fin: 0xb98a4a },
};

/** What bites at this elevation (the lake surface, metres). */
function rollSpecies(level, r) {
  if (level > 3350) return r < 0.7 ? 'cutthroat' : 'brook';
  if (level > 3000) return r < 0.5 ? 'brook' : r < 0.85 ? 'cutthroat' : 'rainbow';
  return r < 0.35 ? 'brown' : r < 0.7 ? 'rainbow' : 'brook';
}

function rollFish(level) {
  const key = rollSpecies(level, Math.random());
  const s = SPECIES[key];
  const u = Math.pow(Math.random(), 1.7);              // most fish are middling; a few are big
  const cm = Math.round(s.cm[0] + (s.cm[1] - s.cm[0]) * u);
  return { key, name: s.name, cm, kg: +(1.1e-5 * cm ** 3).toFixed(2), size: u };
}

const REACH = [4.5, 15];      // how far you can cast, metres
const WAIT = [3.5, 9.5];      // seconds to a bite
const HOOK_WINDOW = 1.5;
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Fishing {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.state = 'idle';       // idle | cast | wait | bite | fight | land | show
    this.t = 0;
    this.hint = '';
    this.events = [];
    this.log = { caught: 0, best: null, species: {} };
    this.origin = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.bobber = new THREE.Vector3();
    this.lineEnd = new THREE.Vector3();
    this.focus = new THREE.Vector3();   // where the fish is, for the camera to follow while it's on
    this.level = 0;
    this.up = 0.9; this.bend = 0; this.tension = 0;
    this.castYaw = 0;
    this.#buildRod();
    this.#buildLine();
    this.#buildBobber();
    this.#buildRipples();
    this.#buildFish();
    this.ui = document.getElementById('fishing');
  }

  get locked() { return this.state === 'bite' || this.state === 'fight' || this.state === 'land'; }
  get busy() { return this.state !== 'idle'; }

  // ---------------------------------------------------------------- scene objects
  #buildRod() {
    this.rod = new THREE.Group();
    const wood = new THREE.MeshLambertMaterial({ color: 0x4a3524 }), cork = new THREE.MeshLambertMaterial({ color: 0xb98e5a });
    const steel = new THREE.MeshLambertMaterial({ color: 0x9a9da0 });
    const L = 0.5, N = 4;
    const cyl = (r0, r1, len, mat, z) => {
      const g = new THREE.CylinderGeometry(r1, r0, len, 7);   // top (toward the tip) is the thin end
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0, -len / 2 + z);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true;
      return m;
    };
    const grip = cyl(0.026, 0.022, 0.3, cork, 0.15);
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 10), steel);
    reel.rotation.z = Math.PI / 2; reel.position.set(0.04, -0.05, -0.08);
    this.rod.add(grip, reel);
    this.segs = [];
    let parent = this.rod;
    for (let i = 0; i < N; i++) {
      const seg = new THREE.Group();
      if (i) seg.position.z = -L;
      seg.add(cyl(0.017 - i * 0.0032, 0.017 - (i + 1) * 0.0032, L, wood, 0));
      parent.add(seg);
      this.segs.push(seg);
      parent = seg;
    }
    this.tip = new THREE.Object3D();
    this.tip.position.z = -L;
    parent.add(this.tip);
    this.rod.rotation.order = 'YXZ';
    this.rod.visible = false;
    this.scene.add(this.rod);
  }

  #buildLine() {
    this.linePts = 28;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.linePts * 3), 3));
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xe8ece8, transparent: true, opacity: 0.75 }));
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.scene.add(this.line);
  }

  #buildBobber() {
    this.bob = new THREE.Group();
    const red = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xd8372b }));
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.085, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xf3efe6 }));
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.14, 5), new THREE.MeshLambertMaterial({ color: 0xf3efe6 }));
    stem.position.y = 0.13;
    this.bob.add(red, white, stem);
    this.bob.visible = false;
    this.scene.add(this.bob);
  }

  #buildRipples() {
    const geo = new THREE.RingGeometry(0.1, 0.14, 28);
    geo.rotateX(-Math.PI / 2);
    this.ripples = Array.from({ length: 6 }, () => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }));
      m.visible = false; m.renderOrder = 2; m.userData.age = 1;
      this.scene.add(m);
      return m;
    });
  }

  ripple(x, y, z, size = 1) {
    this.onRipple?.(x, z, size);   // the live wave field (main.js) takes it too
    const r = this.ripples.find((m) => m.userData.age >= 1) || this.ripples[0];
    r.position.set(x, y + 0.02, z);
    r.userData.age = 0; r.userData.size = size;
    r.visible = true;
  }

  #buildFish() {
    this.fish = new THREE.Group();
    this.fishParts = {};
    const back = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), new THREE.MeshLambertMaterial({ color: 0x4a5a38 }));
    back.scale.set(0.2, 0.24, 1);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), new THREE.MeshLambertMaterial({ color: 0xe0873a }));
    belly.scale.set(0.19, 0.14, 0.96); belly.position.y = -0.07;
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.2, 4), new THREE.MeshLambertMaterial({ color: 0x4a5a38 }));
    tail.rotation.x = -Math.PI / 2; tail.scale.set(0.6, 1, 0.12); tail.position.z = 0.55;
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 3), new THREE.MeshLambertMaterial({ color: 0xe86a2a }));
    fin.rotation.x = Math.PI / 2; fin.position.set(0, -0.07, -0.18); fin.scale.set(0.4, 1, 0.2);
    const eyeMat = new THREE.MeshLambertMaterial({ color: 0x0c0c0c, emissive: 0x050505 });
    for (const x of [-0.08, 0.08]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.028, 8, 6), eyeMat);
      eye.position.set(x, 0.06, -0.36);
      this.fish.add(eye);
    }
    this.fish.add(back, belly, tail, fin);
    Object.assign(this.fishParts, { back, belly, tail, fin });
    this.fish.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.fish.visible = false;
    this.scene.add(this.fish);
  }

  #dress(f) {
    const s = SPECIES[f.key], p = this.fishParts;
    for (const [part, hex] of [[p.back, s.back], [p.tail, s.back], [p.belly, s.belly], [p.fin, s.fin]]) {
      part.material.color.setHex(hex);
      part.material.emissive.setHex(hex).multiplyScalar(0.7);   // lit from within a little, so it never goes to a black silhouette against the water
    }
    this.fishScale = f.cm / 100 * 1.8;
    this.fish.scale.setScalar(this.fishScale);   // 1 unit of model length is a metre of fish, drawn large so you can see it from the bank
  }

  // ---------------------------------------------------------------- casting
  /** Farthest open water in front of you inside casting range. */
  #findWater(pos, yaw) {
    const w = this.world, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    let frozen = false;
    for (let d = REACH[1]; d >= REACH[0]; d -= 0.5) {
      const x = pos.x + fx * d, z = pos.z + fz * d;
      const lake = w.lakeAt(x, z);
      if (!lake) continue;
      if (lake.level >= w.iceLine) { frozen = true; continue; }
      if (lake.level - w.height(x, z) > 0.9) return { x, z, level: lake.level, lake };
    }
    return { frozen };
  }

  /** Is there open water to cast at, straight ahead? (for the prompt) */
  spotAhead(view) { return this.state === 'idle' && view.mode === 'walk' && !!this.#findWater(view.pos, view.yaw).lake; }

  /** [T]: cast, or reel in. */
  toggle(view) {
    if (this.state === 'idle') {
      if (view.mode !== 'walk' || !view.grounded) { this.#toast('Find your footing first.'); return; }
      const spot = this.#findWater(view.pos, view.yaw);
      if (!spot.lake) {
        this.#toast(spot.frozen ? 'The lake is frozen over.' : 'Face open water within reach to cast.');
        return;
      }
      this.origin.copy(view.pos);
      this.target.set(spot.x, spot.level, spot.z);
      this.level = spot.level;
      this.castYaw = Math.atan2(-(spot.x - view.pos.x), -(spot.z - view.pos.z));
      this.state = 'cast'; this.t = 0; this.released = false;
      this.rod.visible = true;
      return;
    }
    if (this.state === 'cast' || this.state === 'wait' || this.state === 'bite') this.cancel('You reel in.');
  }

  cancel(text) {
    if (this.state === 'idle') return;
    this.state = 'idle';
    this.rod.visible = this.line.visible = this.bob.visible = this.fish.visible = false;
    this.ui?.classList.add('hidden');
    this.hint = '';
    if (text) this.#toast(text);
  }

  #toast(text, warn = false) { this.events.push({ type: 'toast', text, warn }); }
  #sound(name) { this.events.push({ type: 'sound', name }); }

  // ---------------------------------------------------------------- per frame
  /** view: { pos, yaw, pitch, mode }, inp: { x (-1 left .. 1 right), reel (held), hook (pressed) }. Returns events. */
  update(dt, view, inp) {
    this.events.length = 0;
    this.hint = '';
    for (const r of this.ripples) {
      if (r.userData.age >= 1) continue;
      r.userData.age += dt * 0.9;
      const u = r.userData.age, k = (0.4 + u * 3.2) * r.userData.size;
      r.scale.setScalar(k);
      r.material.opacity = Math.max(0, (1 - u)) * 0.5;
      if (u >= 1) r.visible = false;
    }
    if (this.state === 'idle') return this.events;
    this.t += dt;

    // walk off, or into the water, and the line comes in
    if (this.state !== 'fight' && this.state !== 'land' && this.state !== 'show') {
      if (view.mode !== 'walk' || Math.hypot(view.pos.x - this.origin.x, view.pos.z - this.origin.z) > 5) { this.cancel('You walked off; the line comes in.'); return this.events; }
    }
    const fx = -Math.sin(view.yaw), fz = -Math.cos(view.yaw), rx = Math.cos(view.yaw), rz = -Math.sin(view.yaw);
    const hand = _a.set(view.pos.x + rx * 0.28 + fx * 0.38, view.pos.y + 1.0, view.pos.z + rz * 0.28 + fz * 0.38);

    switch (this.state) {
      case 'cast': this.#cast(dt, hand); break;
      case 'wait': this.#wait(dt); break;
      case 'bite': this.#bite(dt, inp); break;
      case 'fight': this.#fight(dt, view, inp); break;
      case 'land': case 'show': this.#land(dt, view); break;
    }
    this.#dressRod(dt, hand, view);
    this.#drawLine();
    return this.events;
  }

  #cast(dt, hand) {
    const t = this.t;
    // wind back, flick forward, release
    this.up = t < 0.3 ? 0.9 + (t / 0.3) * 0.7 : t < 0.45 ? 1.6 - ((t - 0.3) / 0.15) * 1.25 : 0.4 + Math.min(1, (t - 0.45) * 2) * 0.5;
    if (t < 0.45) { this.bob.visible = this.line.visible = false; return; }
    if (!this.released) {
      this.released = true; this.flight = 0;
      this.tip.getWorldPosition(this.launch = new THREE.Vector3());
      this.dur = 0.55 + Math.hypot(this.target.x - this.launch.x, this.target.z - this.launch.z) * 0.035;
      this.#sound('whoosh');
    }
    this.flight += dt;
    const u = clamp(this.flight / this.dur, 0, 1);
    this.bobber.set(
      this.launch.x + (this.target.x - this.launch.x) * u,
      this.launch.y + (this.target.y - this.launch.y) * u + Math.sin(Math.PI * u) * 2.6,
      this.launch.z + (this.target.z - this.launch.z) * u);
    this.bob.visible = this.line.visible = true;
    this.bob.position.copy(this.bobber);
    if (u >= 1) {
      this.ripple(this.target.x, this.level, this.target.z, 1.3);
      this.#sound('splash');
      this.state = 'wait'; this.t = 0;
      this.biteIn = WAIT[0] + Math.random() * (WAIT[1] - WAIT[0]);
      this.nibble = 1.5 + Math.random() * 2.5;
    }
  }

  #wait(dt) {
    this.hint = 'Waiting for a bite…  [T] reel in';
    this.bobber.copy(this.target);
    const bob = Math.sin(this.t * 2.1) * 0.012;
    this.biteIn -= dt; this.nibble -= dt;
    let dip = 0;
    if (this.nibble < 0.35 && this.nibble > 0) dip = Math.sin((this.nibble / 0.35) * Math.PI) * 0.05;
    if (this.nibble <= 0) { this.nibble = 2 + Math.random() * 3.5; this.ripple(this.target.x, this.level, this.target.z, 0.6); }
    this.bob.position.set(this.bobber.x, this.level + bob - dip, this.bobber.z);
    if (this.biteIn <= 0) {
      this.state = 'bite'; this.t = 0;
      this.catch = rollFish(this.level);
      this.#sound('splash');
      this.ripple(this.target.x, this.level, this.target.z, 1.6);
    }
  }

  #bite(dt, inp) {
    this.hint = 'Fish on!  [Space] set the hook';
    this.bob.position.set(this.target.x, this.level - 0.16 + Math.sin(this.t * 34) * 0.025, this.target.z);
    if (Math.floor(this.t * 6) !== Math.floor((this.t - dt) * 6)) this.ripple(this.target.x, this.level, this.target.z, 0.8);
    if (inp.hook) { this.#startFight(); return; }
    if (this.t > HOOK_WINDOW) {
      this.#toast('It got away.');
      this.state = 'wait'; this.t = 0;
      this.biteIn = 2 + Math.random() * 5;
      this.nibble = 2;
    }
  }

  // ---------------------------------------------------------------- the fight
  #startFight() {
    const f = this.catch;
    this.#dress(f);
    // the fish is played in toward the nearest shallows on the line to you, not through the bank
    const hx = this.origin.x - this.target.x, hz = this.origin.z - this.target.z, hl = Math.hypot(hx, hz) || 1;
    let reach = 0;
    for (let d = 0; d <= hl; d += 0.5) {
      if (this.#wet(this.target.x + (hx / hl) * d, this.target.z + (hz / hl) * d)) reach = d;
      else if (d - reach > 4) break;
    }
    reach = Math.max(0, reach - 0.7);
    // ...and no closer than you can still see it: the lip of a high bank hides the water at its foot
    const eyeY = this.origin.y + 1.7;
    const seen = (d) => {
      const px = this.target.x + (hx / hl) * d, pz = this.target.z + (hz / hl) * d, py = this.level + 0.4;
      for (let i = 1; i < 14; i++) {
        const u = i / 14, x = this.origin.x + (px - this.origin.x) * u, z = this.origin.z + (pz - this.origin.z) * u;
        if (this.world.height(x, z) > eyeY + (py - eyeY) * u - 0.15) return false;
      }
      return true;
    };
    while (reach > 0 && !seen(reach)) reach -= 0.5;
    this.fight = {
      home: { x: this.target.x + (hx / hl) * reach, z: this.target.z + (hz / hl) * reach },
      P: 0.16, T: 30, dir: Math.random() < 0.5 ? -1 : 1, str: 0.7 + 0.5 * f.size, dirT: 1 + Math.random(),
      lat: 0, run: 0, slack: 0, size: f.size, leap: 0, leapIn: 3 + Math.random() * 3, wig: 0,
    };
    this.focus.copy(this.target);
    this.state = 'fight'; this.t = 0;
    this.tension = this.fight.T;
    this.fish.visible = true;
    this.bob.visible = false;   // the bobber rides up the line; the fish is what you watch now
    this.#sound('splash');
    this.#toast('Hooked! Lean against the pull and reel.');
    this.ui?.classList.remove('hidden');
  }

  #fight(dt, view, inp) {
    const F = this.fight;
    // the fish changes its mind: left, right, now and then a hard run
    F.dirT -= dt;
    if (F.dirT <= 0) {
      F.dir = -F.dir * (Math.random() < 0.85 ? 1 : -1);
      F.dirT = (1.3 + Math.random() * 1.3) / (0.85 + F.size * 0.4);
      F.run = Math.random() < 0.22 ? 0.7 : 0;
    }
    F.run = Math.max(0, F.run - dt);
    const str = F.str * (F.run > 0 ? 1.45 : 1);
    const counter = -F.dir * inp.x;            // positive when you lean against the pull
    const reeling = inp.reel;

    // line tension
    let dT = reeling ? 15 * (0.6 + str) : -22;
    if (counter > 0.3) dT -= 34 * counter;
    else if (counter < -0.3) dT += 30 * -counter * str;   // leaning the wrong way hurts
    else dT += 10 * str;                                   // an unanswered pull
    F.T = clamp(F.T + dT * dt, 0, 110);
    // reeling in
    let dP = reeling ? 0.14 * (1 - F.T / 140) * (counter > 0.3 ? 1.35 : 1) * (1.15 - 0.5 * F.size) : -0.02;
    if (F.T > 80) dP *= 0.5;
    F.P += dP * dt;
    F.slack = F.T < 6 && !reeling ? F.slack + dt : Math.max(0, F.slack - dt * 2);   // only a line you've stopped working goes slack
    this.tension = F.T;

    // where the fish is: out on the line toward the shore, swinging side to side
    const dx = F.home.x - this.target.x, dz = F.home.z - this.target.z, len = Math.hypot(dx, dz) || 1;
    const px = -dz / len, pz = dx / len;                    // sideways, across the line
    const amp = (3 + 3 * F.size) * (1 - F.P * 0.8);
    F.lat += (F.dir * amp * (F.run > 0 ? 1.4 : 1) - F.lat) * Math.min(1, dt * 2.2);
    let lat = F.lat;
    const base = { x: this.target.x + dx * F.P, z: this.target.z + dz * F.P };
    for (let i = 0; i < 6 && !this.#wet(base.x + px * lat, base.z + pz * lat) && F.P < 0.9; i++) lat *= 0.5;   // stay over water
    const fx = base.x + px * lat, fz = base.z + pz * lat;
    F.wig += dt * (8 + str * 6);
    // a leap: out of the water and back with a splash
    F.leapIn -= dt;
    if (F.leapIn <= 0 && F.P < 0.85) { F.leap = 0.0001; F.leapIn = 3.5 + Math.random() * 4; }
    // it swims with its back at the surface, and as you win it's hauled up out of the water to hang from the line
    // drawn larger the farther it is from your eye (a real trout that far off would be a speck), and larger as it comes in
    const eyeD = Math.hypot(this.focus.x - view.pos.x, this.focus.y - (view.pos.y + 1.7), this.focus.z - view.pos.z);
    this.fish.scale.setScalar(this.fishScale * (1 + F.P * 0.6) * Math.max(1, Math.min(eyeD, 30) * 0.09));
    const lift = clamp((F.P - 0.35) / 0.6, 0, 1);
    let fy = this.level + 0.02 + this.fish.scale.x * 0.1 + lift * lift * (0.4 + F.size * 0.5);
    if (F.leap > 0) {
      F.leap += dt * 1.8;
      fy += Math.sin(Math.PI * Math.min(F.leap, 1)) * (0.45 + F.size * 0.5);
      if (F.leap >= 1) { F.leap = 0; this.ripple(fx, this.level, fz, 1.6); this.#sound('splash'); }
    }
    this.bobber.set(fx, this.level, fz);
    this.bob.position.set(fx + px * 0.25, this.level - 0.03 + Math.sin(F.wig * 0.7) * 0.015, fz + pz * 0.25);
    this.fish.position.set(fx, fy, fz);
    const heading = Math.atan2(F.dir * 0.6 * px + dx / len * -0.4 + 0.0001, F.dir * 0.6 * pz + dz / len * -0.4);
    this.fish.rotation.set(F.leap > 0 ? -0.6 + F.leap * 1.2 : lift * 1.2, heading + Math.sin(F.wig) * 0.35 * (1 - lift * 0.6), Math.sin(F.wig * 1.3) * 0.2);
    this.focus.copy(this.fish.position);
    this.fish.updateMatrixWorld(true);
    this.fish.localToWorld(this.lineEnd.set(0, 0, -0.5));   // the line runs to its mouth
    if (Math.floor(F.wig * 0.5) !== Math.floor((F.wig - dt * 8) * 0.5) && Math.random() < 0.5) this.ripple(fx, this.level, fz, 0.7);
    if (reeling && Math.floor(this.t * 10) !== Math.floor((this.t - dt) * 10)) this.#sound('reel');
    this.#ui(F, counter);

    if (F.T >= 100) { this.#lose('The line snapped!'); return; }
    if (F.slack > 2) { this.#lose('The line went slack and it threw the hook.'); return; }
    if (F.P <= 0) { this.#lose('It slipped off.'); return; }
    if (F.P >= 1) {
      this.state = 'land'; this.t = 0; this.reported = false;
      this.landFrom = this.fish.position.clone();
      this.ui?.classList.add('hidden');
      this.#sound('splash');
    }
  }

  #wet(x, z) {
    const lake = this.world.lakeAt(x, z);
    return !!lake && lake.level - this.world.height(x, z) > 0.5;
  }

  #lose(text) {
    this.#toast(text, true);
    this.#sound('splash');
    this.cancel();
  }

  #ui(F, counter) {
    const ui = this.ui;
    if (!ui) return;
    ui.querySelector('.fs-ten i').style.width = `${clamp(F.T, 0, 100)}%`;
    ui.querySelector('.fs-ten').dataset.zone = F.T > 85 ? 'red' : F.T > 60 ? 'amber' : 'green';
    ui.querySelector('.fs-prog i').style.width = `${clamp(F.P, 0, 1) * 100}%`;
    const want = -F.dir;      // the way you should lean
    ui.querySelector('.fs-l').classList.toggle('on', want < 0);
    ui.querySelector('.fs-r').classList.toggle('on', want > 0);
    ui.querySelector('.fs-l').classList.toggle('ok', want < 0 && counter > 0.3);
    ui.querySelector('.fs-r').classList.toggle('ok', want > 0 && counter > 0.3);
    ui.classList.toggle('run', F.run > 0);
  }

  // ---------------------------------------------------------------- landing
  /** Hauled up on the rod: swings in to hang from the tip where you can see it, then drops at your feet. */
  #land(dt, view) {
    this.bob.visible = false;
    const fx = -Math.sin(view.yaw), fz = -Math.cos(view.yaw);
    const x = view.pos.x + fx * 1.1, z = view.pos.z + fz * 1.1, y = this.world.height(x, z) + 0.05;
    const t = this.t, sc = this.fish.scale.x;
    this.tip.getWorldPosition(_b);
    const hang = this.hangAt || (this.hangAt = new THREE.Vector3());
    hang.set(_b.x, _b.y - (0.5 * sc + 0.2), _b.z);
    if (this.state === 'land') {
      this.line.visible = t < 2.2;
      const from = this.landFrom;
      if (t < 0.9) {
        const u = clamp(t / 0.9, 0, 1), e = u * u * (3 - 2 * u);
        this.fish.position.set(from.x + (hang.x - from.x) * e, from.y + (hang.y - from.y) * e + Math.sin(Math.PI * u) * 0.7, from.z + (hang.z - from.z) * e);
        this.fish.rotation.set(1.2 + u * 0.3, this.fish.rotation.y, Math.sin(u * 12) * 0.3);
      } else if (t < 2.2) {
        if (!this.reported) {
          this.reported = true;
          this.#record(this.catch);
          this.events.push({ type: 'catch', fish: this.catch });
          this.ripple(from.x, this.level, from.z, 1.2);
        }
        const k = Math.max(0, 1 - (t - 0.9) / 1.3);
        this.fish.position.set(hang.x + Math.sin(t * 5) * 0.05 * k, hang.y, hang.z + Math.cos(t * 4) * 0.05 * k);
        this.fish.rotation.set(1.45, this.fish.rotation.y + dt * 0.8, Math.sin(t * 9) * 0.3 * (0.3 + k));
      } else {
        const u = clamp((t - 2.2) / 0.5, 0, 1);
        this.fish.position.set(hang.x + (x - hang.x) * u, hang.y + (y - hang.y) * u * u, hang.z + (z - hang.z) * u);
        this.fish.rotation.set(1.45 * (1 - u), this.fish.rotation.y, u * 1.5);
        if (u >= 1) { this.state = 'show'; this.t = 0; }
      }
      this.focus.copy(this.fish.position);
      this.fish.updateMatrixWorld(true);
      this.fish.localToWorld(this.lineEnd.set(0, 0, -0.5));
    } else {
      this.line.visible = false;
      this.fish.position.set(x, y, z);
      this.fish.rotation.z = 1.5 + Math.sin(this.t * 12) * Math.max(0, 0.35 - this.t * 0.2);   // on its side, flapping less and less
      if (this.t > 2.4) this.cancel();
    }
  }

  #record(f) {
    const L = this.log;
    L.caught++;
    L.species[f.key] = (L.species[f.key] || 0) + 1;
    f.record = !L.best || f.kg > L.best.kg;
    f.n = L.caught;
    if (f.record) L.best = { name: f.name, cm: f.cm, kg: f.kg };
  }

  // ---------------------------------------------------------------- drawing
  #dressRod(dt, hand, view) {
    const r = this.rod;
    r.visible = true;
    r.position.copy(hand);
    // point at the bobber when there is one, else where you look
    let yaw = view.yaw;
    if (this.state !== 'cast' || this.t > 0.2) {
      const tx = this.state === 'fight' ? this.bobber.x : this.target.x, tz = this.state === 'fight' ? this.bobber.z : this.target.z;
      yaw = Math.atan2(-(tx - hand.x), -(tz - hand.z));
    }
    const wantBend = this.state === 'fight' ? 0.25 + clamp(this.tension / 100, 0, 1) * 1.1 : this.state === 'bite' ? 0.5 : this.state === 'land' && this.t < 2.2 ? 0.8 : 0.1;
    this.bend += (wantBend - this.bend) * Math.min(1, dt * 10);
    const up = this.state === 'cast' ? this.up : this.state === 'fight' ? 0.5 + this.fight.P * 0.3 : 0.42;
    r.rotation.set(up, yaw - 0.22, 0);   // held a little out to the right, so it isn't hidden behind the line of sight
    this.segs.forEach((s, i) => { s.rotation.x = i ? -this.bend / 3 : 0; });
    r.updateMatrixWorld(true);
  }

  #drawLine() {
    if (!this.line.visible) return;
    const pos = this.line.geometry.attributes.position, n = this.linePts;
    this.tip.getWorldPosition(_a);
    const fishing = this.state === 'fight' || (this.state === 'land' && this.t < 2.2);
    const end = fishing ? this.lineEnd : _b.copy(this.bob.position).setY(this.bob.position.y + 0.07), taut = this.state === 'fight' ? clamp(this.tension / 100, 0, 1) : this.state === 'bite' ? 0.5 : 0;
    const dist = _a.distanceTo(end);
    const sag = Math.min(2.2, dist * 0.12) * (1 - taut * 0.92) + (this.state === 'cast' ? 0 : 0.03);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      pos.setXYZ(i, _a.x + (end.x - _a.x) * u, _a.y + (end.y - _a.y) * u - Math.sin(Math.PI * u) * sag, _a.z + (end.z - _a.z) * u);
    }
    pos.needsUpdate = true;
  }

  save() { return this.log; }
  load(s) { if (s) this.log = { caught: s.caught || 0, best: s.best || null, species: s.species || {} }; }
}
