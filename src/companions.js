import * as THREE from 'three';
import { Character, CHARACTERS } from './character.js';
import { ACTIONS } from './hiker.js';
import { clamp } from './noise.js';

// The other two friends. Whoever you are not playing as walks with you, close
// enough to be company, and every so often the pair stops and does something
// together a few metres away: talk, sit, or play-fight. Each is a Character
// (same rig, same clips) driven by a Body, which carries just the fields the
// Character reads from a Hiker. Movement is deliberately simple: straight at a
// goal, sidestepping water and cliffs, trees pushing them aside via flora.collide.

const WALK = 1.3, JOG = 2.8, RUN = 4.6;
const MEET_SPEED = 2.4;
const CHAT = ['Happy Idle', 'Happy Idle', 'Looking', 'Searching Pockets', 'Wiping Sweat', 'Swatting Bugs'];
// what each punch does to the one it lands on
const REACT = { jab: ['hitHead', 'hitSide'], cross: ['hitSide', 'hitKidney'], combo: ['hitKidney', 'hitSide'], hook: ['hitUpper', 'hitFace'] };
const BOUT = ['jab', 'cross', 'combo', 'hook'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (a, b) => a + Math.random() * (b - a);
const fwd = (yaw) => [-Math.sin(yaw), -Math.cos(yaw)];          // the hiker's yaw 0 faces north (-z)
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);

/** The slice of a Hiker that Character reads. */
class Body {
  constructor() {
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0; this.mode = 'walk'; this.stance = 'stand'; this.grounded = true;
    this.action = null; this.recover = 0; this.sliding = false; this.injured = 0; this.resting = false;
    this.stamina = 100; this.flip = false; this.wallUp = { x: 0, y: 0 }; this.climbSpeed = 0;
    this.face = false; this.emote = ''; this.lookAt = null;
  }
}

class Actor {
  constructor(party, name) {
    this.party = party; this.name = name;
    this.b = new Body();
    this.char = new Character(party.scene, name, { lib: party.lib, placeholder: false, firstPerson: false });
    this.speed = 0; this.kick = new THREE.Vector3(); this.tmp = new THREE.Vector3();
    this.eye = new THREE.Vector3(); this.stuck = 0;
  }

  /** Where a friend looking at this one would aim. */
  get head() { return this.eye.set(this.x, this.b.pos.y + 1.55, this.z); }

  get x() { return this.b.pos.x; }
  get z() { return this.b.pos.z; }

  place(x, z, yaw = 0) {
    this.b.pos.set(x, this.party.world.height(x, z), z);
    this.b.vel.set(0, 0, 0); this.b.yaw = yaw; this.speed = 0;
  }

  /** Is this somewhere a person would step: dry and not a cliff? */
  passable(x, z) {
    const w = this.party.world, e = w.height(x, z), lake = w.lakeAt(x, z);
    if (lake && e < lake.level - 0.6) return false;   // wade the shallows, never swim
    const g = w.gradient(x, z, this.party.g);
    return Math.hypot(g.x, g.z) < 0.95;
  }

  /** Head for (tx, tz) at up to `top` m/s, easing in to stop `stop` metres short. Returns the distance left. */
  goto(tx, tz, top, stop, dt) {
    const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
    let want = d > stop ? Math.min(top, (d - stop) * 1.6 + 0.4) : 0;
    let heading = Math.atan2(dx, dz);
    if (want > 0) {
      // go round water and cliffs: first free heading among a fan either side of the straight line
      let found = false;
      for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 2.0, -2.0]) {
        const h = heading + turn;
        if (this.passable(this.x + Math.sin(h) * 1.3, this.z + Math.cos(h) * 1.3)) { heading = h; found = true; break; }
      }
      if (!found) want = 0;
    }
    this.speed += clamp(want - this.speed, -4 * dt, 3 * dt);
    const v = this.speed;
    this.b.vel.set(Math.sin(heading) * v, 0, Math.cos(heading) * v);
    if (v > 0.3) this.b.yaw = yawTo(this.b.vel.x, this.b.vel.z);
    return d;
  }

  stop() { this.speed = 0; this.b.vel.set(0, 0, 0); }

  face(x, z) { this.b.face = true; this.b.yaw = yawTo(x - this.x, z - this.z); }

  /** Run an action (a punch or a reaction) the way a Hiker would. */
  start(kind) {
    const spec = ACTIONS[kind];
    this.b.action = { id: ++this.party.ids, kind, t: 0, dur: spec.dur, hits: spec.hits, slow: 0 };
  }

  update(dt) {
    const b = this.b, p = b.pos, w = this.party.world;
    if (b.action) { b.action.t += dt; if (b.action.t >= b.action.dur) b.action = null; }
    p.x += (b.vel.x + this.kick.x) * dt; p.z += (b.vel.z + this.kick.z) * dt;
    this.kick.multiplyScalar(Math.exp(-8 * dt));
    this.party.flora.collide(p, 0.35, p.y);
    p.y += (w.height(p.x, p.z) - p.y) * Math.min(1, dt * 14);
    this.char.update(dt, b);
  }
}

