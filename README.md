# Rawah

An open-world hiking, camping and climbing game set in the real Rawah Wilderness
in Colorado's Medicine Bow Mountains. The terrain is a 14.8 × 14.8 km slice of
the actual crest, built from USGS 3DEP elevation data: the Laramie River valley,
the cirque lakes, and Clark Peak (12,957 ft in the data).

No build step and no runtime CDN. It runs on static Three.js (r160, vendored).

## Run

```bash
cd rawah
python3 devserver.py        # no-cache static server on http://localhost:5179
```

Any static server works. ES modules need HTTP, not `file://`.

## Play

| Key | Action |
| --- | --- |
| W A S D | Walk. Uphill is slower; you can't walk up past about 46° |
| Shift | Hike fast (uses stamina) |
| Space | Hop. While climbing, lunge up (uses grip) |
| E | Grab a rock face too steep to walk, or let go |
| C | Pitch the tent (flat ground, 200 ft from lakes, off the trail) or pack it up |
| F | Light a campfire at camp (below treeline only), or put it out |
| Z | Sleep at the tent until morning. Hold it elsewhere to sit and rest |
| L | Headlamp |
| M / Tab | Map |
| Esc | Pause, journal and settings |

What you're up against:

- **Stamina** drains when you hike fast or go steeply uphill, and comes back more slowly in thin air.
- **Warmth** follows the air temperature, which drops with elevation and at night. Swimming in snowmelt lakes makes it worse. Fires, the tent and moving around all help.
- **Grip** only matters while climbing. Ledges let you rest. If you run out, you fall.
- **Falls** over about 6 m hurt your ankle. Over about 17 m you wake up back at camp, or at the car.

To finish the journal, find all 20 lakes and stand on Clark Peak. The game saves to `localStorage` every 10 seconds and every time you sleep.

## How the world is made

`tools/bake_world.py` writes everything in `data/`:

- `dem.bin` is a 2048² uint16 heightfield (zoom-14 Terrarium tiles, about 7.25 m per cell). Each value is `(metres - 1000) * 16`.
- `far.bin` is a 512² zoom-11 heightfield, about 60 km across, used for the horizon ring.
- `world.json` holds the grid metadata, lakes, trails and places.

**Lakes** are found as exactly-flat water surfaces, because 3DEP is hydro-flattened. Each one gets a carved bed so the water renders.

**Trails** are least-cost paths with a grade penalty, starting from a road traced along the valley floor. That makes them switchback the way built trails do. They are *not* the surveyed Forest Service trails.

**Names** are only given where we're sure of them: Clark Peak and Chambers Lake. Every other lake is labelled by its elevation for now. Add real names to `NAMED_LAKES` in the bake script, then re-bake.

To regenerate:

```bash
cd rawah/tools
pip install numpy pillow scipy
python3 bake_world.py         # downloads tiles into tools/.cache/, about a minute
```

At runtime, ground cover comes from `World.cover()` and depends on elevation, slope, aspect and noise. That covers the spruce-fir forest, lodgepole lower down, gold aspen groves (it's late September in-game), krummholz at treeline, tundra, granite, willows in the valley and late-season snowfields. The same function drives both the per-pixel colour map and where trees grow.

## Code map

| File | What it does |
| --- | --- |
| `src/main.js` | Boot, game loop, actions, saving, and local-only dev hooks (`window.__rawah`) |
| `src/world.js` | Heightfield sampling, ecology, the colour map, and trail lookups |
| `src/terrain.js` | 128-cell chunks with distance LOD and skirts, the far horizon mesh, and the terrain shader |
| `src/flora.js` | Streamed instanced trees and boulders with three LOD tiers, plus tree and boulder collision |
| `src/features.js` | Lakes, trail ribbons, cairns, signs, and the car |
| `src/sky.js` | Real sun ephemeris, moon, stars, Milky Way, lights and fog |
| `src/hiker.js` | Movement, sliding, swimming, climbing, and the stamina, warmth and grip meters |
| `src/camp.js` | Tent, fire, and Leave No Trace rules |
| `src/audio.js` | Synthesized wind, footsteps, fire, chickadees and elk bugles |
| `src/hud.js` | Compass, location card, meters, toasts and the map |

## Credits

Terrain comes from the [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) dataset (Mapzen / AWS Open Data). In the US those tiles come from USGS 3DEP. Three.js is MIT-licensed; see `vendor/three/LICENSE`.
