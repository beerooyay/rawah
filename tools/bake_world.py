#!/usr/bin/env python3
"""Bake the Rawah world from real public data.

Everything is resampled onto one Web Mercator grid (the zoom-14 tile window
3368..3375 x 6160..6167, ~14.8 km a side over the Rawah crest) at GRID x GRID:

  elevation   USGS 3DEP 1 m lidar (Arapaho-Roosevelt NF 2023, Northwest Colorado
              2020 and neighbouring projects, prd-tnm on AWS), filled where lidar
              is missing with Terrarium terrain tiles (Mapzen / AWS Open Data)
  imagery     Sentinel-2 L2A true colour, 2023-09-28 (sentinel-cogs on AWS),
              with a partial topographic correction so the game's own sun does
              the shading
  land cover  from the same scene: NDVI separates live conifer, aspen, meadow
              and rock; the burn is the change in NBR since a 2019-09-29
              pre-fire scene (dNBR), as burn-severity maps are made
  vectors     trails, roads, lakes, streams, peaks and names from Overture Maps
              (OpenStreetMap contributors), release OVERTURE_RELEASE

Outputs in data/:
  dem.png       uint16 heights, (metres - H_OFFSET) * H_SCALE, row-major, north first,
                2-D delta coded, bytes packed into a lossless RGB PNG (pack_png.py)
  far.png       uint16 heights for a ~60 km horizon ring at zoom 11, packed the same way
  color.jpg     terrain albedo, COLOR x COLOR
  far.jpg       horizon albedo
  cover.png     COVER x COVER x 4 bytes: live conifer, burned snags, aspen, rock (packed)
  world.json    grid metadata, lakes, streams, trails, places

Usage (from rawah/tools):  python3 bake_world.py
Needs numpy pillow scipy pyproj rasterio shapely pyarrow. Downloads cache in .cache/.
"""
import gzip
import json
import math
import os
import sys
import urllib.parse
import urllib.request

import numpy as np
import pyarrow.compute as pc
import pyarrow.dataset as pds
import pyarrow.fs as pfs
import pyarrow.parquet as pq
import rasterio
import shapely
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import Affine
from rasterio.vrt import WarpedVRT
from scipy import ndimage
from shapely import wkb
from shapely.geometry import LineString, mapping

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')
OUT = os.path.join(HERE, '..', 'data')
os.makedirs(CACHE, exist_ok=True)

Z, X0, Y0, NT = 14, 3368, 6160, 8
GRID = 4096                 # ~3.6 m cells
COLOR = 2048                # imagery texture
COVER = 1024                # land-cover raster
H_OFFSET, H_SCALE = 1000.0, 16.0
FAR_Z, FAR_N = 11, 512

TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
LIDAR = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/{p}/TIFF/USGS_1M_13_{t}_{p}.tif'
LIDAR_PROJECTS = ['CO_ArapahoRooseveltPikeNF_D23', 'CO_CameronPeakWildfire_2021_D21', 'CO_NorthwestCO_2020_D20', 'CO_DRCOG_2020_B20']
S2 = 'https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/13/T/{tile}/{y}/{m}/S2A_13T{tile}_{date}_0_L2A'
S2_DATE, S2_PREFIRE = '20230928', '20190929'   # same orbit, a year before the 2020 fire
S2_TILES = ['DF', 'DE', 'CF', 'CE']
OVERTURE_RELEASE = '2026-10-21.0'

R_EARTH = 6378137.0
MERC_WORLD = 2 * math.pi * R_EARTH
GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', AWS_NO_SIGN_REQUEST='YES', GDAL_HTTP_MAX_RETRY='4',
                GDAL_HTTP_RETRY_DELAY='2', CPL_VSIL_CURL_ALLOWED_EXTENSIONS='.tif')


def merc_transform(px0, py0, zoom, size_px, out):
    """Affine for an `out`-wide raster covering `size_px` tile pixels at `zoom` from global px (px0, py0)."""
    m_per_px = MERC_WORLD / (2 ** zoom * 256)
    x0 = px0 * m_per_px - MERC_WORLD / 2
    y0 = MERC_WORLD / 2 - py0 * m_per_px
    k = m_per_px * size_px / out
    return Affine(k, 0, x0, 0, -k, y0)


def lat_of(py_global, zoom):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * py_global / (2 ** zoom * 256)))))


def lon_of(px_global, zoom):
    return px_global / (2 ** zoom * 256) * 360 - 180


N_PX = NT * 256
lat_c = lat_of(Y0 * 256 + N_PX / 2, Z)
CELL = MERC_WORLD / (2 ** Z * 256) * math.cos(math.radians(lat_c)) * N_PX / GRID
EXTENT = CELL * GRID
DST = merc_transform(X0 * 256, Y0 * 256, Z, N_PX, GRID)
print(f'grid {GRID}^2 at {CELL:.3f} m, {EXTENT / 1000:.2f} km')


