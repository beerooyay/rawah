import { SenseEvent, Senses, SpeechWheel, SensingCrew } from './crew.js';

// The crew as the game uses it: the two friends walking with you talk, but only about what actually reaches them (the camp's
// woodsmoke, bacon on the grate, coffee, a storm front, what Grant left behind a tree), and only at the moments the certified
// scheduler in crew.js says something changed. Lines come from a model when one answers (local Ollama, a model server you
// name in Settings, or the dev server's proxy), and from a small stock of in-character lines when none does.

const EARSHOT = 38;          // m: a friend farther from you than this is not heard, so he is not asked
const MOVED = 6;             // m: a friend who has walked this far gets his wake times redone
const MIN_BETWEEN = { smoke: 0, logsmoke: 25, bacon: 120, coffee: 120, stink: 45, storm: 600 };

// every source of one kind shares one threshold (the referee's rule): same-kind sources add up
const SMELLS = {
  smoke: { kind: 'smoke', A: 900, D: 2.0, eps: 0.05, notice: 'woodsmoke from the campfire' },
  logsmoke: { kind: 'smoke', A: 320, D: 2.0, eps: 0.05, notice: 'woodsmoke from the campfire' },
  bacon: { kind: 'bacon', A: 260, D: 2.5, eps: 0.05, notice: 'bacon sizzling over the fire' },
  coffee: { kind: 'coffee', A: 180, D: 2.0, eps: 0.05, notice: 'coffee percolating on the grate' },
  stink: { kind: 'stink', A: 70, D: 1.5, eps: 0.05, notice: 'something foul from behind a tree' },
  storm: { kind: 'storm', A: 40000, D: 12.0, eps: 0.05, notice: 'rain on hot stone, a storm front rolling in' },
};

const SAY = {
  hello: 'the crew sets out on the trail', lake: (v) => `the crew reaches ${v.place || 'a lake'}`, summit: (v) => `the crew tops out on ${v.place || 'a summit'}`,
  storm: 'thunder starts rolling in', rain: 'rain starts', snow: 'it starts to snow', fog: 'fog rolls in', cold: 'the hiker is shivering',
  dusk: 'the light is going', night: 'night falls', fire: 'the hiker lights a campfire', camp: 'the hiker pitches the tent',
  smore: 'marshmallows go over the fire', fish: 'the hiker catches a fish', travel: 'the crew arrives somewhere new', race: 'a race breaks out',
};

// ------------------------------------------------------------------ a model, or not

/** OpenAI-style chat completions. Tries the server you named, then local Ollama, then the dev server's proxy. */
export class ChatBackend {
  constructor(get) { this.get = get; this.localOk = null; this.localChecked = 0; this.lastApi = 0; this.source = null; }

