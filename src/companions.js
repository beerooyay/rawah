import * as THREE from 'three';
import { Character, CHARACTERS } from './character.js';
import { ACTIONS } from './hiker.js';
import { clamp } from './noise.js';
import { TREES } from './flora.js';

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
// what the friends say, by what is happening (the speech bubble picks from these)
const LINES = {
  hello: ['Alright, Rawah. Let\'s see what you\'ve got.', 'Smell that? Pine and cold air. Perfect.', 'Car\'s locked. Let\'s go.'],
  lake: ['Oh wow. {place}.', 'There it is: {place}. Worth every step.', '{place}! The water is so clear I can see the rocks.', 'I could sit by {place} all day.'],
  summit: ['We\'re on top of {place}! Look at that.', '{place}. You can see all the way into Wyoming.', 'Summit! Nothing higher around here but the clouds.'],
  storm: ['Hear that rumble? We should get off the high ground.', 'Thunder. Treeline. Now.', 'Those clouds are building fast. Let\'s not be the tallest thing up here.'],
  rain: ['And there\'s the rain. Glad I packed the shell.', 'Rain\'s here. Smells amazing, though.'],
  snow: ['It\'s snowing! Like actually snowing.', 'Snow! Okay, this is the coolest thing.'],
  fog: ['Can\'t see a thing. Stay close.', 'This fog is unreal. Let\'s stick to the trail.'],
  cold: ['You\'re shivering. Fire or tent, your pick.', 'Hey, you\'re freezing. Let\'s warm up.'],
  dusk: ['Light\'s going. Find a flat spot for camp?', 'Sun\'s about to dip. We should think about camp.'],
  night: ['Look up. That\'s the whole Milky Way.', 'So quiet out here at night.'],
  alpine: ['Above the trees now. Thin air, big views.', 'Tundra. Every step up here counts.'],
  forest: ['Love how quiet it gets in the trees.', 'Spruce and fir. Smells like Christmas in here.'],
  burn: ['Crazy how much burned here. Look, fireweed is coming back.', 'The 2020 fire came through here. Still eerie.'],
  meadow: ['Elk country, right here.', 'This meadow would be unreal in July.'],
  idle: ['Nice day for it.', 'Your pace is good. I like it.', 'Water break soon?', 'Trail\'s easy to follow here.'],
  tired: ['Breather? I won\'t tell anyone.', 'You\'re gassed. Five minutes.', 'My legs are done. Sitting down.'],
  together: ['Right behind you.', 'Lead the way.'],
  wander: ['Gonna check out that ridge. Back in a bit.', 'I\'m going to look around. Holler if you need me.'],
  view: ['Oh, this is the spot.', 'Look at that. Worth the climb.'],
  back: ['Back! You would\'ve loved it.', 'Miss me?'],
  rest: ['Sitting down. Take your time.', 'I\'ll wait here.'],
  ready: ['Ready when you are.', 'Okay, let\'s go.'],
  race: ['Race you to {place}! Go!', 'Last one to {place} cooks dinner!'],
  win: ['Ha! Beat you to {place}!', 'Too slow! {place} is mine.'],
  lose: ['Okay, okay. You win. {place} is yours.', 'Fine, you\'re faster. I\'m cooking.'],
  catchup: ['Wait up!', 'Hold on, coming!'],
  travel: ['Made it.', 'Whoa, okay, we\'re here.'],
  camp: ['Good spot. I\'ll grab some water.', 'Home for the night.'],
  fire: ['Now we\'re talking.', 'Fire\'s perfect. Don\'t you dare put it out yet.'],
  hop: ['Wait for me!', 'Room for one more?', 'Hold on, I\'m coming!'],
  ride: ['Okay, I\'m on. Go easy!', 'Let\'s ride!', 'Holding on!'],
  fast: ['Faster!', 'Woooo!', 'Watch the trees!', 'I can\'t feel my face!'],
  fish: ['Nice one!', 'Look at the size of that!', 'Beautiful fish. Now I\'m jealous.', 'Dinner!'],
  smore: ['That is the perfect marshmallow. Don\'t look at mine.', 'Okay, golden brown. I am a professional.', 'Best thing I\'ve ever tasted, honestly.', 'Mine is on fire. Mine is definitely on fire.'],
  sit: ['Good spot. Look at those stars.', 'Fire\'s perfect. Stay a while.', 'I could sit here all night.'],
  off: ['Whew. That was fun.', 'My legs are still shaking.', 'Again later?'],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (a, b) => a + Math.random() * (b - a);
const fwd = (yaw) => [-Math.sin(yaw), -Math.cos(yaw)];          // the hiker's yaw 0 faces north (-z)
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);
const _bv = new THREE.Vector3();
const RACE_SPEED = RUN * 0.88;      // a friend racing you: just under a sprint, so a good push wins
const RACE_LIMIT = 300;             // seconds before a race is called off
const ROAM_TIME = 60;               // seconds a friend wanders off on their own before coming back

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
    this.work = null;             // one friend with an axe at a tree while the other walks with you
    this.onSwing = null;          // called with (x, y, z, nx, nz) when a friend's blow lands

    // what they want, 0..100, and what you have asked of them (the "together" menu)
    this.energy = 100; this.curiosity = 30;
    this.stance = 'together';     // together | free | rest | race
    this.race = null;             // { a, goal, t } while racing
    this.roam = null;             // { a, goal, t, arrived } while off on their own
    this.races = { won: 0, lost: 0 };
    this.onRace = null;           // called with ({ won, name }) when a race ends
    this.ctx = {};                // the world as the friends see it, set by main.js each half second
    this.camera = null;
    this.nextTalk = between(18, 30);
    this.talk = { who: null, until: 0, el: document.getElementById('bubble') };
    this.lastSaid = {};
    this.go = null;    // { x, z, who }: a friend with somewhere to be (a scripted moment)
    this.atv = null;   // the four-wheeler, while someone is boarding or riding
    this._pin = null;  // the actor a script owns this frame
  }

  // ------------------------------------------------------------ speech
  /** Show one of `kind`'s lines over whoever says it. Returns false when it is too soon to speak. */
  say(kind, vars = {}, who = null, { force = false, cool = 45 } = {}) {
    const now = performance.now() / 1000;
    if (!force && (now < this.talk.until - 0.5 || now - (this.lastSaid.any || -99) < 6 || (this.lastSaid[kind] || -999) + cool > now)) return false;
    const pool = LINES[kind];
    if (!pool) return false;
    const line = pick(pool).replace('{place}', vars.place || 'there');
    this.lastSaid[kind] = this.lastSaid.any = now;
    this.talk.who = who || pick(this.actors);
    this.talk.text = line;
    this.talk.until = now + 3 + line.length * 0.05;
    if (this.talk.el) { this.talk.el.textContent = line; this.talk.el.classList.remove('hidden'); }
    return true;
  }

  /** Things that happen to the pair (main.js reports discoveries, camp and arrivals). */
  event(kind, vars = {}) {
    if (kind === 'travel') { this.#arriveWith(vars.player); this.say('travel', {}, null, { force: true }); return; }
    const force = kind === 'lake' || kind === 'summit' || kind === 'hello';
    this.say(kind, vars, null, { force, cool: 90 });
    if (kind === 'lake' || kind === 'summit') this.curiosity = Math.max(0, this.curiosity - 40);
  }

  /** After fast travel: the friends are put back behind you where you land. */
  #arriveWith(p) { this.gather(p); }

  /** The friend nearest a point. */
  near(p) {
    let best = null, bd = 1e9;
    for (const a of this.actors) { const d = Math.hypot(a.x - p.x, a.z - p.z); if (d < bd) { bd = d; best = a; } }
    return best;
  }

  /** Say exactly this, now, over `who` (or the nearer friend). */
  tell(text, who = null, cool = 0) {
    const now = performance.now() / 1000;
    this.talk.who = who || this.near(this.ctx.player?.pos || this.actors[0].b.pos);
    this.talk.text = text;
    this.talk.until = now + 3.4 + text.length * 0.05 + cool;
    if (this.talk.el) { this.talk.el.textContent = text; this.talk.el.classList.remove('hidden'); }
  }

  /** You climbed on the quad: the nearer friend jogs over and takes the back seat. */
  boardATV(atv) {
    const a = this.near(atv.pos);
    if (!a || Math.hypot(atv.pos.x - a.x, atv.pos.z - a.z) > 25 || this.race?.a === a || a.b.mode === 'swim') return false;
    this.atv = atv;
    this.endDuo();
    a.boarding = true; a.riding = false; a.seat = null;
    this.say('hop', {}, a, { force: true, cool: 20 });
    return true;
  }

  /** You got off: the passenger hops down on the far side. */
  leaveATV(atv) {
    for (const a of this.actors) {
      const was = a.riding || a.boarding;
      a.boarding = false;
      if (!a.riding) continue;
      a.riding = false; a.b.resting = false;
      const rx = Math.cos(atv.yaw), rz = -Math.sin(atv.yaw);
      a.place(atv.pos.x + rx * 1.5, atv.pos.z + rz * 1.5, atv.yaw);
      if (was) this.say('off', {}, a, { force: true, cool: 20 });
    }
  }

  get boarding() { return this.actors.some((a) => a.boarding); }
  get riding() { return this.actors.some((a) => a.riding); }

  /** Offer the friend nearer the fire the stool you are not on. */
  sitOn(st) { const a = this.near(st); if (a) { a.seat = st; this.say('sit', {}, a, { cool: 120 }); } }
  clearSeat() { for (const a of this.actors) a.seat = null; }

  /** Speech bubble: sit it above the friend who is talking, and hide it when the line is done. */
  #bubbleAt(now) {
    const t = this.talk, el = t.el;
    if (!el) return;
    if (now > t.until || !t.who || !this.camera) { el.classList.add('hidden'); return; }
    const v = _bv.set(t.who.x, t.who.b.pos.y + 2.1, t.who.z).project(this.camera);
    if (v.z > 1) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  }

  /** The line that fits what is happening now, for the ambient chatter. */
  #contextKind() {
    const c = this.ctx;
    if (c.weather === 'Thunderstorm') return 'storm';
    if (c.weather === 'Rain') return 'rain';
    if (c.weather === 'Snow') return 'snow';
    if (c.weather === 'Fog') return 'fog';
    if (c.warmth < 35) return 'cold';
    if (c.dusk) return 'dusk';
    if (c.night) return 'night';
    if (c.alpine) return 'alpine';
    if (c.burn) return 'burn';
    if (c.meadow) return 'meadow';
    if (c.forest) return 'forest';
    return 'idle';
  }

  // ------------------------------------------------------------ the together menu
  /** What you asked for from the menu. `goal` is { x, z, name } for a race. */
  command(what, goal = null) {
    this.roam = null;
    this.race = null;
    this.stance = what === 'rest' ? 'rest' : what === 'race' ? 'race' : what === 'free' ? 'free' : 'together';
    this.endDuo();
    if (what === 'together') { this.say('together', {}, null, { force: true }); return; }
    if (what === 'free') { this.roamFrom(pick(this.actors)); this.say('wander', {}, null, { force: true }); return; }
    if (what === 'rest') { this.startDuo(this.ctx.player, 'sit', true); this.say('rest', {}, null, { force: true }); return; }
    if (what === 'race' && goal) {
      const a = this.actors[0];
      this.race = { a, goal, t: 0 };
      this.stance = 'race';
      this.say('race', { place: goal.name }, a, { force: true });
    }
  }

  /** Send one friend off to a view a short way out, to look and come back. */
  roamFrom(a) {
    const pl = this.ctx.player;
    if (!pl) return;
    for (let k = 0; k < 12; k++) {
      const ang = pl.yaw + between(-1.6, 1.6), r = between(35, 80);
      const [fx, fz] = fwd(ang), x = pl.pos.x + fx * r, z = pl.pos.z + fz * r;
      if (a.passable(x, z)) { this.roam = { a, goal: [x, z], t: 0, arrived: 0 }; return; }
    }
    this.stance = 'together';
  }

  /** Needs and moods, every frame: energy runs down on the trail and comes back sitting; curiosity builds while together. */
  #needs(dt, pl, speed) {
    const sitting = this.duo?.kind === 'sit' || this.stance === 'rest';
    this.energy = clamp(this.energy + (sitting ? 5 : speed > 1.2 ? -0.7 : -0.05) * dt, 0, 100);
    if (this.stance === 'together' && !this.duo && !this.work) this.curiosity = clamp(this.curiosity + dt * 0.5, 0, 100);
    if (this.energy < 22 && this.stance === 'together' && !this.duo && !this.work) {
      this.say('tired', {}, null, { force: true });
      this.startDuo(pl, 'sit', false, 18);
      this.energy = 40;
    }
    if (this.curiosity > 90 && this.stance === 'together' && !this.duo && !this.work && !this.roam) {
      this.curiosity = 30;
      this.roamFrom(pick(this.actors));
      this.say('wander', {}, null, { force: true });
    }
  }

  /** Off on their own: walk to a view, look for a little, then come back to you. */
  #roam(dt, pl) {
    const r = this.roam, a = r.a;
    r.t += dt;
    const back = Math.hypot(pl.pos.x - a.x, pl.pos.z - a.z) > 150 || r.t > ROAM_TIME;
    if (back || pl.mode === 'swim') { this.roam = null; this.stance = 'together'; this.say('back', {}, a, { force: true }); return; }
    if (!r.arrived) {
      const d = a.goto(r.goal[0], r.goal[1], JOG, 1.5, dt);
      a.b.lookAt = null;
      if (d < 2) { r.arrived = 1; this.say('view', {}, a, { cool: 60 }); a.stop(); }
    } else {
      a.stop();
      a.face(pl.pos.x, pl.pos.z);
      a.b.lookAt = null;
    }
  }

  /** The race: the friend runs for the goal, you run for it too. First one in wins. */
  #race(dt, pl) {
    const r = this.race, a = r.a, g = r.goal;
    r.t += dt;
    a.goto(g.x, g.z, RACE_SPEED, 3, dt);
    a.b.face = false; a.b.lookAt = null;
    const you = Math.hypot(pl.pos.x - g.x, pl.pos.z - g.z), them = Math.hypot(a.x - g.x, a.z - g.z);
    // whoever is nearer the goal when either reaches the line wins
    if (you < 12 || them < 12) return this.#finish(you <= them, g);
    if (r.t > RACE_LIMIT || pl.mode === 'swim') this.#finish(null, g);
  }

  #finish(won, goal) {
    const r = this.race;
    this.race = null;
    this.stance = 'together';
    if (won === null) { this.onRace?.({ won: null, name: goal.name }); return; }
    if (won) { this.races.won++; this.say('lose', { place: goal.name }, r.a, { force: true }); }
    else { this.races.lost++; this.say('win', { place: goal.name }, r.a, { force: true }); }
    this.onRace?.({ won, name: goal.name });
  }

  /** Put both behind the player, on ground they can stand on. */
  gather(pl) {
    this.dir = pl.yaw;
    this.actors.forEach((a, i) => {
      for (let k = 0; k < 8; k++) {
        const ang = this.dir + (i ? 0.8 : -0.8) + k * 0.7, r = 6 + i * 2.5 + k;
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

    this.ctx.player = pl;
    if (dt > 0) {
      this.#needs(dt, pl, speed);
      if (this.race) this.#race(dt, pl);
      else if (this.roam) this.#roam(dt, pl);
      else if (this.stance === 'rest' && speed > 0.6) this.command('together');
      else if (this.mode === 'follow') this.follow(dt, pl, speed);
      else if (this.mode === 'meet') this.meet(dt, pl);
      else this.perform(dt, pl);
      if (this.race) for (const a of this.actors) if (a !== this.race.a) this.#trail(a, pl, dt);
      if (this.roam) for (const a of this.actors) if (a !== this.roam.a) this.#trail(a, pl, dt);
      this.nextTalk -= dt;
      if (this.nextTalk <= 0 && !this.race && !this.duo) {
        this.nextTalk = between(25, 45);
        this.say(this.#contextKind(), {}, null, { cool: 50 });
      }
    }
    this._pin = this.go ? (this.go.who || this.actors[0]) : null;
    for (const a of this.actors) {
      if (a === this._pin) { a.goto(this.go.x, this.go.z, RUN, 0.3, dt); a.b.face = false; a.b.lookAt = null; }
      else if (a.boarding && this.atv) {
        const sx = Math.sin(this.atv.yaw), cz = Math.cos(this.atv.yaw);
        if (a.goto(this.atv.pos.x + sx * 1.7, this.atv.pos.z + cz * 1.7, RUN, 0.4, dt) < 0.6) { a.boarding = false; a.riding = true; this.say('ride', {}, a, { cool: 20 }); }
      }
      else if (a.riding && this.atv) {
        this.atv.seat(a.b.pos, 1);
        a.b.vel.set(0, 0, 0); a.speed = 0; a.b.resting = true;
        a.b.yaw = this.atv.yaw; a.char.heading = this.atv.yaw; a.b.face = false; a.b.lookAt = null;
      }
      else if (a.seat) {
        const st = a.seat;
        if (a.goto(st.x, st.z, JOG, 0.4, dt) < 0.5) { a.stop(); a.b.resting = true; a.b.yaw = st.yaw; a.char.heading = st.yaw; }
        else a.b.resting = false;
      }
      else a.b.resting = false;
    }
    for (const a of this.actors) a.update(dt);
    this.#bubbleAt(performance.now() / 1000);
  }

  /** The friend who is not off racing or roaming keeps by you. */
  #trail(a, pl, dt) {
    if (a === this._pin || a.riding || a.boarding || a.seat) return;
    const i = this.actors.indexOf(a);
    const [fx, fz] = fwd(this.dir + (i ? 0.8 : -0.8)), r = 4.5 + i * 2.2;
    a.goto(pl.pos.x + fx * r, pl.pos.z + fz * r, RUN, 1.5, dt);
  }

  // ------------------------------------------------------------ walking with you
  follow(dt, pl, speed) {
    this.actors.forEach((a, i) => {
      if (a === this._pin || a.riding || a.boarding || a.seat) return;
      if (this.work && this.work.a === a) return;
      const ang = this.dir + (i ? 0.8 : -0.8), r = 4.5 + i * 2.2, [fx, fz] = fwd(ang);
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
    if (this.work) this.working(dt, pl);
    this.next -= dt;
    const calm = pl.mode === 'walk' && pl.grounded && !pl.action;
    const close = this.actors.every((a) => Math.hypot(a.x - pl.pos.x, a.z - pl.pos.z) < 22);
    if (this.next <= 0 && calm && close && !this.work) {
      if (Math.random() < 0.4 && this.startWork(pl)) this.next = between(30, 60);
      else this.startDuo(pl);
    }
  }

  /** One friend takes the axe to a tree a little way off, for a dozen swings. */
  startWork(pl) {
    const tree = this.flora.find(pl.pos.x, pl.pos.z, 24, TREES, (k, s, y, x, z) => s >= 0.5 && Math.hypot(x - pl.pos.x, z - pl.pos.z) >= 5);
    if (!tree) return false;
    const a = pick(this.actors), dx = tree.x - a.x, dz = tree.z - a.z, d = Math.hypot(dx, dz) || 1;
    const spot = [tree.x - dx / d * 1.25, tree.z - dz / d * 1.25];
    if (!a.passable(spot[0], spot[1])) return false;
    this.work = { a, tree, spot, swings: 0, max: 6 + Math.floor(Math.random() * 6), beat: 0.5, hit: 0, armed: false };
    return true;
  }

  working(dt, pl) {
    const w = this.work, a = w.a;
    if (Math.hypot(w.tree.x - pl.pos.x, w.tree.z - pl.pos.z) > 60 || pl.mode === 'swim') { this.endWork(); return; }
    a.b.emote = ''; a.b.lookAt = null;
    if (a.goto(w.spot[0], w.spot[1], JOG, 0.15, dt) > 0.5) { a.b.face = false; return; }
    a.stop();
    a.face(w.tree.x, w.tree.z);
    if (!w.armed) { w.armed = true; a.char.setTool('axe'); }
    if (w.hit > 0) {
      w.hit -= dt;
      if (w.hit <= 0) {
        const nx = a.x - w.tree.x, nz = a.z - w.tree.z, m = Math.hypot(nx, nz) || 1;
        this.onSwing?.(w.tree.x + nx / m * 0.3, w.tree.e + 1.1, w.tree.z + nz / m * 0.3, nx / m, nz / m);
      }
    }
    w.beat -= dt;
    if (w.beat > 0 || a.b.action) return;
    a.start('chop');
    w.hit = ACTIONS.chop.hits[0];
    w.beat = 1.5 + Math.random() * 0.5;
    if (++w.swings >= w.max) w.beat = 99;
    if (w.swings >= w.max) setTimeout(() => { if (this.work === w) this.endWork(); }, 1200);
  }

  endWork() {
    const w = this.work;
    if (!w) return;
    w.a.char.setTool('fists'); w.a.b.face = false; w.a.b.action = null;
    this.work = null;
  }

  /** Put one friend back behind you on ground they can stand on. */
  rejoin(a, pl, i) {
    for (let k = 0; k < 8; k++) {
      const [fx, fz] = fwd(this.dir + (i ? 0.8 : -0.8) + k * 0.6), r = 7 + k;
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
  startDuo(pl, forced = null, longer = false, dur = null) {
    const kind = forced || pick(['chat', 'chat', 'spar', 'spar', 'sit']);
    const sep = kind === 'sit' ? 1.1 : 1.8;
    // a spot a few metres out to one side of where you are looking, so you can watch
    for (let k = 0; k < 10; k++) {
      const ang = pl.yaw + (k % 2 ? 1 : -1) * between(0.35, 1.2), r = between(5.5, 9) + k * 0.4;
      const [fx, fz] = fwd(ang), x = pl.pos.x + fx * r, z = pl.pos.z + fz * r;
      const gr = this.world.gradient(x, z, this.g);
      const [a, b] = this.actors, th = between(0, Math.PI), sx = Math.cos(th) * sep / 2, sz = Math.sin(th) * sep / 2;
      if (Math.hypot(gr.x, gr.z) < 0.35 && a.passable(x + sx, z + sz) && a.passable(x - sx, z - sz)) {
        this.duo = { kind, x, z, spots: [[x + sx, z + sz], [x - sx, z - sz]], dur: dur ?? (longer ? 1e9 : between(14, 24)), beat: 0, bouts: 0, roles: 0, bout: null, laugh: 0 };
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
    this.endWork();
    for (const a of this.actors) { a.b.face = false; a.b.emote = ''; a.b.resting = false; a.b.action = null; a.b.lookAt = null; }
    this.duo = null; this.mode = 'follow'; this.t = 0; this.next = between(30, 70);
  }
}