# World coordinates put grid sample (r, c) at x = c * CELL - EXTENT / 2, z = r * CELL - EXTENT / 2,
# matching the game's terrain vertices. Raster pixel centres sit half a cell in from the edge.
def to_world_rc(r, c):
    return c * CELL - EXTENT / 2, r * CELL - EXTENT / 2


to_merc = Transformer.from_crs(4326, 3857, always_xy=True)


def merc_to_world(mx, my):
    c, r = (~DST) * (mx, my)
    return (c - 0.5) * CELL - EXTENT / 2, (r - 0.5) * CELL - EXTENT / 2


def lonlat_to_world(lon, lat):
    return merc_to_world(*to_merc.transform(lon, lat))


to_geo = Transformer.from_crs(3857, 4326, always_xy=True)
lon_w, lon_e = lon_of(X0 * 256, Z), lon_of((X0 + NT) * 256, Z)
lat_n, lat_s = lat_of(Y0 * 256, Z), lat_of((Y0 + NT) * 256, Z)


def world_to_lonlat(x, z):
    mx = DST.a * ((x + EXTENT / 2) / CELL + 0.5) + DST.c
    my = DST.e * ((z + EXTENT / 2) / CELL + 0.5) + DST.f
    return to_geo.transform(mx, my)


def overture(theme, typ, cols):
    path = os.path.join(CACHE, f'overture_{OVERTURE_RELEASE}_{theme}_{typ}.parquet')
    if not os.path.exists(path):
        s3 = pfs.S3FileSystem(anonymous=True, region='us-west-2')
        d = pds.dataset(f'overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme={theme}/type={typ}/',
                        filesystem=s3, format='parquet')
        f = ((pc.field('bbox', 'xmax') >= lon_w) & (pc.field('bbox', 'xmin') <= lon_e) &
             (pc.field('bbox', 'ymax') >= lat_s) & (pc.field('bbox', 'ymin') <= lat_n))
        pq.write_table(d.to_table(columns=cols, filter=f), path)
    rows = pq.read_table(path).to_pylist()
    for r in rows:
        r['geom'] = wkb.loads(r['geometry'])
        r['name'] = (r.get('names') or {}).get('primary')
    return rows


geo_merc = lambda g: shapely.transform(g, lambda xy: np.column_stack(to_merc.transform(xy[:, 0], xy[:, 1])))


def world_line(g, step):
    """Shapely lon/lat line -> list of [x, z] world points resampled every `step` m."""
    m = geo_merc(g)
    pts = []
    n = max(2, int(m.length / (step / CELL * DST.a)) + 1)
    for i in range(n):
        p = m.interpolate(i / (n - 1), normalized=True)
        pts.append(list(merc_to_world(p.x, p.y)))
    return pts


def inside(x, z, m=0):
    return -EXTENT / 2 + m < x < EXTENT / 2 - m and -EXTENT / 2 + m < z < EXTENT / 2 - m


def clip_runs(pts, m=30):
    """Split a polyline into the runs that stay inside the world."""
    runs, cur = [], []
    for p in pts:
        if inside(p[0], p[1], m):
            cur.append(p)
        elif cur:
            runs.append(cur)
            cur = []
    if cur:
        runs.append(cur)
    return [r for r in runs if len(r) > 3]


def sample(A, x, z):
    scalar = np.ndim(x) == 0
    c = np.clip((np.atleast_1d(x) + EXTENT / 2) / CELL, 0, GRID - 1.001)
    r = np.clip((np.atleast_1d(z) + EXTENT / 2) / CELL, 0, GRID - 1.001)
    v = ndimage.map_coordinates(A, [r, c], order=1)
    return float(v[0]) if scalar else v


def cells_near(pts, radius):
    """Grid cells within `radius` m of a polyline, with the index of the nearest vertex."""
    out = {}
    rc = int(math.ceil(radius / CELL)) + 1
    for i, (x, z) in enumerate(pts):
        c0 = int(round((x + EXTENT / 2) / CELL))
        r0 = int(round((z + EXTENT / 2) / CELL))
        for r in range(max(0, r0 - rc), min(GRID, r0 + rc + 1)):
            for c in range(max(0, c0 - rc), min(GRID, c0 + rc + 1)):
                cx, cz = to_world_rc(r, c)
                d = math.hypot(cx - x, cz - z)
                if d <= radius and d < out.get((r, c), (1e9, 0))[0]:
                    out[(r, c)] = (d, i)
    return out


