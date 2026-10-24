// Everything you hear is synthesized: wind that builds above treeline,
// footsteps per surface, a crackling fire, mountain chickadees by day, and
// bull elk bugling across the valley at dusk (it is late September, after all).

export class Audio {
  constructor() {
    this.ctx = null;
    this.volume = 0.8;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = this.ctx = new Ctx();
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = (b + 0.02 * w) / 1.02; d[i] = b * 3.5; }
    this.white = ctx.createBuffer(1, len, ctx.sampleRate);
    const wd = this.white.getChannelData(0);
    for (let i = 0; i < len; i++) wd[i] = Math.random() * 2 - 1;

    // wind bed
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 400; this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;
    src.connect(this.windFilter).connect(this.windGain).connect(this.master);
    src.start();

    // fire bed
    const fsrc = ctx.createBufferSource();
    fsrc.buffer = this.white; fsrc.loop = true;
    const ff = ctx.createBiquadFilter(); ff.type = 'lowpass'; ff.frequency.value = 700;
    this.fireGain = ctx.createGain(); this.fireGain.gain.value = 0;
    fsrc.connect(ff).connect(this.fireGain).connect(this.master);
    fsrc.start();
    // creek bed: bright noise with a wandering bandpass, like water over cobbles
    const csrc = ctx.createBufferSource();
    csrc.buffer = this.white; csrc.loop = true;
    this.creekFilter = ctx.createBiquadFilter();
    this.creekFilter.type = 'bandpass'; this.creekFilter.frequency.value = 1800; this.creekFilter.Q.value = 0.9;
    this.creekGain = ctx.createGain(); this.creekGain.gain.value = 0;
    csrc.connect(this.creekFilter).connect(this.creekGain).connect(this.master);
    csrc.start();
    // rain bed: bright hiss plus a softer patter
    const rsrc = ctx.createBufferSource();
    rsrc.buffer = this.white; rsrc.loop = true;
    const rh = ctx.createBiquadFilter(); rh.type = 'highpass'; rh.frequency.value = 900;
    const rl = ctx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 7000;
    this.rainGain = ctx.createGain(); this.rainGain.gain.value = 0;
    rsrc.connect(rh).connect(rl).connect(this.rainGain).connect(this.master);
    rsrc.start();
    this.nextBird = 4; this.nextElk = 20; this.nextCrackle = 0; this.nextDrop = 0;
  }

  /** The four-wheeler's engine: a throaty saw plus a sub, opened up by speed and throttle. `on` false lets it die away. */
  engine(on, speed, throttle) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.eng) {
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500; lp.Q.value = 2;
      const gain = ctx.createGain(); gain.gain.value = 0;
      const a = ctx.createOscillator(); a.type = 'sawtooth';
      const b = ctx.createOscillator(); b.type = 'square';
      const bg = ctx.createGain(); bg.gain.value = 0.5;
      a.connect(lp); b.connect(bg).connect(lp);
      lp.connect(gain).connect(this.master);
      a.start(); b.start();
      this.eng = { a, b, lp, gain };
    }
    const e = this.eng, t = ctx.currentTime;
    // idle ~28 Hz firing, climbing with speed, with a surge on the throttle
    const hz = 26 + speed * 62 + throttle * 14;
    e.a.frequency.setTargetAtTime(hz, t, 0.08);
    e.b.frequency.setTargetAtTime(hz * 0.5, t, 0.08);
    e.lp.frequency.setTargetAtTime(380 + speed * 900 + throttle * 500, t, 0.1);
    e.gain.gain.setTargetAtTime(on ? 0.05 + speed * 0.05 + throttle * 0.03 : 0, t, on ? 0.15 : 0.4);
  }

  /** A reel click. */
  reel() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime, src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3200; f.Q.value = 6;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.1, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 2, 0.06);
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  #burst(dur, freq, q, gain, type = 'bandpass', when = 0, buf = this.white) {
    const ctx = this.ctx, t = ctx.currentTime + when;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(this.master);
    s.start(t, Math.random() * 2, dur + 0.05);
  }

  step(surface, speed) {
    if (!this.ctx) return;
    const v = Math.min(1, 0.45 + speed / 10);
    const sets = {
      dirt: [0.11, 900, 0.9, 0.22], gravel: [0.14, 2600, 0.7, 0.24], rock: [0.07, 1700, 2.5, 0.2],
      grass: [0.16, 3200, 0.5, 0.1], duff: [0.15, 600, 0.6, 0.18], snow: [0.2, 1400, 0.6, 0.16],
      water: [0.3, 1100, 0.4, 0.3], swim: [0.5, 700, 0.4, 0.22],
    };
    const [dur, f, q, g] = sets[surface] || sets.dirt;
    this.#burst(dur, f * (0.85 + Math.random() * 0.3), q, g * v);
    if (surface === 'gravel' || surface === 'rock') this.#burst(0.05, f * 1.8, 3, g * 0.5 * v, 'bandpass', 0.03);
  }

  /** A saw working through a log. */
  saw() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) this.#burst(0.14, 1800 + Math.random() * 900, 0.9, 0.16, 'bandpass', i * 0.16);
  }

  /** A tree's trunk giving way. */
  creak() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(130, t + 0.5); o.frequency.exponentialRampToValueAtTime(50, t + 1.1);
    f.type = 'bandpass'; f.frequency.value = 420; f.Q.value = 5;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + 0.15); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.15);
    o.connect(f).connect(g).connect(this.master);
    o.start(t); o.stop(t + 1.2);
    this.#burst(0.9, 900, 0.6, 0.12, 'bandpass', 0.1);
  }

  /** The crown hitting the ground. */
  crash() {
    if (!this.ctx) return;
    this.#burst(0.9, 120, 0.7, 0.95, 'lowpass', 0, this.noise);
    this.#burst(0.5, 700, 0.5, 0.35, 'bandpass', 0.03);
    this.#burst(0.35, 90, 0.8, 0.8, 'lowpass', 0.06, this.noise);
  }

  /** A log landing on a stack. */
  clunk() {
    if (!this.ctx) return;
    this.#burst(0.1, 260, 1.2, 0.4, 'bandpass');
    this.#burst(0.12, 90, 0.8, 0.3, 'lowpass', 0.01, this.noise);
  }

  /** Bacon and eggs in a hot pan. */
  sizzle() {
    if (!this.ctx) return;
    this.#burst(0.22, 5200, 0.7, 0.05, 'highpass', 0, this.noise);
    if (Math.random() < 0.4) this.#burst(0.025, 1400 + Math.random() * 1200, 3, 0.1, 'bandpass', Math.random() * 0.15);
  }

  /** Something soft hitting the ground. */
  plop() {
    if (!this.ctx) return;
    this.#burst(0.12, 160, 1.5, 0.35, 'lowpass', 0, this.noise);
    this.#burst(0.05, 420, 2, 0.15, 'bandpass', 0.02);
  }

  /** Flies circling: `v` 0..1 by how close you are. */
  buzz(v) {
    if (!this.ctx) return;
    const f = 190 + Math.random() * 90;
    this.#burst(0.1, f, 9, 0.07 * v, 'bandpass');
    this.#burst(0.08, f * 2.1, 8, 0.04 * v, 'bandpass', 0.01);
  }

  /** A bubble popping up the percolator's stem. */
  perk() {
    if (!this.ctx) return;
    const f = 380 + Math.random() * 380;
    this.#burst(0.05, f, 4, 0.22, 'bandpass');
    this.#burst(0.04, f * 1.5, 5, 0.12, 'bandpass', 0.045);
  }

  /** Coffee poured into a cup. */
  pour() {
    if (!this.ctx) return;
    for (let i = 0; i < 7; i++) this.#burst(0.1, 900 + i * 90, 2.5, 0.07, 'bandpass', i * 0.09);
  }

  /** The pot lid going on. */
  lid() {
    if (!this.ctx) return;
    this.#burst(0.05, 2600, 3, 0.2, 'bandpass');
    this.#burst(0.08, 1700, 4, 0.15, 'bandpass', 0.05);
  }

  /** The percolator is done: two bright notes. */
  ready() {
    if (!this.ctx) return;
    this.#whistle(1175, 1175, 0, 0.9, 0.22);
    this.#whistle(1568, 1568, 0.22, 1.1, 0.2);
  }

  /** A sip. */
  sip() {
    if (!this.ctx) return;
    this.#burst(0.18, 700, 1.5, 0.12, 'bandpass', 0.05);
    this.#burst(0.12, 200, 1, 0.2, 'lowpass', 0.3, this.noise);
  }

  thud(big) {
    if (!this.ctx) return;
    this.#burst(big ? 0.45 : 0.2, 160, 0.8, big ? 0.7 : 0.35, 'lowpass', 0, this.noise);
  }

  /** A blade: `hit` false is the swing through air, true bites into wood (`small` for brush and saplings). */
  chop(hit, small = false) {
    if (!this.ctx) return;
    if (!hit) { this.#burst(0.2, 1500, 0.7, 0.09); return; }
    this.#burst(0.05, 2400, 2.5, 0.34, 'bandpass');
    this.#burst(small ? 0.12 : 0.3, small ? 720 : 250, 0.9, small ? 0.22 : 0.5, 'lowpass', 0.012, this.noise);
  }

  /** Earth shifting under attention: a low grind and a faint rising shimmer. */
  rumble(level = 0.6) {
    if (!this.ctx) return;
    this.#burst(0.3, 90 + level * 60, 0.7, 0.22 * level, 'lowpass', 0, this.noise);
    this.#whistle(300 + level * 200, 520 + level * 400, 0, 0.25, 0.02 * level);
  }

  splash() {
    if (!this.ctx) return;
    this.#burst(0.7, 900, 0.5, 0.5);
    this.#burst(0.4, 2400, 0.8, 0.2, 'bandpass', 0.08);
  }

  zip() {
    if (!this.ctx) return;
    for (let i = 0; i < 14; i++) this.#burst(0.03, 3000 + i * 160, 4, 0.12, 'bandpass', i * 0.035);
  }

  strike() {
    if (!this.ctx) return;
    this.#burst(0.12, 3800, 1.5, 0.3);
    this.#burst(0.6, 500, 0.6, 0.25, 'lowpass', 0.1, this.noise);
  }

  #whistle(f0, f1, start, dur, gain, pan = 0) {
    const ctx = this.ctx, t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; o.connect(g).connect(p).connect(this.master); } else o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  /** Mountain chickadee: a clear "fee-bee-bee", the high note first. */
  chickadee(dist) {
    const g = 0.05 / (1 + dist), pan = Math.random() * 1.6 - 0.8;
    this.#whistle(3950, 3900, 0, 0.32, g, pan);
    this.#whistle(3200, 3150, 0.42, 0.22, g * 0.9, pan);
    if (Math.random() < 0.6) this.#whistle(3200, 3150, 0.7, 0.2, g * 0.8, pan);
  }

  /** Bull elk bugle: a rising glide into a high whistle, then grunts. */
  bugle(dist) {
    const ctx = this.ctx, t = ctx.currentTime;
    const gain = 0.16 / (1 + dist / 400);
    const out = ctx.createBiquadFilter();
    out.type = 'lowpass'; out.frequency.value = 5000 / (1 + dist / 900);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = Math.random() * 1.4 - 0.7; out.connect(pan).connect(this.master); } else out.connect(this.master);
    for (const [mult, amp] of [[1, 1], [2, 0.35], [3, 0.12]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = o.frequency;
      f.setValueAtTime(320 * mult, t);
      f.exponentialRampToValueAtTime(760 * mult, t + 0.9);
      f.exponentialRampToValueAtTime(1350 * mult, t + 1.4);
      f.setValueAtTime(1350 * mult, t + 2.5);
      f.exponentialRampToValueAtTime(420 * mult, t + 3.1);
      const vib = ctx.createOscillator(); vib.frequency.value = 6;
      const vg = ctx.createGain(); vg.gain.value = 18 * mult;
      vib.connect(vg).connect(f);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain * amp, t + 0.5);
      g.gain.setValueAtTime(gain * amp, t + 2.6);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      o.connect(g).connect(out);
      o.start(t); o.stop(t + 3.3); vib.start(t); vib.stop(t + 3.3);
    }
    for (let i = 0; i < 3; i++) this.#burst(0.18, 180, 1.2, gain * 1.4, 'bandpass', 3.3 + i * 0.32, this.noise);
  }

  /** Rushing air for a quick-travel flight: swells, then settles as you land. */
  whoosh(dur) {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 0.7;
    f.frequency.setValueAtTime(220, now);
    f.frequency.linearRampToValueAtTime(900, now + dur * 0.45);
    f.frequency.linearRampToValueAtTime(260, now + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.5, now + dur * 0.4);
    g.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(now);
    src.stop(now + dur + 0.1);
  }

  /** Thunder from a strike `dist` metres away: crack for close ones, then a long rolling rumble. */
  thunder(dist) {
    if (!this.ctx) return;
    const ctx = this.ctx, when = ctx.currentTime + dist / 343;
    const near = Math.max(0, 1 - dist / 2500);
    if (near > 0.3) this.#burst(0.25, 1800, 0.6, 0.5 * near, 'bandpass', dist / 343, this.white);
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 160 + near * 260; f.Q.value = 0.9;
    const g = ctx.createGain();
    const peak = 0.35 + near * 0.9, len = 3.5 + Math.random() * 3 + (1 - near) * 2;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.08 + (1 - near) * 0.5);
    // a few rolls as the sound comes back off the ridges
    for (let i = 1; i < 5; i++) g.gain.linearRampToValueAtTime(peak * (0.35 + Math.random() * 0.5) * (1 - i / 6), when + (len * i) / 5);
    g.gain.linearRampToValueAtTime(0, when + len);
    src.connect(f).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + len + 0.1);
  }

  /** Per-frame ambience. */
  update(dt, s) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const wind = Math.min(1, 0.12 + s.exposure * 0.55 + s.gust * 0.35 + (s.storm || 0) * 0.2);
    this.windGain.gain.setTargetAtTime(wind * 0.32, now, 0.6);
    this.windFilter.frequency.setTargetAtTime(260 + wind * 520 + s.gust * 200, now, 0.8);
    this.creekGain.gain.setTargetAtTime((s.creek || 0) * 0.14, now, 0.4);
    const rain = s.rain || 0;
    this.rainGain.gain.setTargetAtTime(rain * 0.16 * (1 - s.exposure * 0.3), now, 0.8);
    if (rain > 0.1) {
      this.nextDrop -= dt;
      if (this.nextDrop < 0) {   // fat drops on the hood and the leaves
        this.nextDrop = Math.random() * 0.12 / rain;
        this.#burst(0.02, 2500 + Math.random() * 3500, 3, 0.05 * rain * (0.4 + s.forest));
      }
    }
    this.creekFilter.frequency.setTargetAtTime(1500 + Math.sin(now * 2.3) * 400 + Math.sin(now * 5.1) * 250, now, 0.1);
    this.fireGain.gain.setTargetAtTime(s.fireDist < 25 ? 0.05 * (1 - s.fireDist / 25) : 0, now, 0.3);
    if (s.fireDist < 20) {
      this.nextCrackle -= dt;
      if (this.nextCrackle < 0) {
        this.nextCrackle = Math.random() * 0.5;
        this.#burst(0.025, 2000 + Math.random() * 3000, 2, 0.25 * (1 - s.fireDist / 20));
      }
    }
    this.nextBird -= dt;
    if (this.nextBird < 0) {
      this.nextBird = 6 + Math.random() * 18;
      if (s.forest > 0.3 && s.daylight > 0.5 && !(s.rain > 0.2)) this.chickadee(Math.random() * 3);
    }
    this.nextElk -= dt;
    if (this.nextElk < 0) {
      this.nextElk = 25 + Math.random() * 50;
      if (s.dusk && s.elevation < 3500) this.bugle(200 + Math.random() * 900);
    }
  }
}
