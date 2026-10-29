// Quality tiers. "auto" picks low on phones, medium on tablets and touch
// laptops, high on desktops. Everything that costs GPU time scales from here.
// `logDepth` is a logarithmic depth buffer: far-view precision by writing every fragment's depth,
// which turns off early depth rejection and more than doubled the frame time on a laptop GPU. It is
// off in every preset; Settings -> Distance depth -> Extended turns it on (camera.near/far change with it).

export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const small = Math.min(screen.width, screen.height) < 820;

export const PRESETS = {
  high: {
    dpr: 2, aa: true, logDepth: false, shadows: true, shadowMap: 2048, rangeK: 2.3, shafts: 34, clouds: { steps: 64, scale: 0.5 },
    grass: { radius: 58, spacing: 0.35 },
    flora: { card: 100, radius: 1900, thin: 1000, impostor: 4096, cap: 320000 },
    precip: 8000,
  },
  medium: {
    dpr: 1.5, aa: true, logDepth: false, shadows: true, shadowMap: 2048, rangeK: 2.0, shafts: 22, clouds: { steps: 48, scale: 0.5 },
    grass: { radius: 40, spacing: 0.44 },
    flora: { card: 78, radius: 1500, thin: 800, impostor: 4096, cap: 220000 },
    precip: 5000,
  },
  low: {
    dpr: 1, aa: false, logDepth: false, shadows: false, shadowMap: 1024, rangeK: 1.7, shafts: 0, soil: false, clouds: { steps: 32, scale: 0.35 },
    grass: { radius: 22, spacing: 0.6 },
    flora: { card: 45, radius: 750, thin: 380, impostor: 2048, cap: 120000 },
    precip: 2500,
  },
};

/** Render scale bounds for the adaptive resolution, as fractions of the preset's pixel ratio. */
export const SCALE = { min: 0.6, max: 1 };

export function resolveQuality(pref = 'auto') {
  if (PRESETS[pref]) return pref;
  return isTouch ? (small ? 'low' : 'medium') : 'high';
}
