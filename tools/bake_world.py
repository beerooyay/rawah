#!/usr/bin/env python3
"""Bake the Rawah world from real elevation data.

Downloads Terrarium elevation tiles (Mapzen terrain tiles on AWS Open Data,
which for this region come from USGS 3DEP), stitches a 2048x2048 window at
zoom 14 (~7.25 m per sample) over the Rawah Wilderness crest, and writes:

  data/dem.bin     uint16 heights, (metres - H_OFFSET) * H_SCALE, row-major, north row first
  data/far.bin     uint16 heights for a ~60 km horizon ring at zoom 11, same encoding
  data/world.json  grid metadata, lakes (water level + row runs), trails, places

Lakes are found as exactly-flat water surfaces (3DEP is hydro-flattened) and
get a carved bed so water renders above the terrain. Trails are not taken from
a map: they are least-cost paths with a grade penalty, which is roughly how
trail crews lay out switchbacks, so they land in believable places.

Usage (from rawah/tools):  python3 bake_world.py
Needs numpy, pillow and scipy. Downloaded tiles are cached in tools/.cache/.
"""
import heapq
import json
import math
import os
import urllib.request

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')
OUT = os.path.join(HERE, '..', 'data')
TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'

Z, X0, Y0, NT = 14, 3368, 6160, 8          # 8x8 tiles -> 2048 px
N = NT * 256
H_OFFSET, H_SCALE = 1000.0, 16.0           # 1/16 m precision, covers 1000..5095 m

FAR_Z, FAR_N = 11, 512                     # far ring: 512 px crop, resampled from zoom 11


def tile(z, x, y):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f'{z}_{x}_{y}.png')
    if not os.path.exists(path):
        urllib.request.urlretrieve(TILE_URL.format(z=z, x=x, y=y), path)
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def mosaic(z, x0, y0, nx, ny):
    return np.vstack([np.hstack([tile(z, x, y) for x in range(x0, x0 + nx)]) for y in range(y0, y0 + ny)])


def lat_of(py_global, z):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py_global / (2 ** z * 256)))))


def lon_of(px_global, z):
    return px_global / (2 ** z * 256) * 360 - 180


# ---------------------------------------------------------------- base grid
H = mosaic(Z, X0, Y0, NT, NT)
lat_c = lat_of(Y0 * 256 + N / 2, Z)
CELL = 40075016.686 / (2 ** Z * 256) * math.cos(math.radians(lat_c))
print(f'grid {N}x{N}, {CELL:.3f} m/cell, {N * CELL / 1000:.2f} km, {H.min():.0f}..{H.max():.0f} m')


def to_world(r, c):
    return (c - N / 2) * CELL, (r - N / 2) * CELL


# ---------------------------------------------------------------- lakes
eq = np.ones_like(H, bool)
for dy in (-1, 0, 1):
    for dx in (-1, 0, 1):
        eq &= np.roll(np.roll(H, dy, 0), dx, 1) == H
eq[[0, -1], :] = False
eq[:, [0, -1]] = False
lab, k = ndimage.label(eq)
sizes = ndimage.sum(eq, lab, range(1, k + 1))

NAMED_LAKES = {  # only names we are sure of; the rest stay unnamed for now
    'Chambers Lake': (40.604, -105.854),
}

lakes = []
lake_mask = np.zeros_like(H, bool)
for i, s in enumerate(sizes, 1):
    if s < 20:
        continue
    m = lab == i
    # grow over the 1-px rim the 3x3 test shaved off
    m = ndimage.binary_dilation(m) & (np.abs(H - H[m][0]) < 0.01)
    level = float(H[m][0])
    rows, cols = np.nonzero(m)
    r, c = rows.mean(), cols.mean()
    lat, lon = lat_of(Y0 * 256 + r, Z), lon_of(X0 * 256 + c, Z)
    # carve a bed: deeper away from shore, capped
    dist = ndimage.distance_transform_edt(m)
    depth = np.minimum(1.2 + dist * 1.6, 9.0 + math.sqrt(s) * 0.15)
    H[m] = level - depth[m]
    ring = ndimage.binary_dilation(m, iterations=1) & ~m
    H[ring] = np.maximum(H[ring], level + 0.25)
    lake_mask |= m
    water = ndimage.binary_dilation(m, iterations=2)
    runs = []
    for rr in np.unique(np.nonzero(water)[0]):
        cs = np.nonzero(water[rr])[0]
        start = prev = cs[0]
        for cc in cs[1:]:
            if cc != prev + 1:
                runs.append([int(rr), int(start), int(prev)])
                start = cc
            prev = cc
        runs.append([int(rr), int(start), int(prev)])
    x, z = to_world(r, c)
    lakes.append({'level': round(level, 2), 'x': round(x, 1), 'z': round(z, 1),
                  'area': round(float(m.sum()) * CELL * CELL), 'runs': runs,
                  'lat': round(lat, 5), 'lon': round(lon, 5)})
