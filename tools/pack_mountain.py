#!/usr/bin/env python3
"""Pack the user's mountain terrain pack (rawah_mountain_terrain_textures_package.zip) for the game.

usage: python3 tools/pack_mountain.py <folder holding the unzipped PNGs>

Per set (talus, till, bedrock, meadow, creekside) this writes assets/mountain/<name>_albedo.jpg and <name>_nh.webp.
The _nh map holds the slope the shader adds to the surface normal, already turned into the terrain's own convention
(u -> world +x, v -> world +z, so a bump facing +x tilts the normal toward +x): R = 0.5 + 0.25 * dx, G = 0.5 + 0.25 * dz,
B = height. The pack's normal map convention (OpenGL or DirectX) is measured from its height map, not assumed.
The roughness maps are nearly flat and the terrain is Lambert, so they are not used.
"""
import os, sys
import numpy as np
from PIL import Image

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'mountain')
SETS = ['alpine_talus_scree', 'glacial_till_diamicton', 'weathered_alpine_bedrock', 'subalpine_meadow_ground', 'wet_creekside_alluvium']
os.makedirs(OUT, exist_ok=True)

for name in SETS:
    base = os.path.join(SRC, 'rawah_' + name)
    alb = Image.open(base + '_albedo.png').convert('RGB')
    h = np.asarray(Image.open(base + '_height.png').convert('L')).astype(np.float32) / 255
    n = np.asarray(Image.open(base + '_normal.png').convert('RGB')).astype(np.float32) / 255 * 2 - 1
    nz = np.maximum(n[..., 2], 0.2)
    ox, oy = n[..., 0] / nz, n[..., 1] / nz
    # seamless tiles: wrap-around gradients of the height map (u to the right, v down the rows)
    du = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dv = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    # OpenGL: nx ~ -dh/du and ny(up) ~ +dh/dv (rows go down), DirectX flips ny. correlate to see which
    cx = np.corrcoef(ox.ravel(), (-du).ravel())[0, 1]
    cy = np.corrcoef(oy.ravel(), dv.ravel())[0, 1]
    gl = cy > 0
    sx = np.sign(cx) if abs(cx) > 0.02 else 1.0
    oz = -oy if gl else oy                           # world z offset = -dh/dv
    ox = ox * sx
    print(f'{name}: corr x {cx:+.2f} y {cy:+.2f} -> {"OpenGL" if gl else "DirectX"} normals, x sign {sx:+.0f}')
    r = np.clip(0.5 + 0.25 * ox, 0, 1)
    g = np.clip(0.5 + 0.25 * oz, 0, 1)
    nh = np.stack([r, g, h], -1)
    alb.save(os.path.join(OUT, name + '_albedo.jpg'), quality=90)
    Image.fromarray((nh * 255 + 0.5).astype(np.uint8)).save(os.path.join(OUT, name + '_nh.webp'), quality=92, method=6)
    a = np.asarray(alb).astype(np.float32) / 255
    print('   mean colour', np.round(a.reshape(-1, 3).mean(0), 3), ' |offset| mean', round(float(np.abs(ox).mean()), 3), round(float(np.abs(oz).mean()), 3))
