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
| W A S D | Walk at about 2.5 m/s. Uphill, backwards and sideways are slower, and you can't walk up past about 46° |
| Shift | Hike fast at about 4.5 m/s (uses stamina) |
| Space | Hop. While climbing, lunge up (uses grip) |
| E | Grab a rock face too steep to walk, or let go |
| C | Pitch the tent (flat ground, 200 ft from lakes, off the trail) or pack it up |
| F | Light a campfire at camp (below treeline only), or put it out |
| Z | Sleep at the tent until morning. Hold it elsewhere to sit and rest |
| L | Headlamp |
| V | Switch between first and third person (scroll to zoom in third) |
| M / Tab | Map |
| Esc | Pause, journal and settings |

A gamepad works too. The sticks walk and look, and walking speed follows how far you push the stick. A hops, B grabs rock, X pitches the tent, Y switches camera, RB lights a fire, LB toggles the headlamp, LT rests, RT or L3 hikes fast, Back opens the map, and Start pauses.

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

Outputs in `data/`: `dem.png`, `cover.png`, `far.png`, `color.jpg`, `far.jpg` and `world.json`. Heights are uint16 `(m - 1000) * 16`, delta-coded. The binary layers ship as lossless RGB PNGs so any static host serves them; the loader decodes them without color conversion and reads the bytes back exactly (`tools/pack_png.py`).

To regenerate:

```bash
cd rawah/tools
pip install numpy pillow scipy pyproj rasterio shapely pyarrow
python3 bake_world.py         # ~10 min cold; downloads cache in tools/.cache/
```

## Rendering

- **Terrain** uses continuous LOD (CDLOD). Each frame a quadtree over the map picks nodes, and every node is the same 32×32 grid. The vertex shader reads heights straight from a 16-bit lidar texture, adds seeded fractal micro-relief, and morphs vertices between levels so nothing pops. The relief is rougher on rock, gentler in meadows, and switched off on trails, streams and lakeshores. Up close the vertex spacing is about 0.9 m, finer than the lidar. Normals are computed per pixel. The CPU never rebuilds terrain geometry. The relief function exists in both JS and GLSL (`src/detail.js`), so what you stand on matches what you see.
- **Trees** are built at startup:
  - needle sprays, pine tufts, aspen leaves and bark are painted into a texture atlas;
  - spruce, fir, lodgepole, aspen, snags, krummholz and willow are built from those as branch whorls of drooping sprays;
  - each tree is rendered once into an impostor atlas.

  Within about 85 m you see the real card trees, which sway in the wind and cast leafy shadows. Beyond that they're crossed-quad impostors out to 1.25 km. The whole forest is about 20 draw calls.
- **Camera** has two modes. First person rides a spring over the ground, and the head motion follows the stride: a dip at each footfall, sway from foot to foot, roll into strafes, a lean and wider FOV at speed, a dip when you land, and breathing. Third person is a shoulder-offset orbit that pulls in to stay out of the hillside, following a placeholder hiker. In first person that hiker still casts your shadow.

## Code map

| File | What it does |
| --- | --- |
| `src/main.js` | Boot, game loop, actions, saving, and local-only dev hooks (`window.__rawah`) |
| `src/world.js` | Heightfield and relief sampling, the smoothing mask, land cover, and trail and stream lookups |
| `src/cdlod.js` | Quadtree LOD terrain on the GPU |
| `src/detail.js` | Fractal micro-relief, in matching JS and GLSL |
| `src/terrain.js` | Texture helpers, the shared albedo shader, and the far horizon mesh |
| `src/trees.js` | Painted foliage atlas, procedural tree meshes, impostor baking, and wind |
| `src/flora.js` | Placement tiles from satellite land cover, per-instance LOD refills, and collision |
| `src/features.js` | Lakes, streams, trail ribbons, cairns, signs, and the car |
| `src/sky.js` | Real sun ephemeris, moon, stars, Milky Way, lights and fog |
| `src/hiker.js` | Movement, stride phase, sliding, swimming, climbing, and the stamina, warmth and grip meters |
| `src/camera.js` | First- and third-person camera rig |
| `src/avatar.js` | Placeholder hiker body with procedural walk, climb and swim poses |
| `src/input.js` | Keyboard, mouse and gamepad |
| `src/camp.js` | Tent, fire, and Leave No Trace rules |
| `src/audio.js` | Synthesized wind, footsteps, creeks, fire, chickadees and elk bugles |
| `src/hud.js` | Compass, location card, meters, toasts and the map |

## Credits

- **Elevation:** USGS 3D Elevation Program (public domain), plus [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Mapzen / AWS Open Data).
- **Imagery:** contains modified Copernicus Sentinel data (2023).
- **Trails, roads, water and names:** © OpenStreetMap contributors, distributed via Overture Maps under the ODbL.
- **Three.js:** MIT; see `vendor/three/LICENSE`.
