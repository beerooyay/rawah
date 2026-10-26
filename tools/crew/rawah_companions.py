"""
rawah_companions.py - starter crew companion module for Rawah.

Five companions (Blaize, Corey, Grant, Taylor, Trey) share one model:
NVIDIA Nemotron 3.5 Bolt E4B. Each gets its own voice card, but they all
read a shared scene log, so they can react to and roast each other.

Backend order: local Ollama (your laptop / home box) first, NVIDIA's free
API as the fallback. Same model on both, so voices stay identical.

Quick start
-----------
    export NVIDIA_API_KEY=nvapi-...          # fallback (free tier, ~40 req/min)
    ollama run nemotron-3.5-bolt:e4b         # optional: local backend
    python rawah_companions.py               # runs the demo scene
    python rawah_companions.py --mock        # offline dry run, no model needed

Main calls for the game
-----------------------
    crew = Crew(Backend())
    crew.event("a storm rolls over the ridge")     # log something that happened
    crew.banter(n=3)                                # 2-3 companions react / roast
    crew.debate("what now?", calm="...", wild="...") # the eternal argument, with a vote
    crew.remember_moment("grant almost ate it on one block")  # becomes an inside joke
    crew.act("Corey", "follow Blaize")              # tool calls -> game actions
    crew.save("crew_state.json") / Crew.load(...)   # persistent memory
"""

import heapq
import json
import math
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict

# ---------------------------------------------------------------- config

LOCAL_URL = os.environ.get("RAWAH_LOCAL_URL", "http://localhost:11434/v1")
LOCAL_MODEL = os.environ.get("RAWAH_LOCAL_MODEL", "nemotron-3.5-bolt:e4b")
API_URL = "https://integrate.api.nvidia.com/v1"
API_MODEL = "nvidia/nemotron-3.5-bolt-e4b"
API_MIN_INTERVAL = 1.6          # seconds between API calls, stays under 40 rpm
LOCAL_HEALTH_TTL = 60           # re-check whether the local box is up this often
LOG_WINDOW = 14                 # how many recent scene lines each companion sees
ROAST_RATE = 0.7                # how often a line gets aimed at whoever just talked

# ---------------------------------------------------------------- the crew

CREW_BIBLE = (
    "You are one of a five-man crew in the game Rawah: Blaize, Corey, Grant, Taylor and Trey. "
    "They're brothers in everything but blood and best friends since forever. Every one of them "
    "is witty, sarcastic, smart and down to earth. They roast each other constantly, but it's love: "
    "the roasts are never actually cruel, and if someone is genuinely hurt or in trouble the jokes "
    "stop until he's okay, then resume immediately.\n"
    "The crew's eternal argument: slow down and soak in the calm, beautiful stuff (sunsets, quiet "
    "ridges, glowing caves you just look at) versus chase side quests, danger and off-trail chaos."
)


@dataclass
class Companion:
    name: str
    lean: float                 # -1 = soak in the calm ... +1 = send it off-trail
    angle: str                  # their role in the group's comedy
    voice: str                  # how they talk
    roast_style: str            # how they go after the others
    examples: list
    notes: list = field(default_factory=list)   # things this companion personally remembers

    def stance(self) -> str:
        if self.lean <= -0.4:
            return "You usually argue for slowing down and enjoying the calm, beautiful stuff."
        if self.lean >= 0.4:
            return "You usually argue for the side quest, the danger, the off-trail option."
        return ("You're the swing vote. You side with whichever option makes the better story, "
                "and you enjoy watching both camps fight for you.")


# Placeholder personalities. All five share the core traits; these angles just keep
# their voices from blurring together. Rewrite freely with the real guys' energy.
DEFAULT_CREW = [
    Companion(
        name="Blaize", lean=0.5,
        angle="the schemer. every bad idea arrives with a full pitch.",
        voice="confident and fast, talks like he's selling the plan, loves 'hear me out' and 'trust me'",
        roast_style="buries people in mock-serious logic and fake statistics",
        examples=["hear me out: the cliff IS the shortcut.",
                  "statistically Grant falls first, so the rest of us are fine."]),
    Companion(
        name="Corey", lean=-0.4,
        angle="the deadpan. watches the chaos like a nature documentary.",
        voice="dry, short, understated, never raises his voice, lets one sentence do the damage",
        roast_style="flat one-liners delivered like facts",
        examples=["cool. I'll be over here, enjoying not dying.",
                  "Blaize has a plan. so now we have a problem."]),
    Companion(
        name="Grant", lean=0.9,
        angle="the send-it guy. sees a ledge, needs to know what's under it.",
        voice="loud, hyped, competitive, talks in dares and challenges",
        roast_style="dares people and questions their nerve",
        examples=["bet you won't. bet. you. won't.",
                  "Taylor's about to say 'we could just chill' in three, two..."]),
    Companion(
        name="Taylor", lean=-0.8,
        angle="the vibe keeper. would happily watch one sunset for six hours.",
        voice="laid back, unbothered, warm, slow-drawl sarcasm",
        roast_style="stays unbothered so everyone else's panic looks ridiculous",
        examples=["y'all go get eaten. I'm watching the sky do its thing.",
                  "Grant's almost died four times today. that's just his cardio."]),
    Companion(
        name="Trey", lean=0.0,
        angle="the swing vote. pretends to mediate, secretly picks whatever makes the best story.",
        voice="observant, quick, a little smug, narrates the group's dysfunction",
        roast_style="calls out everyone's patterns like he's been keeping score",
        examples=["so we're doing the dumb thing. great. somebody hold my stuff.",
                  "Corey sighed. that's a yes from Corey."]),
]