lakes.sort(key=lambda l: -l['area'])
for nm, (la, lo) in NAMED_LAKES.items():
    near = min(lakes, key=lambda l: (l['lat'] - la) ** 2 + (l['lon'] - lo) ** 2)
    if abs(near['lat'] - la) < 0.01 and abs(near['lon'] - lo) < 0.01:
        near['name'] = nm
for lake in lakes:
    lake.setdefault('name', None)
print(f'{len(lakes)} lakes')

# ---------------------------------------------------------------- trails
# least-cost routing on a half-res grid with a grade penalty that rewards switchbacks
S = 2
Hh = H[::S, ::S]
M = Hh.shape[0]
blocked = lake_mask[::S, ::S] | ndimage.binary_erosion(lake_mask, iterations=1)[::S, ::S]
cs = CELL * S
NB = [(dr, dc) for dr in range(-2, 3) for dc in range(-2, 3)
      if (dr, dc) != (0, 0) and math.gcd(abs(dr), abs(dc)) == 1]


def route(sources, target, grade_ref):
    """A* from any source cell to target. Cost per metre grows with (grade/grade_ref)^2."""
    tr, tc = target
    flat_h = Hh.ravel()
    best = {}
    prev = {}
    pq = []
    for s in sources:
        best[s] = 0.0
        heapq.heappush(pq, (math.hypot(s[0] - tr, s[1] - tc) * cs, 0.0, s))
    while pq:
        _, g, cur = heapq.heappop(pq)
        if cur == target:
            break
        if g > best.get(cur, 1e18):
            continue
        r, c = cur
        h0 = flat_h[r * M + c]
        for dr, dc in NB:
            nr, nc = r + dr, c + dc
            if nr < 1 or nc < 1 or nr >= M - 1 or nc >= M - 1 or blocked[nr, nc]:
                continue
            d = math.hypot(dr, dc) * cs
            grade = abs(flat_h[nr * M + nc] - h0) / d
            ng = g + d * (1 + (grade / grade_ref) ** 2)
            if ng < best.get((nr, nc), 1e18):
                best[(nr, nc)] = ng
                prev[(nr, nc)] = cur
                heapq.heappush(pq, (ng + math.hypot(nr - tr, nc - tc) * cs, ng, (nr, nc)))
    path = [target]
    while path[-1] in prev:
        path.append(prev[path[-1]])
    return path[::-1]


def shore_cell(lake):
    """Nearest open half-res cell to a lake's centre."""
    r0 = int(round(lake['z'] / CELL + N / 2)) // S
    c0 = int(round(lake['x'] / CELL + N / 2)) // S
    best, bd = None, 1e18
    for r in range(max(1, r0 - 40), min(M - 1, r0 + 40)):
        for c in range(max(1, c0 - 40), min(M - 1, c0 + 40)):
            if not blocked[r, c]:
                d = (r - r0) ** 2 + (c - c0) ** 2
                if d < bd:
                    best, bd = (r, c), d
    return best


def smooth(pts, iters=2):
    for _ in range(iters):
        out = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            out.append((0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]))
            out.append((0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]))
        out.append(pts[-1])
        pts = out
    return pts


def to_polyline(cells):
    pts = [to_world(r * S, c * S) for r, c in cells]
    return [[round(x, 1), round(z, 1)] for x, z in smooth(pts)]


def lake_near(r, c):
    x, z = to_world(r, c)
    return min(lakes, key=lambda l: (l['x'] - x) ** 2 + (l['z'] - z) ** 2)


trails, places = [], []

