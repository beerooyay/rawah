import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { doyOf } from './calendar.js';
import { renderThumb } from './thumbs.js';
import { AnimLibrary, retarget, BODY_SCALE } from './anims.js';

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
export function buildTitle({ trailheads, pick, characters, onTime }) {
  // one icon language for every pick: 24px line-art, currentColor stroke
  const IC = {
    flower: '<circle cx="12" cy="11" r="2"/><path d="M12 8.5c-2.5 0-2.5-4 0-4s2.5 4 0 4Zm0 5c2.5 0 2.5 4 0 4s-2.5-4 0-4Zm-2.5-2.5c0 2.5-4 2.5-4 0s4-2.5 4 0Zm5 0c0-2.5 4-2.5 4 0s-4 2.5-4 0Z"/><path d="M12 15v6"/>',
    sprout: '<path d="M12 21v-8"/><path d="M12 13c0-4 3-6 7-6 0 4-3 6-7 6Zm0-2c0-3-2.5-4.5-5.5-4.5C6.5 9.5 9 11 12 11"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.7m0 13.6v2.7M2.5 12h2.7m13.6 0h2.7M5.3 5.3l1.9 1.9m9.6 9.6 1.9 1.9m0-15.4-1.9 1.9M7.2 16.8l-1.9 1.9"/>',
    heat: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.7m0 13.6v2.7M2.5 12h2.7m13.6 0h2.7M5.3 5.3l1.9 1.9m9.6 9.6 1.9 1.9m0-15.4-1.9 1.9M7.2 16.8l-1.9 1.9"/><path d="M3.5 21h4m3 0h4m3 0h3"/>',
    leaf: '<path d="M6 19C6 10 12 4.5 20 4.5 20 12.5 14 19 6 19Z"/><path d="M6 19c2.5-5.5 6-9 10-11"/>',
    snow: '<path d="M12 3v18m0-18-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M4.2 7.5l15.6 9M4.2 7.5l-.2 4m.2-4 3.9-.6M19.8 16.5l.2-4m-.2 4-3.9.6M19.8 7.5l-15.6 9m15.6-9 .2 4m-.2-4-3.9-.6M4.2 16.5l-.2-4m.2 4 3.9.6"/>',
    sunrise: '<path d="M3.5 18.5h17M8 18.5a4 4 0 0 1 8 0"/><path d="M12 8v3.5M6.2 9.7l2.2 2.2M17.8 9.7l-2.2 2.2M12 4l-2 2.5M12 4l2 2.5"/>',
    morning: '<circle cx="12" cy="14.5" r="3.5"/><path d="M12 5.5v3M6 9l2 2M18 9l-2 2M4 19h16"/>',
    noon: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5m0 14v2.5M2.5 12H5m14 0h2.5M5.3 5.3 7 7m10 10 1.7 1.7m0-15.4L17 7M7 17l-1.7 1.7"/>',
    golden: '<path d="M3.5 19.5h17M7 19.5a5 5 0 0 1 10 0"/><path d="M12 8.5V5M6.8 9.8 5 8M17.2 9.8 19 8"/>',
    dusk: '<path d="M4 19h16"/><path d="M15 13.5a5 5 0 0 1-8.5-3.5 5 5 0 0 0 8.5 3.5Z"/><path d="M17 5.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5Z"/>',
    moon: '<path d="M15.5 3a8 8 0 1 0 5.5 13.9A8 8 0 0 1 15.5 3Z"/><path d="M17.5 4.5l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5Z"/>',
  };
  const SEA_IC = { 'Spring thaw': 'sprout', 'Early summer': 'sun', 'Midsummer': 'heat', 'High fall': 'leaf', 'Deep winter': 'snow' };
  const TIM_IC = { 'Dawn': 'sunrise', 'Morning': 'morning', 'Midday': 'noon', 'Golden hour': 'golden', 'Dusk': 'dusk', 'Night': 'moon' };

  // a row of circular icon buttons bound to a pick field; numbers mark the closest value, strings the exact one
  const chips = (rootId, items, get, set, iconOf) => {
    const root = $(rootId);
    const btns = items.map(([label, v]) => {
      const b = el('button', 'ic');
      b.title = label;
      b.setAttribute('aria-label', label);
      const badge = el('span', 'ic-badge');
      badge.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${IC[iconOf(label)] || ''}</svg>`;
      b.appendChild(badge);
      b.appendChild(el('span', 'ic-name', label.replace(' hour', '').replace(' thaw', '').replace(' summer', '')));
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

  chips('chips-season', SEASONS, () => pick.doy, (v) => { pick.doy = v; }, (l) => SEA_IC[l]);
  chips('chips-time', TIMES, () => pick.hour, (v) => { pick.hour = v; onTime?.(v); }, (l) => TIM_IC[l]);

  // ---- who: a circle of faces, click to pick
  const names = Object.keys(characters);
  const castRoot = $('chips-cast'), shots = {};
  let cur = 0;
  const markCast = () => [...castRoot.children].forEach((b, i) => b.classList.toggle('on', i === cur));
  const castBtns = names.map((n, i) => {
    const b = el('button', 'ic cast-ic');
    b.title = cap(n); b.setAttribute('aria-label', cap(n));
    const img = document.createElement('img');
    img.alt = ''; img.draggable = false; img.className = 'cast-face';
    const wrap = el('span', 'face-wrap');
    wrap.appendChild(img);
    b.appendChild(wrap); b.appendChild(el('span', 'ic-name', cap(n)));
    b.onclick = () => show(i);
    castRoot.appendChild(b);
    return b;
  });
  const show = (i) => {
    cur = (i + names.length) % names.length;
    pick.character = names[cur];
    markCast();
    buildCrew?.();
  };
  document.addEventListener('keydown', (e) => {
    if ($('title').classList.contains('hidden')) return;
    if (e.code === 'ArrowLeft') show(cur - 1);
    else if (e.code === 'ArrowRight') show(cur + 1);
  });
  pick.trailhead = (trailheads.find((t) => t.name.includes('West Branch')) || trailheads[0]).name;   // always west branch

  // ---- who tryna come: chips for everyone you are not playing as; empty means the usual two
  const crewAll = () => (pick.party && pick.party.length ? pick.party : names.filter((n) => n !== pick.character).slice(0, 2));
  const crewRow = el('div', 'crew-row');
  const card3 = document.querySelectorAll('.pick-card')[2];
  const buildCrew = () => {
    if (!card3) return;
    if (!crewRow.parentNode) { card3.appendChild(el('div', 'mc-div')); card3.appendChild(el('div', 'mc-sub', 'Who tryna come?')); card3.appendChild(crewRow); }
    crewRow.innerHTML = '';
    for (const n of names.filter((x) => x !== pick.character)) {
      const b = el('button', 'togchip', cap(n));
      b.dataset.name = n;
      b.onclick = () => { const cur = crewAll(); pick.party = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n]; b.classList.toggle('on'); };
      b.classList.toggle('on', crewAll().includes(n));
      crewRow.appendChild(b);
    }
  };
  buildCrew();
  show(Math.max(0, names.indexOf(pick.character)));

  // portraits render once their models arrive, so the menu opens without waiting for them;
  // each is photographed mid-idle, posed by the same retarget the game uses
  const loader = new GLTFLoader(), lib = new AnimLibrary();
  const idle = lib.load(['Neutral Idle']).then(() => lib.get('Neutral Idle')).catch(() => null);
  const measure = (model) => {
    model.updateMatrixWorld(true);
    const bones = [];
    model.traverse((o) => { if (o.isBone) bones.push(o); });
    const hips = bones.find((b) => b.name === 'mixamorigHips');
    const list = bones.map((b) => ({ name: b.name, parent: b.parent?.isBone ? b.parent.name : null, wq: b.getWorldQuaternion(new THREE.Quaternion()), wp: b.getWorldPosition(new THREE.Vector3()) }));
    const root = new THREE.Quaternion();
    hips.parent.getWorldQuaternion(root);
    return { bones: list, rootQ: root, hips: (hips.getWorldPosition(new THREE.Vector3()).y / model.scale.y) * 100 };
  };
  // the hiker on screen loads first, so the card you are looking at fills in first
  const order = [names[cur], ...names.filter((n) => n !== names[cur])];
  for (const name of order) {
    Promise.all([loader.loadAsync(characters[name]), idle]).then(([g, clip]) => {
      const model = g.scene;
      model.scale.setScalar(BODY_SCALE);
      model.traverse((o) => { for (const mt of [].concat(o.material || [])) if (mt && 'metalness' in mt) mt.metalness = 0; });
      if (clip && lib.srcRest) {
        const mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(retarget(clip, lib.srcRest, measure(model))).play();
        mixer.setTime(1.05);
        model.updateMatrixWorld(true);
      }
      shots[name] = renderThumb(model, { w: 460, h: 620, yaw: 0.45, lift: 0.2 });
      const img = castBtns[names.indexOf(name)]?.querySelector('img');
      if (img) { img.src = shots[name]; img.classList.add('on'); }
    }).catch((err) => console.warn(`portrait for ${name} failed`, err));
  }
}
