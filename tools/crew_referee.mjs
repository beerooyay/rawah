// Brute-force referee for the crew's wake scheduling (a port of Blaize's referee.py and referee_wheel.py, which are kept
// beside the original module in tools/crew/). It grades the real src/crew.js against ground truth.
//
//   node tools/crew_referee.mjs [scenarios=200] [seed=7]
//
// Ground truth: for each companion and smell kind, the SUMMED field (diffusion is linear, two fires' smoke adds) sampled
// every DT seconds. A "transition" is the perceived level changing: crossing eps (notice / fade) or 8 eps (strong / easing
// off), strictly greater-than. Graded:
//   v1  one window per source (arrival, strong, departure): what you get if sources are treated one at a time
//   v2  certifiedCrossings on the summed field, recomputed whenever a new source of that kind is released
//   wheel  the actual SpeechWheel with sources arriving live (revisions, pruning)
import { SenseEvent, Senses, SpeechWheel, certifiedCrossings, R2_FLOOR } from '../src/crew.js';

const DT = 0.02, TOL = 0.01, HORIZON = 900, STRONG = 8;
const KINDS = { smoke: 0.05, spores: 0.08 };

function rng(seed) {
  let s = seed >>> 0;
  const r = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.range = (a, b) => a + (b - a) * r();
  r.int = (a, b) => a + Math.floor(r() * (b - a + 1));
  r.gauss = (m, sd) => m + sd * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  return r;
}

function scenario(r, nComp = 5) {
  const centers = Array.from({ length: r.int(1, 3) }, () => [r.range(10, 110), r.range(10, 110)]);
  const events = Array.from({ length: r.int(2, 8) }, () => {
    const [cx, cy] = r.pick(centers);
    return { kind: r.pick(Object.keys(KINDS)), pos: [r.gauss(cx, 12), r.gauss(cy, 12)], t0: r.range(0, 400), A: r.range(100, 2500), D: r.range(0.8, 4.0) };
  });
  const comps = {};
  for (let i = 0; i < nComp; i++) {
    if (r() < 0.6) { const [cx, cy] = r.pick(centers); comps[`c${i}`] = [r.gauss(cx, 25), r.gauss(cy, 25)]; }
    else comps[`c${i}`] = [r.range(0, 120), r.range(0, 120)];
  }
  return { events, comps };
}

const key = (n, k, m, d) => `${n}|${k}|${m}|${d}`;
const add = (o, k, t) => { (o[k] ||= []).push(t); };

function reference(events, comps, grid) {
  const out = {};
  for (const [name, p] of Object.entries(comps)) {
    for (const [kind, eps] of Object.entries(KINDS)) {
      const evs = events.filter((e) => e.kind === kind);
      if (!evs.length) continue;
      const S = new Float64Array(grid.length);
      for (const e of evs) {
        const r2 = Math.max((p[0] - e.pos[0]) ** 2 + (p[1] - e.pos[1]) ** 2, R2_FLOOR);
        for (let i = 0; i < grid.length; i++) {
          const tau = grid[i] - e.t0;
          if (tau > 0) S[i] += (e.A / (4 * Math.PI * e.D * tau)) * Math.exp(-r2 / (4 * e.D * tau));
        }
      }
      for (const m of [1, STRONG]) {
        for (let i = 0; i + 1 < grid.length; i++) {
          const a = S[i] > eps * m, b = S[i + 1] > eps * m;
          if (a !== b) add(out, key(name, kind, m, b ? 1 : -1), (grid[i] + grid[i + 1]) / 2);
        }
      }
    }
  }
  return out;
}

function scheduleV1(events, comps) {
  const out = {};
  for (const e of events) {
    const se = new SenseEvent(e.kind, e.pos, e.t0, e.A, e.D, KINDS[e.kind], 'x');
    for (const [name, p] of Object.entries(comps)) {
      const w = se.window(p);
      if (!w) continue;
      const put = (k, t) => { if (t <= HORIZON) add(out, k, t); };
      put(key(name, e.kind, 1, 1), w[0]);
      const ws = se.window(p, se.eps * STRONG);
      if (ws && ws[0] - w[0] > 5) put(key(name, e.kind, STRONG, 1), ws[0]);
      put(key(name, e.kind, 1, -1), w[1]);
    }
  }
  return out;
}

function scheduleV2(events, comps) {
  const out = {};
  let recomputes = 0;
  for (const [kind, eps] of Object.entries(KINDS)) {
    const evs = events.filter((e) => e.kind === kind).sort((a, b) => a.t0 - b.t0);
    if (!evs.length) continue;
    const revs = [0, ...evs.map((e) => e.t0), HORIZON];
    for (const [name, p] of Object.entries(comps)) {
      for (let k = 0; k + 1 < revs.length; k++) {
        const a = revs[k], b = revs[k + 1];
        if (b <= a) continue;
        const known = evs.filter((e) => e.t0 <= a).map((e) => [e.A, e.D, e.t0, (p[0] - e.pos[0]) ** 2 + (p[1] - e.pos[1]) ** 2]);
        recomputes++;
        for (const m of [1, STRONG]) for (const [t, d] of certifiedCrossings(known, eps * m, a, b, TOL).crossings) add(out, key(name, kind, m, d), t);
      }
    }
  }
  return { out, recomputes };
}

