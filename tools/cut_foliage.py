#!/usr/bin/env python3
"""Cut the user's foliage sheets (rawah_tree_leaves_and_cones.zip) into individual cutouts and pack them for the game.

usage: python3 tools/cut_foliage.py <folder holding the five sheet PNGs> [preview_dir]

Each sheet is an illustrated cutout atlas (several branches, leaves or cones on one transparent page, with a coloured
chroma-key fringe on the edges). For every sprite this script:
  1. finds it (connected blob of alpha, small gaps closed),
  2. cleans the fringe (alpha eroded and softened, edge colour replaced by the colour just inside),
  3. turns it so the woody end of a branch sits at the left (u = 0, where a spray card starts), a leaf or cluster
     stands with its stalk at the bottom, and a cone hangs with its stem at the top,
  4. stretches it to fill its cell (the game undoes the stretch with the aspect stored in foliage.json) and fills the
     transparent texels with the sprite's own colour so mipmaps never fade to black or fringe colours.
Aspen gets composites too: a single leaf is 6 cm, so crown cards are built from many real leaves and twig clusters.
Output (assets/foliage/): foliage.webp (2048 x 3072, the top six 512-px rows of the tree atlas) and foliage.json.
"""
import json, math, os, sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SRC = sys.argv[1]
PREVIEW = sys.argv[2] if len(sys.argv) > 2 else None
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets', 'foliage')
CELL = 512
rs = np.random.RandomState(5)


def load(name):
    return np.asarray(Image.open(os.path.join(SRC, name + '.png')).convert('RGBA')).astype(np.float32)


def clean(im):
    """Soften the alpha edge and replace the key-colour fringe with the colour just inside."""
    rgb, a = im[..., :3], im[..., 3]
    m = a > 128
    core = ndi.binary_erosion(m, iterations=3)
    w = ndi.gaussian_filter(core.astype(np.float32), 3)
    fill = np.stack([ndi.gaussian_filter(rgb[..., c] * core, 3) for c in range(3)], -1) / np.maximum(w[..., None], 1e-4)
    far = ndi.gaussian_filter(core.astype(np.float32), 12) < 1e-3
    out = np.where((core | (w < 1e-3))[..., None], rgb, fill)
    out = np.where(far[..., None] | (w[..., None] < 1e-3), rgb, out)
    m2 = ndi.binary_erosion(m, iterations=2)
    a2 = ndi.gaussian_filter(m2.astype(np.float32), 1.0) * 255
    return np.dstack([out, a2])


def blobs(im, gap=7, minarea=6000):
    m = im[..., 3] > 60
    lab, n = ndi.label(ndi.binary_dilation(m, iterations=gap))
    objs = ndi.find_objects(lab)
    out = []
    for i, sl in enumerate(objs):
        area = (lab[sl] == i + 1).sum()
        if area < minarea:
            continue
        own = ndi.binary_dilation(lab[sl] == i + 1, iterations=2) & (im[sl][..., 3] > 4)
        sub = im[sl].copy()
        sub[..., 3] *= own
        out.append((sl, sub))
    # reading order: rows of similar y, then x
    out.sort(key=lambda t: (round((t[0][0].start + t[0][0].stop) / 2 / 250), (t[0][1].start + t[0][1].stop) / 2))
    return [s for _, s in out]


def brown(sub, mask):
    r, g, b = sub[..., 0], sub[..., 1], sub[..., 2]
    return (((r > g * 1.04) & (r > b * 1.25)) & mask).astype(np.float32)


def rotate(sub, deg):
    rgb = Image.fromarray(np.clip(sub[..., :3], 0, 255).astype(np.uint8))
    a = Image.fromarray(np.clip(sub[..., 3], 0, 255).astype(np.uint8))
    rgb = rgb.rotate(deg, resample=Image.BICUBIC, expand=True)
    a = a.rotate(deg, resample=Image.BICUBIC, expand=True)
    return np.dstack([np.asarray(rgb).astype(np.float32), np.asarray(a).astype(np.float32)])


def crop(sub, pad=2):
    ys, xs = np.where(sub[..., 3] > 10)
    return sub[max(ys.min() - pad, 0):ys.max() + pad + 1, max(xs.min() - pad, 0):xs.max() + pad + 1]


def principal(mask):
    ys, xs = np.nonzero(mask)
    pts = np.stack([xs - xs.mean(), ys - ys.mean()], 1)
    w, v = np.linalg.eigh(np.cov(pts.T))
    return v[:, 1], pts @ v[:, 1]            # major axis (x, y), coordinates along it