# Real inside jokes go here. The model uses at most a couple per line, only when they fit.
SEED_INSIDE_JOKES: list = [
    # "the time Trey ...",
]

# ---------------------------------------------------------------- tools (game actions)

ACTION_TOOLS = [
    {"type": "function", "function": {
        "name": "follow_player", "description": "Start following a crew member",
        "parameters": {"type": "object", "properties": {"player": {"type": "string"}},
                       "required": ["player"]}}},
    {"type": "function", "function": {
        "name": "emote", "description": "Play an animation",
        "parameters": {"type": "object", "properties": {"animation": {"type": "string",
                       "enum": ["wave", "shrug", "laugh", "point", "facepalm", "sit"]}},
                       "required": ["animation"]}}},
    {"type": "function", "function": {
        "name": "point_at", "description": "Point at something in the world to draw attention to it",
        "parameters": {"type": "object", "properties": {"target": {"type": "string"}},
                       "required": ["target"]}}},
]

# ---------------------------------------------------------------- backends


class Backend:
    """Tries the local Ollama box first, falls back to NVIDIA's API."""

    def __init__(self, api_key=None, local_url=LOCAL_URL, use_local=True):
        self.api_key = api_key or os.environ.get("NVIDIA_API_KEY")
        self.local_url = local_url.rstrip("/")
        self.use_local = use_local
        self._local_ok = None
        self._local_checked = 0.0
        self._last_api_call = 0.0
        self.last_source = None

    def _local_up(self) -> bool:
        if not self.use_local:
            return False
        if time.time() - self._local_checked < LOCAL_HEALTH_TTL and self._local_ok is not None:
            return self._local_ok
        try:
            urllib.request.urlopen(self.local_url + "/models", timeout=1.5).read()
            self._local_ok = True
        except Exception:
            self._local_ok = False
        self._local_checked = time.time()
        return self._local_ok

    def _post(self, url, body, key=None, timeout=30):
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        req = urllib.request.Request(url + "/chat/completions",
                                     data=json.dumps(body).encode(), headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)

    def chat(self, messages, tools=None, max_tokens=90, temperature=0.8) -> dict:
        body = {"messages": messages, "max_tokens": max_tokens,
                "temperature": temperature, "top_p": 0.95, "stream": False}
        if tools:
            # learned in testing: tool_choice auto + lower temp = real structured tool calls
            body["tools"] = tools
            body["tool_choice"] = "auto"
            body["temperature"] = min(temperature, 0.6)

        errors = []
        if self._local_up():
            try:
                d = self._post(self.local_url, {**body, "model": LOCAL_MODEL}, timeout=30)
                self.last_source = "local"
                return d["choices"][0]["message"]
            except Exception as e:
                errors.append(f"local: {e}")
                self._local_ok = False

        if self.api_key:
            api_body = {**body, "model": API_MODEL,
                        "chat_template_kwargs": {"enable_thinking": False}}
            for attempt in range(3):
                wait = API_MIN_INTERVAL - (time.time() - self._last_api_call)
                if wait > 0:
                    time.sleep(wait)
                self._last_api_call = time.time()
                try:
                    d = self._post(API_URL, api_body, key=self.api_key)
                    self.last_source = "api"
                    return d["choices"][0]["message"]
                except urllib.error.HTTPError as e:
                    errors.append(f"api: HTTP {e.code}")
                    if e.code == 429 or e.code >= 500:   # rate limit or a server hiccup: back off, retry
                        time.sleep(2 * (attempt + 1))
                        continue
                    break
                except Exception as e:
                    errors.append(f"api: {e}")
                    break

        raise RuntimeError("no backend answered: " + "; ".join(errors or ["no key, no local box"]))


class MockBackend:
    """Offline stand-in so the plumbing can be tested without a model."""
    last_source = "mock"

    def chat(self, messages, tools=None, **_):
        system = messages[0]["content"]
        m = re.search(r"You are (\w+)\. Your role", system)
        name = m.group(1) if m else "?"
        if tools:
            return {"content": None, "tool_calls": [{"type": "function", "function": {
                "name": "follow_player", "arguments": json.dumps({"player": "Blaize"})}}]}
        lean = float(re.search(r"LEAN=(-?[\d.]+)", system).group(1))
        tag = ""
        if "[CALM] or [WILD]" in messages[-1]["content"]:
            tag = " [WILD]" if lean > 0 or (lean == 0 and random.random() > .5) else " [CALM]"
        return {"content": f"{name.lower()} mock line{tag}"}

# ---------------------------------------------------------------- the crew engine


