import * as THREE from 'three';
import { clamp, smoothstep, lerp } from './noise.js';

// Weather and climate. Late September on the Medicine Bow crest: cold clear
// mornings, cumulus that build over the peaks by noon, afternoon thunderstorms
// on some days, now and then a front that drops the snow line to the lakes,
// and valley fog after a wet night. Each day gets a schedule from a seeded
// roll, so the morning forecast in your journal tells you what's coming.
// Every regime is a handful of numbers; the live state eases toward the
// current one, and everything else reads that state: clouds, sun and sky,
// fog, rain and snow, wind, air temperature, wet ground and snow cover.

export const REGIMES = {
  clear: { label: 'Clear', cloud: 0.03, thick: 0.15, precip: 0, fog: 0, wind: 0, temp: 0, storm: 0 },
  fair: { label: 'Fair-weather cumulus', cloud: 0.34, thick: 0.3, precip: 0, fog: 0, wind: 0.05, temp: 0, storm: 0 },
  building: { label: 'Clouds building', cloud: 0.56, thick: 0.62, precip: 0, fog: 0, wind: 0.2, temp: -1.5, storm: 0 },
  storm: { label: 'Thunderstorm', cloud: 0.94, thick: 1, precip: 0.9, fog: 0.25, wind: 0.75, temp: -5, storm: 1 },
  showers: { label: 'Showers', cloud: 0.86, thick: 0.82, precip: 0.45, fog: 0.3, wind: 0.3, temp: -4, storm: 0 },
  overcast: { label: 'Overcast', cloud: 0.9, thick: 0.7, precip: 0, fog: 0.1, wind: 0.2, temp: -3, storm: 0 },
  front: { label: 'Snow squalls', cloud: 1, thick: 0.95, precip: 0.75, fog: 0.55, wind: 0.6, temp: -9, storm: 0 },
  fog: { label: 'Fog', cloud: 0.75, thick: 0.55, precip: 0, fog: 1, wind: -0.25, temp: -2, storm: 0 },
};
const KEYS = ['cloud', 'thick', 'precip', 'fog', 'wind', 'temp', 'storm'];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One day's weather as [hour, regime] steps. */
export function daySchedule(seed, day) {
  const r = rng(seed * 7919 + day * 104729);
  const pick = (opts) => { let x = r(), k; for (k of Object.keys(opts)) { x -= opts[k]; if (x < 0) return k; } return k; };
  const kind = pick({ storms: 0.42, fair: 0.24, front: 0.12, clear: 0.12, grey: 0.1 });
  const s = [[0, pick({ clear: 0.75, overcast: 0.25 })]];
  const t = (a, b) => a + r() * (b - a);
  if (kind === 'front') {
    s.push([t(2, 6), 'overcast'], [t(7, 9), 'front'], [t(11, 13), 'showers'], [t(14, 15.5), 'front'], [t(17, 19), 'overcast'], [t(21, 23), 'clear']);
    return s;
  }
  s.push([t(4.5, 6), r() < 0.3 ? 'fog' : 'clear']);
  if (kind === 'grey') {
    s.push([t(9, 10.5), 'overcast'], [t(13, 15), 'showers'], [t(16.5, 18), 'overcast'], [t(20, 22), 'fair']);
  } else if (kind === 'storms') {
    const build = t(10.5, 12.5), hit = build + t(1.2, 2.6);
    s.push([t(8.5, 9.5), 'clear'], [build - 1.5, 'fair'], [build, 'building'], [hit, 'storm'], [hit + t(0.8, 1.6), 'showers'], [hit + t(2.4, 3.6), 'fair'], [t(19.5, 21), 'clear']);
  } else if (kind === 'fair') {
    s.push([t(8.5, 9.5), 'clear'], [t(10.5, 12), 'fair'], [t(13.5, 15), 'building'], [t(16.5, 18), 'fair'], [t(19, 20.5), 'clear']);
  } else {
    s.push([t(8.5, 9.5), 'clear']);
  }
  return s.sort((a, b) => a[0] - b[0]);
}