def base_end(sub, axis, along, mask):
    """+1 if the woody base is at the + end of the axis, else -1."""
    ys, xs = np.nonzero(mask)
    br = brown(sub, mask)[ys, xs]
    lo, hi = np.percentile(along, 18), np.percentile(along, 82)
    b_lo, b_hi = br[along <= lo].mean(), br[along >= hi].mean()
    if abs(b_hi - b_lo) > 0.03:
        return 1 if b_hi > b_lo else -1
    sk = ((along - along.mean()) ** 3).mean()          # a stalk is a thin tail: skewed away from the body
    return 1 if sk > 0 else -1


def orient(sub, base):
    """base: 'left' (spray), 'down' (leaf / cluster), 'up' (hanging cone). Returns the cropped, oriented sprite."""
    mask = sub[..., 3] > 60
    axis, along = principal(mask)
    s = base_end(sub, axis, along, mask)
    # image y points down; rotate so the base direction (s * axis) maps to the requested side
    ang = math.degrees(math.atan2(s * axis[1], s * axis[0]))      # current heading of the base end, 0 = +x (right), +90 = down
    want = {'left': 180, 'down': 90, 'up': -90}[base]
    return crop(rotate(sub, ang - want))


def fit(sub, w=CELL, h=CELL, margin=4):
    """Stretch to fill (w - 2 margin) x (h - 2 margin) and centre it on a cell coloured like the sprite."""
    rgb = Image.fromarray(np.clip(sub[..., :3], 0, 255).astype(np.uint8)).resize((w - 2 * margin, h - 2 * margin), Image.LANCZOS)
    a = Image.fromarray(np.clip(sub[..., 3], 0, 255).astype(np.uint8)).resize((w - 2 * margin, h - 2 * margin), Image.LANCZOS)
    rgb, a = np.asarray(rgb).astype(np.float32), np.asarray(a).astype(np.float32)
    op = a > 128
    mean = rgb[op].mean(0) if op.any() else np.array([60, 80, 40.0])
    cell = np.zeros((h, w, 4), np.float32)
    cell[..., :3] = mean
    cell[margin:h - margin, margin:w - margin, :3] = np.where(a[..., None] > 4, rgb, mean)
    cell[margin:h - margin, margin:w - margin, 3] = a
    return cell


def aspect(sub):
    return sub.shape[0] / sub.shape[1]          # height / width of the sprite before stretching


# ---------------------------------------------------------------- the sheets
sheets = {n: clean(load(n)) for n in ['engelmann_spruce_needles', 'subalpine_fir_needles', 'lodgepole_pine_needles', 'quaking_aspen_leaves', 'pine_cones']}
sprites = {}
for n, im in sheets.items():
    sprites[n] = blobs(im, gap=9 if 'needles' in n else 7)
    print(n, len(sprites[n]), 'sprites')

atlas = np.zeros((CELL * 6, CELL * 4, 4), np.float32)
atlas[..., :3] = (60, 80, 40)
os.makedirs(OUT, exist_ok=True)
meta = {'cell': CELL, 'variants': {}}
preview = {}


def put(kind, cx, cy, sub, w=CELL, h=CELL, **extra):
    cell = fit(sub, w, h)
    atlas[cy * CELL:cy * CELL + h, cx * CELL:cx * CELL + w] = cell
    meta['variants'].setdefault(kind, []).append({'x': cx * CELL, 'y': cy * CELL, 'w': w, 'h': h, 'aspect': round(aspect(sub), 3), **extra})
    preview.setdefault(kind, []).append(cell)


# conifer sprays: four per species, the woody end at the left
PICK = {'spruce': ('engelmann_spruce_needles', [0, 1, 4, 5]), 'fir': ('subalpine_fir_needles', [0, 1, 4, 8]), 'pine': ('lodgepole_pine_needles', [1, 4, 5, 8])}
for row, (kind, (sheet, idx)) in enumerate(PICK.items()):
    for col, k in enumerate(idx):
        sp = orient(sprites[sheet][k], 'left')
        put(kind, col, row, sp)

