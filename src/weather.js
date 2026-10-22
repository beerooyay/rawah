import * as THREE from 'three';
import { clamp, smoothstep, lerp } from './noise.js';

// Weather and climate. Late September on the Medicine Bow crest: cold clear
// mornings, cumulus that build over the peaks by noon, afternoon thunderstorms
// on some days, now and then a front that drops the snow line to the lakes,
// and valley fog after a wet night. The weather is a continuous function of
// time (`sampleWeather`): slow systems, afternoon heating, instability and
// drifting cloud banks, seeded per game and tilted by the season. The morning
// forecast in your journal is read off the same function, so it tells you
// what is really coming. The named regimes are what the settings menu can
// hold, and the labels the state is described with. The live state eases
// toward the sampled one, and everything else reads that state: clouds, sun
// and sky, fog, rain and snow, wind, air temperature, wet ground and snow.

export const REGIMES = {
  clear: { label: 'Clear', cloud: 0.03, thick: 0.15, precip: 0, fog: 0, wind: 0, temp: 0, storm: 0 },
  fair: { label: 'Fair-weather cumulus', cloud: 0.44, thick: 0.3, precip: 0, fog: 0, wind: 0.05, temp: 0, storm: 0 },
  building: { label: 'Clouds building', cloud: 0.56, thick: 0.62, precip: 0, fog: 0, wind: 0.2, temp: -1.5, storm: 0 },
  storm: { label: 'Thunderstorm', cloud: 0.94, thick: 1, precip: 0.9, fog: 0.25, wind: 0.75, temp: -5, storm: 1 },
  showers: { label: 'Showers', cloud: 0.86, thick: 0.82, precip: 0.45, fog: 0.3, wind: 0.3, temp: -4, storm: 0 },
  overcast: { label: 'Overcast', cloud: 0.9, thick: 0.7, precip: 0, fog: 0.1, wind: 0.2, temp: -3, storm: 0 },
  front: { label: 'Snow squalls', cloud: 1, thick: 0.95, precip: 0.75, fog: 0.55, wind: 0.6, temp: -9, storm: 0 },
  fog: { label: 'Fog', cloud: 0.75, thick: 0.55, precip: 0, fog: 1, wind: -0.25, temp: -2, storm: 0 },
};
const KEYS = ['cloud', 'thick', 'precip', 'fog', 'wind', 'temp', 'storm'];

