# Blaize's crew module, as received

`rawah_companions.py` (the module), `referee.py` and `referee_wheel.py` (graders) and `live_transcripts.txt` (raw model output
from his runs, nemotron-3.5-bolt-e4b) are Blaize's originals, kept unchanged for reference. The game uses a JavaScript port:
`src/crew.js` (senses, speech wheel, voices, prompts), `src/crewtalk.js` (model backends, stock lines, the game glue) and
`tools/crew_referee.mjs` (his referee, run on the port).

    python3 tools/crew/referee.py 300     # his referee on his Python (needs numpy)
    node tools/crew_referee.mjs 300       # the same grading on src/crew.js

Both report v2 (the summed-field certified scheduler) and the live wheel at 0 missed and 0 spurious transitions against
brute force, where treating sources one at a time (v1) misses over half.
