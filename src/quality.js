// Quality tiers. "auto" picks low on phones, medium on tablets and touch
// laptops, high on desktops. Everything that costs GPU time scales from here.

export const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const small = Math.min(screen.width, screen.height) < 820;

export const PRESETS = {
  high: {
    dpr: 2, aa: true, logDepth: true, shadows: true, shadowMap: 2048, rangeK: 2.3,
    grass: { radius: 26, spacing: 0.19 },
    flora: { card: 85, radius: 1250, thin: 700, impostor: 4096 },
  },
  medium: {
    dpr: 1.5, aa: true, logDepth: true, shadows: true, shadowMap: 2048, rangeK: 2.0,
    grass: { radius: 20, spacing: 0.24 },
    flora: { card: 65, radius: 1000, thin: 550, impostor: 4096 },
  },
  low: {
    dpr: 1, aa: false, logDepth: false, shadows: false, shadowMap: 1024, rangeK: 1.7,
    grass: { radius: 15, spacing: 0.3 },
    flora: { card: 45, radius: 750, thin: 380, impostor: 2048 },
  },
};

export function resolveQuality(pref = 'auto') {
  if (PRESETS[pref]) return pref;
  return isTouch ? (small ? 'low' : 'medium') : 'high';
}