export class Party {
  /** `lib` is the player's animation library, shared so every clip loads once. `player` is the character name to leave out. */
  constructor(world, flora, scene, lib, player) {
    this.world = world; this.flora = flora; this.scene = scene; this.lib = lib;
    this.g = { x: 0, z: 0 };
    this.eye = new THREE.Vector3();
    this.ids = 1000;
    this.actors = Object.keys(CHARACTERS).filter((n) => n !== player).slice(0, 2).map((n) => new Actor(this, n));
    this.dir = 0;                 // the way the player last walked
    this.placed = false;
    this.mode = 'follow'; this.t = 0; this.next = between(18, 30);
    this.duo = null;
  }

  /** Put both behind the player, on ground they can stand on. */
  gather(pl) {
    this.dir = pl.yaw;
    this.actors.forEach((a, i) => {
      for (let k = 0; k < 8; k++) {
        const ang = this.dir + Math.PI + (i ? 0.8 : -0.8) + k * 0.7, r = 6 + i * 2.5 + k;
        const [fx, fz] = fwd(ang), x = pl.pos.x + fx * r, z = pl.pos.z + fz * r;
        if (a.passable(x, z)) { a.place(x, z, pl.yaw); return; }
      }
      a.place(pl.pos.x, pl.pos.z, pl.yaw);
    });
    this.endDuo();
    this.placed = true;
  }

  update(dt, pl) {
    if (!this.placed) this.gather(pl);
    const speed = Math.hypot(pl.vel.x, pl.vel.z);
    if (speed > 0.6 && !pl.action) this.dir += Math.atan2(Math.sin(yawTo(pl.vel.x, pl.vel.z) - this.dir), Math.cos(yawTo(pl.vel.x, pl.vel.z) - this.dir)) * Math.min(1, dt * 1.5);
    const near = Math.min(...this.actors.map((a) => Math.hypot(a.x - pl.pos.x, a.z - pl.pos.z)));
    if (near > 120) this.gather(pl);   // fast travel, a long fall, or just left behind: catch up

    if (dt > 0) {
      if (this.mode === 'follow') this.follow(dt, pl, speed);
      else if (this.mode === 'meet') this.meet(dt, pl);
      else this.perform(dt, pl);
    }
    for (const a of this.actors) a.update(dt);
  }

  // ------------------------------------------------------------ walking with you
  follow(dt, pl, speed) {
    this.actors.forEach((a, i) => {
      const ang = this.dir + Math.PI + (i ? 0.9 : -0.9), r = 4.5 + i * 2.2, [fx, fz] = fwd(ang);
      const tx = pl.pos.x + fx * r, tz = pl.pos.z + fz * r, d = Math.hypot(tx - a.x, tz - a.z);
      const top = d > 25 ? RUN : d > 12 ? JOG : d > 5 ? Math.max(JOG * 0.7, speed) : Math.max(WALK, speed * 0.95);
      a.goto(tx, tz, top, speed > 0.5 ? 0.8 : 2.5, dt);
      a.b.face = false; a.b.emote = ''; a.b.resting = false;
      // glance at you when you are close and in front of them, otherwise at the way ahead
      const near = Math.hypot(pl.pos.x - a.x, pl.pos.z - a.z) < 14;
      a.b.lookAt = near ? this.eye.set(pl.pos.x, pl.pos.y + 1.55, pl.pos.z) : null;
      // wedged against something for a while with you far off: rejoin
      a.stuck = d > 10 && a.speed < 0.3 ? a.stuck + dt : 0;
      if (a.stuck > 5) { this.rejoin(a, pl, i); a.stuck = 0; }
    });
    this.separate(pl);
    this.next -= dt;
    const calm = pl.mode === 'walk' && pl.grounded && !pl.action;
    const close = this.actors.every((a) => Math.hypot(a.x - pl.pos.x, a.z - pl.pos.z) < 22);
    if (this.next <= 0 && calm && close) this.startDuo(pl);
  }

  /** Put one friend back behind you on ground they can stand on. */
  rejoin(a, pl, i) {
    for (let k = 0; k < 8; k++) {
      const [fx, fz] = fwd(this.dir + Math.PI + (i ? 0.8 : -0.8) + k * 0.6), r = 7 + k;
      const x = pl.pos.x + fx * r, z = pl.pos.z + fz * r;
      if (a.passable(x, z)) { a.place(x, z, a.b.yaw); return; }
    }
  }

