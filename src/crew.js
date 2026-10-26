// The crew's senses and voices, ported from Blaize's rawah_companions.py (kept beside the referee in tools/crew/).
// No browser or three.js here, so the node referee (tools/crew_referee.mjs) runs this same file.
//
// SENSES. A companion only "knows" what physics delivers to him. A smell is a diffusing event of mass A, diffusivity D and
// a perception threshold eps; from the boxel cone laws (Rouyea & Bourgeois, "Certified Locality in Diffusive Simulation")
// it can only ever be noticed inside R = sqrt(A / (pi e eps)), only between a closed-form arrival and departure, and is gone
// everywhere after A / (4 pi D eps). Same-kind sources ADD (diffusion is linear), so two fires' smoke is one smell and two
// faint sources can be noticeable together when neither is alone. `certifiedCrossings` finds when the SUMMED field crosses
// a threshold, with a certificate that a stretch has no crossing (so a companion sleeps through it) and bisection only on
// the undecided pieces. Convention everywhere: perceived iff the summed level is strictly above the threshold.
//
// THE WHEEL. Companions sleep like boxel cells: no model call until a certified window opens, a smell turns strong, or it
// fades. Wake times are filed in a timing wheel; a new source of a kind files a new revision of every companion's wake
// times for it, and times filed under an older revision are dropped when they come up. Call count follows what happens,
// not how long it takes. Blaize measured 10-12x fewer model calls than polling every companion every 10 s.
//
// VOICES. Each companion has a voice card; they all read one shared scene log, so they react to and roast each other.

export const R2_FLOOR = 0.25;   // a listener is never closer than half a unit to a point source

// ------------------------------------------------------------------ the math

/** Real Lambert W on (-1/e, 0): branch 0 (w >= -1) or -1 (w <= -1), by Halley iteration. */
export function lambertW(x, branch) {
  if (!(x > -1 / Math.E && x < 0)) throw new RangeError('x outside (-1/e, 0)');
  let w;
  if (branch === -1) { const L = Math.log(-x); w = Math.min(L - Math.log(-L), -1.0001); } else w = x > -0.25 ? x : -0.5;
  for (let i = 0; i < 60; i++) {
    const ew = Math.exp(w), f = w * ew - x, d = ew * (w + 1);
    if (d === 0) break;
    const step = f / (d - ((w + 2) * f) / (2 * (w + 1)));
    w -= step;
    if (Math.abs(step) < 1e-13) break;
  }
  return w;
}

/** 2D heat kernel of mass A, tau seconds after release, at squared distance r2. */
export function kernel(A, D, tau, r2) {
  if (tau <= 0) return 0;
  return (A / (4 * Math.PI * D * tau)) * Math.exp(-Math.max(r2, R2_FLOOR) / (4 * D * tau));
}

/**
 * Times in [tFrom, tTo] where S(t) = the sum of kernels crosses thr, as { state0, crossings: [[t, +1 up / -1 down], ...] }.
 * terms: [A, D, t0, r2] for every same-kind source the listener could ever get.
 * Certificate: each kernel rises monotonically from its release to its peak (t0 + r2 / 4D) and falls after it, so on any piece
 * free of those breakpoints the sum is enclosed by its terms' endpoint values. A piece whose enclosure clears thr provably
 * has no crossing and is skipped; only undecided pieces are bisected, down to width tol.
 */