# Laramie River Road: valley floor, north edge down to above Chambers Lake
road = route([(1, 1537 // S)], (1450 // S, 1620 // S), 0.05)
trails.append({'name': 'Laramie River Road', 'kind': 'road', 'pts': to_polyline(road)})
road_set = set(road)
network = set(road)

summit = np.unravel_index(int(H.argmax()), H.shape)
sx, sz = to_world(*summit)
places.append({'name': 'Clark Peak', 'kind': 'peak', 'x': round(sx, 1), 'z': round(sz, 1),
               'elev': round(float(H[summit]), 1)})

targets = []
for lake in lakes:
    if lake['name'] == 'Chambers Lake' or lake['area'] < 6000:
        continue
    targets.append(('lake', lake))
# the biggest crest lake first, so the first trailhead is the main way in
crest = [t for t in targets if t[1]['level'] > 3100]
first = max(crest, key=lambda t: t[1]['area'])
targets.remove(first)
targets.sort(key=lambda t: (t[1]['x'] - first[1]['x']) ** 2 + (t[1]['z'] - first[1]['z']) ** 2)
targets.insert(0, first)
targets.append(('peak', places[0]))

trailheads = []
for kind, obj in targets:
    if kind == 'lake':
        tgt = shore_cell(obj)
        label = obj['name'] or f"Lake {round(obj['level'] * 3.28084):,} ft"
        grade_ref = 0.13
    else:
        tgt = (summit[0] // S, summit[1] // S)
        label = 'Clark Peak'
        grade_ref = 0.3   # a scramble route, not a built trail
    path = route(sorted(network), tgt, grade_ref)
    if len(path) < 3:
        continue
    if path[0] in road_set:
        x, z = to_world(path[0][0] * S, path[0][1] * S)
        trailheads.append((x, z))
    network.update(path)
    trails.append({'name': label, 'kind': 'route' if kind == 'peak' else 'trail',
                   'to': label, 'pts': to_polyline(path)})
    print(f'trail to {label}: {len(path)} cells')

for i, (x, z) in enumerate(trailheads):
    places.append({'name': 'Rawah Trailhead' if i == 0 else f'Trailhead {i + 1}', 'kind': 'trailhead',
                   'x': round(x, 1), 'z': round(z, 1)})
for lake in lakes:
    places.append({'name': lake['name'] or f"Lake {round(lake['level'] * 3.28084):,} ft", 'kind': 'lake',
                   'x': lake['x'], 'z': lake['z'], 'elev': lake['level']})

# ---------------------------------------------------------------- far ring
# zoom-11 mosaic centred on the play window, cropped to FAR_N px (~60 km)
cx_g = (X0 * 256 + N / 2) / 8   # global px at zoom 11
cy_g = (Y0 * 256 + N / 2) / 8
fx0 = int((cx_g - FAR_N / 2) // 256)
fy0 = int((cy_g - FAR_N / 2) // 256)
fn = FAR_N // 256 + 2
F = mosaic(FAR_Z, fx0, fy0, fn, fn)
ox, oy = int(round(cx_g - FAR_N / 2 - fx0 * 256)), int(round(cy_g - FAR_N / 2 - fy0 * 256))
F = F[oy:oy + FAR_N, ox:ox + FAR_N]
FAR_CELL = CELL * 8

# ---------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)


def enc(a):
    return np.clip(np.round((a - H_OFFSET) * H_SCALE), 0, 65535).astype('<u2').tobytes()


with open(os.path.join(OUT, 'dem.bin'), 'wb') as f:
    f.write(enc(H))
with open(os.path.join(OUT, 'far.bin'), 'wb') as f:
    f.write(enc(F))

world = {
    'source': 'Terrarium terrain tiles (Mapzen / AWS Open Data; USGS 3DEP in this region)',
    'size': N, 'cell': round(CELL, 5), 'hOffset': H_OFFSET, 'hScale': H_SCALE,
    'nw': {'lat': round(lat_of(Y0 * 256, Z), 6), 'lon': round(lon_of(X0 * 256, Z), 6)},
    'far': {'size': FAR_N, 'cell': round(FAR_CELL, 4)},
    'lakes': lakes, 'trails': trails, 'places': places,
}
with open(os.path.join(OUT, 'world.json'), 'w') as f:
    json.dump(world, f, separators=(',', ':'))
print('wrote', OUT)
