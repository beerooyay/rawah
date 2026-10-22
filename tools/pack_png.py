#!/usr/bin/env python3
"""Pack binary world data into lossless RGB PNGs any static host will serve.

Bytes run left to right, top to bottom through the R, G, B channels of a
4096-wide image (no alpha, no colour profile, so browsers hand the bytes back
unchanged). The game knows each file's byte length from world.json.

Usage: python3 pack_png.py            (packs data/dem, cover and far)
"""
import gzip
import os

import numpy as np
from PIL import Image

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
WIDTH = 4096


def pack(raw: bytes, path: str):
    n = len(raw)
    rows = -(-n // (WIDTH * 3))
    buf = np.zeros(rows * WIDTH * 3, np.uint8)
    buf[:n] = np.frombuffer(raw, np.uint8)
    Image.fromarray(buf.reshape(rows, WIDTH, 3), 'RGB').save(path, optimize=True, compress_level=9)
    return n


def pack_all():
    sizes = {}
    for name, src, gz in (('dem', 'dem.bin.gz', True), ('cover', 'cover.bin.gz', True), ('far', 'far.bin', False)):
        p = os.path.join(DATA, src)
        raw = gzip.open(p).read() if gz else open(p, 'rb').read()
        sizes[name] = pack(raw, os.path.join(DATA, f'{name}.png'))
        os.remove(p)
    return sizes


if __name__ == '__main__':
    print(pack_all())