export function certifiedCrossings(termsIn, thr, tFrom, tToIn, tol = 0.01) {
  let tTo = tToIn;
  const terms = termsIn.map(([A, D, t0, r2]) => [A, D, t0, Math.max(r2, R2_FLOOR)]).filter((t) => t[2] < tTo);
  const S = (t) => { let s = 0; for (const [A, D, t0, r2] of terms) s += kernel(A, D, t - t0, r2); return s; };
  const state0 = S(tFrom) > thr;
  if (!terms.length) return { state0, crossings: [] };
  // certified silence: after the time the bound sum A / (4 pi D tau) drops under thr, the field is under thr everywhere
  let last = -Infinity;
  for (const t of terms) last = Math.max(last, t[2]);
  const bound = (t) => { let s = 0; for (const [A, D, t0] of terms) s += A / (4 * Math.PI * D * (t - t0)); return s; };
  let hi = last + 1;
  while (bound(hi) > thr) hi = last + (hi - last) * 2;
  let lo = last;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (bound(mid) > thr) lo = mid; else hi = mid; }
  tTo = Math.min(tTo, hi);
  if (tTo <= tFrom) return { state0, crossings: [] };

  const set = new Set([tFrom, tTo]);
  for (const [, D, t0, r2] of terms) for (const b of [t0, t0 + r2 / (4 * D)]) if (b > tFrom && b < tTo) set.add(b);
  const breaks = [...set].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < breaks.length; k++) {
    const stack = [[breaks[k], breaks[k + 1], S(breaks[k]), S(breaks[k + 1])]];
    while (stack.length) {
      const [x, y, sx, sy] = stack.pop();
      let lo2 = 0, hi2 = 0;
      for (const [A, D, t0, r2] of terms) {
        const ux = kernel(A, D, x - t0, r2), uy = kernel(A, D, y - t0, r2);
        lo2 += Math.min(ux, uy); hi2 += Math.max(ux, uy);
      }
      if (hi2 <= thr || lo2 > thr) continue;          // certified: no crossing in here
      if (y - x <= tol) {
        if (sx <= thr && thr < sy) out.push([(x + y) / 2, +1]);
        else if (sx > thr && thr >= sy) out.push([(x + y) / 2, -1]);
        continue;
      }
      const m = (x + y) / 2, sm = S(m);
      stack.push([m, y, sm, sy]);                      // the right half after the left half
      stack.push([x, m, sx, sm]);
    }
  }
  return { state0, crossings: out };
}

/** One diffusing event: a smell, a storm front, a stink. pos = [x, z] in metres, t0 in seconds. */
export class SenseEvent {
  constructor(kind, pos, t0, A, D, eps, notice) {
    this.kind = kind; this.pos = pos; this.t0 = t0; this.A = A; this.D = D; this.eps = eps; this.notice = notice;
  }

  level(pos, t) {
    const dt = t - this.t0;
    if (dt <= 0) return 0;
    const r2 = (pos[0] - this.pos[0]) ** 2 + (pos[1] - this.pos[1]) ** 2;
    return (this.A / (4 * Math.PI * this.D * dt)) * Math.exp(-r2 / (4 * this.D * dt));
  }

  /** R_eps: footprint pi R^2 = A / (e eps). */
  get radius() { return Math.sqrt(this.A / (Math.PI * Math.E * this.eps)); }

  /** After this, nothing anywhere exceeds eps. */
  get goneAt() { return this.t0 + this.A / (4 * Math.PI * this.D * this.eps); }

  /** [arrival, departure] of level >= thr (default eps) at pos from this one source, or null if it never gets there. */
  window(pos, thr = this.eps) {
    const r = Math.hypot(pos[0] - this.pos[0], pos[1] - this.pos[1]);
    if (r < 1e-9) return [this.t0, this.t0 + this.A / (4 * Math.PI * this.D * thr)];
    if (r >= Math.sqrt(this.A / (Math.PI * Math.E * thr))) return null;
    const x = (-Math.PI * r * r * thr) / this.A;
    const early = -lambertW(x, -1), late = -lambertW(x, 0);
    return [this.t0 + (r * r) / (4 * this.D * early), this.t0 + (r * r) / (4 * this.D * late)];
  }
}

/** All the smells in the world. */
export class Senses {
  static PRUNE = 1e-3;     // drop a source once its bound A / (4 pi D tau) is under 0.1% of eps

  constructor() { this.events = []; this.kinds = new Map(); }   // kind -> [eps, notice]

  add(ev) {
    if (!this.kinds.has(ev.kind)) this.kinds.set(ev.kind, [ev.eps, ev.notice]);
    const [eps] = this.kinds.get(ev.kind);
    if (ev.eps !== eps) throw new Error(`every '${ev.kind}' source must share one threshold (${eps})`);
    this.events.push(ev);
  }

