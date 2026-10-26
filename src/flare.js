// subtle lens flare: a 2D overlay (soft glow, faint anamorphic streak, a few ghosts along the line through the screen centre).
// strength comes from how much sun reaches the eye: terrain (sky.terrainBlock), cloud (sky.sunBlock), overcast, and the
// trees between you and the sun (a crown test against Flora.treesAround; the ray from the eye to the sun is the shadow ray).
import * as THREE from 'three';

const GHOSTS = [
  // k along sun -> opposite side of the centre, radius (of screen height), alpha, rgb, kind
  { k: 0.32, r: 0.030, a: 0.16, c: [255, 200, 140], ring: false },
  { k: -0.42, r: 0.055, a: 0.10, c: [150, 200, 255], ring: true },
  { k: -0.78, r: 0.022, a: 0.14, c: [255, 150, 200], ring: false },
  { k: -1.15, r: 0.075, a: 0.07, c: [170, 255, 210], ring: true },
  { k: -1.55, r: 0.040, a: 0.09, c: [255, 220, 170], ring: false },
];

export class LensFlare {
  constructor() {
    this.on = true;
    this.strength = 0.6;
    this.cv = document.createElement('canvas');
    Object.assign(this.cv.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2', mixBlendMode: 'screen' });
    document.body.appendChild(this.cv);
    this.ctx = this.cv.getContext('2d');
    this.treeVis = 1;
    this.shown = 0;
    this.frame = 0;
    this._v = new THREE.Vector3();
  }

  #trees(list, eye, sd) {
    const hz = Math.hypot(sd.x, sd.z);
    if (hz < 1e-3) return 1;
    const dx = sd.x / hz, dz = sd.z / hz, slope = sd.y / hz;
    let vis = 1;
    for (const t of list) {
      const tx = t.x - eye.x, tz = t.z - eye.z, tc = tx * dx + tz * dz;
      if (tc < 0) continue;
      const perp = Math.abs(tx * dz - tz * dx), s = t.rad / 0.24, R = 1.6 * s + 0.6;
      if (perp >= R) continue;
      const y = eye.y + tc * slope;                               // the ray's height over the tree
      if (y < t.y0 - 0.5 || y > t.y0 + 14 * s) continue;
      vis *= 1 - 0.9 * Math.sqrt(1 - perp / R);
    }
    return vis;
  }

  update({ camera, sky, flora, groundAt, paused, overcast }) {
    const cv = this.cv, W = innerWidth, H = innerHeight, dpr = Math.min(devicePixelRatio || 1, 1.5);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = this.ctx;
    const sd = sky.sunDir;
    const day = THREE.MathUtils.smoothstep(sd.y, -0.01, 0.06);
    let target = 0;
    if (this.on && !paused && day > 0) {
      if (this.frame++ % 4 === 0) {
        const eye = camera.position;
        const list = flora.treesAround(eye.x, eye.z, 70);
        for (const t of list) t.y0 = groundAt(t.x, t.z);
        this.treeVis += (this.#trees(list, eye, sd) - this.treeVis) * 0.5;
      }
      this._v.copy(camera.position).addScaledVector(sd, 1000).project(camera);
      const p = this._v;
      const off = Math.max(Math.abs(p.x) - 1, Math.abs(p.y) - 1, 0);
      const edge = p.z < 1 ? 1 - THREE.MathUtils.smoothstep(off, 0, 0.35) : 0;
      target = edge * day * this.treeVis * (1 - sky.terrainBlock) * (1 - 0.9 * sky.sunBlock) * (1 - 0.85 * overcast) * this.strength;
      this.sx = (p.x * 0.5 + 0.5) * cv.width; this.sy = (0.5 - p.y * 0.5) * cv.height;
    }
    this.shown += (target - this.shown) * 0.2;
    g.clearRect(0, 0, cv.width, cv.height);
    const I = this.shown;
    if (I < 0.004) return;
    const h = cv.height, cx = cv.width / 2, cy = cv.height / 2, sx = this.sx, sy = this.sy;
    const warm = THREE.MathUtils.lerp(255, 215, 1 - THREE.MathUtils.smoothstep(sd.y, 0.02, 0.5));   // low sun is amber
    const glow = (x, y, r, a, c, e = 1) => {
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a * e})`);
      gr.addColorStop(0.4, `rgba(${c[0]},${c[1]},${c[2]},${a * 0.25 * e})`);
      gr.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    };
    g.globalCompositeOperation = 'lighter';
    const sun = [255, warm, warm * 0.78 | 0];
    glow(sx, sy, h * 0.42, 0.10 * I, sun);
    glow(sx, sy, h * 0.10, 0.34 * I, [255, 238, 205]);
    // faint horizontal streak
    g.save(); g.translate(sx, sy); g.scale(1, 0.035);
    glow(0, 0, h * 0.9, 0.16 * I, [170, 200, 255]);
    g.restore();
    // ghosts: the further the sun is from the centre, the stronger they are
    const dxs = cx - sx, dys = cy - sy;
    const away = Math.min(1, Math.hypot(dxs, dys) / (h * 0.7)) * 0.8 + 0.2;
    for (const gh of GHOSTS) {
      const x = sx + dxs * (1 - gh.k) , y = sy + dys * (1 - gh.k), r = gh.r * h;
      if (gh.ring) {
        const gr = g.createRadialGradient(x, y, r * 0.55, x, y, r);
        gr.addColorStop(0, `rgba(${gh.c},0)`);
        gr.addColorStop(0.8, `rgba(${gh.c},${gh.a * I * away})`);
        gr.addColorStop(1, `rgba(${gh.c},0)`);
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
      } else glow(x, y, r, gh.a * I * away, gh.c);
    }
    g.globalCompositeOperation = 'source-over';
  }
}