/** Smooth 1-D noise in 0..1: value noise on an integer lattice, hashed from the seed. */
function lat(seed, i) {
  let h = Math.imul((i | 0) ^ Math.imul(seed | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function n1(seed, t) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  return lat(seed, i) * (1 - u) + lat(seed, i + 1) * u;
}
const fbm1 = (seed, t, oct = 2) => { let s = 0, a = 0.5, n = 0; for (let k = 0; k < oct; k++) { s += n1(seed + k * 31, t) * a; n += a; t *= 2.17; a *= 0.5; } return s / n; };

/**
 * The weather at a moment, as continuous numbers rather than a menu of
 * regimes. Slow systems (a day or two across) bring grey decks, cold fronts
 * and clearings; the sun builds cumulus through the afternoon and, on the
 * right days, tips it into thunderstorms; cold, wet, still mornings give
 * valley fog. The season's climate (calendar.js) tilts all of it, and the
 * seed makes every game's run of weather its own. T is hours since the start.
 */
export function sampleWeather(seed, T, climate = { storms: 0.32, fair: 0.26, front: 0.12, clear: 0.18, grey: 0.12 }) {
  const h = ((T % 24) + 24) % 24, day = Math.floor(T / 24);
  const c = climate;
  const system = fbm1(seed + 11, T / 31, 2);                         // slow pressure pattern
  const deck = smoothstep(0.6 - c.grey * 1.1 - c.front * 0.5, 0.82, system);   // grey overcast
  const frontish = smoothstep(0.7 - c.front * 0.9, 0.93, system) * Math.min(1, c.front * 4);
  const sun = smoothstep(9, 13, h) * (1 - smoothstep(16.5, 20.5, h));            // afternoon heating
  const mood = fbm1(seed + 23, T / 9, 2);                                        // today's instability
  const instab = clamp((mood - 0.4) * 1.6 * (0.35 + c.storms * 2.4), 0, 1) * (1 - deck * 0.6);
  const cumulus = sun * (0.18 + 0.62 * fbm1(seed + 37, T / 5, 2)) * (1 - deck * 0.5) * (0.5 + c.fair + c.storms);
  const conv = sun * instab;
  const banks = fbm1(seed + 41, T / 1.7, 2) - 0.5;                              // clouds drifting through
  const cloud = clamp(0.02 + 0.78 * deck + 0.55 * conv + 0.6 * cumulus + frontish * 0.5 + banks * 0.22 * (0.4 + deck + cumulus), 0, 1);
  const thick = clamp(0.12 + 0.66 * deck + 0.62 * conv + 0.25 * cumulus + frontish * 0.35 + banks * 0.1, 0, 1);
  const storm = smoothstep(0.52, 0.82, conv * (0.7 + 0.6 * fbm1(seed + 53, T / 2.3, 2)));
  const shower = smoothstep(0.58, 0.88, cloud * thick + 0.3 * (fbm1(seed + 67, T / 3.1, 2) - 0.5)) * 0.5;
  const precip = clamp(Math.max(storm * 0.95, shower, frontish * 0.78), 0, 1);
  // cold, damp, still dawns: valley fog that burns off by mid-morning
  const dawn = smoothstep(2, 5, h) * (1 - smoothstep(7.5, 10.5, h));
  const fogRoll = n1(seed + 79, day * 2.7 + 0.4);
  const fog = clamp(dawn * smoothstep(0.5, 0.82, fogRoll) * (1 - deck * 0.4) + frontish * 0.55 + shower * 0.25, 0, 1);
  const wind = clamp(0.03 + 0.28 * deck + 0.65 * frontish + 0.5 * storm + 0.25 * conv + 0.14 * cumulus - fog * 0.3 + (fbm1(seed + 89, T / 2.6) - 0.5) * 0.25, -0.25, 1);
  const temp = -(2.2 * deck + 4.5 * storm + 9 * frontish + 1.6 * shower * 2 + 1.4 * cloud * thick);
  return { cloud, thick, precip, fog, wind, temp, storm };
}

/** The named regime a state is closest to: for labels, the forecast and the journal. */
export function classify(w) {
  if (w.storm > 0.5) return 'storm';
  if (w.precip > 0.55 && w.temp < -6) return 'front';
  if (w.precip > 0.2) return 'showers';
  if (w.fog > 0.55) return 'fog';
  if (w.cloud > 0.78) return 'overcast';
  if (w.cloud > 0.5 && w.thick > 0.5) return 'building';
  if (w.cloud > 0.2) return 'fair';
  return 'clear';
}

/** One day's weather as [hour, regime] steps, read off the same model the game runs on. */
export function daySchedule(seed, day, climate) {
  const out = [];
  let last = null;
  for (let q = 0; q < 24 * 4; q++) {
    const hr = q / 4, k = classify(sampleWeather(seed, (day - 1) * 24 + hr, climate));
    if (k !== last) { out.push([hr, k]); last = k; }
  }
  // a regime that lasts under 45 minutes is a flicker, not a forecast: fold it into what came before
  for (let i = out.length - 1; i > 0; i--) {
    const end = i + 1 < out.length ? out[i + 1][0] : 24;
    if (end - out[i][0] < 0.75) out.splice(i, 1);
  }
  return out.filter((e, i) => i === 0 || e[1] !== out[i - 1][1]);
}

function fmtHour(h) {
  const hh = Math.floor(h);
  return `${((hh + 11) % 12) + 1} ${hh < 12 ? 'AM' : 'PM'}`;
}

/** A one-line forecast for the journal, read off the schedule. */
export function forecast(sched) {
  sched = sched.filter(([t]) => t >= 5);   // the day you plan is the daylight one
  if (!sched.length) return 'Clear and dry. Cold tonight.';
  const at = (k) => sched.find(([, r]) => r === k);
  const before = (k, h) => [...sched].reverse().find(([t, r]) => r === k && t < h);
  if (at('front')) return `Cold front: snow squalls from about ${fmtHour(at('front')[0])}, snow down to the lakes. Bring the puffy.`;
  if (at('storm') && !at('building')) return `Thunderstorms around ${fmtHour(at('storm')[0])}.`;
  if (at('storm')) return `Clear early, clouds building by ${fmtHour(before('building', at('storm')[0])?.[0] ?? at('storm')[0] - 1)}, thunderstorms around ${fmtHour(at('storm')[0])}. Be off the ridges by noon.`;
  if (at('showers')) return `Grey and cool, showers from about ${fmtHour(at('showers')[0])}.`;
  if (at('building')) return 'Fair. Afternoon cumulus over the crest, storms unlikely.';
  return 'Clear and dry. Cold tonight.';
}

export class Weather {
  constructor(seed = (Math.random() * 1e9) | 0) {
    this.seed = seed;
    this.override = null;         // a regime name to hold, or null for the live schedule
    this.climate = undefined;     // the season's weather mix (calendar.js)
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
    if (day !== this.day) { this.day = day; this.sched = daySchedule(this.seed, day, this.climate); }
    if (this.override && REGIMES[this.override]) { this.regime = this.override; return REGIMES[this.override]; }
    const w = sampleWeather(this.seed, (day - 1) * 24 + hour, this.climate);
    this.regime = classify(w);
    return w;
  }

  get label() {
    if (this.precip > 0.15) return this.storm > 0.5 ? 'Thunderstorm' : this.snowK > 0.6 ? 'Snow' : this.snowK > 0.25 ? 'Sleet' : 'Rain';
    if (this.fog > 0.6) return 'Fog';
    if (this.cloud > 0.82) return 'Overcast';
    if (this.cloud > 0.5) return this.thick > 0.55 ? 'Clouds building' : 'Mostly cloudy';
    if (this.cloud > 0.18) return 'Partly cloudy';
    return 'Clear';
  }

  get forecast() { return forecast(this.sched || daySchedule(this.seed, this.day, this.climate)); }

  /**
   * Advance. `dt` real seconds, `gameMin` game minutes elapsed, `tempC` air
   * temperature at the hiker before weather, `sunUp` 0..1, `freezeLine` the
   * elevation where the air is at freezing right now.
   */
  update(dt, gameMin, day, hour, tempC, sunUp, freezeLine) {
    this.events.length = 0;
    const T = this.#target(day, hour);
    // the sampled weather is already smooth; this only softens jumps (a menu override, waking from a nap)
    const k = 1 - Math.exp(-gameMin / 7);
    for (const key of KEYS) this[key] = lerp(this[key], T[key], key === 'cloud' && T.cloud < this.cloud ? k * 0.7 : k);
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