  active(kind, t) {
    const eps = this.kinds.get(kind)[0];
    return this.events.filter((e) => e.kind === kind && (t <= e.t0 || e.A / (4 * Math.PI * e.D * (t - e.t0)) > eps * Senses.PRUNE));
  }

  level(kind, pos, t) { let s = 0; for (const e of this.active(kind, t)) s += e.level(pos, t); return s; }

  /** What can be sensed at pos at time t, as phrases. */
  perceive(pos, t) {
    const out = [];
    for (const [kind, [eps, notice]] of this.kinds) {
      const ratio = this.level(kind, pos, t) / eps;
      if (ratio > 1) out.push(`a ${ratio > 8 ? 'strong' : ratio > 2 ? 'clear' : 'faint'} smell of ${notice}`);
    }
    return out;
  }

  /** Forget sources that are long gone, so lists stay short over a long session. */
  prune(t) {
    this.events = this.events.filter((e) => { const eps = this.kinds.get(e.kind)[0]; return t <= e.t0 || e.A / (4 * Math.PI * e.D * (t - e.t0)) > eps * Senses.PRUNE; });
  }
}

// ------------------------------------------------------------------ the wheel

const REASONS = { '1,1': 'you just started to notice {n}', '8,1': '{n} is getting strong', '8,-1': '{n} is easing off', '1,-1': '{n} just faded away' };

/**
 * Wake times for a set of listeners. It never calls a model itself: `run(tEnd, wake)` pops due entries in time order and awaits
 * `wake({ t, name, reason, kind })` for each, which does whatever a wake means (say a line). `positions` is { name: [x, z] }.
 */
export class SpeechWheel {
  static STRONG = 8;

  constructor(senses, positions, { cooldown = 20, quietGap = 150, replyDelay = 4, camp = null } = {}) {
    this.senses = senses;
    this.positions = positions;
    this.cooldown = cooldown;          // a companion won't speak twice inside this (a minor update is slept through)
    this.quietGap = quietGap;          // dead air this long -> ambient banter
    this.replyDelay = replyDelay;
    this.camp = camp || (() => Object.keys(positions));   // who can hear whom
    this.heap = [];                    // sorted by [t, seq]
    this.seq = 0;
    this.lastSpoke = {};
    this.lastAny = 0;
    this.now = 0;
    this.calls = 0; this.skipped = 0; this.recomputes = 0; this.pruned = 0;
    this.replyBlockUntil = -Infinity;
    this.rev = new Map();              // "name|kind" -> the current revision of his wake times
  }

