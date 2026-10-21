# Rawah

An open-world hiking, camping and climbing game set in the real Rawah Wilderness
in Colorado's Medicine Bow Mountains: a 14.8 × 14.8 km slice of the crest built
from lidar, satellite imagery and OpenStreetMap. Start at the West Branch
Trailhead and hike the real West Branch and Rawah trails to Twin Crater Lakes,
the Rawah Lakes, Island Lake, Camp Lakes and McIntyre Lake. Summit North Rawah,
South Rawah or Clark Peak, and walk through the 2020 Cameron Peak Fire scar
along the Laramie River.

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

To finish the journal, visit every named lake and stand on every named summit. The game saves to `localStorage` every 10 seconds and every time you sleep.

## How the world is made

Everything is real public data, resampled onto one 4096² grid (3.6 m cells) by `tools/bake_world.py`:

| Layer | Source |
| --- | --- |
| Elevation | USGS 3DEP **1 m lidar** (Arapaho-Roosevelt NF 2023, Northwest Colorado 2020 and neighbouring flights), filled with 10 m 3DEP Terrarium tiles where no lidar exists |
| Ground colour | **Sentinel-2** true colour from **28 Sep 2023**, a cloud-free day at peak aspen. The baked-in terrain shading is mostly divided out so the game's sun does the lighting |
| Vegetation | Classified from the same scene: NDVI picks out live spruce-fir and lodgepole, the burn ratio (NBR) finds the **2020 Cameron Peak Fire** scar (standing snags and downed logs), the red/green ratio finds gold aspen, and low NDVI on bright ground marks talus |
| Trails, roads, lakes, streams, peaks, names | **Overture Maps** (OpenStreetMap). This includes the West Branch, Rawah, Twin Crater Lakes, Camp Lake, McIntyre, Link and Blue Lake trails, the Rawah Lakes, Island Lake and Twin Crater Lakes, the West Branch Laramie River, Rawah Creek, and North Rawah, South Rawah and Clark peaks |

The bake also adjusts the terrain to fit the vector data:

- **Streams** are snapped to the lowest ground in their lidar channel and forced to flow only downhill. The bed is carved so the water sits inside its banks.
- **Lakes** take their shoreline from OpenStreetMap and grow over the lidar's flattened water surface.
- **Roads** are graded flat across and smoothed along their length.

Outputs in `data/`: `dem.bin.gz`, `cover.bin.gz`, `color.jpg`, `far.bin`, `far.jpg` and `world.json`. Heights are uint16 `(m - 1000) * 16`. The browser streams the gzip files through `DecompressionStream`.

To regenerate:

```bash
cd rawah/tools
pip install numpy pillow scipy pyproj rasterio shapely pyarrow
python3 bake_world.py         # ~10 min cold; downloads cache in tools/.cache/
```

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

- **Elevation:** USGS 3D Elevation Program (public domain), plus [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen / AWS Open Data).
- **Imagery:** contains modified Copernicus Sentinel data (2023).
- **Trails, roads, water and names:** © OpenStreetMap contributors, distributed via Overture Maps under the ODbL.
- **Three.js:** MIT; see `vendor/three/LICENSE`.