  async #post(url, body, key, timeout = 25000) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    const r = await fetch(`${url.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).choices[0].message;
  }

  async #throttle() {
    const wait = 1600 - (performance.now() - this.lastApi);
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    this.lastApi = performance.now();
  }

  async chat(messages, { maxTokens = 90, temperature = 0.8 } = {}) {
    const cfg = this.get();
    const body = { messages, max_tokens: maxTokens, temperature, top_p: 0.95, stream: false };
    const errors = [];
    if (cfg.url) {                                                     // a server named in Settings
      try {
        await this.#throttle();
        const nv = /nvidia\.com/.test(cfg.url);
        const m = await this.#post(cfg.url, { ...body, model: cfg.model || 'nvidia/nemotron-3.5-bolt-e4b', ...(nv ? { chat_template_kwargs: { enable_thinking: false } } : {}) }, cfg.key);
        this.source = 'server'; return m;
      } catch (e) { errors.push(`server: ${e.message}`); }
    }
    if (cfg.local !== false) {                                         // local Ollama on this machine
      try {
        if (this.localOk === null || performance.now() - this.localChecked > 60000) {
          this.localChecked = performance.now();
          this.localOk = await fetch('http://localhost:11434/v1/models', { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
        }
        if (this.localOk) { const m = await this.#post('http://localhost:11434/v1', { ...body, model: 'nemotron-3.5-bolt:e4b' }, null, 30000); this.source = 'local'; return m; }
      } catch (e) { this.localOk = false; errors.push(`local: ${e.message}`); }
    }
    if (cfg.proxy !== false) {                                         // devserver.py forwards to NVIDIA with a key in its environment
      try {
        await this.#throttle();
        const m = await this.#post(`${location.origin}/crew`, { ...body, model: 'nvidia/nemotron-3.5-bolt-e4b', chat_template_kwargs: { enable_thinking: false } }, null);
        this.source = 'proxy'; return m;
      } catch (e) { errors.push(`proxy: ${e.message}`); }
    }
    throw new Error('no backend answered: ' + errors.join('; '));
  }
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

// stock lines when no model answers: per voice, per kind. Several come straight from Blaize's live runs (tools/crew/live_transcripts.txt).
const OFFLINE = {
  Blaize: {
    smoke: ["Hear me out: that smoke means resources nearby. Statistically.", "Smoke means a camp, a camp means a plan, and I have a plan."],
    bacon: ["That's bacon. Trust me, statistically it's the best idea this crew has had.", "Hear me out: we skip the hike and just stay for the bacon."],
    coffee: ["Coffee. The correct next step is coffee, and I can prove it.", "Hear me out: one more cup and we cover twice the ground."],
    stink: ["Statistically, that was Grant.", "I'm filing that under 'avoidable'. Moving upwind."],
    storm: ["The pressure drop says go now. Trust me.", "Hear me out: storms are just free sound effects."],
    reply: ["Bold claim. I have a chart.", "That's what I'd say if I hadn't done the math."],
    quiet: ["Nobody's talking, which means I get to pitch something.", "Quiet's fine. I'm just drafting the plan."],
  },
  Corey: {
    smoke: ["Smoke is just smoke.", "The fire is adequate."],
    bacon: ["Bacon. Fine. That's a good reason to stay.", "I'll be over here, enjoying not rushing breakfast."],
    coffee: ["Coffee is fine. The view is fine. Everything is fine.", "The percolator is the only one here with a plan."],
    stink: ["Cool. I'll be over here, enjoying not dying.", "Something died. I'm guessing it was dignity."],
    storm: ["The sunset is gone. The storm is adequate.", "We should have left twenty minutes ago."],
    reply: ["Noted.", "Blaize has a plan. so now we have a problem."],
    quiet: ["The quiet is the best thing out here.", "Nothing's happening. I like it."],
  },
  Grant: {
    smoke: ["Bet you won't walk up to that fire and check it first.", "Smoke? Somebody's cooking. I'm in."],
    bacon: ["Bet you can't eat that before it's cooked. Bet. You. Can't.", "Bacon! Dare you to take the first piece."],
    coffee: ["Coffee? I could climb that ridge right now.", "Bet you won't drink it black."],
    stink: ["That wasn't me. That was totally not me.", "Okay, that was a little me."],
    storm: ["Storm's coming. Bet you won't stay on the ridge.", "Thunder! Who's going up?"],
    reply: ["Bet you won't say that again.", "You're scared. I can hear it."],
    quiet: ["It's too quiet. Bet I find something.", "Somebody dare me to do something."],
  },
  Taylor: {
    smoke: ["Smellin' a little smoke over here, ain't that nice.", "Letting the fire breathe is the whole point."],
    bacon: ["Bacon and a sunset. y'all can leave if you want.", "That smell is why I'm not going anywhere."],
    coffee: ["Coffee and nowhere to be. That's my whole religion.", "Slow cup, slow morning."],
    stink: ["Y'all go find the source. I'm watching the sky.", "Somebody check Grant."],
    storm: ["Rain on hot stone. Best smell there is.", "y'all go get eaten. I'm staying dry."],
    reply: ["Mm, sure.", "That's a lot of effort for a hill."],
    quiet: ["The light is doing its thing again.", "Nobody say anything. Just look."],
  },
  Trey: {
    smoke: ["Still romanticizing campfire smoke? Predictable.", "The smoke arrived. The drama is right behind it."],
    bacon: ["Bacon. Now the story has a second act.", "So we're doing breakfast first. Great. Somebody hold my coffee."],
    coffee: ["Coffee: the plot device of the morning.", "Corey sighed. That's a yes to coffee."],
    stink: ["And the plot thickens. Literally.", "I'm narrating this. Don't."],
    storm: ["There it is. The calm was never going to last.", "Storm front. Just in time for the second act."],
    reply: ["I've been keeping score and that doesn't count.", "Noted for the record."],
    quiet: ["Quiet stretch. Somebody's about to do something dumb.", "I give it two minutes before somebody pitches a side quest."],
  },
};

const offlineLine = (name, kind) => { const bank = OFFLINE[name] || OFFLINE.Corey; return pick(bank[kind] || bank.quiet || ['...']); };

// ------------------------------------------------------------------ in the game

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export class CrewTalk {
  constructor(party, settings) {
    this.party = party;
    this.settings = settings;
    this.on = false;
    this.t = 0;                          // seconds of unpaused play: the crew's own clock
    this.senses = new Senses();
    this.positions = {};
    this.moved = {};
    this.backend = new ChatBackend(() => ({ url: settings.crewUrl, model: settings.crewModel, key: settings.crewKey }));
    this.crew = new SensingCrew(this.backend, this.positions, this.senses, { offline: offlineLine });
    this.wheel = new SpeechWheel(this.senses, this.positions, { cooldown: 25, quietGap: 170, replyDelay: 4, camp: () => this.#hearable() });
    this.busy = false;
    this.last = {};                      // kind -> t it was last registered
    this.storming = false;
    this.player = null;
    this.pruneAt = 90;
    this.calls = 0; this.lines = 0; this.sinceSync = 0;
    this.shown = [];                     // recent { t, name, text, reason } for the dev hooks
  }

  #actor(name) { return this.party.actors.find((a) => cap(a.name) === name); }

  #hearable() {
    const p = this.player;
    return Object.keys(this.positions).filter((n) => { const a = this.#actor(n); return a && (!p || Math.hypot(a.x - p.x, a.z - p.z) <= EARSHOT); });
  }

  /** Keep the listeners in step with who is walking with you, and where they are. */
  #sync() {
    const names = this.party.actors.map((a) => cap(a.name));
    for (const n of Object.keys(this.positions)) if (!names.includes(n)) { delete this.positions[n]; delete this.moved[n]; }
    this.crew.present = names;
    for (const a of this.party.actors) {
      const n = cap(a.name);
      const fresh = !this.positions[n];
      this.positions[n] = [a.x, a.z];
      if (fresh || !this.moved[n]) this.moved[n] = [a.x, a.z];
      if (fresh || Math.hypot(a.x - this.moved[n][0], a.z - this.moved[n][1]) > MOVED) {
        this.moved[n] = [a.x, a.z];
        this.wheel.now = this.t;
        this.wheel.refreshListener(n);       // he walked: his wake times for every live smell are filed again
      }
    }
  }

  /** Called every frame (dt 0 while paused). */
  update(dt, { player = null, storm = 0, wind = [1, 0] } = {}) {
    if (!this.on) return;
    this.player = player;
    this.t += dt;
    this.sinceSync += dt;
    if (this.sinceSync > 0.5) { this.sinceSync = 0; this.#sync(); }
    // a storm front building: it arrives from upwind, about 150 m off
    if (storm > 0.45 && !this.storming) { this.storming = true; if (this.player) this.smell('storm', this.player.x - wind[0] * 150, this.player.z - wind[1] * 150); }
    if (storm < 0.1) this.storming = false;
    if (this.t > this.pruneAt) { this.pruneAt = this.t + 90; this.senses.prune(this.t); }
    if (this.busy || !this.wheel.due(this.t)) return;
    this.busy = true;
    this.wheel.run(this.t, (w) => this.#wake(w)).catch((e) => console.warn('crew:', e.message)).finally(() => { this.busy = false; });
  }

  /** A smell appears in the world at (x, z). Same-kind sources add; one kind is not registered again too soon. */
  smell(name, x, z) {
    const s = SMELLS[name];
    if (!this.on || !s || !Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.t - (this.last[name] ?? -Infinity) < (MIN_BETWEEN[name] ?? 30)) return;
    this.last[name] = this.t;
    this.#sync();
    this.wheel.now = this.t;
    this.wheel.watch(new SenseEvent(s.kind, [x, z], this.t, s.A, s.D, s.eps, s.notice));
  }

  /** The game tells the crew what happened, so lines can refer to it. */
  event(kind, vars = {}) {
    const text = SAY[kind];
    if (!text) return;
    this.crew.event(typeof text === 'function' ? text(vars) : text);
  }

  async #wake({ t, name, reason, kind }) {
    const a = this.#actor(name), p = this.player;
    if (!a || (p && Math.hypot(a.x - p.x, a.z - p.z) > EARSHOT)) return false;       // out of earshot: not asked, not heard
    this.crew.now = t;
    this.calls++;
    let line;
    if (reason === 'reply') line = await this.crew.say(name, this.crew.roastNudge(name), 'reply');
    else if (reason === 'quiet stretch') line = await this.crew.say(name, this.crew.roastNudge(name, "It's been quiet on the trail for a while."), 'quiet');
    else line = await this.crew.notice(name, reason, kind);
    if (!line) return false;
    this.lines++;
    this.shown.push({ t, name, text: line, reason, source: this.backend.source || 'offline' });
    if (this.shown.length > 30) this.shown.shift();
    this.party.tell(line, a);
    return true;
  }

  stats() { return { calls: this.calls, lines: this.lines, skipped: this.wheel.skipped, recomputes: this.wheel.recomputes, pruned: this.wheel.pruned, source: this.backend.source }; }
}