# cones: 256 x 512 cells, stem at the top. lodgepole: small ovoid and open cones; spruce: long hanging; fir: upright young
cones = sprites['pine_cones']
CONE = [('pineCone', [4, 6]), ('spruceCone', [0, 5, 9, 1]), ('firCone', [2, 10])]
slot = 0
for kind, idx in CONE:
    for k in idx:
        sp = orient(cones[k], 'up')
        cx, cy = (slot % 8) / 2.0, 3 + (slot // 8)
        cell = fit(sp, 256, CELL)
        x0 = int(cx * CELL)
        atlas[cy * CELL:cy * CELL + CELL, x0:x0 + 256] = cell
        meta['variants'].setdefault(kind, []).append({'x': x0, 'y': cy * CELL, 'w': 256, 'h': CELL, 'aspect': round(aspect(sp), 3)})
        preview.setdefault(kind, []).append(cell)
        slot += 1
# lodgepole twigs carrying cones (needles + 2 cones): hang from the stem at the top
for k in [7, 8]:
    sp = orient(cones[k], 'up')
    cx, cy = (slot % 8) / 2.0, 3 + (slot // 8)
    cell = fit(sp, 256, CELL)
    x0 = int(cx * CELL)
    atlas[cy * CELL:cy * CELL + CELL, x0:x0 + 256] = cell
    meta['variants'].setdefault('pineCluster', []).append({'x': x0, 'y': cy * CELL, 'w': 256, 'h': CELL, 'aspect': round(aspect(sp), 3)})
    preview.setdefault('pineCluster', []).append(cell)
    slot += 1
print('cone cells used', slot, 'of 10 (row 3 holds 8, row 4 the rest)')

# aspen: sort the sprites into single leaves and twig clusters, then build composites
asp = sprites['quaking_aspen_leaves']
singles, twigs = [], []
for s in asp:
    mask = s[..., 3] > 60
    br = brown(s, mask).sum() / max(mask.sum(), 1)
    (twigs if br > 0.04 else singles).append(s)
print('aspen: singles', len(singles), 'twig clusters', len(twigs))
leaf_img = [orient(s, 'down') for s in singles]
twig_img = [orient(s, 'down') for s in twigs]


def paste(canvas, sub, cx, cy, scale, rot, shade=1.0, flip=False):
    rgb = Image.fromarray(np.clip(sub[..., :3] * shade, 0, 255).astype(np.uint8))
    a = Image.fromarray(np.clip(sub[..., 3], 0, 255).astype(np.uint8))
    if flip:
        rgb, a = rgb.transpose(Image.FLIP_LEFT_RIGHT), a.transpose(Image.FLIP_LEFT_RIGHT)
    w, h = max(2, int(rgb.width * scale)), max(2, int(rgb.height * scale))
    rgb, a = rgb.resize((w, h), Image.LANCZOS), a.resize((w, h), Image.LANCZOS)
    rgb, a = rgb.rotate(rot, resample=Image.BICUBIC, expand=True), a.rotate(rot, resample=Image.BICUBIC, expand=True)
    rgb, a = np.asarray(rgb).astype(np.float32), np.asarray(a).astype(np.float32) / 255
    # the stalk (bottom centre of the sprite) sits on (cx, cy): place by the rotated bottom-centre
    th = math.radians(rot)
    ox, oy, off = rgb.shape[1] / 2, rgb.shape[0] / 2, h / 2
    bx, by = ox + math.sin(th) * off, oy + math.cos(th) * off
    x0, y0 = int(cx - bx), int(cy - by)
    H, W = canvas.shape[:2]
    xs0, ys0 = max(x0, 0), max(y0, 0)
    xs1, ys1 = min(x0 + rgb.shape[1], W), min(y0 + rgb.shape[0], H)
    if xs1 <= xs0 or ys1 <= ys0:
        return
    r = rgb[ys0 - y0:ys1 - y0, xs0 - x0:xs1 - x0]
    al = a[ys0 - y0:ys1 - y0, xs0 - x0:xs1 - x0, None]
    dst = canvas[ys0:ys1, xs0:xs1]
    dst[..., :3] = dst[..., :3] * (1 - al) + r * al
    dst[..., 3:4] = np.maximum(dst[..., 3:4], al * 255)


def composite(n_leaves, spread, size, twig_n, seed):
    R = np.random.RandomState(seed)
    cv = np.zeros((CELL, CELL, 4), np.float32)
    cv[..., :3] = (70, 100, 40)
    # a few twig clusters behind, then single leaves in front (lighter, glossier ones on top)
    for _ in range(twig_n):
        t = twig_img[R.randint(len(twig_img))]
        paste(cv, t, CELL * (0.25 + R.rand() * 0.5), CELL * (0.55 + R.rand() * 0.4), size * 1.9 / max(t.shape[:2]) * 1.0, R.uniform(-40, 40), 0.82, R.rand() < 0.5)
    for i in range(n_leaves):
        l = leaf_img[R.randint(len(leaf_img))]
        ang = R.uniform(0, 2 * math.pi)
        rad = math.sqrt(R.rand()) * spread
        cx = CELL * 0.5 + math.cos(ang) * rad * CELL * 0.5
        cy = CELL * 0.62 + math.sin(ang) * rad * CELL * 0.4
        paste(cv, l, cx, cy + 12, size * (0.75 + R.rand() * 0.5) / max(l.shape[:2]), R.uniform(-110, 110), 0.7 + 0.4 * (i / n_leaves), R.rand() < 0.5)
    return cv


for col, (nl, sp, size, tw) in enumerate([(90, 0.95, 120, 3), (105, 1.0, 100, 2), (72, 0.9, 135, 4), (120, 1.0, 88, 2)]):
    cv = composite(nl, sp, size, tw, 100 + col)
    # clean the composite's edge too
    m = cv[..., 3] > 128
    cv[..., 3] = ndi.gaussian_filter(ndi.binary_erosion(m, iterations=1).astype(np.float32), 0.8) * 255
    mean = cv[..., :3][m].mean(0)
    cv[..., :3] = np.where(cv[..., 3:4] > 4, cv[..., :3], mean)
    atlas[5 * CELL:6 * CELL, col * CELL:(col + 1) * CELL] = cv
    meta['variants'].setdefault('aspen', []).append({'x': col * CELL, 'y': 5 * CELL, 'w': CELL, 'h': CELL, 'aspect': 1.0})
    preview.setdefault('aspen', []).append(cv)

# falling leaves: four single leaves as luminance only (the game tints each one gold, orange or russet), 256-px cells in a row
lv = np.zeros((256, 1024, 4), np.float32)
for c, k in enumerate([0, 3, 6, 9]):
    sp = leaf_img[k % len(leaf_img)]
    h, w = sp.shape[:2]
    sc = 236.0 / max(h, w)
    rgb = Image.fromarray(np.clip(sp[..., :3], 0, 255).astype(np.uint8)).resize((max(2, int(w * sc)), max(2, int(h * sc))), Image.LANCZOS)
    al = Image.fromarray(np.clip(sp[..., 3], 0, 255).astype(np.uint8)).resize(rgb.size, Image.LANCZOS)
    g = np.asarray(rgb.convert('L')).astype(np.float32)
    g = np.clip((g - g[np.asarray(al) > 128].mean()) * 1.6 + 190, 60, 255)
    oy, ox = (256 - g.shape[0]) // 2, c * 256 + (256 - g.shape[1]) // 2
    lv[oy:oy + g.shape[0], ox:ox + g.shape[1], :3] = g[..., None]
    lv[oy:oy + g.shape[0], ox:ox + g.shape[1], 3] = np.asarray(al)
lv[..., :3] = np.where(lv[..., 3:4] > 4, lv[..., :3], 150)
Image.fromarray(np.clip(lv, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'leaves.webp'), quality=90, alpha_quality=100)
meta['leaves'] = {'cells': 4, 'aspect': [round(a_.shape[0] / a_.shape[1], 3) for a_ in [leaf_img[k % len(leaf_img)] for k in [0, 3, 6, 9]]]}

# row 4: willow (painted in the game) lives at x 512..1024, dead twigs at 1024..1536; the rest of the row is free
meta['painted'] = {'willowLeaf': [1, 4], 'deadTwig': [2, 4]}

os.makedirs(OUT, exist_ok=True)
img = Image.fromarray(np.clip(atlas, 0, 255).astype(np.uint8), 'RGBA')
img.save(os.path.join(OUT, 'foliage.webp'), quality=88, alpha_quality=100, method=6)
json.dump(meta, open(os.path.join(OUT, 'foliage.json'), 'w'), indent=1)
print('wrote', os.path.getsize(os.path.join(OUT, 'foliage.webp')) // 1024, 'KiB')
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    bg = Image.new('RGBA', img.size, (110, 140, 190, 255))
    bg.alpha_composite(img)
    bg.convert('RGB').resize((1024, 1536)).save(os.path.join(PREVIEW, 'atlas_preview.png'))
