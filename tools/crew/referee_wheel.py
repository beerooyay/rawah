"""Grade the actual SpeechWheel (revisions, pruning, live event arrival) against the referee."""
import math, random, sys, time
import numpy as np
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rawah_companions as rc
import referee as R

LAB = {"you just started to notice": (1.0, +1), "is getting strong": (8.0, +1),
       "is easing off": (8.0, -1), "just faded away": (1.0, -1)}


def run_wheel(events, comps):
    crew = rc.SensingCrew(rc.MockBackend(), comps, rc.Senses())
    wheel = rc.SpeechWheel(crew, cooldown=0.0, quiet_gap=math.inf)
    wheel._push = (lambda orig: (lambda t, name, reason, key=None, rev=None:
                                 None if reason == "reply" else orig(t, name, reason, key, rev)))(wheel._push)
    got = {}

    def on_line(t, name, reason, line):
        for frag, (m, d) in LAB.items():
            if frag in reason:
                kind = reason.split("|")[0] if "|" in reason else None
                got.setdefault((name, KIND_OF[reason], m, d), []).append(t)

    # events arrive live: run the wheel up to each release, then register it
    for e in sorted(events, key=lambda e: e["t0"]):
        wheel.run(e["t0"], on_line)
        crew.now = e["t0"]
        wheel.watch(rc.SenseEvent(e["kind"], e["pos"], e["t0"], e["A"], e["D"],
                                  R.KINDS[e["kind"]], e["kind"]))
    wheel.run(R.HORIZON, on_line)
    return got, wheel


KIND_OF = {}
for k in R.KINDS:
    for tpl in rc.SpeechWheel.REASONS.values():
        KIND_OF[tpl.format(n=k)] = k

rng = random.Random(11)
grid = np.arange(0, R.HORIZON + R.DT, R.DT)
tot = dict(matched=0, missed=0, spurious=0)
recomputes = pruned = 0
t_sched = 0.0
for s in range(150):
    events, comps = R.scenario(rng)
    comps = dict(zip(["Blaize", "Corey", "Grant", "Taylor", "Trey"], comps.values()))
    ref = R.reference(events, comps, grid)
    t = time.time()
    got, wheel = run_wheel(events, comps)
    t_sched += time.time() - t
    recomputes += wheel.recomputes
    pruned += wheel.pruned
    g = R.grade(ref, got, R.DT + R.TOL)
    for f in tot:
        tot[f] += g[f]
print("SpeechWheel vs referee, 150 live-arrival scenarios:", tot)
print(f"recomputes {recomputes}, pruned by the cone (provably no wake) {pruned}, "
      f"total scheduling time {t_sched:.2f}s")