class Crew:
    def __init__(self, backend, members=None, inside_jokes=None):
        self.backend = backend
        self.members = {c.name: c for c in (members or DEFAULT_CREW)}
        self.inside_jokes = list(inside_jokes if inside_jokes is not None else SEED_INSIDE_JOKES)
        self.log = []               # shared scene log: "EVENT: ..." / "Name: line"
        self.recent = {}            # each companion's own recent lines (anti-parroting)
        self.last_speaker = None

    # ---- prompt building

    def _system(self, c: Companion) -> str:
        parts = [
            CREW_BIBLE,
            f"\nYou are {c.name}. Your role in the crew: {c.angle}",
            f"How you talk: {c.voice}.",
            f"How you roast: {c.roast_style}.",
            c.stance(),
            "Tone reference ONLY. Never reuse these lines or their catchphrases; say something new "
            "about what's actually happening: " + " / ".join(f"'{e}'" for e in c.examples),
        ]
        mine = self.recent.get(c.name, [])[-3:]
        if mine:
            parts.append("You already said these. Don't repeat their wording, openers or catchphrases: "
                         + " / ".join(f"'{m}'" for m in mine))
        jokes = random.sample(self.inside_jokes, min(2, len(self.inside_jokes)))
        if jokes:
            parts.append("Crew inside jokes (reference one ONLY if it fits naturally, never force it): "
                         + "; ".join(jokes))
        if c.notes:
            parts.append("Things you personally remember: " + "; ".join(c.notes[-4:]))
        parts.append("Reply with only your spoken line: 1-2 sentences, under 30 words. "
                     "No narration, no quotes, no name prefix. Never speak for the other guys.")
        parts.append(f"LEAN={c.lean}")
        return "\n".join(parts)

    def _scene(self) -> str:
        return "Recent moments:\n" + "\n".join(self.log[-LOG_WINDOW:])

    @staticmethod
    def _clean(text: str, name: str) -> str:
        text = " ".join((text or "").split())
        text = re.sub(rf"^\s*{name}\s*:\s*", "", text, flags=re.I)
        text = text.strip().strip('"').strip()
        return text

    # ---- core moves

    def event(self, what: str):
        """Log something that happened in the world (or something a real player said)."""
        self.log.append(f"EVENT: {what}")

    def player_says(self, player: str, line: str):
        self.log.append(f"{player} (player): {line}")

    def say(self, name: str, nudge: str = "What do you say next?") -> str:
        c = self.members[name]
        try:
            msg = self.backend.chat([{"role": "system", "content": self._system(c)},
                                     {"role": "user", "content": f"{self._scene()}\n\n{nudge}"}])
        except RuntimeError:
            return ""   # both backends down: the companion just stays quiet this beat
        line = self._clean(msg.get("content"), name)
        self.log.append(f"{name}: {line}")
        self.recent.setdefault(name, []).append(line)
        self.last_speaker = name
        return line

    def _last_other_speaker(self, name: str):
        for entry in reversed(self.log[-6:]):
            who = entry.split(":", 1)[0]
            if who in self.members and who != name:
                return who
        return None

    def roast_nudge(self, name: str, base: str = "React to the moment.") -> str:
        """Most of the time, aim the line at whoever just talked, by name."""
        target = self._last_other_speaker(name)
        if target and random.random() < ROAST_RATE:
            return (f"{base} Roast {target} by name for what he just said or did. "
                    f"It's love, so keep it clever, not mean.")
        return f"{base} Say what you'd say next."

    def banter(self, n: int = 3, first: str = None) -> list:
        """n companions react in turn; later speakers see (and can roast) earlier ones."""
        pool = [m for m in self.members if m != self.last_speaker and m != first]
        order = ([first] if first else []) + random.sample(pool, k=min(n - (1 if first else 0), len(pool)))
        said = [(name, self.say(name, self.roast_nudge(name))) for name in order]
        return [(n, l) for n, l in said if l]

    def debate(self, question: str, calm: str, wild: str) -> dict:
        """The eternal argument. Everyone pitches and votes; majority wins; a loser gets the last word."""
        self.log.append(f"EVENT: decision time - {question} CALM option: {calm}. WILD option: {wild}.")
        votes = {}
        order = sorted(self.members.values(), key=lambda c: abs(c.lean), reverse=True)
        for c in order:  # strongest opinions first, swing vote last
            other_side = [m.name for m in self.members.values()
                          if m.name != c.name and (m.lean > 0) != (c.lean > 0)]
            target = random.choice(other_side) if other_side else None
            nudge = ("Make your case to the crew. "
                     + (f"Roast {target} by name while you're at it. " if target else "")
                     + "End your line with [CALM] or [WILD] to show your vote.")
            mood = None
            if abs(c.lean) < 0.4:
                # the model alone always sided with drama, so the swing vote's mood is rolled
                # and enforced; the model just has to argue it
                mood = random.choice(["CALM", "WILD"])
                side = "the calm option" if mood == "CALM" else "the wild option"
                nudge = (f"You're voting for {side} this time, but make the other camp "
                         f"sweat a little first. " + nudge)
            line = self.say(c.name, nudge)
            if not line:
                votes[c.name] = ("WILD" if c.lean > 0 else "CALM", "")
                continue
            tag = re.search(r"\[(CALM|WILD)\]", line, re.I)
            vote = mood or (tag.group(1).upper() if tag else ("WILD" if c.lean > 0 else "CALM"))
            clean = re.sub(r"\s*\[(CALM|WILD)\]\s*", " ", line, flags=re.I).strip()
            self.log[-1] = f"{c.name}: {clean}"
            self.recent[c.name][-1] = clean
            votes[c.name] = (vote, clean)

        wild_n = sum(v == "WILD" for v, _ in votes.values())
        winner = "WILD" if wild_n >= 3 else "CALM"
        choice = wild if winner == "WILD" else calm
        self.log.append(f"EVENT: the crew voted {wild_n}-{5 - wild_n}. They're going with: {choice}.")
        losers = [n for n, (v, _) in votes.items() if v != winner]
        reaction = None
        if losers:
            sore = random.choice(losers)
            line = self.say(sore, "You lost the vote. React like a good-natured sore loser.")
            reaction = (sore, line) if line else None
        return {"winner": winner, "choice": choice, "votes": votes, "reaction": reaction}

    def remember_moment(self, moment: str, who: list = None):
        """Promote something that happened into a crew inside joke (and personal memory)."""
        self.inside_jokes.append(moment)
        for name in (who or self.members):
            self.members[name].notes.append(moment)
        self.log.append(f"EVENT: (moment the crew will never let go) {moment}")

    def act(self, name: str, instruction: str) -> dict:
        """Ask a companion to do something; returns a spoken line and/or game tool calls."""
        c = self.members[name]
        msg = self.backend.chat(
            [{"role": "system", "content": self._system(c) +
              "\nYou can act in the game world by calling tools. Call a tool when asked to do something."},
             {"role": "user", "content": f"{self._scene()}\n\n{instruction}"}],
            tools=ACTION_TOOLS)
        calls = []
        for tc in msg.get("tool_calls") or []:
            fn = tc["function"]
            args = fn.get("arguments") or "{}"
            calls.append({"name": fn["name"], "args": json.loads(args) if isinstance(args, str) else args})
        line = self._clean(msg.get("content"), name) if msg.get("content") else None
        if line:
            self.log.append(f"{name}: {line}")
        return {"line": line, "tool_calls": calls}

    # ---- persistence (the Pi can own this file later)

    def save(self, path: str):
        state = {"members": [asdict(c) for c in self.members.values()],
                 "inside_jokes": self.inside_jokes, "log": self.log[-200:]}
        with open(path, "w") as f:
            json.dump(state, f, indent=2)

    @classmethod
    def load(cls, path: str, backend):
        with open(path) as f:
            s = json.load(f)
        crew = cls(backend, [Companion(**m) for m in s["members"]], s["inside_jokes"])
        crew.log = s.get("log", [])
        return crew

