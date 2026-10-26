"""Brute-force referee for companion wake scheduling.

Ground truth: for each companion and smell kind, the SUMMED field (diffusion is linear,
two fires' smoke adds) sampled every DT seconds. A "transition" is the perceived level
changing: crossing eps (notice / fade) or 8*eps (strong / easing off), strict > convention.

Graded:
  v1 = current wheel: per-event windows (arrival, strong if >5s later, departure)
  v2 = certified_crossings on the summed field, recomputed whenever a new event of that
       kind is released (revision), exactly what a live engine would do
"""
import math, random, sys, time, json
import numpy as np
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawah_companions as rc

DT = 0.02
TOL = 0.01
HORIZON = 900.0
STRONG = 8.0
KINDS = {"smoke": 0.05, "spores": 0.08}


def scenario(rng, n_comp=5):
    centers = [(rng.uniform(10, 110), rng.uniform(10, 110)) for _ in range(rng.randint(1, 3))]
    events = []
    for _ in range(rng.randint(2, 8)):
        cx, cy = rng.choice(centers)
        kind = rng.choice(list(KINDS))
        events.append(dict(kind=kind, pos=(cx + rng.gauss(0, 12), cy + rng.gauss(0, 12)),
                           t0=rng.uniform(0, 400), A=rng.uniform(100, 2500), D=rng.uniform(0.8, 4.0)))
    comps = {}
    for i in range(n_comp):
        if rng.random() < 0.6:                       # most companions hang near the action
            cx, cy = rng.choice(centers)
            comps[f"c{i}"] = (cx + rng.gauss(0, 25), cy + rng.gauss(0, 25))
        else:
            comps[f"c{i}"] = (rng.uniform(0, 120), rng.uniform(0, 120))
    return events, comps


def reference(events, comps, grid):
    """{(comp, kind, thr_mult, dir): [times]} from dense sampling of the summed field."""
    out = {}
    for name, p in comps.items():
        for kind, eps in KINDS.items():
            evs = [e for e in events if e["kind"] == kind]
            if not evs:
                continue
            S = np.zeros_like(grid)
            for e in evs:
                tau = grid - e["t0"]
                r2 = max((p[0] - e["pos"][0]) ** 2 + (p[1] - e["pos"][1]) ** 2, rc.R2_FLOOR)
                with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
                    u = np.where(tau > 0, e["A"] / (4 * np.pi * e["D"] * tau) *
                                 np.exp(-r2 / (4 * e["D"] * np.where(tau > 0, tau, 1))), 0.0)
                S += u
            for m in (1.0, STRONG):
                st = S > eps * m
                d = np.diff(st.astype(np.int8))
                for idx in np.nonzero(d)[0]:
                    # true crossing lies in (grid[idx], grid[idx+1]]; report the midpoint
                    out.setdefault((name, kind, m, int(d[idx])), []).append((grid[idx] + grid[idx + 1]) / 2)
    return out


def schedule_v1(events, comps):
    out = {}
    for e in events:
        se = rc.SenseEvent(e["kind"], e["pos"], e["t0"], e["A"], e["D"], KINDS[e["kind"]], "x")
        for name, p in comps.items():
            w = se.window(p)
            if not w:
                continue
            add = lambda k, t: out.setdefault(k, []).append(t) if t <= HORIZON else None
            add((name, e["kind"], 1.0, +1), w[0])
            ws = se.window(p, se.eps * STRONG)
            if ws and ws[0] - w[0] > 5:
                add((name, e["kind"], STRONG, +1), ws[0])
            add((name, e["kind"], 1.0, -1), w[1])
    return out


def schedule_v2(events, comps):
    out = {}
    recomputes = 0
    for kind, eps in KINDS.items():
        evs = sorted((e for e in events if e["kind"] == kind), key=lambda e: e["t0"])
        if not evs:
            continue
        revs = [0.0] + [e["t0"] for e in evs] + [HORIZON]
        for name, p in comps.items():
            for k in range(len(revs) - 1):
                a, b = revs[k], revs[k + 1]
                if b <= a:
                    continue
                known = [(e["A"], e["D"], e["t0"],
                          (p[0] - e["pos"][0]) ** 2 + (p[1] - e["pos"][1]) ** 2)
                         for e in evs if e["t0"] <= a]
                recomputes += 1
                for m in (1.0, STRONG):
                    _, xs = rc.certified_crossings(known, eps * m, a, b, tol=TOL)
                    for t, d in xs:
                        out.setdefault((name, kind, m, d), []).append(t)
    return out, recomputes


def grade(ref, sched, tol):
    missed = spurious = matched = 0
    errs = []
    keys = set(ref) | set(sched)
    for k in keys:
        R = sorted(ref.get(k, []))
        W = sorted(sched.get(k, []))
        used = [False] * len(W)
        for t in R:
            best, bi = None, None
            for i, w in enumerate(W):
                if not used[i] and abs(w - t) <= tol and (best is None or abs(w - t) < best):
                    best, bi = abs(w - t), i
            if bi is None:
                missed += 1
            else:
                used[bi] = True
                matched += 1
                errs.append(best)
        spurious += used.count(False)
    return dict(matched=matched, missed=missed, spurious=spurious,
                max_err=round(max(errs), 4) if errs else None)


def main(n=300, seed=7):
    rng = random.Random(seed)
    grid = np.arange(0, HORIZON + DT, DT)
    match_tol = DT + TOL
    tot = {"v1": dict(matched=0, missed=0, spurious=0, max_err=0),
           "v2": dict(matched=0, missed=0, spurious=0, max_err=0)}
    by_kind = {"v1": {}, "v2": {}}
    ref_total = 0
    t_v2 = 0.0
    recs = 0
    overlap_scen = 0
    for s in range(n):
        events, comps = scenario(rng)
        ref = reference(events, comps, grid)
        ref_total += sum(len(v) for v in ref.values())
        overlap_scen += any(sum(e["kind"] == k for e in events) > 1 for k in KINDS)
        v1 = schedule_v1(events, comps)
        t = time.time()
        v2, r = schedule_v2(events, comps)
        t_v2 += time.time() - t
        recs += r
        for name, sched in (("v1", v1), ("v2", v2)):
            g = grade(ref, sched, match_tol)
            for f in ("matched", "missed", "spurious"):
                tot[name][f] += g[f]
            if g["max_err"] is not None:
                tot[name]["max_err"] = max(tot[name]["max_err"], g["max_err"])
            # breakdown of misses by transition type
            for k, R in ref.items():
                lab = f"{'eps' if k[2] == 1 else '8eps'} {'up' if k[3] > 0 else 'down'}"
                gk = grade({k: R}, {k: sched.get(k, [])}, match_tol)
                by_kind[name].setdefault(lab, [0, 0])
                by_kind[name][lab][0] += len(R)
                by_kind[name][lab][1] += gk["missed"]
    print(f"{n} randomized scenarios, {overlap_scen} with same-kind overlapping sources, "
          f"{ref_total} reference transitions (dt={DT}s)")
    for name in ("v1", "v2"):
        print(f"\n{name}: {json.dumps(tot[name])}")
        for lab, (total, miss) in sorted(by_kind[name].items()):
            print(f"   {lab:9s} missed {miss:5d} / {total}")
    print(f"\nv2 scheduler cost: {t_v2 * 1000 / recs:.2f} ms per (companion, kind) recompute, "
          f"{recs} recomputes total")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 300)
