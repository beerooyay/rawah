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
  // a row of circular icon buttons bound to a pick field; numbers mark the closest value, strings the exact one
  const chips = (rootId, items, get, set, iconOf) => {
    const root = $(rootId);
    const btns = items.map(([label, v], i) => {
      const b = el('button', 'ic');
      b.title = label;
      b.setAttribute('aria-label', label);
      b.appendChild(el('span', `ic-dot ${iconOf ? iconOf(label, i) : ''}`));
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

  const SEA_IC = { 'Spring thaw': 's1', 'Early summer': 's2', 'Midsummer': 's3', 'High fall': 's4', 'Deep winter': 's5' };
  const TIM_IC = { 'Dawn': 't1', 'Morning': 't2', 'Midday': 't3', 'Golden hour': 't4', 'Dusk': 't5', 'Night': 't6' };
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
  };
  document.addEventListener('keydown', (e) => {
    if ($('title').classList.contains('hidden')) return;
    if (e.code === 'ArrowLeft') show(cur - 1);
    else if (e.code === 'ArrowRight') show(cur + 1);
  });
  chips('chips-place', trailheads.map((p) => [p.name.replace(/ Trailhead$/, ''), p.name]), () => pick.trailhead, (v) => { pick.trailhead = v; }, () => 'p1');
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
