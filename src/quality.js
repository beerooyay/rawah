// Quality tiers. "auto" picks low on phones, medium on tablets and touch
// laptops, high on desktops. Everything that costs GPU time scales from here.

export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const small = Math.min(screen.width, screen.height) < 820;

export const PRESETS = {
  high: {
    dpr: 2, aa: true, logDepth: true, shadows: true, shadowMap: 2048, rangeK: 2.3,
    grass: { radius: 32, spacing: 0.42 },
    flora: { card: 85, radius: 1250, thin: 700, impostor: 4096 },
    precip: 8000,
  },
  medium: {
    dpr: 1.5, aa: true, logDepth: true, shadows: true, shadowMap: 2048, rangeK: 2.0,
    grass: { radius: 26, spacing: 0.5 },
    flora: { card: 65, radius: 1000, thin: 550, impostor: 4096 },
    precip: 5000,
  },
  low: {
    dpr: 1, aa: false, logDepth: false, shadows: false, shadowMap: 1024, rangeK: 1.7,
    grass: { radius: 18, spacing: 0.62 },
    flora: { card: 45, radius: 750, thin: 380, impostor: 2048 },
    precip: 2500,
  },
};

/** Render scale bounds for the adaptive resolution, as fractions of the preset's pixel ratio. */
export const SCALE = { min: 0.6, max: 1 };

export function resolveQuality(pref = 'auto') {
  if (PRESETS[pref]) return pref;
  return isTouch ? (small ? 'low' : 'medium') : 'high';
}