  /** Keep everyone a person's width apart: the two friends and you. */
  separate(pl) {
    const bodies = [...this.actors, { x: pl.pos.x, z: pl.pos.z, fixed: true }];
    for (let i = 0; i < this.actors.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j], dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz);
        if (d >= 1.0 || d < 1e-3) continue;
        const push = (1.0 - d) * 0.5, nx = dx / d, nz = dz / d;
        a.b.pos.x += nx * push * (b.fixed ? 2 : 1); a.b.pos.z += nz * push * (b.fixed ? 2 : 1);
        if (!b.fixed) { b.b.pos.x -= nx * push; b.b.pos.z -= nz * push; }
      }
    }
  }

  // ------------------------------------------------------------ doing something together
  startDuo(pl) {
    const kind = pick(['chat', 'chat', 'spar', 'spar', 'sit']);
    const sep = kind === 'sit' ? 1.1 : 1.8;
    // a spot a few metres out to one side of where you are looking, so you can watch
    for (let k = 0; k < 10; k++) {
      const ang = pl.yaw + (k % 2 ? 1 : -1) * between(0.35, 1.2), r = between(5.5, 9) + k * 0.4;
      const [fx, fz] = fwd(ang), x = pl.pos.x + fx * r, z = pl.pos.z + fz * r;
      const gr = this.world.gradient(x, z, this.g);
      const [a, b] = this.actors, th = between(0, Math.PI), sx = Math.cos(th) * sep / 2, sz = Math.sin(th) * sep / 2;
      if (Math.hypot(gr.x, gr.z) < 0.35 && a.passable(x + sx, z + sz) && a.passable(x - sx, z - sz)) {
        this.duo = { kind, x, z, spots: [[x + sx, z + sz], [x - sx, z - sz]], dur: between(14, 24), beat: 0, bouts: 0, roles: 0, bout: null, laugh: 0 };
        this.mode = 'meet'; this.t = 0;
        return;
      }
    }
    this.next = between(6, 12);   // nowhere flat enough nearby; try again soon
  }

  meet(dt, pl) {
    this.t += dt;
    let left = 0;
    this.actors.forEach((a, i) => {
      const [x, z] = this.duo.spots[i];
      left = Math.max(left, a.goto(x, z, MEET_SPEED, 0.15, dt));
      a.b.face = false;
    });
    if (Math.hypot(this.duo.x - pl.pos.x, this.duo.z - pl.pos.z) > 45 || this.t > 22) { this.endDuo(); return; }
    if (left < 0.45) { this.mode = 'duo'; this.t = 0; this.duo.beat = 0; }
  }

  perform(dt, pl) {
    const d = this.duo, [a, b] = this.actors;
    this.t += dt;
    if (Math.hypot(d.x - pl.pos.x, d.z - pl.pos.z) > 60 || pl.mode === 'swim') { this.endDuo(); return; }
    for (const x of this.actors) x.stop();
    if (d.kind === 'sit') {
      // side by side, looking out toward where you are
      for (const x of this.actors) { x.face(pl.pos.x, pl.pos.z); x.b.resting = true; x.b.lookAt = null; }
    } else {
      a.face(b.x, b.z); b.face(a.x, a.z);
      a.b.lookAt = b.head; b.b.lookAt = a.head;
    }
    if (d.kind === 'chat') this.chat(dt, d, a, b);
    else if (d.kind === 'spar') this.spar(dt, d, a, b);
    if (this.t > d.dur) this.endDuo();
  }

  chat(dt, d, a, b) {
    d.beat -= dt;
    if (d.beat > 0) return;
    d.beat = between(3, 6);
    // one holds forth, the other listens
    const [who, other] = Math.random() < 0.5 ? [a, b] : [b, a];
    who.b.emote = pick(CHAT);
    other.b.emote = Math.random() < 0.7 ? '' : 'Looking';
  }

  spar(dt, d, a, b) {
    const [atk, def] = d.roles ? [b, a] : [a, b];
    if (!d.bout) {
      // hands up between rounds; after a few exchanges they laugh it off
      if (d.laugh > 0) { d.laugh -= dt; a.b.emote = b.b.emote = 'Happy Idle'; if (d.laugh <= 0) this.t = d.dur; return; }
      a.b.emote = b.b.emote = 'Fighting Idle';
      d.beat -= dt;
      if (d.beat > 0) return;
      const kind = pick(BOUT);
      atk.start(kind);
      d.bout = { kind, t: 0, landed: false, def };
      return;
    }
    const o = d.bout;
    o.t += dt;
    if (!o.landed && o.t >= ACTIONS[o.kind].hits[0] * ACTIONS[o.kind].dur) {
      o.landed = true;
      o.def.start(pick(REACT[o.kind]));
      const dx = o.def.x - atk.x, dz = o.def.z - atk.z, m = Math.hypot(dx, dz) || 1;
      o.def.kick.set(dx / m * 2.4, 0, dz / m * 2.4);
    }
    if (o.t >= ACTIONS[o.kind].dur + 0.5) {
      d.bout = null; d.beat = between(0.8, 1.6); d.bouts++;
      if (Math.random() < 0.55) d.roles ^= 1;
      if (d.bouts >= 4 + Math.floor(Math.random() * 3)) d.laugh = 3;
    }
  }

  endDuo() {
    for (const a of this.actors) { a.b.face = false; a.b.emote = ''; a.b.resting = false; a.b.action = null; a.b.lookAt = null; }
    this.duo = null; this.mode = 'follow'; this.t = 0; this.next = between(30, 70);
  }
}