def merc_line(path, step=3.0):
    """Web-mercator vertex list -> [x, z] world points resampled every `step` m."""
    pts = [list(merc_to_world(x, y)) for x, y in path]
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        out += [[a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n] for i in range(1, n + 1)]
    return out


NHD = 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6/query'
NHD_CODES = set(range(46000, 46010)) | set(range(33600, 33610))  # stream/river + canal/ditch


def nhd_streams():
    """USGS NHD flowlines over the world window — surveyed channels where Overture generalises."""
    path = os.path.join(CACHE, 'nhd.json')
    if not os.path.exists(path):
        lonw, latn = world_to_lonlat(-EXTENT / 2 - 300, -EXTENT / 2 - 300)
        lone, lats = world_to_lonlat(EXTENT / 2 + 300, EXTENT / 2 + 300)
        feats, T = [], 4          # the service crawls on big envelopes — tile it
        for ty in range(T):
            for tx in range(T):
                gw = lonw + (lone - lonw) * tx / T
                ge = lonw + (lone - lonw) * (tx + 1) / T
                gs = lats + (latn - lats) * ty / T
                gn = lats + (latn - lats) * (ty + 1) / T
                off = 0
                try:
                    while True:
                        q = urllib.parse.urlencode({
                            'where': '1=1', 'geometry': f'{gw},{gs},{ge},{gn}',
                            'geometryType': 'esriGeometryEnvelope', 'inSR': 4326, 'outSR': 3857,
                            'outFields': 'gnis_name,fcode', 'returnGeometry': 'true',
                            'resultOffset': off, 'resultRecordCount': 2000, 'f': 'json'})
                        d = json.loads(urllib.request.urlopen(NHD + '?' + q, timeout=120).read())
                        got = d.get('features', [])
                        feats += got
                        if len(got) < 2000:
                            break
                        off += 2000
                except Exception as e:
                    print(f'nhd tile {tx},{ty} failed:', e)
                print(f'nhd tile {tx},{ty}: {len(feats)} feats')
        seen, uniq = set(), []
        for f in feats:  # tiles share edges — dedupe on exact geometry
            key = json.dumps(f['geometry'])
            if key not in seen:
                seen.add(key)
                uniq.append(f)
        with open(path, 'w') as f:
            json.dump(uniq, f)
    out = []
    for f in json.load(open(path)):
        a = f['attributes']
        if int(a.get('fcode') or 0) not in NHD_CODES:
            continue
        name = a.get('gnis_name')
        if name and 'tunnel' in name.lower():
            continue  # buried conduit — carving it trenches the ridge
        w = 5.0 if name and 'river' in name.lower() else 2.4 if name else 1.6
        for p in f['geometry']['paths']:
            out.append({'name': name, 'width': w, 'pts': merc_line(p)})
    return out


def overture_streams(water):
    out = []
    for s in water:
        if s['subtype'] not in ('stream', 'river', 'canal') or s['geom'].geom_type not in ('LineString', 'MultiLineString'):
            continue
        if s['name'] and 'tunnel' in s['name'].lower():
            continue  # buried conduit — carving it trenches the ridge
        w = 7.0 if s['subtype'] == 'river' else 2.4 if s['name'] else 1.6
        for g in getattr(s['geom'], 'geoms', [s['geom']]):
            out.append({'name': s['name'], 'width': w, 'pts': world_line(g, 3.0)})
    return out


def carve_streams(H, items):
    """Snap each channel to the thalweg, force the bed monotonic, carve H, emit the ribbon."""
    streams = []
    for it in items:
        for run in clip_runs(it['pts'], 5):
            xs, zs = np.array(run).T
            # snap each vertex to the lowest ground within ~6 m across the line
            snapped = []
            for i in range(len(run)):
                a, b = run[max(0, i - 1)], run[min(len(run) - 1, i + 1)]
                dx, dz = b[0] - a[0], b[1] - a[1]
                L = math.hypot(dx, dz) or 1
                nx, nz = -dz / L, dx / L
                offs = np.linspace(-6, 6, 13)
                hs = sample(H, xs[i] + nx * offs, zs[i] + nz * offs)
                o = offs[int(hs.argmin())]
                snapped.append([xs[i] + nx * o, zs[i] + nz * o])
            sm = np.array(snapped)
            for _ in range(3):  # relax the zig-zag from snapping
                sm[1:-1] = 0.25 * sm[:-2] + 0.5 * sm[1:-1] + 0.25 * sm[2:]
            hs = sample(H, sm[:, 0], sm[:, 1])
            if hs[0] < hs[-1]:
                sm, hs = sm[::-1], hs[::-1]
            surf = np.minimum.accumulate(hs)   # water only flows downhill
            for i in range(1, len(surf)):      # but the bed may climb out over a spur
                surf[i] = min(surf[i - 1] + 0.5, hs[i])
            w = it['width']
            for (r, c), (d, i) in cells_near(sm.tolist(), w / 2 + CELL).items():
                bed = surf[i] - 0.35 - 0.4 * (1 - d / (w / 2 + CELL))
                H[r, c] = max(H[r, c] - 4.0, min(H[r, c], bed))  # cut a channel, never a trench
            for i, (x, z) in enumerate(sm):
                surf[i] = min(surf[i], sample(H, x, z) + 0.04)
            streams.append({'name': it['name'], 'width': w,
                            'pts': [[round(float(x), 1), round(float(z), 1), round(float(y) - 0.12, 2)]
                                    for (x, z), y in zip(sm, surf)]})
    return streams