# ---------------------------------------------------------------- boxel perception
#
# Certified senses from the boxel cone laws (Rouyea & Bourgeois, "Certified Locality in
# Diffusive Simulation"). A diffusive event of mass A, diffusivity D and perception
# threshold eps can only ever be noticed inside radius R_eps = sqrt(A / (pi e eps)),
# only between a closed-form arrival and departure time, and is gone everywhere after
# T_eps = A / (4 pi D eps). So a companion only "knows" what physics delivers to him.


def _lambertw(x: float, branch: int) -> float:
    """Real Lambert W on (-1/e, 0): branch 0 (w >= -1) or -1 (w <= -1). Halley iteration."""
    if not (-1 / math.e < x < 0):
        raise ValueError("x outside (-1/e, 0)")
    if branch == -1:
        L = math.log(-x)
        w = min(L - math.log(-L), -1.0001)
    else:
        w = x if x > -0.25 else -0.5
    for _ in range(60):
        ew = math.exp(w)
        f = w * ew - x
        d = ew * (w + 1)
        if d == 0:
            break
        step = f / (d - (w + 2) * f / (2 * (w + 1)))
        w -= step
        if abs(step) < 1e-13:
            break
    return w


R2_FLOOR = 0.25     # a listener is never closer than half a cell to a point source


def _kernel(A: float, D: float, tau: float, r2: float) -> float:
    """2d heat kernel of mass A, tau seconds after release, at squared distance r2."""
    if tau <= 0:
        return 0.0
    return A / (4 * math.pi * D * tau) * math.exp(-max(r2, R2_FLOOR) / (4 * D * tau))


