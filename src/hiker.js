import * as THREE from 'three';
import { clamp, smoothstep } from './noise.js';

// First-person hiker: walking with grade-aware pace, sprinting on a stamina
// budget, wading and swimming, sliding on steep ground, falls that hurt, and
// free climbing on any face too steep to walk, with a grip meter.

const EYE = 1.68;
const GRAVITY = 18;
const WALK_MAX = 1.05;    // |dh/dxz| you can walk up (~46 deg)
const SLIDE = 1.4;        // you lose your footing beyond this (~54 deg)
const CLIMBABLE = 0.95;   // a face steeper than this can be climbed
const TOP_OUT = 0.68;

// stances: eye height, and the share of walking pace you keep
const STANCE = {
  stand: { eye: EYE, speed: 1 },
  crouch: { eye: 0.92, speed: 0.5 },
  prone: { eye: 0.36, speed: 0.14 },
};

// timed body actions. `hits` are the moments (s into the action) a strike
// lands; `slow` is the share of pace you keep while it plays. The hit
// reactions are what other characters' blows do to you.
export const ACTIONS = {
  jab: { dur: 0.62, hits: [0.26], slow: 0.35, cost: 3 },
  cross: { dur: 0.58, hits: [0.24], slow: 0.3, cost: 4 },
  combo: { dur: 1.15, hits: [0.22, 0.5, 0.85], slow: 0.2, cost: 8 },
  hook: { dur: 0.85, hits: [0.4], slow: 0.25, cost: 6 },
  stomp: { dur: 0.9, hits: [0.45], slow: 0.2, cost: 4 },
  chop: { dur: 0.65, hits: [0.3], slow: 0.12, cost: 2 },      // an axe swing (0.65 s, landing at 46%); props.js decides what it hits
  slash: { dur: 0.9, hits: [0.4], slow: 0.2, cost: 2.5 },      // a machete swing
  hitSide: { dur: 1.1, hits: [], slow: 0 },
  hitKidney: { dur: 0.9, hits: [], slow: 0 },
  hitHead: { dur: 0.7, hits: [], slow: 0.1 },
  hitUpper: { dur: 1.3, hits: [], slow: 0 },
  hitFace: { dur: 1.0, hits: [], slow: 0 },
  climbOut: { dur: 1.7, hits: [], slow: 0.4 },   // hauling out of deep water onto the bank
};
const CHAIN = 0.45;   // window after a jab or cross to throw the next punch of the combo

export class Hiker {
  constructor(world, flora) {
    this.world = world;
    this.flora = flora;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.mode = 'walk';
    this.grounded = true;
    this.stamina = 100; this.grip = 100; this.warmth = 100;
    this.wet = 0; this.injured = 0;
    this.airTop = 0; this.slideDrop = 0;
    this.phase = 0; this.moving = 0;  // phase advances PI per footstep
    this.hint = '';
    this.events = [];
    this.wallUp = new THREE.Vector2(0, -1);
    this._g = { x: 0, z: 0 };
    this.stance = 'stand'; this.eyeH = EYE;
    this.stanceLock = 0;              // s left getting up or down
    this.recover = 0;                 // s left stumbling out of a hard landing
    this.flip = false; this.resting = false; this.climbSpeed = 0;
    this.swimT = 0; this.exitCool = 0;   // s spent swimming; s before the next climb-out can play
    this.action = null;               // { id, kind, t, dur, ... } while punching or reeling
    this.lastKind = ''; this.chainT = 0; this.actionId = 0;
    this.tool = 'fists';              // what is in hand: fists, axe or machete (props.js sets it)
    this.load = 0;                    // 1 while carrying a stone
    this.channel = false;             // true while sculpting the ground (mind.js)
    this.pushing = false;             // shoving a boulder
  }

  place(x, z, yaw = this.yaw) {
    this.pos.set(x, this.world.height(x, z), z);
    this.vel.set(0, 0, 0);
    this.yaw = yaw; this.pitch = 0;
    this.mode = 'walk'; this.grounded = true;
    this.airTop = this.pos.y; this.slideDrop = 0;
    this.stance = 'stand'; this.eyeH = EYE; this.stanceLock = 0; this.recover = 0;
    this.action = null; this.chainT = 0; this.flip = false;
  }