def grade_tracks(H, trails):
    """Flatten across and smooth along road and track beds."""
    for t in trails:
        if t['kind'] == 'trail':
            continue
        pts = np.array(t['pts'])
        prof = sample(H, pts[:, 0], pts[:, 1])
        prof = ndimage.gaussian_filter1d(prof, 6 if t['kind'] == 'road' else 3, mode='nearest')
        half = 3.4 if t['kind'] == 'road' else 2.0
        for (r, c), (d, i) in cells_near(pts.tolist(), half + CELL * 1.5).items():
            wgt = 1.0 if d <= half else 1 - (d - half) / (CELL * 1.5)
            H[r, c] += (prof[i] - H[r, c]) * wgt


def dem_decode():
    px = np.asarray(Image.open(os.path.join(OUT, 'dem.png')), np.uint8).reshape(-1)
    q = np.frombuffer(px[:GRID * GRID * 2].tobytes(), '<u2').reshape(GRID, GRID).astype(np.int64)
    return ((np.cumsum(np.cumsum(q, axis=0), axis=1) & 0xFFFF) / H_SCALE + H_OFFSET).astype(np.float32)


def dem_encode(H):
    import pack_png
    q = np.clip(np.round((H - H_OFFSET) * H_SCALE), 0, 65535).astype('<u2').reshape(GRID, GRID).astype(np.int64)
    q[:, 1:] = (q[:, 1:] - q[:, :-1]) & 0xFFFF
    q[1:, :] = (q[1:, :] - q[:-1, :]) & 0xFFFF
    pack_png.pack(q.astype('<u2').tobytes(), os.path.join(OUT, 'dem.png'))


if '--streams' in sys.argv:
    # patch pass: re-carve channels from NHD over the existing DEM, no raster re-pull
    H = dem_decode()
    world = json.load(open(os.path.join(OUT, 'world.json')))
    lake = np.zeros((GRID, GRID), bool)
    for l in world['lakes']:
        for r, c0, c1 in l['runs']:
            lake[r, c0:c1 + 1] = True
    mask = np.zeros((GRID, GRID), bool)
    for st in world['streams']:
        for r, c in cells_near([[p[0], p[1]] for p in st['pts']], st['width'] / 2 + CELL):
            mask[r, c] = True
    mask &= ~lake
    if mask.any():  # heal the old channel cuts, then the new survey carves fresh
        i0, i1 = ndimage.distance_transform_edt(mask, return_indices=True)[1]
        H[mask] = H[i0[mask], i1[mask]]
        for _ in range(40):
            P = np.pad(H, 1, 'edge')
            H[mask] = ((P[:-2, 1:-1] + P[2:, 1:-1] + P[1:-1, :-2] + P[1:-1, 2:]) / 4)[mask]
    if '--overture' in sys.argv:
        items = overture_streams(overture('base', 'water', ['id', 'names', 'class', 'subtype', 'geometry']))
        world['sources']['streams'] = f'Overture Maps {OVERTURE_RELEASE} water'
    else:
        items = nhd_streams()
        if not items:
            sys.exit('nhd fetch failed')
        world['sources']['streams'] = 'USGS NHD flowlines (the National Map)'
    world['streams'] = carve_streams(H, items)
    grade_tracks(H, world['trails'])  # road bed wins wherever a new channel dips under it
    with open(os.path.join(OUT, 'world.json'), 'w') as f:
        json.dump(world, f, separators=(',', ':'))
    dem_encode(H)
    print(f"{len(world['streams'])} stream runs re-carved from NHD")
    sys.exit(0)


# ---------------------------------------------------------------- elevation
def terrarium(z, x, y):
    path = os.path.join(CACHE, f'terrarium_{z}_{x}_{y}.png')
    if not os.path.exists(path):
        urllib.request.urlretrieve(TERRARIUM.format(z=z, x=x, y=y), path)
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float64)
    return a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def mosaic(z, x0, y0, nx, ny):
    return np.vstack([np.hstack([terrarium(z, x, y) for x in range(x0, x0 + nx)]) for y in range(y0, y0 + ny)])