  #push(t, name, reason, kind = null, rev = null) {
    const e = { t, seq: this.seq++, name, reason, kind, rev };
    let lo = 0, hi = this.heap.length;
    while (lo < hi) { const m = (lo + hi) >> 1; const h = this.heap[m]; if (h.t < e.t || (h.t === e.t && h.seq < e.seq)) lo = m + 1; else hi = m; }
    this.heap.splice(lo, 0, e);
  }

  /** Is anything due by time t (a wake time, or dead air long enough for banter)? */
  due(t) { return (this.heap.length > 0 && this.heap[0].t <= t) || this.lastAny + this.quietGap <= t; }

  /** Register a world event: every listener's wake times for that smell are refiled from now on, as a new revision. */
  watch(ev, tol = 0.01) {
    this.senses.add(ev);
    this.#refreshKind(ev.kind, tol);
  }

  /** Listeners who moved (or a new listener) need their wake times redone for every live smell. */
  refreshListener(name, tol = 0.01) {
    for (const kind of this.senses.kinds.keys()) this.#refreshOne(name, kind, tol);
  }

  #refreshKind(kind, tol) {
    for (const name of Object.keys(this.positions)) this.#refreshOne(name, kind, tol);
  }

  #refreshOne(name, kind, tol) {
    const [eps, notice] = this.senses.kinds.get(kind);
    const pos = this.positions[name];
    const now = Math.max(this.now, 0);
    const terms = this.senses.active(kind, now).map((e) => [e.A, e.D, e.t0, (pos[0] - e.pos[0]) ** 2 + (pos[1] - e.pos[1]) ** 2]);
    const key = `${name}|${kind}`;
    // each source peaks at A / (pi e r^2) at his spot; if even the sum of every peak can't beat eps, the summed field
    // provably never does (for one source, the cone test)
    let peaks = 0;
    for (const [A, , , r2] of terms) peaks += A / (Math.PI * Math.E * Math.max(r2, R2_FLOOR));
    this.rev.set(key, (this.rev.get(key) || 0) + 1);         // older wake times of this pair are dead either way
    if (peaks <= eps) { this.pruned++; return; }
    this.recomputes++;
    const rev = this.rev.get(key);
    for (const mult of [1, SpeechWheel.STRONG]) {
      const { crossings } = certifiedCrossings(terms, eps * mult, now, Infinity, tol);
      for (const [t, d] of crossings) this.#push(t, name, REASONS[`${mult},${d}`].replace('{n}', notice), kind, rev);
    }
  }

  /** Advance to tEnd, waking at the filed times. `wake` may be async (a model call); the clock does not run ahead of it. */
  async run(tEnd, wake) {
    for (;;) {
      const next = this.heap.length ? this.heap[0].t : Infinity;
      const quiet = this.lastAny + this.quietGap;
      if (Math.min(next, quiet) > tEnd) break;
      if (quiet < next) {                                     // dead air: two at camp shoot the breeze
        this.now = quiet;
        const camp = this.camp();
        if (camp.length >= 2) {
          const a = camp[Math.floor(Math.random() * camp.length)];
          const rest = camp.filter((n) => n !== a);
          const b = rest[Math.floor(Math.random() * rest.length)];
          for (const who of [a, b]) {
            this.calls++;
            this.lastSpoke[who] = quiet;
            await wake({ t: quiet, name: who, reason: 'quiet stretch', kind: 'quiet' });
          }
        }
        this.lastAny = quiet;
        continue;
      }
      const e = this.heap.shift();
      if (e.kind !== null && this.rev.get(`${e.name}|${e.kind}`) !== e.rev) continue;    // superseded by a newer revision
      this.now = e.t;
      if (e.reason !== 'reply' && !e.reason.includes('started to notice') && e.t - (this.lastSpoke[e.name] ?? -Infinity) < this.cooldown) {
        this.skipped++;                                        // just talked: he sleeps through a minor update
        continue;
      }
      this.calls++;
      this.lastSpoke[e.name] = this.lastAny = e.t;
      const said = await wake({ t: e.t, name: e.name, reason: e.reason, kind: e.kind || 'reply' });
      if (e.reason !== 'reply' && said !== false && e.t >= this.replyBlockUntil) {
        const others = this.camp().filter((n) => n !== e.name);
        if (others.length) {                                   // someone answers (replies never chain)
          this.#push(e.t + this.replyDelay, others[Math.floor(Math.random() * others.length)], 'reply');
          this.replyBlockUntil = e.t + this.cooldown / 2;      // one reply per moment
        }
      }
    }
    this.now = Math.max(this.now, tEnd);
  }
}

// ------------------------------------------------------------------ the voices

export const CREW_BIBLE =
  "You are one of the crew in the game Rawah: Blaize, Corey, Grant, Taylor and Trey (today only some of them are on this trail). " +
  "They're brothers in everything but blood and best friends since forever. Every one of them is witty, sarcastic, smart and down to earth. " +
  "They roast each other constantly, but it's love: the roasts are never actually cruel, and if someone is genuinely hurt or in trouble " +
  "the jokes stop until he's okay, then resume immediately.\n" +
  "The crew's eternal argument: slow down and soak in the calm, beautiful stuff (sunsets, quiet ridges, glowing caves you just look at) " +
  "versus chase side quests, danger and off-trail chaos.";