  eye(out) {
    if (this.mode === 'climb') {
      return out.set(this.pos.x - this.wallUp.x * 0.55, this.pos.y + 1.45, this.pos.z - this.wallUp.y * 0.55);
    }
    return out.set(this.pos.x, this.pos.y + (this.mode === 'swim' ? 1.68 : this.sitting ? this.eyeH - 0.56 : this.eyeH), this.pos.z);
  }

  ground(x, z) {
    return this.world.height(x, z);
  }

  update(dt, inp, env) {
    this.events.length = 0;
    this.hint = '';
    this.yaw -= inp.lookX;
    this.pitch = clamp(this.pitch - inp.lookY, -1.5, 1.5);
    this.injured = Math.max(0, this.injured - dt);
    this.resting = !!env.resting;
    this.stanceLock = Math.max(0, this.stanceLock - dt);
    this.recover = Math.max(0, this.recover - dt);
    this.exitCool = Math.max(0, this.exitCool - dt);
    if (this.mode === 'climb') { this.stance = 'stand'; this.action = null; this.eyeH = EYE; }
    else { this.#stance(dt, inp); this.#combat(dt, inp); }
    this.wet = Math.max(0, this.wet - dt * (env.nearFire ? 4 : 1));
    if (this.mode === 'climb') this.#climb(dt, inp);
    else this.#walk(dt, inp);
    this.#body(dt, env);
    return this.events;
  }

  /** Riding: the vehicle owns the body; follow it and keep the survival numbers ticking. */
  carried(dt, pos, vel, env) {
    this.events.length = 0;
    this.hint = '';
    this.pos.copy(pos);
    this.vel.copy(vel);
    this.mode = 'walk'; this.grounded = true; this.sliding = false;
    this.moving = 0; this.lastGrade = 0;
    this.airTop = pos.y; this.slideDrop = 0;
    this.injured = Math.max(0, this.injured - dt);
    this.wet = Math.max(0, this.wet - dt * (env.nearFire ? 4 : 1));
    this.#body(dt, env);
    return this.events;
  }

  // ---------------------------------------------------------------- walking
  #walk(dt, inp) {
    const w = this.world, p = this.pos;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    // bodies walk backwards and sideways slower than forwards
    const my = inp.move.y < 0 ? inp.move.y * 0.6 : inp.move.y, mx = inp.move.x * 0.85;
    let wx = fx * my + -fz * mx;
    let wz = fz * my + fx * mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }

    const lakeHere = w.lakeAt(p.x, p.z);
    const frozen = lakeHere && lakeHere.level >= w.iceLine;   // winter: walk out on the ice
    const lake = frozen ? null : lakeHere;
    const groundH = w.height(p.x, p.z);
    const brook = w.nearestStream(p.x, p.z);
    const creekDepth = brook.stream && brook.d < brook.stream.width / 2 + 0.3 ? Math.max(0, brook.y - groundH) : 0;
    const depth = Math.max(lake ? lake.level - groundH : 0, creekDepth);
    if (creekDepth > 0.05 && this.grounded) this.wet = Math.max(this.wet, 40);
    if (depth > 1.3) {
      if (this.mode !== 'swim') this.events.push({ type: 'splash', big: true });
      this.mode = 'swim';
    } else if (this.mode === 'swim') {
      this.mode = 'walk';
      // a real swim ends with a haul out, not a sudden stand
      if (this.swimT > 0.8 && this.exitCool <= 0 && !this.action) { this.#startAction('climbOut'); this.exitCool = 4; this.events.push({ type: 'exit' }); }
    }
    this.swimT = this.mode === 'swim' ? this.swimT + dt : 0;

    const winded = this.stamina < 2;
    const sprinting = inp.sprint && !this.load && !this.channel && this.stance === 'stand' && !this.action && !winded && this.injured <= 0 && this.mode === 'walk' && wl > 0.1 && depth < 0.4;
    let speed = this.mode === 'swim' ? 1.2 : sprinting ? 4.5 : winded ? 1.8 : 2.5;
    if (this.injured > 0) speed *= 0.55;
    if (this.load) speed *= 0.72;
    if (this.channel) speed *= 0.6;
    if (depth > 0.15 && this.mode === 'walk') speed *= 0.6;
    if (this.mode === 'walk') {
      speed *= STANCE[this.stance].speed * (this.action ? this.action.slow : 1) * (this.recover > 0 ? 0.3 : 1) * (this.stanceLock > 0.3 ? 0.2 : 1);
    }

    // pace by grade along the direction of travel
    let grade = 0;
    if (wl > 0.05 && this.mode === 'walk') {
      const ahead = w.height(p.x + wx * 0.8, p.z + wz * 0.8);
      grade = (ahead - groundH) / 0.8;
      speed *= grade > 0 ? 1 / (1 + 1.7 * grade) : 1 - 0.35 * clamp(-grade - 0.35, 0, 1);
      const steepAhead = w.localGrade(p.x + wx * 0.8, p.z + wz * 0.8);
      if (grade > 0.2 && steepAhead > WALK_MAX) {
        // too steep: only the along-contour part of the move survives
        const g = w.gradient(p.x, p.z, this._g), gl = Math.hypot(g.x, g.z) || 1;
        const ux = g.x / gl, uz = g.z / gl, up = wx * ux + wz * uz;
        if (up > 0) { wx -= ux * up; wz -= uz * up; }
        this.hint = steepAhead > CLIMBABLE ? 'Too steep to walk — [E] to climb' : 'Too steep';
      }
    }
    this.lastGrade = grade;

    const accel = this.grounded || this.mode === 'swim' ? 11 : 1.5;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (wx * speed - this.vel.x) * k;
    this.vel.z += (wz * speed - this.vel.z) * k;

    // sliding on ground too steep to stand on
    const here = w.localGrade(p.x, p.z);
    this.sliding = this.grounded && this.mode === 'walk' && here > SLIDE;
    if (this.sliding) {
      const g = w.gradient(p.x, p.z, this._g), gl = Math.hypot(g.x, g.z) || 1;
      this.vel.x -= (g.x / gl) * 9 * dt;
      this.vel.z -= (g.z / gl) * 9 * dt;
      this.hint = 'Sliding! — [E] grab the rock';
    }

    p.x += this.vel.x * dt;
    p.z += this.vel.z * dt;
    const lim = w.half - 40;
    p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
    this.solids?.(p, 0.3);               // tent walls
    const lift = this.flora.collide(p, 0.32, p.y);
    const lk2 = w.lakeAt(p.x, p.z);
    const ice = lk2 && lk2.level >= w.iceLine ? lk2.level : -Infinity;
    const ground = Math.max(w.height(p.x, p.z), lift, ice, this.floorAt ? this.floorAt(p.x, p.z) : -Infinity);

    if (this.mode === 'swim') {
      const lk = w.lakeAt(p.x, p.z);
      const surface = (lk ? lk.level : ground + 1.3) - 1.3;
      p.y = Math.max(ground, surface);
      this.vel.y = 0;
      this.grounded = true;
      this.wet = 180;
      this.#strideStep(dt, 'swim', 2.2);
      return;
    }

    if (this.grounded) {
      const snap = 0.25 + Math.hypot(this.vel.x, this.vel.z) * dt * 1.6;
      if (p.y - ground <= snap && this.vel.y <= 0.01) {
        const drop = p.y - ground;
        p.y = ground;
        this.vel.y = 0;
        if (this.sliding) this.slideDrop += Math.max(0, drop); else this.slideDrop = Math.max(0, this.slideDrop - dt * 6);
      } else {
        this.grounded = false;
        this.airTop = p.y;
      }
    }
    if (this.grounded && inp.jump && this.mode === 'walk' && !this.action) {
      if (this.stance !== 'stand') {
        if (this.stanceLock <= 0) this.#setStance('stand');
      } else if (this.stamina > 6 && this.recover <= 0) {
        // sprinting into a jump throws a front flip: higher and longer, and it costs more
        const flip = sprinting && this.stamina > 22;
        this.vel.y = flip ? 7.4 : 5.4;
        this.flip = flip;
        this.grounded = false;
        this.airTop = p.y;
        this.stamina -= flip ? 16 : 6;
        this.events.push({ type: 'jump', flip });
      }
    }
    if (!this.grounded) {
      this.vel.y -= GRAVITY * dt;
      p.y += this.vel.y * dt;
      this.airTop = Math.max(this.airTop, p.y);
      if (p.y <= ground) {
        const fall = this.airTop - ground;
        p.y = ground; this.vel.y = 0; this.grounded = true;
        this.#landed(fall);
      }
    }
    if (this.slideDrop > 28) { this.slideDrop = 0; this.events.push({ type: 'fall', severe: true, why: 'You tumbled down the slope.' }); }

    if (inp.grab) this.#tryGrab();
    const surface = depthSurface(depth) || (ice > -Infinity && p.y - ice < 0.1 ? 'snow' : surfaceAt(w, p, this.grounded));
    this.#strideStep(dt, surface, sprinting ? 1.75 : 1.4);
  }

