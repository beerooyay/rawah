import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { doyOf } from './calendar.js';
import { renderThumb } from './thumbs.js';

// The title screen's four choices, each a row of chips over the live world:
// the season, the hour, the trailhead and who you play as. Every chip writes
// into `pick`, which main.js reads when you start hiking.

const cap = (n) => n[0].toUpperCase() + n.slice(1);
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// season chips stand in for a real date on the calendar; the world renders the season, not the number
const SEASONS = [['Spring thaw', doyOf(4, 1)], ['Early summer', doyOf(5, 15)], ['Midsummer', doyOf(6, 25)], ['High fall', doyOf(9, 1)], ['Deep winter', doyOf(11, 15)]];
const TIMES = [['Dawn', 6], ['Morning', 9], ['Midday', 13], ['Golden hour', 18.5], ['Dusk', 20.5], ['Night', 23]];

/**
 * Wires the title picks. `trailheads` are the places to park at and
 * `characters` maps each name to its model URL.
 */
export function buildTitle({ trailheads, pick, characters }) {
  // a row of chips bound to a pick field; numbers mark the closest value, strings the exact one
  const chips = (rootId, items, get, set) => {
    const root = $(rootId);
    const btns = items.map(([label, v]) => {
      const b = el('button', 'chip', label);
      b.onclick = () => { set(v); mark(); };
      root.appendChild(b);
      return [b, v];
    });
    const mark = () => {
      const cur = get();
      let best = btns[0];
      for (const e of btns) if (typeof e[1] === 'number' ? Math.abs(e[1] - cur) < Math.abs(best[1] - cur) : e[1] === cur) best = e;
      for (const [b] of btns) b.classList.toggle('on', b === best[0]);
    };
    mark();
    return mark;
  };

  chips('chips-season', SEASONS, () => pick.doy, (v) => { pick.doy = v; });
  chips('chips-time', TIMES, () => pick.hour, (v) => { pick.hour = v; });

  // ---- who: one hiker at a time, cycled by arrows, dots or the arrow keys
  const names = Object.keys(characters);
  const card = $('cast'), img = card.querySelector('img');
  const nameEl = card.querySelector('.cast-name'), whereEl = card.querySelector('.cast-where');
  const shots = {};
  let cur = 0;
  const show = (i, dir = 0) => {
    cur = (i + names.length) % names.length;
    pick.character = names[cur];
    nameEl.textContent = cap(names[cur]);
    whereEl.textContent = `Parked at ${pick.trailhead}`;
    if (shots[names[cur]]) img.src = shots[names[cur]];
    img.alt = names[cur];
    for (const [j, d] of dotEls.entries()) d.classList.toggle('on', j === cur);
    if (dir) card.animate([{ opacity: 0, transform: `translateX(${12 * dir}px)` }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'ease-out' });
  };
  const dotEls = names.map((n, i) => {
    const d = el('button', 'cast-dot');
    d.setAttribute('aria-label', cap(n));
    d.onclick = () => show(i, i > cur ? 1 : -1);
    $('cast-dots').appendChild(d);
    return d;
  });
  $('cast-prev').onclick = () => show(cur - 1, -1);
  $('cast-next').onclick = () => show(cur + 1, 1);
  document.addEventListener('keydown', (e) => {
    if ($('title').classList.contains('hidden')) return;
    if (e.code === 'ArrowLeft') show(cur - 1, -1);
    else if (e.code === 'ArrowRight') show(cur + 1, 1);
  });
  chips('chips-place', trailheads.map((p) => [p.name.replace(/ Trailhead$/, ''), p.name]), () => pick.trailhead, (v) => { pick.trailhead = v; show(cur); });
  show(Math.max(0, names.indexOf(pick.character)));

  // portraits render once their models arrive, so the menu opens without waiting for them
  const loader = new GLTFLoader();
  for (const name of names) {
    loader.loadAsync(characters[name]).then((g) => {
      g.scene.traverse((o) => { for (const mt of [].concat(o.material || [])) if (mt && 'metalness' in mt) mt.metalness = 0; });
      shots[name] = renderThumb(g.scene, { w: 400, h: 500, yaw: 0.45, lift: 0.2 });
      if (names[cur] === name) img.src = shots[name];
    }).catch(() => {});
  }
}