base = mosaic(Z, X0, Y0, NT, NT).astype(np.float32)
H = ndimage.zoom(base, GRID / N_PX, order=1).astype(np.float32)

def cached(name, build):
    path = os.path.join(CACHE, f'{name}.npy')
    if os.path.exists(path):
        return np.load(path)
    a = build()
    np.save(path, a)
    return a


to_utm = Transformer.from_crs(4326, 26913, always_xy=True)
ex = [to_utm.transform(lo, la) for lo in (lon_w, lon_e) for la in (lat_n, lat_s)]
tiles = [f'x{tx}y{ty}' for tx in range(int(min(e[0] for e in ex) // 1e4), int(max(e[0] for e in ex) // 1e4) + 1)
         for ty in range(int(min(e[1] for e in ex) // 1e4) + 1, int(max(e[1] for e in ex) // 1e4) + 2)]


def read_lidar():
    out = np.full((GRID, GRID), np.nan, np.float32)
    with rasterio.Env(**GDAL_ENV):
        for proj in LIDAR_PROJECTS:   # earlier projects win where they overlap
            for t in tiles:
                url = '/vsicurl/' + LIDAR.format(p=proj, t=t)
                try:
                    src = rasterio.open(url)
                except rasterio.errors.RasterioIOError:
                    continue
                with src, WarpedVRT(src, crs='EPSG:3857', transform=DST, width=GRID, height=GRID,
                                    resampling=Resampling.bilinear, src_nodata=src.nodata, nodata=np.nan) as vrt:
                    a = vrt.read(1).astype(np.float32)
                ok = np.isfinite(a) & (a > 1000) & np.isnan(out)
                out[ok] = a[ok]
                print(f'lidar {proj} {t}: +{ok.mean() * 100:.1f}% of grid')
    return out


lidar = cached(f'lidar_{GRID}_{len(LIDAR_PROJECTS)}', read_lidar)
have = np.isfinite(lidar)
print(f'lidar coverage {have.mean() * 100:.1f}%')
# feather lidar into the terrain-tile fill over ~150 m
w = np.clip(ndimage.distance_transform_edt(have) / (150 / CELL), 0, 1).astype(np.float32)
lid = np.where(have, lidar, H)
H = H + (lid - H) * w

# ---------------------------------------------------------------- vectors (Overture)
segments = overture('transportation', 'segment', ['id', 'names', 'class', 'subtype', 'geometry'])
water = overture('base', 'water', ['id', 'names', 'class', 'subtype', 'geometry'])
land = overture('base', 'land', ['id', 'names', 'class', 'subtype', 'geometry', 'elevation'])


# ---------------------------------------------------------------- lakes
lake_polys = [w_ for w_ in water if w_['geom'].geom_type in ('Polygon', 'MultiPolygon')
              and w_['subtype'] in ('lake', 'pond', 'reservoir', 'water')]
shapes = [(mapping(geo_merc(w_['geom'])), i + 1) for i, w_ in enumerate(lake_polys)]
poly_id = rasterize(shapes, out_shape=(GRID, GRID), transform=DST, fill=0, dtype='int32', all_touched=False)

lakes = []
lake_mask = np.zeros((GRID, GRID), bool)
lab, k = ndimage.label(poly_id > 0)
for i in range(1, k + 1):
    m = lab == i
    area = float(m.sum()) * CELL * CELL
    if area < 400:
        continue
    ids = poly_id[m]
    src = lake_polys[int(np.bincount(ids).argmax()) - 1]
    core = ndimage.binary_erosion(m, iterations=2)
    level = float(np.percentile(H[core if core.sum() > 8 else m], 30))
    # lidar water is flattened: grow the outline over the real flat surface it misses
    flat = (np.abs(H - level) < 0.08) & ndimage.binary_dilation(m, iterations=6)
    m = ndimage.binary_propagation(m, mask=m | flat)
    area = float(m.sum()) * CELL * CELL
    dist = ndimage.distance_transform_edt(m)
    depth = np.minimum(0.8 + dist * CELL * 0.22, 3 + math.sqrt(area) * 0.04)
    H[m] = np.minimum(H[m], level - depth[m])
    ring = ndimage.binary_dilation(m, iterations=2) & ~m
    H[ring] = np.maximum(H[ring], level + 0.15)
    lake_mask |= m
    sheet = ndimage.binary_dilation(m, iterations=3)
    runs = []
    for rr in np.unique(np.nonzero(sheet)[0]):
        cs = np.nonzero(sheet[rr])[0]
        start = prev = cs[0]
        for cc in cs[1:]:
            if cc != prev + 1:
                runs.append([int(rr), int(start), int(prev)])
                start = cc
            prev = cc
        runs.append([int(rr), int(start), int(prev)])
    rows, cols = np.nonzero(m)
    x, z = to_world_rc(rows.mean(), cols.mean())
    lakes.append({'name': src['name'], 'kind': src['subtype'], 'level': round(level, 2), 'x': round(x, 1),
                  'z': round(z, 1), 'area': round(area), 'runs': runs})
lakes.sort(key=lambda l: -l['area'])
print(f'{len(lakes)} lakes, {sum(1 for l in lakes if l["name"])} named')

# ---------------------------------------------------------------- streams
src = nhd_streams()
streams = carve_streams(H, src or overture_streams(water))
print(f'{len(streams)} stream runs ({"nhd" if src else "overture"})')

# ---------------------------------------------------------------- trails and roads
ROAD = {'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'}
trails = []
for s in segments:
    if s['subtype'] != 'road':
        continue
    cls = s['class']
    kind = 'road' if cls in ROAD else 'track' if cls == 'track' and not (s['name'] or '').endswith('Trail') \
        else 'trail' if cls in ('path', 'footway', 'bridleway', 'track', 'cycleway', 'steps') else None
    if not kind:
        continue
    for g in getattr(s['geom'], 'geoms', [s['geom']]):
        for run in clip_runs(world_line(g, 3.0 if kind != 'road' else 4.0)):
            trails.append({'name': s['name'] or ('Forest road' if kind != 'trail' else 'Unnamed trail'),
                           'kind': kind, 'cls': cls, 'pts': [[round(x, 1), round(z, 1)] for x, z in run]})

# grade roads and tracks: flatten across and smooth along
grade_tracks(H, trails)
print(f'{len(trails)} trail/road runs')

# ---------------------------------------------------------------- places
places = []
for s in land:
    if s['class'] == 'peak' and s['name']:
        x, z = lonlat_to_world(*s['geom'].coords[0])
        if not inside(x, z, 50):
            continue
        # settle the marker on the true high point within 40 m
        best = (sample(H, x, z), x, z)
        for dx in range(-40, 41, 4):
            for dz in range(-40, 41, 4):
                hh = float(sample(H, x + dx, z + dz))
                if hh > best[0] and math.hypot(dx, dz) <= 40:
                    best = (hh, x + dx, z + dz)
        places.append({'name': s['name'], 'kind': 'peak', 'x': round(best[1], 1), 'z': round(best[2], 1),
                       'elev': round(float(best[0]), 1)})
for l in lakes:
    if l['name']:
        places.append({'name': l['name'], 'kind': 'lake', 'x': l['x'], 'z': l['z'], 'elev': l['level']})

# trailheads: where a named trail meets a road or a track
road_pts = np.array([p for t in trails if t['kind'] != 'trail' for p in t['pts']])
seen = set()
for t in trails:
    if t['kind'] != 'trail' or not t['name'].endswith('Trail'):
        continue
    for end in (t['pts'][0], t['pts'][-1]):
        d = np.hypot(road_pts[:, 0] - end[0], road_pts[:, 1] - end[1])
        if d.min() < 25 and t['name'] not in seen:
            seen.add(t['name'])
            places.append({'name': f"{t['name'].replace(' Trail', '')} Trailhead", 'kind': 'trailhead',
                           'x': round(end[0], 1), 'z': round(end[1], 1), 'trail': t['name']})
print('places:', ', '.join(p['name'] for p in places if p['kind'] != 'lake'))

# ---------------------------------------------------------------- imagery + land cover
def s2_url(tile, date=S2_DATE):
    return S2.format(tile=tile, y=date[:4], m=int(date[4:6]), date=date)


def s2_band(band, transform, size, resampling=Resampling.bilinear, date=S2_DATE, tiles=S2_TILES):
    key = f's2_{date}_{band}_{size}_{int(transform.c)}_{int(transform.f)}'
    return cached(key, lambda: _s2_band(band, transform, size, resampling, date, tiles))


def _s2_band(band, transform, size, resampling, date, tiles):
    out = np.zeros((size, size), np.float32)
    with rasterio.Env(**GDAL_ENV):
        for tile in tiles:
            try:
                src = rasterio.open(f'/vsicurl/{s2_url(tile, date)}/{band}.tif')
            except rasterio.errors.RasterioIOError:
                continue
            with src, WarpedVRT(src, crs='EPSG:3857', transform=transform, width=size, height=size,
                                resampling=resampling, src_nodata=0, nodata=0) as vrt:
                a = vrt.read().astype(np.float32)
            a = a if a.shape[0] > 1 else a[0]
            if a.ndim == 3:
                if out.ndim == 2:
                    out = np.zeros((a.shape[0], size, size), np.float32)
                fill = (out.sum(0) == 0) & (a.sum(0) > 0)
                out[:, fill] = a[:, fill]
            else:
                fill = (out == 0) & (a > 0)
                out[fill] = a[fill]
    return out


def sun_of_scene():
    meta = json.load(urllib.request.urlopen(f"{s2_url('DF')}/S2A_13TDF_{S2_DATE}_0_L2A.json"))
    p = meta['properties']
    return p.get('view:sun_azimuth', 155.0), p.get('view:sun_elevation', 44.0)


def topo_correct(rgb, heights, cell, sun_az, sun_el, k=0.5):
    """Divide out most of the terrain shading baked into the scene."""
    gy, gx = np.gradient(heights, cell)
    nx, ny, nz = -gx, np.ones_like(gx), gy  # x east, y up, z north (row index runs south)
    nl = np.sqrt(nx ** 2 + ny ** 2 + nz ** 2)
    az, el = math.radians(sun_az), math.radians(sun_el)
    sx, sy, sz = math.sin(az) * math.cos(el), math.sin(el), math.cos(az) * math.cos(el)
    cosi = np.clip((nx * sx + ny * sy + nz * sz) / nl, 0.12, 1)
    f = (math.sin(el) / cosi) ** k
    return rgb * np.clip(f, 0.75, 1.7)[None]


sun_az, sun_el = sun_of_scene()
print(f'scene sun azimuth {sun_az:.1f}, elevation {sun_el:.1f}')
CT = merc_transform(X0 * 256, Y0 * 256, Z, N_PX, COLOR)
tci = s2_band('TCI', CT, COLOR)
Hc = ndimage.zoom(H, COLOR / GRID, order=1)
tci = topo_correct(tci, Hc, EXTENT / COLOR, sun_az, sun_el)
# grade: lift the dark L2A visual product toward what the eye sees on the ground
g = np.clip(tci / 255.0, 0, 1)
g = np.power(g, 0.85) * 1.04
lum = g.mean(0, keepdims=True)
g = np.clip(lum + (g - lum) * 1.1, 0, 1)
# roll off highlights so sunlit tundra and snow keep their texture
g = np.where(g > 0.7, 0.7 + (g - 0.7) * 0.55, g)
Image.fromarray((g.transpose(1, 2, 0) * 255).astype(np.uint8)).save(os.path.join(OUT, 'color.jpg'), quality=90)

KT = merc_transform(X0 * 256, Y0 * 256, Z, N_PX, COVER)
red = s2_band('B04', KT, COVER)
nir = s2_band('B08', KT, COVER)
swir = s2_band('B12', KT, COVER)
grn = s2_band('B03', KT, COVER)
ndvi = (nir - red) / np.maximum(nir + red, 1)
nbr = (nir - swir) / np.maximum(nir + swir, 1)
Hk = ndimage.zoom(H, COVER / GRID, order=1)
gy, gx = np.gradient(Hk, EXTENT / COVER)
slope = np.hypot(gx, gy)
bright = (red + grn) / 2
treeline = 3440
low = Hk < treeline + 60
live = np.clip((ndvi - 0.32) / 0.25, 0, 1) * np.clip((nbr - 0.05) / 0.25, 0, 1) * low
red0 = s2_band('B04', KT, COVER, date=S2_PREFIRE, tiles=['DF'])
nir0 = s2_band('B08', KT, COVER, date=S2_PREFIRE, tiles=['DF'])
swir0 = s2_band('B12', KT, COVER, date=S2_PREFIRE, tiles=['DF'])
scl0 = s2_band('SCL', KT, COVER, Resampling.nearest, date=S2_PREFIRE, tiles=['DF'])
clear0 = ~np.isin(scl0, (0, 3, 8, 9, 10))
ndvi0 = (nir0 - red0) / np.maximum(nir0 + red0, 1)
nbr0 = (nir0 - swir0) / np.maximum(nir0 + swir0, 1)
dnbr = np.where(clear0, nbr0 - nbr, 0)
# was forest before, lost it since: moderate-to-high severity burn
burned = np.clip((dnbr - 0.12) / 0.25, 0, 1) * np.clip((ndvi0 - 0.3) / 0.2, 0, 1) * (Hk < treeline + 40)
print(f'dNBR > 0.27 (moderate+ severity) over {(dnbr > 0.27).mean() * 100:.1f}% of the map')
aspen = (np.clip((red - grn * 0.95) / 250, 0, 1) * np.clip((ndvi - 0.3) / 0.2, 0, 1) * np.clip((nbr - 0.12) / 0.15, 0, 1)
         * np.clip((bright - 600) / 500, 0, 1) * (Hk < 3150))
rock = np.clip((0.18 - ndvi) / 0.15, 0, 1) * np.clip((bright - 700) / 900, 0, 1) * (Hk > 3150) * (slope > 0.25)
lk = ndimage.zoom(lake_mask.astype(np.float32), COVER / GRID, order=0) > 0.5
for a in (live, burned, aspen, rock):
    a[lk] = 0
cover = np.stack([live, burned, aspen, rock], -1)
cover = (ndimage.uniform_filter(cover, size=(3, 3, 1)) * 255).astype(np.uint8)
with gzip.open(os.path.join(OUT, 'cover.bin.gz'), 'wb', compresslevel=9) as f:
    f.write(cover.tobytes())
print(f'cover: live {live.mean():.2f}, burned {burned.mean():.2f}, aspen {aspen.mean():.3f}, rock {rock.mean():.2f}')

# ---------------------------------------------------------------- far ring
cx_g = (X0 * 256 + N_PX / 2) / 8
cy_g = (Y0 * 256 + N_PX / 2) / 8
fx0 = int((cx_g - FAR_N / 2) // 256)
fy0 = int((cy_g - FAR_N / 2) // 256)
fn = FAR_N // 256 + 2
F = mosaic(FAR_Z, fx0, fy0, fn, fn)
ox, oy = int(round(cx_g - FAR_N / 2 - fx0 * 256)), int(round(cy_g - FAR_N / 2 - fy0 * 256))
F = F[oy:oy + FAR_N, ox:ox + FAR_N]
FAR_CELL = MERC_WORLD / (2 ** FAR_Z * 256) * math.cos(math.radians(lat_c))
FT = merc_transform(fx0 * 256 + ox, fy0 * 256 + oy, FAR_Z, FAR_N, FAR_N)
far_rgb = s2_band('TCI', FT, FAR_N)
far_rgb = topo_correct(far_rgb, F, FAR_CELL, sun_az, sun_el)
fg = np.power(np.clip(far_rgb / 255.0, 0, 1), 0.85) * 1.04
fg = np.where(fg > 0.7, 0.7 + (fg - 0.7) * 0.55, fg)
Image.fromarray((np.clip(fg, 0, 1).transpose(1, 2, 0) * 255).astype(np.uint8)).save(os.path.join(OUT, 'far.jpg'), quality=88)

# ---------------------------------------------------------------- write
def enc(a):
    return np.clip(np.round((a - H_OFFSET) * H_SCALE), 0, 65535).astype('<u2').tobytes()


# 2-D delta coding (left, then up, wrapping uint16) gzips about three times smaller
q = np.frombuffer(enc(H), '<u2').reshape(GRID, GRID).astype(np.int64)
q[:, 1:] = (q[:, 1:] - q[:, :-1]) & 0xFFFF
q[1:, :] = (q[1:, :] - q[:-1, :]) & 0xFFFF
with gzip.open(os.path.join(OUT, 'dem.bin.gz'), 'wb', compresslevel=9) as f:
    f.write(q.astype('<u2').tobytes())
with open(os.path.join(OUT, 'far.bin'), 'wb') as f:
    f.write(enc(F))

world = {
    'sources': {
        'elevation': 'USGS 3DEP 1 m lidar (CO_ArapahoRooseveltPikeNF_D23, CO_CameronPeakWildfire_2021_D21); Terrarium tiles elsewhere',
        'imagery': 'Copernicus Sentinel-2 L2A, 2023-09-28',
        'vectors': f'Overture Maps {OVERTURE_RELEASE} (© OpenStreetMap contributors, ODbL)',
        'streams': 'USGS NHD flowlines (the National Map)' if src else f'Overture Maps {OVERTURE_RELEASE} water',
    },
    'size': GRID, 'cell': round(CELL, 5), 'hOffset': H_OFFSET, 'hScale': H_SCALE, 'demCoding': 'delta2',
    'color': COLOR, 'cover': COVER, 'lidar': round(float(have.mean()), 3),
    'nw': {'lat': round(lat_n, 6), 'lon': round(lon_w, 6)},
    'far': {'size': FAR_N, 'cell': round(FAR_CELL, 4)},
    'lakes': lakes, 'streams': streams, 'trails': trails, 'places': places,
}
with open(os.path.join(OUT, 'world.json'), 'w') as f:
    json.dump(world, f, separators=(',', ':'))
for old in ('dem.bin',):
    if os.path.exists(os.path.join(OUT, old)):
        os.remove(os.path.join(OUT, old))
# ship binaries as lossless PNGs so any static host serves them
import pack_png  # noqa: E402
pack_png.pack_all()
print('wrote', os.path.abspath(OUT))