  #landed(fall) {
    this.flip = false;
    if (fall > 2.5) this.recover = 0.45;
    if (fall > 17) this.events.push({ type: 'fall', severe: true, why: `You fell ${Math.round(fall)} m.` });
    else if (fall > 6.5) {
      this.injured = 30 + fall * 2;
      this.stamina = Math.max(0, this.stamina - fall * 3);
      this.events.push({ type: 'fall', severe: false, why: 'Hard landing — you tweaked an ankle.' });
    } else if (fall > 0.35) this.events.push({ type: 'land', hard: fall > 3, fall });
  }

  /** Advance the stride phase; a footstep lands each time it crosses a multiple of PI. */
  #strideStep(dt, surface, stride) {
    const v = Math.hypot(this.vel.x, this.vel.z);
    this.moving += ((v > 0.4 ? 1 : 0) - this.moving) * Math.min(1, dt * 8);
    if (!this.grounded) return;
    const before = Math.floor(this.phase / Math.PI);
    // at rest, settle onto the next footfall instead of freezing mid-stride
    this.phase += v > 0.15 ? v * dt * (Math.PI / stride) : Math.min(0.6 * dt, Math.PI - (this.phase % Math.PI)) * (this.phase % Math.PI > 0.01 ? 1 : 0);
    if (Math.floor(this.phase / Math.PI) !== before && v > 0.25) this.events.push({ type: 'step', surface, speed: v });
  }

  #tryGrab() {
    const w = this.world, p = this.pos;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const ahead = w.localGrade(p.x + fx * 1.2, p.z + fz * 1.2);
    const here = w.localGrade(p.x, p.z);
    if (Math.max(ahead, here) < CLIMBABLE) {
      this.events.push({ type: 'toast', text: 'Nothing steep enough to climb here.' });
      return;
    }
    if (this.stamina < 10 || this.grip < 15) {
      this.events.push({ type: 'toast', text: 'Too tired to climb — rest a moment.' });
      return;
    }
    if (ahead > here) { p.x += fx * 0.8; p.z += fz * 0.8; }
    p.y = w.height(p.x, p.z);
    this.mode = 'climb';
    this.vel.set(0, 0, 0);
    this.grounded = true;
    this.climbStartY = p.y;
    this.events.push({ type: 'grab' });
  }

  // ---------------------------------------------------------------- climbing
  #climb(dt, inp) {
    const w = this.world, p = this.pos;
    const g = w.gradient(p.x, p.z, this._g);
    const gl = Math.hypot(g.x, g.z);
    if (gl > 1e-3) this.wallUp.set(g.x / gl, g.z / gl);
    const ux = this.wallUp.x, uz = this.wallUp.y;
    const cosT = 1 / Math.sqrt(1 + gl * gl);
    const steep = w.localGrade(p.x, p.z);

    let ds = 1.15 * dt;
    let up = inp.move.y, side = inp.move.x;
    if (inp.jump && this.grip > 18 && up >= 0) { up = 1; ds = 1.8; this.grip -= 16; this.events.push({ type: 'grab', lunge: true }); }
    const moving = Math.abs(up) + Math.abs(side) > 0.1;
    // move along the wall: "up" follows the fall line, "side" follows the contour
    p.x += ux * up * ds * cosT + -uz * side * ds;
    p.z += uz * up * ds * cosT + ux * side * ds;
    const lim = w.half - 40;
    p.x = clamp(p.x, -lim, lim); p.z = clamp(p.z, -lim, lim);
    p.y = w.height(p.x, p.z);

    const ledge = steep < 0.85;
    this.grip += (ledge ? 14 : -(1.6 + (moving ? 3.4 : 0)) * (1 + Math.max(0, p.y - 3300) / 1500)) * dt;
    this.grip = Math.min(100, this.grip);
    this.stamina = Math.max(0, this.stamina - (moving ? 2.5 : 0.5) * dt);
    this.hint = ledge ? 'Good ledge — catch your breath' : '[W/S] climb · [A/D] traverse · [Space] lunge · [E] let go';
    this.climbSpeed = moving ? ds / dt : 0;
    this.climbStride = (this.climbStride || 0) + (moving ? ds : 0);
    if (moving) this.phase += ds * 2.2;
    if (this.climbStride > 0.7) { this.climbStride = 0; this.events.push({ type: 'step', surface: 'rock', speed: 1 }); }

    if (steep < TOP_OUT) {
      this.mode = 'walk';
      if (p.y - this.climbStartY > 4) this.events.push({ type: 'toast', text: `Topped out · climbed ${Math.round(p.y - this.climbStartY)} m` });
      return;
    }
    if (this.grip <= 0 || inp.grab) {
      this.mode = 'walk';
      this.grounded = false;
      this.airTop = p.y;
      this.vel.set(-ux * 1.6, 0.5, -uz * 1.6);
      p.x -= ux * 0.6; p.z -= uz * 0.6;
      p.y += 0.3;
      if (this.grip <= 0) this.events.push({ type: 'toast', text: 'Lost your grip!', warn: true });
    }
  }

  // ---------------------------------------------------------------- stance
  #stance(dt, inp) {
    if (this.mode !== 'walk') this.stance = 'stand';
    else if (inp.crouch && this.grounded && this.stanceLock <= 0 && !this.action) {
      this.#setStance(this.stance === 'stand' ? 'crouch' : this.stance === 'crouch' ? 'prone' : 'stand');
    }
    let eye = STANCE[this.stance].eye;
    if (this.stance === 'crouch' && this.moving > 0.5) eye += 0.2;                       // the crouched walk rides higher than the crouch
    else if (this.stance === 'stand' && this.resting && this.moving < 0.2) eye = 1.15;   // sitting
    this.eyeH += (eye - this.eyeH) * (1 - Math.exp(-9 * dt));
  }

  #setStance(to) {
    const from = this.stance;
    this.stance = to;
    // getting up from lying down takes a moment; the rest are quick
    this.stanceLock = from === 'prone' ? 1.3 : to === 'prone' ? 1 : 0.25;
    this.events.push({ type: 'stance', from, to });
  }

  // ---------------------------------------------------------------- fighting
  #combat(dt, inp) {
    const a = this.action;
    if (a) {
      const before = a.t;
      a.t += dt;
      a.hits.forEach((h, n) => {
        if (before < h && a.t >= h) this.events.push({ type: 'strike', kind: a.kind, n, last: n === a.hits.length - 1, x: -Math.sin(this.yaw), z: -Math.cos(this.yaw), reach: 1.2 });
      });
      if (a.t >= a.dur) {
        this.chainT = a.kind === 'jab' || a.kind === 'cross' ? CHAIN : 0;
        this.lastKind = a.kind;
        this.action = null;
      }
    } else if (this.chainT > 0) this.chainT -= dt;

    const want = this.load || this.channel ? '' : inp.punch ? (this.tool === 'axe' ? 'chop' : this.tool === 'machete' ? 'slash' : 'punch') : inp.hook ? 'hook' : inp.stomp ? 'stomp' : '';
    if (!want || this.action || this.mode !== 'walk' || !this.grounded || this.stance !== 'stand' || this.stanceLock > 0 || this.stamina < 4) return;
    let kind = want;
    if (want === 'punch') kind = this.chainT > 0 && this.lastKind === 'jab' ? 'cross' : this.chainT > 0 && this.lastKind === 'cross' ? 'combo' : 'jab';
    this.#startAction(kind);
  }

  #startAction(kind) {
    const spec = ACTIONS[kind];
    this.action = { id: ++this.actionId, kind, t: 0, dur: spec.dur, hits: spec.hits, slow: spec.slow };
    this.chainT = 0;
    this.stamina = Math.max(0, this.stamina - (spec.cost || 0));
  }

  /**
   * Take a blow: kind is side, kidney, head, upper or face. `from` is an
   * optional {x, z} for the attacker, which shoves you back a little. Other
   * characters' fights call this; nothing in the world throws punches yet.
   */
  receiveHit(kind = 'side', from = null) {
    const name = `hit${kind[0].toUpperCase()}${kind.slice(1)}`;
    if (!ACTIONS[name] || this.mode !== 'walk') return false;
    this.#startAction(name);
    this.stanceLock = 0;
    if (from) {
      const dx = this.pos.x - from.x, dz = this.pos.z - from.z, d = Math.hypot(dx, dz) || 1;
      this.vel.x += (dx / d) * 2.2; this.vel.z += (dz / d) * 2.2;
    }
    return true;
  }

  // ---------------------------------------------------------------- body
  #body(dt, env) {
    const working = this.moving > 0.5;
    const thin = 1 - smoothstep(3000, 3950, this.pos.y) * 0.4; // thinner air, slower recovery
    if (this.mode === 'walk' && this.grounded) {
      const sprint = working && Math.hypot(this.vel.x, this.vel.z) > 3.6;
      const climbGrade = Math.max(0, this.lastGrade || 0);
      if (sprint) this.stamina -= (13 + climbGrade * 14) * dt;
      else if (working) this.stamina += (7 - climbGrade * 22) * thin * dt;
      else this.stamina += 14 * thin * dt;
      if (this.mode !== 'climb') this.grip = Math.min(100, this.grip + 20 * dt);
    } else if (this.mode === 'swim') this.stamina -= 3 * dt;
    if (env.resting) this.stamina += 20 * dt;
    if (this.warmth < 25) this.stamina = Math.min(this.stamina, 60);
    this.stamina = clamp(this.stamina, 0, 100);

    // warmth follows air temperature, wind, wetness, fire and shelter
    let target = env.tempC + 22 * (env.fireWarm ?? (env.nearFire ? 1 : 0)) + (env.inTent ? 18 : 0) + (working ? 5 : 0) - (this.wet > 0 ? 9 : 0) - (this.mode === 'swim' ? 12 : 0);
    const rate = (target - 8) * 0.12;
    this.warmth = clamp(this.warmth + rate * dt, 0, 100);
    this.cold = this.warmth < 25;
  }
}

function depthSurface(depth) {
  return depth > 0.08 ? 'water' : null;
}

function surfaceAt(w, p, grounded) {
  if (!grounded) return 'air';
  const t = w.nearestTrail(p.x, p.z);
  if (t.trail && t.d < t.trail.width / 2 + 0.3) return t.trail.kind === 'road' ? 'gravel' : 'dirt';
  const cv = w.cover(p.x, p.z, p.y);
  if (cv.snow > 0.5) return 'snow';
  if (cv.rock > 0.5) return 'rock';
  if (cv.forest > 0.5) return 'duff';
  return 'grass';
}
