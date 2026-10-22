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

  thud(big) {
    if (!this.ctx) return;
    this.#burst(big ? 0.45 : 0.2, 160, 0.8, big ? 0.7 : 0.35, 'lowpass', 0, this.noise);
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