function fmtHour(h) {
  const hh = Math.floor(h);
  return `${((hh + 11) % 12) + 1} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** A one-line forecast for the journal, read off the schedule. */
export function forecast(sched) {
  const at = (k) => sched.find(([, r]) => r === k);
  if (at('front')) return `Cold front: snow squalls from about ${fmtHour(at('front')[0])}, snow down to the lakes. Bring the puffy.`;
  if (at('storm')) return `Clear early, clouds building by ${fmtHour(at('building')?.[0] ?? at('storm')[0] - 1)}, thunderstorms around ${fmtHour(at('storm')[0])}. Be off the ridges by noon.`;
  if (at('showers')) return `Grey and cool, showers from about ${fmtHour(at('showers')[0])}.`;
  if (at('building')) return 'Fair. Afternoon cumulus over the crest, storms unlikely.';
  return 'Clear and dry. Cold tonight.';
}

export class Weather {
  constructor(seed = (Math.random() * 1e9) | 0) {
    this.seed = seed;
    this.override = null;         // a regime name to hold, or null for the live schedule
    this.day = -1;
    this.sched = null;
    this.regime = 'clear';
    for (const k of KEYS) this[k] = REGIMES.clear[k];
    this.wet = 0;                  // ground wetness 0..1
    this.snowCover = 0;            // fresh snow depth 0..1 above the snow line
    this.snowK = 0;                // how much of what's falling is snow, at the hiker
    this.snowLine = 5000;          // lowest elevation the fresh snow reaches
    this.flash = 0;                // lightning flash 0..1
    this.offset = new THREE.Vector2(); // cloud drift in metres
    this.nextBolt = 6;
    this.events = [];
  }

  /** Jump straight to the target (after sleeping, loading or changing the setting). */
  settle(day, hour) {
    this.day = -1;
    this.#target(day, hour);
    for (const k of KEYS) this[k] = REGIMES[this.regime][k];
  }

  #target(day, hour) {
    if (day !== this.day) { this.day = day; this.sched = daySchedule(this.seed, day); }
    if (this.override && REGIMES[this.override]) { this.regime = this.override; return REGIMES[this.override]; }
    let cur = this.sched[0][1];
    for (const [h, k] of this.sched) if (hour >= h) cur = k;
    this.regime = cur;
    return REGIMES[cur];
  }

  get label() {
    if (this.precip > 0.15) return this.storm > 0.5 ? 'Thunderstorm' : this.snowK > 0.6 ? 'Snow' : this.snowK > 0.25 ? 'Sleet' : 'Rain';
    if (this.fog > 0.6) return 'Fog';
    if (this.cloud > 0.82) return 'Overcast';
    if (this.cloud > 0.5) return this.thick > 0.55 ? 'Clouds building' : 'Mostly cloudy';
    if (this.cloud > 0.18) return 'Partly cloudy';
    return 'Clear';
  }

  get forecast() { return forecast(this.sched || daySchedule(this.seed, this.day)); }

  /**
   * Advance. `dt` real seconds, `gameMin` game minutes elapsed, `tempC` air
   * temperature at the hiker before weather, `sunUp` 0..1, `freezeLine` the
   * elevation where the air is at freezing right now.
   */
  update(dt, gameMin, day, hour, tempC, sunUp, freezeLine) {
    this.events.length = 0;
    const T = this.#target(day, hour);
    // fronts and storms roll in over ~20 game minutes; clearing is slower
    const k = 1 - Math.exp(-gameMin / 22);
    for (const key of KEYS) this[key] = lerp(this[key], T[key], key === 'cloud' && T.cloud < this.cloud ? k * 0.6 : k);
    this.snowK = smoothstep(2.5, -0.5, tempC + this.temp);
    const rain = this.precip * (1 - this.snowK);
    // ground: soaks in rain, dries under sun and wind; snow piles up and melts
    this.wet = clamp(this.wet + gameMin * (rain * 0.05 - (0.004 + sunUp * 0.01) * (1 - this.precip)), 0, 1);
    // snow piles up wherever it falls above the freezing level, and melts under sun and warm air
    const snowing = freezeLine < 3950 ? this.precip : 0;
    const melt = (0.0015 + sunUp * 0.004) * (freezeLine > this.snowLine ? 2 : 1) * (1 - snowing);
    this.snowCover = clamp(this.snowCover + gameMin * (snowing * 0.025 - melt), 0, 1);
    // the snow line drops with the freezing level while it snows, then creeps back up as it melts
    const falling = this.precip > 0.05 && freezeLine < this.snowLine;
    if (falling) this.snowLine = lerp(this.snowLine, freezeLine, Math.min(1, gameMin / 15));
    else if (freezeLine > this.snowLine) this.snowLine += gameMin * 0.8;
    if (this.snowCover <= 0) this.snowLine = 5000;
    // clouds drift with the westerlies aloft
    this.offset.x += dt * (11 + this.wind * 14);
    this.offset.y += dt * (4 + this.wind * 5);
    // lightning
    this.flash = Math.max(0, this.flash - dt * 5);
    if (this.storm > 0.6) {
      this.nextBolt -= dt;
      if (this.nextBolt < 0) {
        this.nextBolt = 4 + Math.random() * 16;
        this.flash = 0.6 + Math.random() * 0.4;
        this.events.push({ type: 'bolt', dist: 400 + Math.random() * 4500 });
      }
    }
  }

  save() { return { seed: this.seed, wet: this.wet, snow: this.snowCover, line: this.snowLine }; }
  load(s) {
    if (!s) return;
    this.seed = s.seed ?? this.seed;
    this.wet = s.wet || 0; this.snowCover = s.snow || 0; this.snowLine = s.line ?? 5000;
    this.day = -1;
  }
}
