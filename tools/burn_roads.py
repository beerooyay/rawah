#!/usr/bin/env python3
"""Burn trail/road/track centrelines from world.json into data/color.jpg so the
ground texture carries a crisp tread instead of blurry satellite pixels.
Run after bake_world.py (or standalone: python3 tools/burn_roads.py)."""
import json, math, os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W = json.load(open(os.path.join(ROOT, 'data', 'world.json')))
EXTENT = W['size'] * W['cell']
C = W['color']
img = np.asarray(Image.open(os.path.join(ROOT, 'data', 'color.jpg'))).astype(np.float32) / 255.0

TONES = {
    'road':  ((0.50, 0.44, 0.35), 6.6, 2.6),   # packed gravel: width m, soft edge m
    'track': ((0.40, 0.33, 0.24), 3.2, 1.8),
    'trail': ((0.38, 0.30, 0.21), 1.4, 1.0),
}
M2PX = C / EXTENT

def resample(pts, step):
    out = [pts[0]]
    ax, az = pts[0]
    for bx, bz in pts[1:]:
        d = math.hypot(bx - ax, bz - az)
        n = max(1, int(d / step))
        for i in range(1, n + 1):
            out.append((ax + (bx - ax) * i / n, az + (bz - az) * i / n))
        ax, az = bx, bz
    return out

for t in W['trails']:
    if t['kind'] not in TONES:
        continue
    tone, w, edge = TONES[t['kind']]
    inner, outer = (w / 2) * M2PX, (w / 2 + edge) * M2PX
    R = int(math.ceil(outer)) + 1
    for x, z in resample(t['pts'], 1.0):
        u, v = x * M2PX + C / 2, z * M2PX + C / 2
        r0, r1 = int(math.floor(v)) - R, int(math.ceil(v)) + R
        c0, c1 = int(math.floor(u)) - R, int(math.ceil(u)) + R
        for r in range(max(0, r0), min(C, r1)):
            for c in range(max(0, c0), min(C, c1)):
                d = math.hypot(c - u, r - v)
                if d > outer:
                    continue
                k = 1.0 if d <= inner else 1.0 - (d - inner) / (outer - inner)
                # worn wheel lines on roads: darken the two ruts a touch
                px = img[r, c]
                fade = min(1.0, k * 0.92)
                img[r, c] = px * (1 - fade) + np.array(tone) * fade

# ---------------------------------------------------------------- the pull-off
# West Branch's gravel loop: the same oval ring the game builds around its worn
# island, stamped into the albedo so the lot is not blurry satellite pixels.
ths = [p for p in W['places'] if p.get('kind') == 'trailhead']
main = next((p for p in ths if p.get('trail') == 'West Branch Trail'), ths[0] if ths else None)
if main:
    bd, rp, rt = 1e18, None, None
    for t in W['trails']:
        if t['kind'] == 'trail':
            continue
        for pt in t['pts']:
            d = (pt[0] - main['x']) ** 2 + (pt[1] - main['z']) ** 2
            if d < bd:
                bd, rp, rt = d, pt, t
    i = rt['pts'].index(rp)
    a, b = rt['pts'][max(0, i - 1)], rt['pts'][min(len(rt['pts']) - 1, i + 1)]
    dl = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
    ax, az = (b[0] - a[0]) / dl, (b[1] - a[1]) / dl
    sd = 1 if (main['x'] - rp[0]) * az - (main['z'] - rp[1]) * ax >= 0 else -1
    px_, pz_ = -az * sd, ax * sd
    cx, cz = rp[0] + px_ * 15, rp[1] + pz_ * 15      # where features.js puts the loop
    HW, WW = 34, 16
    reach = (HW + 12) * M2PX
    uc, vc = cx * M2PX + C / 2, cz * M2PX + C / 2
    tone = np.array((0.52, 0.47, 0.37))
    for r in range(max(0, int(vc - reach)), min(C, int(vc + reach) + 1)):
        for c in range(max(0, int(uc - reach)), min(C, int(uc + reach) + 1)):
            x, z = (c - C / 2) / M2PX, (r - C / 2) / M2PX
            u = ((x - cx) * ax + (z - cz) * az) / HW
            v = ((x - cx) * px_ + (z - cz) * pz_) / (WW * (0.72 + 0.28 * u))
            rr = math.hypot(u, v)
            k = 0.0
            if 0.62 < rr < 1.16:                                  # the ring tread
                k = max(k, 0.9 - abs(rr - 0.9) * 2.2)
            if abs(v) < 0.4 and 0.9 < abs(u) < 1.4:               # the mouths
                k = max(k, 0.85 - abs(abs(u) - 1.12) * 2.0 - abs(v))
            if k > 0:
                img[r, c] = img[r, c] * (1 - min(1, k)) + tone * min(1, k)

Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8)).save(
    os.path.join(ROOT, 'data', 'color.jpg'), quality=90)
print('burned', len(W['trails']), 'lines into color.jpg')
