# Blaize's crew module, as received

`rawah_companions.py` (the module), `referee.py` and `referee_wheel.py` (graders) and `live_transcripts.txt` (raw model output
from his runs, nemotron-3.5-bolt-e4b) are Blaize's originals, kept unchanged for reference. The game uses a JavaScript port:
`src/crew.js` (senses, speech wheel, voices, prompts), `src/crewtalk.js` (model backends, stock lines, the game glue) and
`tools/crew_referee.mjs` (his referee, run on the port).

    python3 tools/crew/referee.py 300     # his referee on his Python (needs numpy)
    node tools/crew_referee.mjs 300       # the same grading on src/crew.js

Both report v2 (the summed-field certified scheduler) and the live wheel at 0 missed and 0 spurious transitions against
brute force, where treating sources one at a time (v1) misses over half.

## Direct conversations

Face a companion within roughly three metres and press U (controller Y / touch Ride).
The chat panel pauses play, Enter sends, and Escape or Back to the trail releases the companion.
Each companion keeps up to 16 messages for the current page session; reload starts fresh.
Direct chat works independently of the ambient chatter toggle. Failed requests are shown explicitly,
not replaced with scripted dialogue. Closing cancels the browser request; an upstream inference already
started may still finish. No microphone or speech synthesis is used.

`src/crew-chat.js` owns the panel; `src/crew-dialogue.js` shares the personality prompt between local
and hosted inference. Local development uses the existing model backend. Production POSTs to
`api/crew.mjs`, which requires the encrypted Vercel production variable `NVIDIA_API_KEY` and optionally
`RAWAH_CREW_MODEL` (default `nvidia/nemotron-3.5-bolt-e4b`). Never put the key in source or public settings.
The endpoint fixes the upstream URL, bounds messages and response tokens, and applies a best-effort
per-instance burst limit; it is not a durable global quota or authentication system.

Checks: `node tools/tests/crew-api.mjs`, changed-file syntax checks, and browser checks for U/open,
typing isolation, send, failure/retry, close, and separate histories. A simulated provider checks plumbing;
a real deployment response is required to verify live model availability and personality.