const LAB = [['just started to notice', 1, 1], ['is getting strong', STRONG, 1], ['is easing off', STRONG, -1], ['just faded away', 1, -1]];

async function runWheel(events, comps) {
  const senses = new Senses();
  const wheel = new SpeechWheel(senses, comps, { cooldown: 0, quietGap: Infinity });
  const got = {};
  const wake = async ({ t, name, reason, kind }) => {
    if (reason === 'reply') return false;
    for (const [frag, m, d] of LAB) if (reason.includes(frag)) add(got, key(name, kind, m, d), t);
    return false;                                             // replies are off in the referee
  };
  for (const e of [...events].sort((a, b) => a.t0 - b.t0)) {
    await wheel.run(e.t0, wake);
    wheel.now = e.t0;
    wheel.watch(new SenseEvent(e.kind, e.pos, e.t0, e.A, e.D, KINDS[e.kind], e.kind));
  }
  await wheel.run(HORIZON, wake);
  return { got, wheel };
}

function grade(ref, sched, tol) {
  let missed = 0, spurious = 0, matched = 0, maxErr = 0;
  for (const k of new Set([...Object.keys(ref), ...Object.keys(sched)])) {
    const R = (ref[k] || []).slice().sort((a, b) => a - b), W = (sched[k] || []).slice().sort((a, b) => a - b);
    const used = new Array(W.length).fill(false);
    for (const t of R) {
      let best = null, bi = -1;
      W.forEach((w, i) => { if (!used[i] && Math.abs(w - t) <= tol && (best === null || Math.abs(w - t) < best)) { best = Math.abs(w - t); bi = i; } });
      if (bi < 0) missed++; else { used[bi] = true; matched++; maxErr = Math.max(maxErr, best); }
    }
    spurious += used.filter((u) => !u).length;
  }
  return { matched, missed, spurious, maxErr };
}

const n = Number(process.argv[2] || 200), seed = Number(process.argv[3] || 7);
const r = rng(seed);
const grid = Float64Array.from({ length: Math.round(HORIZON / DT) + 1 }, (_, i) => i * DT);
const tot = { v1: { matched: 0, missed: 0, spurious: 0, maxErr: 0 }, v2: { matched: 0, missed: 0, spurious: 0, maxErr: 0 }, wheel: { matched: 0, missed: 0, spurious: 0, maxErr: 0 } };
let refTotal = 0, recomputes = 0, wheelRecomputes = 0, pruned = 0, overlap = 0, tV2 = 0;
for (let s = 0; s < n; s++) {
  const { events, comps } = scenario(r);
  const ref = reference(events, comps, grid);
  refTotal += Object.values(ref).reduce((a, v) => a + v.length, 0);
  overlap += Object.keys(KINDS).some((k) => events.filter((e) => e.kind === k).length > 1) ? 1 : 0;
  const t0 = performance.now();
  const v2 = scheduleV2(events, comps);
  tV2 += performance.now() - t0;
  recomputes += v2.recomputes;
  const { got, wheel } = await runWheel(events, comps);
  wheelRecomputes += wheel.recomputes; pruned += wheel.pruned;
  for (const [name, sched] of [['v1', scheduleV1(events, comps)], ['v2', v2.out], ['wheel', got]]) {
    const g = grade(ref, sched, DT + TOL);
    for (const f of ['matched', 'missed', 'spurious']) tot[name][f] += g[f];
    tot[name].maxErr = Math.max(tot[name].maxErr, g.maxErr);
  }
}
console.log(`${n} randomized scenarios, ${overlap} with same-kind overlapping sources, ${refTotal} reference transitions (dt=${DT}s)`);
for (const [name, t] of Object.entries(tot)) console.log(`${name.padEnd(6)} matched ${t.matched}  missed ${t.missed}  spurious ${t.spurious}  max error ${t.maxErr.toFixed(4)} s`);
console.log(`v2 scheduler cost: ${(tV2 / recomputes).toFixed(3)} ms per (companion, kind) recompute, ${recomputes} recomputes; wheel ${wheelRecomputes} recomputes, ${pruned} pruned by the cone (provably no wake)`);
if (tot.v2.missed || tot.v2.spurious || tot.wheel.missed || tot.wheel.spurious) { console.error('FAIL: the certified scheduler disagrees with brute force'); process.exit(1); }