// Placeholder personalities from Blaize's file; rewrite freely with the real guys' energy.
export const DEFAULT_CREW = [
  { name: 'Blaize', lean: 0.5, angle: 'the schemer. every bad idea arrives with a full pitch.',
    voice: "confident and fast, talks like he's selling the plan, loves 'hear me out' and 'trust me'",
    roast: 'buries people in mock-serious logic and fake statistics',
    examples: ['hear me out: the cliff IS the shortcut.', 'statistically Grant falls first, so the rest of us are fine.'] },
  { name: 'Corey', lean: -0.4, angle: 'the deadpan. watches the chaos like a nature documentary.',
    voice: 'dry, short, understated, never raises his voice, lets one sentence do the damage',
    roast: 'flat one-liners delivered like facts',
    examples: ["cool. I'll be over here, enjoying not dying.", 'Blaize has a plan. so now we have a problem.'] },
  { name: 'Grant', lean: 0.9, angle: 'the send-it guy. sees a ledge, needs to know what\'s under it.',
    voice: 'loud, hyped, competitive, talks in dares and challenges',
    roast: 'dares people and questions their nerve',
    examples: ["bet you won't. bet. you. won't.", "Taylor's about to say 'we could just chill' in three, two..."] },
  { name: 'Taylor', lean: -0.8, angle: 'the vibe keeper. would happily watch one sunset for six hours.',
    voice: 'laid back, unbothered, warm, slow-drawl sarcasm',
    roast: "stays unbothered so everyone else's panic looks ridiculous",
    examples: ["y'all go get eaten. I'm watching the sky do its thing.", "Grant's almost died four times today. that's just his cardio."] },
  { name: 'Trey', lean: 0.0, angle: 'the swing vote. pretends to mediate, secretly picks whatever makes the best story.',
    voice: 'observant, quick, a little smug, narrates the group\'s dysfunction',
    roast: "calls out everyone's patterns like he's been keeping score",
    examples: ["so we're doing the dumb thing. great. somebody hold my stuff.", 'Corey sighed. that\'s a yes from Corey.'] },
];

const stance = (lean) => (lean <= -0.4 ? 'You usually argue for slowing down and enjoying the calm, beautiful stuff.'
  : lean >= 0.4 ? 'You usually argue for the side quest, the danger, the off-trail option.'
  : "You're the swing vote. You side with whichever option makes the better story, and you enjoy watching both camps fight for you.");

const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

/**
 * The shared scene log and the prompts. `backend.chat(messages, opts)` resolves to { content } (an OpenAI-style chat
 * message) or rejects when no model answers; then `offline(name, kind)` (if given) supplies a stock line instead.
 */
export class Crew {
  static LOG_WINDOW = 14;      // recent scene lines each companion sees
  static ROAST_RATE = 0.7;     // how often a line is aimed at whoever just talked

  constructor(backend, { members = DEFAULT_CREW, present = null, insideJokes = [], offline = null } = {}) {
    this.backend = backend;
    this.cards = new Map(members.map((c) => [c.name, { ...c, notes: [...(c.notes || [])] }]));
    this.present = present || [...this.cards.keys()];     // who is actually here (the others are only mentioned in the bible)
    this.insideJokes = [...insideJokes];
    this.offline = offline;
    this.log = [];
    this.recent = new Map();
    this.lastSpeaker = null;
  }

  system(c) {
    const parts = [
      CREW_BIBLE,
      `\nYou are ${c.name}. Your role in the crew: ${c.angle}`,
      `How you talk: ${c.voice}.`,
      `How you roast: ${c.roast}.`,
      stance(c.lean),
      'Tone reference ONLY. Never reuse these lines or their catchphrases; say something new about what\'s actually happening: ' + c.examples.map((e) => `'${e}'`).join(' / '),
    ];
    const mine = (this.recent.get(c.name) || []).slice(-3);
    if (mine.length) parts.push("You already said these. Don't repeat their wording, openers or catchphrases: " + mine.map((m) => `'${m}'`).join(' / '));
    if (this.insideJokes.length) {
      const j = [...this.insideJokes].sort(() => Math.random() - 0.5).slice(0, 2);
      parts.push('Crew inside jokes (reference one ONLY if it fits naturally, never force it): ' + j.join('; '));
    }
    if (c.notes.length) parts.push('Things you personally remember: ' + c.notes.slice(-4).join('; '));
    parts.push('Reply with only your spoken line: 1-2 sentences, under 30 words. No narration, no quotes, no name prefix. Never speak for the other guys.');
    return parts.join('\n');
  }