def certified_crossings(terms, thr: float, t_from: float, t_to: float, tol: float = 0.01):
    """Times in [t_from, t_to] where S(t) = sum of kernels crosses thr, as (t, +1 up / -1 down).

    terms: (A, D, t0, r2) for every same-kind source a listener could ever get.
    Convention: a smell is perceived iff S > thr (strict), so touching thr is not noticing it.
    Certificate: each kernel is monotone from its release to its peak (t0 + r2/4D) and after it,
    so on any piece free of those breakpoints the sum is enclosed by its terms' endpoint values.
    A piece whose enclosure clears thr provably has no crossing and is skipped (the listener
    sleeps through it); only undecided pieces are bisected, down to width tol.
    Returns (perceived at t_from, crossings in time order)."""
    terms = [(A, D, t0, max(r2, R2_FLOOR)) for A, D, t0, r2 in terms if t0 < t_to]

    def S(t):
        return sum(_kernel(A, D, t - t0, r2) for A, D, t0, r2 in terms)

    state0 = S(t_from) > thr
    if not terms:
        return state0, []
    # certified silence: after t_gone, sum_i A_i / (4 pi D_i tau_i) <= thr bounds S everywhere
    last = max(t0 for _, _, t0, _ in terms)
    bound = lambda t: sum(A / (4 * math.pi * D * (t - t0)) for A, D, t0, _ in terms)
    hi_t = last + 1.0
    while bound(hi_t) > thr:
        hi_t = last + (hi_t - last) * 2
    lo_t = last
    for _ in range(60):
        mid = (lo_t + hi_t) / 2
        lo_t, hi_t = (mid, hi_t) if bound(mid) > thr else (lo_t, mid)
    t_to = min(t_to, hi_t)
    if t_to <= t_from:
        return state0, []

    breaks = sorted({t_from, t_to} | {b for A, D, t0, r2 in terms
                                      for b in (t0, t0 + r2 / (4 * D)) if t_from < b < t_to})
    out = []
    for a, b in zip(breaks, breaks[1:]):
        stack = [(a, b, S(a), S(b))]
        while stack:
            x, y, sx, sy = stack.pop()
            lo = hi = 0.0
            for A, D, t0, r2 in terms:
                ux, uy = _kernel(A, D, x - t0, r2), _kernel(A, D, y - t0, r2)
                lo += min(ux, uy)
                hi += max(ux, uy)
            if hi <= thr or lo > thr:
                continue                                   # certified: no crossing in here
            if y - x <= tol:
                if sx <= thr < sy:
                    out.append(((x + y) / 2, +1))
                elif sx > thr >= sy:
                    out.append(((x + y) / 2, -1))
                continue
            m = (x + y) / 2
            sm = S(m)
            stack.append((m, y, sm, sy))                   # right half after the left half
            stack.append((x, m, sx, sm))
    return state0, out


@dataclass
class SenseEvent:
    kind: str           # "smoke", "spores", "blood", "rain-wet earth" ...
    pos: tuple          # world cells
    t0: float           # seconds
    A: float            # total excess (state units x cells)
    D: float            # diffusivity, cells^2 / s
    eps: float          # perception threshold for this sense
    notice: str         # how it reads when perceived

    def level(self, pos, t) -> float:
        dt = t - self.t0
        if dt <= 0:
            return 0.0
        r2 = (pos[0] - self.pos[0]) ** 2 + (pos[1] - self.pos[1]) ** 2
        return self.A / (4 * math.pi * self.D * dt) * math.exp(-r2 / (4 * self.D * dt))

    @property
    def radius(self) -> float:          # R_eps; footprint pi R^2 = A / (e eps)
        return math.sqrt(self.A / (math.pi * math.e * self.eps))

    @property
    def gone_at(self) -> float:         # T_eps: after this, nothing anywhere exceeds eps
        return self.t0 + self.A / (4 * math.pi * self.D * self.eps)

    def window(self, pos, thr: float = None):
        """(arrival, departure) of level >= thr (default eps) at pos, or None if it never gets there."""
        thr = thr or self.eps
        r = math.dist(pos, self.pos)
        if r < 1e-9:
            return (self.t0, self.t0 + self.A / (4 * math.pi * self.D * thr))
        if r >= math.sqrt(self.A / (math.pi * math.e * thr)):
            return None
        x = -math.pi * r * r * thr / self.A
        s_early, s_late = -_lambertw(x, -1), -_lambertw(x, 0)
        return (self.t0 + r * r / (4 * self.D * s_early), self.t0 + r * r / (4 * self.D * s_late))


class Senses:
    """All smells in the world. Same-kind sources ADD (diffusion is linear): two fires' smoke
    is one smell, and two faint sources can be noticeable together when neither is alone.
    Convention everywhere: perceived iff summed level > eps (strict)."""

    PRUNE = 1e-3    # drop a source once its bound A/(4 pi D tau) is under 0.1% of eps

    def __init__(self):
        self.events = []
        self.kinds = {}             # kind -> (eps, notice)

    def add(self, ev: SenseEvent):
        eps, _ = self.kinds.setdefault(ev.kind, (ev.eps, ev.notice))
        if ev.eps != eps:
            raise ValueError(f"every '{ev.kind}' source must share one threshold ({eps})")
        self.events.append(ev)

    def active(self, kind: str, t: float) -> list:
        eps = self.kinds[kind][0]
        return [e for e in self.events if e.kind == kind and
                (t <= e.t0 or e.A / (4 * math.pi * e.D * (t - e.t0)) > eps * self.PRUNE)]

    def level(self, kind: str, pos, t) -> float:
        return sum(e.level(pos, t) for e in self.active(kind, t))

    def perceive(self, pos, t) -> list:
        out = []
        for kind, (eps, notice) in self.kinds.items():
            ratio = self.level(kind, pos, t) / eps
            if ratio > 1:
                strength = "strong" if ratio > 8 else "clear" if ratio > 2 else "faint"
                out.append(f"a {strength} smell of {notice}")
        return out


