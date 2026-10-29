import { clamp, lerp } from './noise.js';

// The calendar. The Rawah changes completely through the year, and most of it
// follows from the date: where the sun runs (real declination, equation of
// time and daylight saving), how warm the valley gets, how much of the
// meadow has cured gold, what colour the aspens and willows are, how low the
// snowpack reaches, which lakes are frozen hard enough to walk on, and what
// kind of weather the days bring. Valley climate is for ~2,700 m in the
// upper Laramie River valley.

export const SEASONS = {
  spring: { label: 'Spring thaw · late May', doy: 146 },
  summer: { label: 'High summer · mid July', doy: 196 },
  autumn: { label: 'Golden aspens · late September', doy: 269 },
  late: { label: 'Late autumn · late October', doy: 296 },
  winter: { label: 'Deep winter · mid January', doy: 15 },
};

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Piecewise-linear lookup over [doy, value] keys, wrapping round the year. */
function curve(keys, doy) {
  const d = ((doy % 365) + 365) % 365, n = keys.length;
  for (let i = 0; i < n; i++) {
    const [d0, v0] = keys[i], [d1, v1] = keys[(i + 1) % n];
    const end = i + 1 < n ? d1 : d1 + 365;
    const x = i === n - 1 && d < d0 ? d + 365 : d;
    if (x >= d0 && x < end) return lerp(v0, v1, (x - d0) / (end - d0));
  }
  return keys[0][1];
}

// mid-month valley highs and lows, °C
const HIGH = [[15, -3], [46, -1], [74, 3], [105, 8], [135, 14], [166, 20], [196, 24], [227, 22], [258, 18], [288, 11], [319, 3], [349, -2]];
const LOW = [[15, -18], [46, -16], [74, -12], [105, -7], [135, -2], [166, 2], [196, 5], [227, 4], [258, 0], [288, -5], [319, -12], [349, -17]];
// how low the seasonal snowpack reaches (m); 4,600 means none
const SNOWLINE = [[1, 2000], [75, 2000], [105, 2550], [135, 2950], [160, 3350], [182, 3700], [205, 3880], [220, 4600], [270, 4600], [290, 3700], [310, 3000], [335, 2300], [364, 2000]];
// lakes above this elevation are frozen
const ICELINE = [[1, 2000], [110, 2000], [125, 2850], [150, 3250], [170, 3450], [178, 4600], [300, 4600], [312, 3350], [330, 2900], [345, 2000], [364, 2000]];
// share of meadow grass that has cured gold
const CURE = [[1, 1], [120, 1], [145, 0.7], [165, 0.2], [196, 0.06], [227, 0.25], [250, 0.55], [270, 0.78], [295, 0.96], [320, 1], [364, 1]];

// spring flush on the new growth, how far the aspens have turned, the share of their leaves that have fallen
const FLUSH = [[1, 0], [139, 0], [148, 1], [172, 0.75], [205, 0], [364, 0]];
const TURN = [[1, 0], [240, 0], [255, 0.35], [269, 0.75], [285, 1], [364, 1]];
const FALL = [[1, 0], [280, 0], [292, 0.5], [300, 0.95], [364, 1]];

export class Calendar {
  constructor(startDoy = SEASONS.autumn.doy) {
    this.start = startDoy;
    this.doy = startDoy;
  }

  /** Day-of-year for game day `day` (day 1 is the start date). */
  setDay(day) { this.doy = (this.start + day - 1) % 365; }

  get dateLabel() {
    let d = Math.floor(this.doy), m = 0;
    while (d >= DAYS[m]) { d -= DAYS[m]; m = (m + 1) % 12; }
    return `${MONTH[m]} ${d + 1}`;
  }

  /** Solar declination (radians) and clock time of solar noon at the trailhead. */
  get sun() {
    const n = this.doy + 1;
    const decl = (23.44 * Math.PI / 180) * Math.sin((2 * Math.PI * (284 + n)) / 365);
    const B = (2 * Math.PI * (n - 81)) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
    const dst = n >= 70 && n < 308;   // mid-March to early November
    const noon = 12 + 105.9 / 15 - eot / 60 - (dst ? 6 : 7);
    return { decl, noon };
  }

  /** Mean valley temperature and half its daily swing. */
  get valley() {
    const hi = curve(HIGH, this.doy), lo = curve(LOW, this.doy);
    return { mean: (hi + lo) / 2, swing: (hi - lo) / 2 };
  }

  get snowLine() { return curve(SNOWLINE, this.doy); }
  get iceLine() { return curve(ICELINE, this.doy); }
  get cure() { return clamp(curve(CURE, this.doy), 0, 1); }

  /** Foliage colour state read by the tree shaders every frame (the cut-out sheets are one green; see `toned` in trees.js). */
  get foliage() {
    return { fresh: curve(FLUSH, this.doy), autumn: curve(TURN, this.doy), drop: curve(FALL, this.doy), cold: clamp((3 - this.valley.mean) / 15, 0, 1) };
  }

  /** Which leaves the deciduous trees carry. Read once, when the atlas is painted. */
  get leaves() {
    const d = this.doy;
    if (d < 140 || d > 292) return 'bare';
    if (d < 165) return 'spring';
    if (d < 252) return 'summer';
    return 'autumn';
  }

  /** Weather-mix weights for the day's schedule, by season. */
  get climate() {
    const d = this.doy;
    if (d >= 175 && d < 245) return { storms: 0.6, fair: 0.25, front: 0, clear: 0.08, grey: 0.07 };       // summer monsoon
    if (d >= 245 && d < 290) return { storms: 0.32, fair: 0.26, front: 0.12, clear: 0.18, grey: 0.12 };   // early autumn
    if (d >= 290 && d < 335) return { storms: 0.04, fair: 0.2, front: 0.28, clear: 0.3, grey: 0.18 };     // late autumn
    if (d >= 120 && d < 175) return { storms: 0.2, fair: 0.25, front: 0.18, clear: 0.15, grey: 0.22 };   // spring
    return { storms: 0, fair: 0.12, front: 0.38, clear: 0.32, grey: 0.18 };                              // winter
  }
}

/** Day-of-year for a month index and day of month. */
export function doyOf(m, d) {
  let n = 0;
  for (let i = 0; i < m; i++) n += DAYS[i];
  return n + Math.min(d, DAYS[m]) - 1;
}