  scene() { return 'Recent moments:\n' + this.log.slice(-Crew.LOG_WINDOW).join('\n'); }

  static clean(text, name) {
    let t = (text || '').split(/\s+/).filter(Boolean).join(' ').replace(/^"+|"+$/g, '');
    t = t.replace(new RegExp(`^\\s*${name}\\s*:\\s*`, 'i'), '');
    return t.trim().replace(/^"+|"+$/g, '').trim();
  }

  /** Log something that happened in the world. */
  event(what) { this.log.push(`EVENT: ${what}`); if (this.log.length > 400) this.log.splice(0, 200); }

  playerSays(player, line) { this.log.push(`${player} (player): ${line}`); }

  /** Promote something that happened into a crew inside joke (and personal memory). */
  rememberMoment(moment, who = null) {
    this.insideJokes.push(moment);
    for (const n of who || this.cards.keys()) this.cards.get(n)?.notes.push(moment);
    this.log.push(`EVENT: (moment the crew will never let go) ${moment}`);
  }

  async say(name, nudge = 'What do you say next?', kind = 'quiet') {
    const c = this.cards.get(name);
    let line = '';
    try {
      const msg = await this.backend.chat([{ role: 'system', content: this.system(c) }, { role: 'user', content: `${this.scene()}\n\n${nudge}` }]);
      line = Crew.clean(msg.content, name);
    } catch (e) {
      line = this.offline ? this.offline(name, kind) : '';
    }
    if (!line) return '';
    this.log.push(`${name}: ${line}`);
    const mine = this.recent.get(name) || [];
    mine.push(line); if (mine.length > 6) mine.shift();
    this.recent.set(name, mine);
    this.lastSpeaker = name;
    return line;
  }

  lastOtherSpeaker(name) {
    for (const entry of this.log.slice(-6).reverse()) {
      const who = entry.split(':', 1)[0];
      if (this.cards.has(who) && this.present.includes(who) && who !== name) return who;
    }
    return null;
  }

  /** Most of the time, aim the line at whoever just talked, by name. */
  roastNudge(name, base = 'React to the moment.') {
    const target = this.lastOtherSpeaker(name);
    if (target && Math.random() < Crew.ROAST_RATE) return `${base} Roast ${target} by name for what he just said or did. It's love, so keep it clever, not mean.`;
    return `${base} Say what you'd say next.`;
  }
}

/**
 * A crew where each companion has a position and only senses what reaches him. `away` are the ones out of earshot of the
 * others: their lines stay private (muttered, not logged).
 */
export class SensingCrew extends Crew {
  constructor(backend, positions, senses, opts = {}) {
    super(backend, opts);
    this.positions = positions;
    this.senses = senses;
    this.now = 0;
    this.away = new Set();
  }

  async notice(name, changed = null, kind = 'quiet') {
    const felt = this.senses.perceive(this.positions[name], this.now);
    const where = this.away.has(name) ? 'off on your own, out of earshot' : 'with the crew';
    let what = felt.length ? 'Right now you can sense: ' + felt.join('; ') + '.' : 'Right now you sense nothing unusual in the air.';
    if (changed) what += ` What just changed for you: ${changed}.`;
    let nudge = `You are ${where}. ${what} Only react to what you can actually sense or hear; you don't know about anything else. Say one line, in character.`;
    if (!this.away.has(name)) nudge = this.roastNudge(name, nudge);
    else nudge += " Nobody can hear you, so mutter to yourself; don't address anyone.";
    const line = await this.say(name, nudge, kind);
    if (this.away.has(name) && line) this.log.pop();           // nobody back at camp heard that
    return line;
  }
}

export { pickOne };