class SensingCrew(Crew):
    """A crew where each companion has a position and only senses what reaches him."""

    def __init__(self, backend, positions, senses, **kw):
        super().__init__(backend, **kw)
        self.positions = positions
        self.senses = senses
        self.now = 0.0
        self.away = set()           # companions out of earshot: their lines stay private

    def notice(self, name: str, changed: str = None) -> str:
        felt = self.senses.perceive(self.positions[name], self.now)
        where = "with the crew" if name not in self.away else "off on your own, out of earshot"
        if felt:
            what = "Right now you can sense: " + "; ".join(felt) + "."
        else:
            what = "Right now you sense nothing unusual in the air."
        if changed:
            what += f" What just changed for you: {changed}."
        nudge = (f"You are {where}. {what} Only react to what you can actually sense or hear; "
                 f"you don't know about anything else. Say one line, in character.")
        if name not in self.away:
            nudge = self.roast_nudge(name, base=nudge)
        else:
            nudge += " Nobody can hear you, so mutter to yourself; don't address anyone."
        line = self.say(name, nudge)
        if name in self.away and line:
            self.log.pop()          # nobody back at camp heard that
        return line


class SpeechWheel:
    """Companions sleep like boxel cells: no model calls until a certified sense window
    opens, an event turns strong, or it fades. Wake times come straight from the cone
    laws, filed in a timing wheel, so call count scales with what happens, not with time."""

    STRONG = 8.0    # level/eps ratio that counts as "strong"

    def __init__(self, crew: SensingCrew, cooldown: float = 20.0, quiet_gap: float = 150.0,
                 reply_delay: float = 4.0):
        self.crew = crew
        self.cooldown = cooldown            # a companion won't speak twice inside this
        self.quiet_gap = quiet_gap          # dead air this long -> ambient banter at camp
        self.reply_delay = reply_delay
        self.heap = []
        self.seq = 0
        self.last_spoke = {}
        self.last_any = 0.0
        self.calls = 0
        self.skipped = 0
        self.reply_block_until = -math.inf
        self.rev = {}               # (companion, kind) -> current revision of his wake times
        self.recomputes = 0
        self.pruned = 0

    def _push(self, t, name, reason, key=None, rev=None):
        heapq.heappush(self.heap, (t, self.seq, name, reason, key, rev))
        self.seq += 1

    REASONS = {(1, +1): "you just started to notice {n}", (8, +1): "{n} is getting strong",
               (8, -1): "{n} is easing off", (1, -1): "{n} just faded away"}

    # Locality cutoff: ignore a source wherever its own peak is under NEAR * eps.
    # 0 = exact (default). Measured against the brute-force referee (40 companions, 48 sources),
    # NEAR=0.02 already misses ~1% of transitions outright and shifts ~10% by >0.03s, because
    # the 1/r^2 diffusion tail is fat: many faint far sources really do add up. Only turn this
    # on for huge casts; the principled fix there is a bounded far-field sum (fast Gauss transform).
    NEAR = 0.0
    CELL = 64.0     # spatial hash cell size, world cells

    def _cells(self, pos, radius):
        c = self.CELL
        x0, x1 = int((pos[0] - radius) // c), int((pos[0] + radius) // c)
        y0, y1 = int((pos[1] - radius) // c), int((pos[1] + radius) // c)
        return [(i, j) for i in range(x0, x1 + 1) for j in range(y0, y1 + 1)]

    def _index_companions(self):
        if getattr(self, "_comp_grid", None) is None:
            self._comp_grid = {}
            for name, p in self.crew.positions.items():
                self._comp_grid.setdefault((int(p[0] // self.CELL), int(p[1] // self.CELL)), []).append(name)
        return self._comp_grid

    def watch(self, ev: SenseEvent, tol: float = 0.01):
        """Register a world event. For every companion whose perception of that smell could
        change, recompute certified crossings of the SUMMED field from now on and file them
        as a new revision; wake times filed under older revisions are discarded on pop.

        Locality: a source of mass A peaks at A / (pi e r^2), so beyond its reach
        sqrt(A / (pi e NEAR eps)) it never exceeds NEAR * eps anywhere, ever. Only companions
        inside the new source's reach are rechecked, and each recheck only sums sources whose
        reach covers him. Companions who moved need a recheck too (call watch-style refresh)."""
        senses = self.crew.senses
        senses.add(ev)
        now = max(self.crew.now, 0.0)
        eps, notice = senses.kinds[ev.kind]
        if self.NEAR <= 0:                      # exact: every companion, every live same-kind source
            live = senses.active(ev.kind, now)
            for name, pos in self.crew.positions.items():
                terms = [(e.A, e.D, e.t0, (pos[0] - e.pos[0]) ** 2 + (pos[1] - e.pos[1]) ** 2)
                         for e in live]
                self._refresh(name, ev.kind, terms, eps, notice, now, tol)
            return
        reach = lambda e: math.sqrt(e.A / (math.pi * math.e * self.NEAR * eps))
        grids = self.__dict__.setdefault("_ev_grid", {})
        grid = grids.setdefault(ev.kind, {})
        max_reach = self.__dict__.setdefault("_max_reach", {})
        max_reach[ev.kind] = max(max_reach.get(ev.kind, 0.0), reach(ev))
        grid.setdefault((int(ev.pos[0] // self.CELL), int(ev.pos[1] // self.CELL)), []).append(ev)
        comp_grid = self._index_companions()
        r_new = reach(ev)
        cand = [n for cell in self._cells(ev.pos, r_new) for n in comp_grid.get(cell, [])]
        prune_cut = eps * Senses.PRUNE
        for name in cand:
            pos = self.crew.positions[name]
            if math.dist(pos, ev.pos) > r_new:
                continue
            terms = []
            for cell in self._cells(pos, max_reach[ev.kind]):
                for e in grid.get(cell, []):
                    r2 = (pos[0] - e.pos[0]) ** 2 + (pos[1] - e.pos[1]) ** 2
                    if r2 > reach(e) ** 2:
                        continue                # this source never gets near 2% of eps here
                    if now > e.t0 and e.A / (4 * math.pi * e.D * (now - e.t0)) <= prune_cut:
                        continue                # long dead
                    terms.append((e.A, e.D, e.t0, r2))
            self._refresh(name, ev.kind, terms, eps, notice, now, tol)

    def _refresh(self, name, kind, terms, eps, notice, now, tol):
        """File a new revision of one companion's wake times for one smell."""
        # each source peaks at A / (pi e r^2) at his spot; if even the sum of every peak
        # can't beat eps, the summed field provably never does (one source: the cone test)
        if sum(A / (math.pi * math.e * max(r2, R2_FLOOR)) for A, _, _, r2 in terms) <= eps:
            self.pruned += 1
            return
        key = (name, kind)
        self.rev[key] = self.rev.get(key, 0) + 1
        self.recomputes += 1
        for mult in (1, int(self.STRONG)):
            _, xs = certified_crossings(terms, eps * mult, now, math.inf, tol)
            for t, d in xs:
                self._push(t, name, self.REASONS[(mult, d)].format(n=notice), key, self.rev[key])

    def _camp(self, exclude=None):
        return [n for n in self.crew.positions if n not in self.crew.away and n != exclude]

    def run(self, t_end: float, on_line):
        """Advance game time to t_end, calling the model only at wake times."""
        while True:
            next_t = self.heap[0][0] if self.heap else math.inf
            quiet_t = self.last_any + self.quiet_gap
            if min(next_t, quiet_t) > t_end:
                break
            if quiet_t < next_t:            # dead air: two guys at camp shoot the breeze
                self.crew.now = quiet_t
                camp = self._camp()
                if len(camp) >= 2:
                    a, b = random.sample(camp, 2)
                    for who in (a, b):
                        line = self.crew.say(who, self.crew.roast_nudge(
                            who, base="It's been quiet at camp for a while."))
                        self.calls += 1
                        on_line(quiet_t, who, "quiet stretch", line)
                        self.last_spoke[who] = quiet_t
                self.last_any = quiet_t
                continue

            t, _, name, reason, key, rev = heapq.heappop(self.heap)
            if key is not None and self.rev.get(key) != rev:
                continue                    # superseded by a newer revision of the field
            self.crew.now = t
            if reason != "reply" and "started to notice" not in reason and \
                    t - self.last_spoke.get(name, -math.inf) < self.cooldown:
                self.skipped += 1           # just talked: he sleeps through a minor update
                continue
            if reason == "reply":
                line = self.crew.say(name, self.crew.roast_nudge(name))
            else:
                line = self.crew.notice(name, changed=reason)
            self.calls += 1
            self.last_spoke[name] = self.last_any = t
            on_line(t, name, reason, line)
            if reason != "reply" and name not in self.crew.away and t >= self.reply_block_until:
                others = self._camp(exclude=name)
                if others:                  # someone at camp answers (replies never chain)
                    self._push(t + self.reply_delay, random.choice(others), "reply")
                    self.reply_block_until = t + self.cooldown / 2   # one reply per moment

# ---------------------------------------------------------------- demo


def demo(backend):
    crew = Crew(backend)
    t0 = time.time()

    def show(title, lines):
        print(f"\n--- {title}")
        for name, line in lines:
            print(f"{name:7s} {line}")

    crew.event("the crew climbs out of a collapsed ravine at golden hour. "
               "below them, a valley of floating block-islands is lit orange by the sunset.")
    show("out of the ravine", crew.banter(n=3))

    result = crew.debate(
        "the trail splits.",
        calm="a quiet overlook where you can sit and watch the islands drift into the sunset",
        wild="a cave mouth with something growling inside and a trail of glowing cubes leading in")
    print("\n--- the debate")
    for name, (vote, line) in result["votes"].items():
        print(f"{name:7s} [{vote}] {line}")
    print(f"\n>> {result['choice']}")
    if result["reaction"]:
        print(f"{result['reaction'][0]:7s} {result['reaction'][1]}")

    crew.event("Grant slips on a single loose block, windmills his arms, and barely catches himself. "
               "nobody else even tripped.")
    crew.remember_moment("Grant almost died to one (1) block")
    show("grant vs one block", crew.banter(n=3, first="Taylor"))

    crew.event("night falls. the crew builds a campfire. the floating islands glow faintly overhead.")
    show("campfire", crew.banter(n=4))

    print("\n--- action test: 'Corey, follow Blaize and stay close.'")
    print(crew.act("Corey", "Corey, follow Blaize and stay close."))

    crew.save("crew_state.json")
    print(f"\n[{backend.last_source}] done in {time.time() - t0:.1f}s, state saved to crew_state.json")


def demo_senses(backend):
    """Camp smoke vs cave spores: each companion only reacts to what physically reaches him."""
    positions = {"Taylor": (2, 1), "Corey": (14, 6), "Trey": (30, 0),
                 "Blaize": (40, -18), "Grant": (55, -8)}
    senses = Senses()
    senses.add(SenseEvent("smoke", (0, 0), 0, A=900, D=2.0, eps=0.05, notice="woodsmoke from the campfire"))
    senses.add(SenseEvent("spores", (56, -6), 10, A=400, D=3.0, eps=0.05,
                          notice="something sweet and metallic, like the glowing cubes"))
    crew = SensingCrew(backend, positions, senses)
    crew.away = {"Grant", "Blaize"}
    crew.event("the crew splits up at dusk: Taylor, Corey and Trey stay near the new campfire; "
               "Grant and Blaize wander off toward the cave to 'just look'.")

    print("\n--- certified sense windows (seconds)")
    for e in senses.events:
        print(f"{e.kind}: radius {e.radius:.1f} cells, gone everywhere at t={e.gone_at:.0f}s")
        for n, p in positions.items():
            w = e.window(p)
            print(f"   {n:7s} r={math.dist(p, e.pos):5.1f}  " +
                  (f"senses it t={w[0]:.0f}s -> {w[1]:.0f}s" if w else "never (outside the cone)"))

    for t in (30, 240):
        crew.now = t
        print(f"\n--- t = {t}s")
        for n in ["Taylor", "Corey", "Trey", "Blaize", "Grant"]:
            felt = senses.perceive(positions[n], t)
            line = crew.notice(n)
            print(f"{n:7s} senses {felt or 'nothing'}\n        {line}")


def demo_wheel(backend, t_end: float = 600, poll_every: float = 10):
    """Ten minutes of game time at camp. Companions only wake when physics says so."""
    positions = {"Taylor": (2, 1), "Corey": (14, 6), "Trey": (30, 0),
                 "Blaize": (40, -18), "Grant": (55, -8)}
    crew = SensingCrew(backend, positions, Senses())
    crew.away = {"Grant", "Blaize"}
    crew.event("dusk. Taylor, Corey and Trey are setting up camp and lighting a fire. "
               "Grant and Blaize wandered off toward the cave to 'just look'.")
    wheel = SpeechWheel(crew)
    wheel.watch(SenseEvent("smoke", (0, 0), 0, A=900, D=2.0, eps=0.05, notice="woodsmoke"))
    # Trey lights a small smudge fire up the trail to mark the way back. Grant is outside the
    # campfire's cone AND outside the smudge fire's cone, but the two smokes add up at his spot.
    smudge = SenseEvent("smoke", (34, 0), 323, A=150, D=2.0, eps=0.05, notice="woodsmoke")
    wheel.watch(smudge)
    wheel.watch(SenseEvent("spores", (56, -6), 10, A=400, D=3.0, eps=0.05,
                           notice="something sweet and metallic, like the glowing cubes"))
    wheel.watch(SenseEvent("storm", (20, 120), 200, A=40000, D=12.0, eps=0.05,
                           notice="rain on hot stone, a storm front rolling in"))

    t0 = time.time()

    def on_line(t, name, reason, line):
        tag = " (alone)" if name in crew.away else ""
        if "started to notice" in reason:
            kind = next(k for k, (_, n) in crew.senses.kinds.items() if n in reason)
            solo = [e for e in crew.senses.events if e.kind == kind and
                    (w := e.window(positions[name])) and w[0] - 1 <= t <= w[1]]
            if not solo:
                tag += " [only because two sources add up]"
        print(f"[t={t:5.0f}s] {name}{tag} <- {reason}\n           {line}")

    print(f"\n--- {t_end:.0f}s of game time, companions asleep until a wake time fires")
    wheel.run(t_end, on_line)
    polls = len(positions) * int(t_end / poll_every)
    print(f"\nmodel calls: {wheel.calls} (slept through {wheel.skipped} minor updates)")
    print(f"naive polling, everyone every {poll_every:.0f}s: {polls} calls "
          f"-> {polls / max(wheel.calls, 1):.0f}x more")
    print(f"real time {time.time() - t0:.1f}s via [{backend.last_source}]")


if __name__ == "__main__":
    b = MockBackend() if "--mock" in sys.argv else Backend()
    if "--senses" in sys.argv:
        demo_senses(b)
    elif "--wheel" in sys.argv:
        demo_wheel(b)
    else:
        demo(b)
