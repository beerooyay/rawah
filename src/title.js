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

  // ---- who: each character with the car they drive, parked where the trailhead says
  const cards = new Map();
  const where = () => { for (const c of cards.values()) c.where.textContent = `Parked at ${pick.trailhead}`; };
  chips('chips-place', trailheads.map((p) => [p.name.replace(/ Trailhead$/, ''), p.name]), () => pick.trailhead, (v) => { pick.trailhead = v; where(); });
  for (const name of Object.keys(characters)) {
    const root = el('button', 'cast-card');
    root.setAttribute('aria-pressed', 'false');
    const art = el('div', 'cast-art');
    const portrait = el('img', 'portrait');
    portrait.alt = '';
    art.append(portrait);
    const where2 = el('div', 'cast-where');
    root.append(art, el('div', 'cast-name', cap(name)), where2);
    root.onclick = () => { pick.character = name; for (const [n, c] of cards) c.root.setAttribute('aria-pressed', String(n === name)); };
    $('cast').appendChild(root);
    cards.set(name, { root, where: where2, portrait });
  }
  cards.forEach((c, name) => c.root.setAttribute('aria-pressed', String(name === pick.character)));
  where();

  // characters are drawn once their models arrive, so the menu opens without waiting for them
  const loader = new GLTFLoader();
  for (const name of Object.keys(characters)) {
    loader.loadAsync(characters[name]).then((g) => {
      g.scene.traverse((o) => { for (const mt of [].concat(o.material || [])) if (mt && 'metalness' in mt) mt.metalness = 0; });
      cards.get(name).portrait.src = renderThumb(g.scene, { yaw: 0.45, lift: 0.2 });
    }).catch(() => {});
  }
}
