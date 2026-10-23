import * as THREE from 'three';
import { World } from './world.js';
import { farTerrain, terrainMaterial, colorTexture, coverTexture, makeNoiseTexture } from './terrain.js';
import { CDLODTerrain } from './cdlod.js';
import { Flora } from './flora.js';
import { buildLakes, buildTrails, buildSigns, buildStreams } from './features.js';
import { Sky, setSun } from './sky.js';
import { Calendar, SEASONS } from './calendar.js';
import { Hiker } from './hiker.js';
import { Camp } from './camp.js';
import { Hud, keyCap } from './hud.js';
import { GameMap } from './map.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { Character, CHARACTERS } from './character.js';
import { Party } from './companions.js';
import { Props } from './props.js';
import { Mind } from './mind.js';
import { TOOL_NAME } from './tools.js';
import { clamp, smoothstep, lerp } from './noise.js';
import { Grass } from './grass.js';
import { updateAtmosphere, atmosphere } from './atmosphere.js';
import { Weather, REGIMES } from './weather.js';
import { Precip } from './precip.js';
import { skyViewTexture } from './skyview.js';
import { gustAt, WIND_DIR } from './wind.js';
import { PRESETS, resolveQuality, isTouch, SCALE } from './quality.js';
import { setRangeK } from './cdlod.js';

const SAVE_KEY = 'rawah-save-v2';
const $ = (id) => document.getElementById(id);
const DEV = ['localhost', '127.0.0.1', ''].includes(location.hostname);

const settings = loadJSON('rawah-settings', { sens: 1, fov: 72, volume: 0.8, timeScale: 1, quality: 'auto', season: 'autumn' });
if (!SEASONS[settings.season]) settings.season = 'autumn';
const calendar = new Calendar(SEASONS[settings.season].doy);
const QUALITY = resolveQuality(settings.quality);
const Q = PRESETS[QUALITY];
settings.shadows ??= Q.shadows;
setRangeK(Q.rangeK);

// ------------------------------------------------------------------ renderer
// Colour grade, folded into the tone mapper so it costs nothing extra: ACES, then more vibrance where
// colour is dull, a gentle S-curve, and a split tone (cool shadows, warm highlights). Filmic and dusty
// like a western, but with the saturated, clean air of a painted sci-fi planet.
THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment
  .replace('vec3 ACESFilmicToneMapping( vec3 color ) {', 'vec3 ACESFilmicBase( vec3 color ) {')
  + `
vec3 ACESFilmicToneMapping( vec3 color ) {
  vec3 c = clamp( ACESFilmicBase( color ), 0.0, 1.0 );
  float l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  float sat = max( c.r, max( c.g, c.b ) ) - min( c.r, min( c.g, c.b ) );
  c = vec3( l ) + ( c - vec3( l ) ) * ( 1.12 + 0.42 * ( 1.0 - clamp( sat * 1.6, 0.0, 1.0 ) ) );
  c = mix( c, c * c * ( 3.0 - 2.0 * c ), 0.12 );
  l = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  c *= mix( vec3( 0.95, 1.0, 1.06 ), vec3( 1.06, 1.0, 0.92 ), smoothstep( 0.08, 0.75, l ) );
  return clamp( c, 0.0, 1.0 );
}
`;

const renderer = new THREE.WebGLRenderer({ antialias: Q.aa, logarithmicDepthBuffer: Q.logDepth, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, Q.dpr));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = settings.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // redrawn every other frame; see the loop
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, Q.logDepth ? 0.1 : 0.4, Q.logDepth ? 90000 : 40000);
camera.rotation.order = 'YXZ';
const headlamp = new THREE.SpotLight(0xfff1dc, 0, 70, 0.42, 0.55, 1.4);
headlamp.position.set(0.15, 0.05, 0);
headlamp.target.position.set(0, -0.6, -6);
camera.add(headlamp, headlamp.target);
scene.add(camera);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

// ------------------------------------------------------------------ load
const setLoad = (f, text) => {
  $('load-bar').style.width = `${Math.round(f * 100)}%`;
  if (text) $('load-text').textContent = text;
};
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// canvases (compass, map, signposts) draw with these, so they must be ready before anything is painted
await Promise.all(['400 14px Gabarito', '600 14px Gabarito', '700 14px Gabarito', '400 20px "Paytone One"'].map((f) => document.fonts.load(f).catch(() => {})));
setLoad(0.02, 'Downloading the Rawah…');
const world = await World.load('./data', (f) => setLoad(f * 0.6));
setLoad(0.7, 'Raising the Medicine Bow crest…');
await frame();
const noiseTex = makeNoiseTexture();
atmosphere.uCloudTex.value = noiseTex;
setLoad(0.72, 'Measuring the sky from every cirque…');
await frame();
atmosphere.uSkyView.value = skyViewTexture(world);
atmosphere.uSkyExtent.value = world.extent;
const F = world.far;
const farMat = terrainMaterial(colorTexture(F.image), F.N * F.cell, noiseTex);
await frame();

const terrain = new CDLODTerrain(world, { colorMap: colorTexture(world.colorImage), coverMap: coverTexture(world.coverData, world.coverN), noise: noiseTex, detail: QUALITY !== 'low' });
scene.add(terrain.group);
scene.add(farTerrain(world, farMat));
const sky = new Sky(scene);
sky.sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
const lakes = buildLakes(world);
scene.add(lakes.group);
scene.add(buildTrails(world));
scene.add(buildSigns(world));
const streams = buildStreams(world);
scene.add(streams.group);
const flora = new Flora(world, scene, renderer, Q.flora, calendar.leaves);
const weather = new Weather();
weather.override = REGIMES[settings.weather] ? settings.weather : null;
const precip = new Precip(Q.precip);
scene.add(precip.mesh);
const grass = new Grass(terrain, Q.grass, flora.uniforms);
scene.add(grass.mesh);
const camp = new Camp(world, flora, scene);
const hiker = new Hiker(world, flora);
const charParam = new URLSearchParams(location.search).get('char');
const playerName = CHARACTERS[charParam] ? charParam : CHARACTERS[settings.character] ? settings.character : 'blaize';
const avatar = new Character(scene, playerName);
const party = new Party(world, flora, scene, avatar.lib, playerName);   // the other two friends
party.camera = camera;
party.onRace = (r) => raceEnded(r);
const rig = new CameraRig(camera, world, hiker, avatar);
const props = new Props({ world, flora, scene, camera, hiker, rig, avatar, hud: null, audio: null });
const hud = new Hud(world);
const mind = new Mind({ scene, world, hiker, camera, hud, audio: null });
// ground that was reshaped: trees and rocks that stood on it are replanted at the new height
const shaped = (rect) => { flora.reground(rect); props.settle(rect); camp.settle(rect); };
const map = new GameMap(world);
const audio = new Audio();
props.hud = hud; props.audio = audio; mind.audio = audio;
party.onSwing = (x, y, z, nx, nz) => props.swingFx(x, y, z, nx, nz);
setLoad(0.85, 'Drawing the map…');
await frame();
map.build(world.colorImage);

// ------------------------------------------------------------------ state
const lakeList = world.lakes.filter((l) => l.name);      // every named pool, for finding them as you walk by
// a name shared by several pools (Twin Lakes, Camp Lake) counts and lists once
const lakeNames = [...new Map([...lakeList].sort((a, b) => b.area - a.area).map((l) => [l.label, l])).values()];
const peaks = world.places.filter((p) => p.kind === 'peak');
const trailhead = world.mainTrailhead || world.places.find((p) => p.kind === 'trailhead');
const state = {
  hour: 7.25, day: 1, km: 0,
  discovered: new Set(),
  paused: true, started: false,
  sleeping: 0, resting: false,
  rescue: null, travel: null,
};
let hudState = null; // the last thing the HUD showed; the map reads it too
let frameNo = 0, togetherOpen = false;

function spawnAtCar() {
  const { x, z, toward } = world.startSpot || { ...trailhead, toward: [trailhead.x - 1, trailhead.z] };
  // face up the trail toward the mountains
  hiker.place(x, z, Math.atan2(-(toward[0] - x), -(toward[1] - z)));
}

function save() {
  const data = {
    x: hiker.pos.x, z: hiker.pos.z, yaw: hiker.yaw, hour: state.hour, day: state.day, km: state.km,
    discovered: [...state.discovered], camp: camp.save(),
    stamina: hiker.stamina, warmth: hiker.warmth, weather: weather.save(), props: props.save(), sculpt: mind.save(), races: party.races,
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* private mode */ }
}

function restore() {
  const s = loadJSON(SAVE_KEY, null);
  if (!s) return false;
  hiker.place(s.x, s.z, s.yaw);
  Object.assign(state, { hour: s.hour, day: s.day, km: s.km || 0 });
  state.discovered = new Set(s.discovered || []);
  hiker.stamina = s.stamina ?? 100; hiker.warmth = s.warmth ?? 100;
  camp.load(s.camp);
  weather.load(s.weather);
  props.load(s.props);
  if (s.races) party.races = s.races;
  mind.load(s.sculpt);
  shaped({ x0: -Infinity, z0: -Infinity, x1: Infinity, z1: Infinity });
  return true;
}

const hasSave = !!loadJSON(SAVE_KEY, null);
spawnAtCar();
$('btn-continue').classList.toggle('hidden', !hasSave);

// ------------------------------------------------------------------ input
const input = new Input(renderer.domElement);
const { keys, pressed } = input;
if (isTouch) input.enableTouch(document.body);
document.addEventListener('visibilitychange', () => { if (document.hidden && state.started && !state.paused) pause(true); });
input.onPress = (code) => {
  if (togetherOpen && (code === 'Escape' || code === 'KeyH')) { toggleTogether(false); return; }
  if (!state.started || state.travel) return;
  if (document.activeElement?.tagName === 'INPUT' && document.activeElement.type === 'search') return;   // typing in the map's search
  if (code === 'Escape' && map.open) { toggleMap(); return; }
  if ((code === 'KeyM' || code === 'Tab') && !state.paused) toggleMap();
  if (code === 'KeyV' && !state.paused && !map.open) hud.toast(rig.toggle() === 'first' ? 'First person' : 'Third person · scroll to zoom');
  if (code === 'KeyT' && !state.paused && !map.open) props.cycleTool();
  if (code === 'KeyH' && !state.paused && !map.open) toggleTogether();
  if (code === 'KeyP' && !map.open) swapPlayer();
  if (code === 'Escape' && input.mode !== 'kbm') pause(!state.paused); // keyboard Escape releases pointer lock instead
};
input.onPad = (name, stickOnly) => {
  if (togetherOpen) {
    if (name === 'B' || name === 'Start') toggleTogether(false);
    else menuPad($('together'), name);
    return;
  }
  if (map.open) {
    if (name === 'B') toggleMap();
    else map.pad(name, stickOnly);
    return;
  }
  const sheet = !$('controls-sheet').classList.contains('hidden') ? $('controls-sheet') : null;
  const screen = sheet || (!state.started ? $('title') : state.paused ? $('pause') : null);
  if (sheet && (name === 'B' || name === 'Start')) { closeControls(); return; }
  if (screen === $('pause') && (name === 'LB' || name === 'RB')) { cycleTab(name === 'RB' ? 1 : -1); return; }
  if (screen) menuPad(screen, name);
};
renderer.domElement.addEventListener('click', () => { if (state.started && !state.paused) lockPointer(); });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement && state.started && !map.open && !state.sleeping && !state.travel) pause(true);
});

/** Gamepad focus for menus: D-pad or stick moves, A presses, left/right adjusts sliders, B backs out. */
function menuPad(screen, name) {
  const items = [...screen.querySelectorAll('button, input, select')].filter((el) => el.offsetParent && !el.disabled);
  if (!items.length) return;
  let i = items.indexOf(document.activeElement);
  const focus = (j) => {
    for (const el of items) el.classList.remove('pad-focus');
    const el = items[(j + items.length) % items.length];
    el.focus({ preventScroll: false });
    el.classList.add('pad-focus');
    el.scrollIntoView({ block: 'nearest' });
  };
  if (i < 0) { focus(0); if (name !== 'A') return; i = 0; }
  const el = items[i];
  const adjust = (dir) => {
    if (el.type === 'range') {
      el.value = Number(el.value) + dir * Number(el.step || 1);
      el.dispatchEvent(new Event('input'));
      return true;
    }
    if (el.tagName === 'SELECT') {
      el.selectedIndex = clamp(el.selectedIndex + dir, 0, el.options.length - 1);
      el.dispatchEvent(new Event('change'));
      return true;
    }
    return false;
  };
  if (name === 'Down') focus(i + 1);
  else if (name === 'Up') focus(i - 1);
  else if (name === 'Left') { if (!adjust(-1)) focus(i - 1); }
  else if (name === 'Right') { if (!adjust(1)) focus(i + 1); }
  else if (name === 'A') {
    if (el.type === 'checkbox') { el.checked = !el.checked; el.dispatchEvent(new Event('change')); }
    else if (el.tagName === 'BUTTON') el.click();
  } else if ((name === 'B' || name === 'Start') && state.paused && state.started) pause(false);
  else if (name === 'Start' && !state.started) (hasSave ? $('btn-continue') : $('btn-start')).click();
}

function lockPointer() {
  if (isTouch) return;
  try { renderer.domElement.requestPointerLock()?.catch?.(() => {}); } catch { /* headless */ }
}

function toggleMap() {
  if (map.open) {
    map.hide();
    document.body.classList.remove('map-open');
    lockPointer();
    return;
  }
  if (!hudState) return;
  map.show(hudState);
  document.body.classList.add('map-open');
  const pad = (b, cls = '') => `<span class="key pad ${cls}">${b}</span>`;
  $('map-hint').innerHTML = input.mode === 'pad'
    ? `<span>${pad('LS')} cursor</span><span>${pad('LT')}${pad('RT')} zoom</span><span>${pad('LB')}${pad('RB')} filter</span><span>${pad('A', 'a')} travel</span><span>${pad('Y', 'y')} find me</span><span>${pad('B', 'b')} close</span>`
    : input.mode === 'touch' ? '<span>Tap a place · drag to pan · pinch to zoom</span>'
      : `<span>Click a place · drag to pan · scroll to zoom</span><span>${keyCap('/', 'kbm')} search</span><span>${keyCap('Enter', 'kbm')} travel</span><span>${keyCap('M', 'kbm')} close</span>`;
  if (document.pointerLockElement) document.exitPointerLock();
}
map.onClose = () => { if (map.open) toggleMap(); };
map.onTravel = (d) => startTravel(d);
$('btn-map').onclick = () => { pause(false); toggleMap(); };

function pause(on) {
  state.paused = on;
  document.body.classList.toggle('playing', state.started && !on);
  $('pause').classList.toggle('hidden', !on);
  if (on) { renderJournal(); keys.clear(); showTab('journal'); $('bubble').classList.add('hidden'); $('btn-swap').textContent = `Play as ${cap(nextFriend())}`; }
  else { lockPointer(); restartArmed = 0; $('btn-restart').textContent = 'Start over'; }
}

// pause-sheet tabs (LB / RB on a pad)
const TABS = ['journal', 'settings', 'controls'];
let tab = 'journal';
function showTab(name) {
  tab = name;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('on', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('hidden', p.dataset.panel !== name);
  if (name === 'controls') renderControls($('controls-pause'), null);
}
function cycleTab(dir) { showTab(TABS[(TABS.indexOf(tab) + dir + TABS.length) % TABS.length]); }
for (const b of document.querySelectorAll('.tab')) b.onclick = () => showTab(b.dataset.tab);

/** The controls reference: the essentials for the scheme in use, with a switch to see the others. */
function renderControls(el, mode) {
  mode = mode || (input.mode === 'pad' || input.mode === 'touch' ? input.mode : 'kbm');
  const k = (c) => keyCap(c, 'kbm'), p = (b, cls = '') => `<span class="key pad ${cls}">${b}</span>`, t = (x) => `<span class="key">${x}</span>`;
  const rows = {
    kbm: [[k('W') + k('A') + k('S') + k('D'), 'Walk'], ['Mouse', 'Look'], [k('Shift'), 'Hike fast'], [k('Space'), 'Hop'], [k('X'), 'Crouch, lie down'],
      [t('Click'), 'Punch, swing, lift'], [t('Right click'), 'Hook, sink'], [k('E'), 'Pick up, grab, level'], [k('T'), 'Tool'], [k('V'), 'Camera'],
      [k('C') + k('F'), 'Tent, campfire'], [k('M'), 'Map'], [k('H'), 'Call the friends together'], [k('P'), 'Play as the next friend'], [k('Esc'), 'Pause']],
    pad: [[p('LS'), 'Walk'], [p('RS'), 'Look'], [p('RT'), 'Hike fast'], [p('A', 'a'), 'Hop'], [p('B', 'b'), 'Pick up, grab, level'], [p('R3'), 'Tool'],
      [p('LB'), 'Together'], [p('Y', 'y'), 'Camera'], [p('X', 'x'), 'Tent'], [p('RB'), 'Campfire'], [p('LT'), 'Rest'], [p('D-pad'), 'Crouch, punch, hook'], [p('View'), 'Map'], [p('Menu'), 'Pause']],
    touch: [['Left thumb', 'Walk'], ['Right thumb', 'Look'], [t('Hop') + t('Fast'), 'Hop, hike fast'], [t('Duck'), 'Crouch'], [t('Punch'), 'Punch, swing, lift'], [t('Hook'), 'Hook, sink'],
      [t('Grab'), 'Pick up, grab, level'], [t('Tool'), 'Tool'], [t('Together'), 'Call the friends together'], [t('Camp') + t('Fire'), 'Tent, campfire'], [t('Rest'), 'Hold to rest'], [t('Map'), 'Map']],
  };
  const names = { kbm: 'Keyboard', pad: 'Controller', touch: 'Touch' };
  el.innerHTML = `<div class="seg" role="tablist">${Object.keys(names).map((m) => `<button data-mode="${m}" class="${m === mode ? 'on' : ''}">${names[m]}</button>`).join('')}</div>
    <dl>${rows[mode].map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>
    <p class="more">Tools (${mode === 'touch' ? t('Tool') : mode === 'pad' ? p('R3') : k('T')}): hands, axe, machete, telekinesis. Telekinesis lifts, sinks and levels the ground; the wheel sets the brush size.</p>`;
  for (const b of el.querySelectorAll('.seg button')) b.onclick = () => renderControls(el, b.dataset.mode);
}
function openControls() { renderControls($('controls-title'), null); $('controls-sheet').classList.remove('hidden'); }
function closeControls() { $('controls-sheet').classList.add('hidden'); }
$('btn-controls').onclick = openControls;
$('controls-close').onclick = closeControls;

function begin(fresh) {
  if (fresh) {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    camp.strike();
    Object.assign(state, { hour: 7.25, day: 1, km: 0 });
    state.discovered = new Set();
    hiker.stamina = hiker.warmth = 100;
    props.reset();
    party.races = { won: 0, lost: 0 };
    mind.load([]);
    shaped({ x0: -Infinity, z0: -Infinity, x1: Infinity, z1: Infinity });
    weather.load({ seed: (Math.random() * 1e9) | 0 });
    spawnAtCar();
    party.event('hello');
  } else restore();
  updateCalendar();
  weather.settle(state.day, state.hour);
  state.started = true;
  if (isTouch) {
    try { document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {}); } catch { /* not allowed */ }
    try { screen.orientation?.lock?.('landscape')?.catch?.(() => {}); } catch { /* not supported */ }
  }
  $('title').classList.add('hidden');
  $('hud').classList.remove('hidden');
  audio.start();
  audio.setVolume(settings.volume);
  pause(false);
  if (fresh) {
    const hello = `${trailhead.name} · ${ft(hiker.pos.y)} ft. Twin Crater Lakes are up the West Branch and Rawah trails.`;
    setTimeout(() => hud.toast(hello), 600);
    setTimeout(() => hud.toast('[V] first / third person · [T] axe · [M] map · [C] camp'), 5200);
  }
}

$('btn-start').onclick = () => begin(true);
$('btn-continue').onclick = () => begin(false);
$('btn-resume').onclick = () => pause(false);
// starting over takes two presses, so it can't happen by accident
let restartArmed = 0;
$('btn-restart').onclick = () => {
  if (performance.now() - restartArmed < 4000) { begin(true); return; }
  restartArmed = performance.now();
  $('btn-restart').textContent = 'Press again to clear your journal';
  setTimeout(() => { if (performance.now() - restartArmed >= 3900) $('btn-restart').textContent = 'Start over'; }, 4000);
};

// season: the title-screen chips and the settings select both reload into the new season
function setSeason(name) {
  if (name === settings.season) return;
  settings.season = name;
  storeJSON('rawah-settings', settings);
  if (state.started) save();
  $('loading').classList.remove('hidden');
  $('load-text').textContent = `Turning the year to ${SEASONS[name].label.split(' · ')[1] || name}…`;
  location.reload();
}
for (const [key, sz] of Object.entries(SEASONS)) {
  const chip = document.createElement('button');
  chip.className = `chip${key === settings.season ? ' on' : ''}`;
  chip.textContent = sz.label.split(' · ')[0];
  chip.title = sz.label;
  chip.onclick = () => setSeason(key);
  $('season-chips').appendChild(chip);
  const opt = document.createElement('option');
  opt.value = key; opt.textContent = sz.label;
  $('set-season').appendChild(opt);
}
// who you play as: the other two walk with you. Changing it reloads (the party is built at boot); Continue picks up your save as the new hiker
function setCharacter(name) {
  if (name === playerName) return;
  settings.character = name;
  storeJSON('rawah-settings', settings);
  if (state.started) save();
  $('loading').classList.remove('hidden');
  $('load-text').textContent = `Switching to ${cap(name)}…`;
  const url = new URL(location.href);
  url.searchParams.delete('char');
  location.href = url.href;
}
const cap = (n) => n[0].toUpperCase() + n.slice(1);
for (const name of Object.keys(CHARACTERS)) {
  const chip = document.createElement('button');
  chip.className = `chip${name === playerName ? ' on' : ''}`;
  chip.textContent = cap(name);
  chip.onclick = () => setCharacter(name);
  $('char-chips').appendChild(chip);
  const opt = document.createElement('option');
  opt.value = name; opt.textContent = cap(name);
  $('set-character').appendChild(opt);
}
$('set-character').value = playerName;
$('set-character').onchange = () => setCharacter($('set-character').value);
$('season-note').textContent = SEASONS[settings.season].label.split(' · ')[1];
$('set-season').value = settings.season;
$('set-season').onchange = () => setSeason($('set-season').value);

// settings controls
const bindRange = (id, key, apply) => {
  const el = $(id);
  el.value = settings[key];
  el.oninput = () => { settings[key] = Number(el.value); apply?.(); storeJSON('rawah-settings', settings); };
};
bindRange('set-sens', 'sens');
bindRange('set-fov', 'fov', () => rig.setFov(settings.fov));
bindRange('set-volume', 'volume', () => audio.setVolume(settings.volume));
bindRange('set-time', 'timeScale');
$('set-quality').value = settings.quality || 'auto';
$('set-quality').onchange = () => {
  settings.quality = $('set-quality').value;
  storeJSON('rawah-settings', settings);
  if (state.started) save();
  location.reload();
};
$('set-weather').value = weather.override || 'live';
$('set-weather').onchange = () => {
  settings.weather = $('set-weather').value;
  weather.override = REGIMES[settings.weather] ? settings.weather : null;
  weather.settle(state.day, state.hour);
  storeJSON('rawah-settings', settings);
};
$('set-shadows').checked = settings.shadows;
$('set-shadows').onchange = () => {
  settings.shadows = $('set-shadows').checked;
  renderer.shadowMap.enabled = settings.shadows;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  storeJSON('rawah-settings', settings);
};

function renderJournal() {
  const list = $('journal-list');
  list.innerHTML = '';
  const found = lakeNames.filter((l) => state.discovered.has(l.label)).length;
  const bagged = peaks.filter((q) => state.discovered.has(`peak:${q.name}`)).length;
  $('pause-date').textContent = `Day ${state.day} · ${calendar.dateLabel} · ${clock(state.hour)}`;
  $('journal-forecast').textContent = weather.forecast;
  const stat = (v, label) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`;
  $('journal-stats').innerHTML = stat(`${found}/${lakeNames.length}`, 'Lakes') + stat(`${bagged}/${peaks.length}`, 'Summits')
    + stat(state.km.toFixed(1), 'Km hiked') + stat(`${party.races.won}–${party.races.lost}`, 'Races won–lost');
  const add = (text, sub, done, cls = '') => {
    const li = document.createElement('li');
    li.className = `${done ? 'done' : ''} ${cls}`;
    li.innerHTML = '<span></span><small></small>';
    li.firstChild.textContent = text; li.lastChild.textContent = sub;
    list.appendChild(li);
  };
  add('Summits', '', false, 'head');
  [...peaks].sort((a, b) => b.elev - a.elev).forEach((q) => add(q.name, `${ft(q.elev)} ft`, state.discovered.has(`peak:${q.name}`)));
  add('Lakes', '', false, 'head');
  [...lakeNames].sort((a, b) => b.level - a.level).forEach((l) => add(l.label, `${ft(l.level)} ft`, state.discovered.has(l.label)));
}

// ------------------------------------------------------------------ actions
function act() {
  const p = hiker.pos;
  const fx = -Math.sin(hiker.yaw), fz = -Math.cos(hiker.yaw);
  if (pressed.has('KeyC')) {
    if (camp.near(p, 'tent', 4)) {
      camp.strike(); audio.zip(); hud.toast('Camp packed up.');
    } else if (hiker.mode !== 'walk' || !hiker.grounded) {
      hud.toast('Find solid ground first.');
    } else {
      const x = p.x + fx * 3, z = p.z + fz * 3;
      const why = camp.campProblem(x, z);
      if (why) hud.toast(why, 'warn');
      else {
        if (camp.tent) hud.toast('You packed up your old camp and moved it here.');
        camp.strike();
        camp.pitch(x, z, Math.atan2(-fx, -fz));
        audio.zip();
        hud.toast('Tent pitched. [Z] near the tent to sleep.');
        save();
      }
    }
  }
  if (pressed.has('KeyF')) {
    if (camp.fire && camp.near(p, 'fire', 5)) { camp.douse(); hud.toast('Fire drowned and stirred cold. Nice.'); }
    else {
      const x = p.x + fx * 2, z = p.z + fz * 2;
      const why = camp.fireProblem(x, z);
      if (why) hud.toast(why, 'warn');
      else { camp.light(x, z); audio.strike(); hud.toast('Fire lit — it will burn for about 90 minutes.'); }
    }
  }
  if (pressed.has('KeyZ') && camp.near(p, 'tent', 4.5) && !state.sleeping) startSleep();
  if (pressed.has('KeyL')) { state.lamp = !state.lamp; audio.step('rock', 0); }
  state.resting = keys.has('KeyZ') && !camp.near(p, 'tent', 4.5) && hiker.mode === 'walk' && hiker.grounded && hiker.moving < 0.2;
}

function startSleep() {
  const h = state.hour;
  const night = h >= 19 || h < 5;
  const target = night ? 7 : h + 2;
  state.sleeping = { from: h, to: target, t: 0, night };
  $('fade').classList.add('on');
  $('fade-text').textContent = night ? 'You crawl into your bag…' : 'A quick nap in the tent…';
  audio.zip();
}

function finishSleep() {
  const s = state.sleeping;
  let mins = (s.to - s.from) * 60;
  if (mins < 0) mins += 24 * 60;
  advanceClock(mins);
  weather.settle(state.day, state.hour);
  hiker.stamina = 100; hiker.warmth = Math.max(hiker.warmth, 85); hiker.injured = 0; hiker.wet = 0;
  camp.douse();
  state.sleeping = 0;
  $('fade').classList.remove('on');
  hud.toast(s.night ? `Morning, day ${state.day}. ${weather.forecast}` : 'Rested.');
  save();
}

function advanceClock(mins) {
  state.hour += mins / 60;
  while (state.hour >= 24) { state.hour -= 24; state.day++; updateCalendar(); }
}

/** The date drives the sun, the season's weather mix, lake ice and snowpack. */
function updateCalendar() {
  calendar.setDay(state.day);
  setSun(calendar.sun);
  weather.climate = calendar.climate;
  world.iceLine = calendar.iceLine;
  lakes.uniforms.uIceLine.value = world.iceLine;
}

function rescue(why) {
  state.rescue = { t: 0 };
  $('fade').classList.add('on');
  $('fade-text').textContent = `${why} You limp back to ${camp.tent ? 'camp' : 'the car'}.`;
  audio.thud(true);
}

function finishRescue() {
  if (camp.tent) {
    const t = camp.tent;
    hiker.place(t.x + Math.sin(t.yaw) * 2.5, t.z + Math.cos(t.yaw) * 2.5, t.yaw);
  } else spawnAtCar();
  advanceClock(120);
  hiker.injured = 60; hiker.stamina = 40;
  state.rescue = null;
  $('fade').classList.remove('on');
}

// ------------------------------------------------------------------ quick travel
// Pick a place on the map and the camera lifts off, glides over the real
// terrain toward it, and settles back into your eyes on the ground there.

/** Where to actually stand for a destination: dry, walkable ground, facing something worth seeing. */
function landing(d) {
  const w = world, from = hiker.pos;
  const heading = Math.atan2(-(d.x - from.x), -(d.z - from.z));
  const ok = (x, z) => w.inBounds(x, z, 40) && !w.lakeAt(x, z) && w.localGrade(x, z) < 0.5 && (() => {
    const s = w.nearestStream(x, z);
    return !s.stream || s.d > s.stream.width / 2 + 1.5;
  })();
  const spiral = (x0, z0, r0, r1, step = 3) => {
    if (r0 === 0 && ok(x0, z0)) return [x0, z0];
    for (let r = Math.max(step, r0); r <= r1; r += step) {
      // prefer the side of the ring facing where you came from
      const a0 = Math.atan2(from.z - z0, from.x - x0);
      const n = Math.max(8, Math.round((r * 2 * Math.PI) / step));
      for (let k = 0; k < n; k++) {
        const a = a0 + ((k % 2 ? 1 : -1) * Math.ceil(k / 2) * 2 * Math.PI) / n;
        const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
        if (ok(x, z)) return [x, z];
      }
    }
    return [x0, z0];
  };
  if (d.kind === 'car' && w.startSpot) {
    const { x, z, toward } = w.startSpot;
    return { x, z, yaw: Math.atan2(-(toward[0] - x), -(toward[1] - z)) };
  }
  if (d.kind === 'tent') {
    const t = camp.tent;
    return { x: t.x + Math.sin(t.yaw) * 2.5, z: t.z + Math.cos(t.yaw) * 2.5, yaw: t.yaw };
  }
  if (d.kind === 'peak') {
    let bx = d.x, bz = d.z, bh = -Infinity;
    for (let dz = -24; dz <= 24; dz += 2) for (let dx = -24; dx <= 24; dx += 2) {
      const h = w.height(d.x + dx, d.z + dz);
      if (h > bh) { bh = h; bx = d.x + dx; bz = d.z + dz; }
    }
    return { x: bx, z: bz, yaw: heading };
  }
  const lake = d.lake || w.lakeAt(d.x, d.z);
  if (lake) {
    const r0 = Math.sqrt(lake.area / Math.PI) * 0.6;
    const [x, z] = spiral(lake.x, lake.z, r0, r0 + 600, 3);
    return { x, z, yaw: Math.atan2(-(lake.x - x), -(lake.z - z)) };
  }
  const [x, z] = spiral(d.x, d.z, 0, 120, 2);
  return { x, z, yaw: heading };
}

function startTravel(d) {
  document.body.classList.remove('map-open');
  const to = landing(d);
  const from = camera.position.clone();
  const dist = Math.hypot(to.x - from.x, to.z - from.z);
  const groundY = world.height(to.x, to.z);
  // cruise above the highest ground on the way
  let top = -Infinity;
  for (let i = 0; i <= 48; i++) {
    const f = i / 48;
    top = Math.max(top, world.height(lerp(from.x, to.x, f), lerp(from.z, to.z, f)));
  }
  const cruise = Math.max(top + 90 + dist * 0.045, from.y + 40, groundY + 60);
  state.travel = {
    t: 0, dur: clamp(2.6 + dist / 2600, 2.6, 7), dist,
    from, q0: camera.quaternion.clone(),
    to: new THREE.Vector3(to.x, groundY + 1.68, to.z), yaw: to.yaw,
    cruise, name: d.kind === 'point' ? null : d.name,
  };
  hiker.place(to.x, to.z, to.yaw);
  keys.clear();
  lockPointer(); // still inside the click that chose the destination
  audio.whoosh?.(state.travel.dur);
}

const _q = new THREE.Quaternion(), _m = new THREE.Matrix4(), _look = new THREE.Vector3(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const ease = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

/** Fly the camera; returns the point on the ground under it (for streaming trees and shadows). */
function flyStep(dt, focus) {
  const T = state.travel;
  T.t += dt;
  const u = clamp(T.t / T.dur, 0, 1);
  const s = u * u * u * (u * (u * 6 - 15) + 10); // smootherstep for the glide
  const x = lerp(T.from.x, T.to.x, s), z = lerp(T.from.z, T.to.z, s);
  const rise = ease(u / 0.42), fall = ease((u - 0.5) / 0.5);
  let y = lerp(lerp(T.from.y, T.cruise, rise), T.to.y, fall);
  if (u < 0.97) y = Math.max(y, world.height(x, z) + lerp(25, 1.6, fall));
  camera.position.set(x, y, z);
  // look ahead along the flight toward the destination, then settle level at the end
  const ahead = Math.min(1, s + 0.2);
  _look.set(lerp(T.from.x, T.to.x, ahead), 0, lerp(T.from.z, T.to.z, ahead));
  _look.lerp(T.to, 0.35 + 0.65 * fall);
  _look.y = world.height(_look.x, _look.z);
  if (_look.distanceTo(camera.position) < 1) _look.set(x - Math.sin(T.yaw), y, z - Math.cos(T.yaw));
  _m.lookAt(camera.position, _look, camera.up);
  _q.setFromRotationMatrix(_m);
  camera.quaternion.copy(T.q0).slerp(_q, ease(u / 0.3));
  camera.quaternion.slerp(_q.setFromEuler(_e.set(0, T.yaw, 0)), ease((u - 0.7) / 0.3));
  focus.set(x, world.height(x, z), z);
  if (u >= 1) {
    state.travel = null;
    camera.rotation.order = 'YXZ';
    rig.eyeY = null;
    while (flora.update(hiker.pos, 8) > 0) { /* finish the trees around you */ }
    if (T.name) hud.toast(`${T.name} · ${ft(hiker.pos.y)} ft`);
    save();
  }
  return u;
}

// ------------------------------------------------------------------ world queries
/** Air temperature: a late-September diurnal swing in the valley, the lapse rate with height, and the weather. */
function tempC(hour, elev) {
  const { mean, swing } = calendar.valley;
  const valley = mean + swing * Math.cos(((hour - 15) / 24) * Math.PI * 2) * (1 - weather.cloud * 0.45);
  return valley + weather.temp - ((elev - 2700) / 1000) * 6.5;
}

/** Elevation where the air is at freezing right now. */
function freezingLevel(hour) {
  return 2700 + (tempC(hour, 2700) - 0.5) / 6.5 * 1000;
}

function locate(p, cv) {
  const zone = cv.snag > 0.35 ? 'Cameron Peak Fire burn (2020)' : 'Rawah Wilderness';
  const lake = world.nearWater(p.x, p.z, 40);
  if (lake) return [lake.label, 'Lakeshore'];
  const t = world.nearestTrail(p.x, p.z);
  if (t.trail && t.d < 8) return [t.trail.name, t.trail.kind === 'trail' ? zone : 'Roosevelt National Forest'];
  const brook = world.nearestStream(p.x, p.z);
  if (brook.stream && brook.stream.name && brook.d < 15) return [brook.stream.name, zone];
  const { place, d } = world.nearestPlace(p.x, p.z, (q) => q.kind !== 'lake');
  if (place && d < 500) return [place.kind === 'peak' && d < 60 ? `${place.name} summit` : `Near ${place.name}`, zone];
  const e = p.y, tl = world.treeline(p.x, p.z);
  const where = cv.snag > 0.35 ? 'Burned forest' : e > tl + 60 ? 'Alpine tundra' : e > tl - 80 ? 'Treeline' : cv.aspen > 0.3 ? 'Aspen grove' : cv.forest > 0.3 ? 'Spruce-fir forest' : 'Subalpine meadow';
  return [where, `${zone} · off trail`];
}

const ft = (m) => Math.round(m * 3.28084).toLocaleString();

function latLon(p) {
  const nw = world.meta.nw;
  const lat = nw.lat - (p.z + world.half) / 111320;
  const lon = nw.lon + (p.x + world.half) / (111320 * Math.cos((nw.lat * Math.PI) / 180));
  return `${lat.toFixed(4)}° N, ${Math.abs(lon).toFixed(4)}° W`;
}

function clock(h) {
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
}

let lastDiscoveryCheck = 0;
function checkDiscoveries() {
  const p = hiker.pos;
  for (const l of lakeList) {
    if (state.discovered.has(l.label)) continue;
    const r = Math.sqrt(l.area / Math.PI) + 45;
    if (Math.hypot(l.x - p.x, l.z - p.z) < r) {
      state.discovered.add(l.label);
      const n = lakeNames.filter((q) => state.discovered.has(q.label)).length;
      hud.discovery(l.label, `${ft(l.level)} ft · lake ${n} of ${lakeNames.length}`);
      party.event('lake', { place: l.label });
      save();
    }
  }
  for (const q of peaks) {
    const key = `peak:${q.name}`;
    if (state.discovered.has(key) || Math.hypot(q.x - p.x, q.z - p.z) > 35 || p.y < q.elev - 12) continue;
    state.discovered.add(key);
    const n = peaks.filter((o) => state.discovered.has(`peak:${o.name}`)).length;
    hud.discovery(q.name, `${ft(q.elev)} ft · summit ${n} of ${peaks.length}${q.elev === Math.max(...peaks.map((o) => o.elev)) ? ' · the roof of the Rawah' : ''}`);
    party.event('summit', { place: q.name });
    save();
  }
}

// ------------------------------------------------------------------ friends
/** What the friends can see, refreshed twice a second: weather, the hour, where you stand. */
function feedFriends(p) {
  const c = world.cover(p.x, p.z), h = state.hour;
  Object.assign(party.ctx, {
    weather: weather.label, warmth: hiker.warmth,
    dusk: (h >= 18 && h < 20.5) || (h >= 5 && h < 6.5), night: h >= 20.5 || h < 5,
    alpine: c.alpine > 0.5, meadow: c.meadow > 0.6, forest: c.forest > 0.5, burn: c.snag > 0.4,
  });
}

/** The nearest named lake or summit a little way off: where a race goes. */
function raceGoal() {
  const p = hiker.pos;
  let best = null, bd = Infinity;
  for (const g of [...lakeList.map((l) => ({ x: l.x, z: l.z, name: l.label })), ...peaks.map((q) => ({ x: q.x, z: q.z, name: q.name }))]) {
    const d = Math.hypot(g.x - p.x, g.z - p.z);
    if (d > 150 && d < 2600 && d < bd) { bd = d; best = g; }
  }
  return best;
}

let togetherGoal = null;
function toggleTogether(open = !togetherOpen) {
  if (open && (!state.started || state.paused || map.open || state.travel)) return;
  togetherOpen = open;
  $('together').classList.toggle('hidden', !open);
  document.body.classList.toggle('together-open', open);
  if (open) {
    keys.clear();
    togetherGoal = raceGoal();
    $('tog-who').textContent = `${cap(party.actors[0]?.name || '')} & ${cap(party.actors[1]?.name || '')}`;
    const race = $('tog-race');
    race.textContent = togetherGoal ? `Race to ${togetherGoal.name}` : 'Race (no summit or lake close enough)';
    race.disabled = !togetherGoal;
    for (const b of $('together').querySelectorAll('[data-stance]')) b.classList.toggle('on', b.dataset.stance === party.stance);
    if (document.pointerLockElement) document.exitPointerLock();
    $('together').querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  } else lockPointer();
}
for (const b of $('together').querySelectorAll('[data-stance]')) {
  b.onclick = () => {
    const s = b.dataset.stance;
    if (s === 'race') { if (!togetherGoal) return; party.command('race', togetherGoal); }
    else party.command(s);
    toggleTogether(false);
  };
}

function raceEnded({ won, name }) {
  if (won === null) hud.toast(`The race to ${name} is off.`, 'warn');
  else hud.toast(won ? `You beat them to ${name}.` : `They beat you to ${name}.`, won ? '' : 'warn');
  save();
}

/** Play as the next friend: the same place and the same journal, continued in the new body. */
const nextFriend = () => { const names = Object.keys(CHARACTERS); return names[(names.indexOf(playerName) + 1) % names.length]; };
function swapPlayer() {
  if (!state.started) return;
  setCharacter(nextFriend());
}
$('btn-swap').onclick = () => swapPlayer();

// ------------------------------------------------------------------ loop
const eye = new THREE.Vector3(), flyFocus = new THREE.Vector3(), precipLight = new THREE.Color(), _snowBounce = new THREE.Color();
const ctl = { move: new THREE.Vector2(), sprint: false, jump: false, grab: false, crouch: false, punch: false, hook: false, stomp: false, lookX: 0, lookY: 0 };
let last = performance.now(), saveTimer = 0, floraTimer = 0, t = 0;

while (flora.update(hiker.pos, 8) > 0) { /* fill the first ring of trees */ }
setLoad(1, 'Ready');
$('loading').classList.add('hidden');
$('title').classList.remove('hidden');


function tick(dt, draw = true) {
  t += dt;
  let gameMin = 0;
  const live = state.started && !state.paused && !state.sleeping && !state.rescue && !state.travel && !map.open && !togetherOpen;
  if (state.sleeping) {
    state.sleeping.t += dt;
    if (state.sleeping.t > 2.2) finishSleep();
  } else if (state.rescue) {
    state.rescue.t += dt;
    if (state.rescue.t > 2.6) finishRescue();
  }

  input.poll();
  const [lx, ly] = input.look(dt, settings.sens);
  ctl.lookX = live ? lx : 0;
  ctl.lookY = live ? ly : 0;
  input.move(ctl.move);
  if (map.open) map.analog(dt, input.padMove, input.padLook, input.trigger(6), input.trigger(7));
  if (!live) ctl.move.set(0, 0);
  ctl.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  ctl.jump = live && pressed.has('Space');
  const mindOn = hiker.tool === 'mind';
  ctl.grab = live && !mindOn && pressed.has('KeyE') && !props.interact();
  ctl.crouch = live && pressed.has('KeyX');
  ctl.punch = live && !mindOn && (pressed.has('KeyQ') || pressed.has('Mouse0'));
  if (ctl.punch && props.throwStone()) ctl.punch = false;
  ctl.hook = live && !mindOn && (pressed.has('KeyR') || pressed.has('Mouse2'));
  ctl.stomp = live && pressed.has('KeyG');

  const p = hiker.pos;
  const env = {
    tempC: tempC(state.hour, p.y) - (p.y > world.treeline(p.x, p.z) ? 3 : 0) - Math.max(0, weather.wind) * 3,
    nearFire: !!camp.fire && camp.near(p, 'fire', 6),
    inTent: !!state.sleeping,
    resting: state.resting,
  };
  if (live) {
    const before = hiker.pos.clone();
    const events = hiker.update(dt, ctl, env);
    state.km += Math.hypot(p.x - before.x, p.z - before.z) / 1000;
    for (const e of events) {
      if (e.type === 'step') audio.step(e.surface, e.speed);
      else if (e.type === 'land') { audio.thud(e.hard); rig.land(e.fall); }
      else if (e.type === 'splash') { audio.splash(); hud.toast('Brrr — snowmelt water.', 'warn'); }
      else if (e.type === 'grab') audio.step('rock', 2);
      else if (e.type === 'strike' && (e.kind === 'chop' || e.kind === 'slash')) props.strike(e);
      else if (e.type === 'toast') hud.toast(e.text, e.warn ? 'warn' : '');
      else if (e.type === 'fall') {
        if (e.severe) rescue(e.why);
        else { audio.thud(true); rig.land(8); hud.toast(e.why, 'warn'); }
      }
    }
    act();
    // caught out in it: rain soaks you (less under thick forest), wet snow too
    const soak = weather.precip * (1 - weather.snowK * 0.6) * (1 - world.coverAt(p.x, p.z, 0) * 0.5);
    if (soak > 0.2 && hiker.mode !== 'swim') hiker.wet = Math.max(hiker.wet, 30 * soak);
    const scale = (state.resting ? 8 : 1) * settings.timeScale;
    gameMin = dt * scale;
    advanceClock(gameMin);
    camp.update(dt, dt * scale, t);
    if (t - lastDiscoveryCheck > 0.5) { lastDiscoveryCheck = t; checkDiscoveries(); }
    saveTimer += dt;
    if (saveTimer > 10) { saveTimer = 0; save(); }
  } else {
    camp.update(dt, 0, t);
  }
  input.endFrame();

  avatar.update(dt, hiker);
  const wheel = input.takeWheel();
  mind.resize(live && mindOn ? wheel : 0);
  mind.update(dt, live, {
    lift: keys.has('KeyQ') || keys.has('Mouse0'), sink: keys.has('KeyR') || keys.has('Mouse2'), level: keys.has('KeyE'),
  }, shaped);
  props.update(dt, live);
  if (state.started) party.update(live ? dt : 0, hiker);
  const zoom = mindOn ? 0 : wheel;
  let focus = p;
  if (state.travel) {
    // stream trees under the flight first, then around where you'll land
    const u = flyStep(dt, flyFocus);
    focus = flyFocus;
    flora.update(u < 0.55 ? flyFocus : p, 2, dt);
  } else {
    rig.update(dt, { zoom: map.open ? 0 : zoom, sprinting: ctl.sprint && hiker.moving > 0.5 && hiker.stamina > 2, strafe: ctl.move.x });
    floraTimer += dt;
    flora.update(p, floraTimer > 0.12 ? 1 : 0, dt);
    if (floraTimer > 0.12) floraTimer = 0;
  }
  eye.copy(camera.position);

  camera.updateMatrixWorld();
  terrain.update(camera);
  // weather: eases toward the day's schedule; lightning, rain on you, warnings
  weather.update(state.paused ? 0 : dt, gameMin, state.day, state.hour, tempC(state.hour, p.y) - weather.temp, smoothstep(-0.05, 0.3, sky.sunDir.y), freezingLevel(state.hour));
  for (const e of weather.events) if (e.type === 'bolt') { audio.thunder?.(e.dist); if (e.dist < 1500) input.rumble(0.6 * (1 - e.dist / 1500), 0.3, 400); }
  atmosphere.uWet.value = weather.wet;
  atmosphere.uTime.value = flora.uniforms.uTime.value;   // the clock the footprints spring back on
  // fresh snow from the weather on top of the season's snowpack
  const packLine = calendar.snowLine, fresh = weather.snowCover > 0.02;
  atmosphere.uSnow.value = Math.max(weather.snowCover, packLine < 4500 ? 1 : 0);
  atmosphere.uSnowLine.value = Math.min(fresh ? weather.snowLine : 5000, packLine);
  atmosphere.uGreen.value = clamp((0.78 - calendar.cure) / 0.7, 0, 1);
  // cold air pools in the valleys at dawn and burns off by midmorning
  atmosphere.uValley.value = 0.00004 * (1 + 2.2 * Math.exp(-((state.hour - 6.6) ** 2) / 4.5)) * (1 - 0.5 * smoothstep(0.4, 1, weather.cloud));
  sky.update(state.hour, eye, focus, t, weather);
  // snow underfoot bounces light back up into the shadows
  const onSnow = atmosphere.uSnow.value * smoothstep(atmosphere.uSnowLine.value - 60, atmosphere.uSnowLine.value + 60, p.y);
  sky.hemi.groundColor.lerp(_snowBounce.setScalar(0.55 * sky.light + 0.04), onSnow * 0.7);
  // eye adaptation: open up in flat grey light and at dusk, settle back in full sun
  const lum = sky.sun.intensity * Math.max(0, sky.sunDir.y) * (1 - sky.sunBlock * 0.8) + sky.hemi.intensity * 0.8 + onSnow * sky.light * 0.8;
  const targetExp = clamp(1.08 * Math.pow(3.4 / (lum + 0.3), 0.32), 0.85, 1.6);
  renderer.toneMappingExposure += (targetExp - renderer.toneMappingExposure) * Math.min(1, dt * 0.8);
  updateAtmosphere(sky, camera);
  // the day's breeze: still at dawn, gusty through the afternoon, settling at dusk
  const h = state.hour;
  flora.uniforms.uCalm.value = clamp(0.3 + 0.55 * smoothstep(9, 14, h) * (1 - smoothstep(18.5, 21.5, h)) + 0.15 * smoothstep(3200, 3700, p.y) + weather.wind * 0.6, 0.05, 1.35);
  const wspd = 2 + Math.max(0, weather.wind) * 9;
  precip.update(state.paused ? 0 : dt, camera, weather, [WIND_DIR[0] * wspd, WIND_DIR[1] * wspd], precipLight.copy(sky.hemi.color).multiplyScalar(0.2 + sky.light * 0.75 + weather.flash));
  const tC = tempC(h, p.y);
  grass.update(camera, hiker, clamp((1.5 - tC) / 4, 0, 1) * (1 - smoothstep(8.5, 10.5, h)) * (h > 3 ? 1 : 0), calendar.cure, avatar.heading);
  headlamp.intensity = state.lamp ? 60 : 0;
  lakes.uniforms.uSky.value.copy(sky.uniforms.uHorizon.value).lerp(sky.uniforms.uZenith.value, 0.3);
  lakes.update(t);
  streams.update(t);

  // ambience
  const cv = world.cover(p.x, p.z, p.y);
  const brook = world.nearestStream(p.x, p.z);
  const creek = brook.stream ? Math.max(0, 1 - brook.d / (22 + brook.stream.width * 3)) * Math.min(1, 0.45 + brook.stream.width / 6) : 0;
  if (state.started && cv.snag > 0.45 && !state.inBurn) {
    state.inBurn = true;
    hud.toast('Burn scar — the Cameron Peak Fire swept through here in 2020.');
  } else if (cv.snag < 0.1) state.inBurn = false;
  const gust = gustAt(p.x, p.z, flora.uniforms.uTime.value, flora.uniforms.uCalm.value); // the gust you see in the grass
  const exposure = smoothstep(cv.treeline - 120, cv.treeline + 200, p.y);
  audio.update(dt, {
    exposure, gust, forest: cv.forest, daylight: sky.light,
    dusk: (state.hour > 17.8 && state.hour < 20.5) || (state.hour > 5.8 && state.hour < 7.5),
    elevation: p.y, creek,
    rain: weather.precip * (1 - weather.snowK) * (state.sleeping ? 0.6 : 1), storm: weather.storm,
    fireDist: camp.fire ? Math.hypot(camp.fire.x - p.x, camp.fire.z - p.z) : 999,
  });

  if (state.started) {
    const [place, sub] = locate(p, cv);
    const found = lakeNames.filter((l) => state.discovered.has(l.label)).length;
    const status = [hiker.mode === 'climb' ? 'Climbing' : hiker.mode === 'swim' ? 'Swimming' : hiker.sliding ? 'Sliding' : '',
      hiker.injured > 0 ? 'Sore ankle' : '', hiker.wet > 0 ? 'Wet' : '', hiker.cold ? 'Cold' : '', state.resting ? 'Resting' : '']
      .filter(Boolean).join(' · ');
    let hint = hiker.hint || props.hint;
    if (!hint && camp.near(p, 'tent', 4.5)) hint = state.hour >= 19 || state.hour < 5 ? '[Z] sleep until morning · [F] fire · [C] pack up' : '[Z] nap · [F] fire · [C] pack up';
    if (!hint && sky.light < 0.35 && !camp.tent && hiker.mode === 'walk') hint = 'Getting dark — find flat ground away from water and [C] make camp';
    if (!hint && sky.light < 0.2 && !state.lamp) hint = '[L] headlamp';
    if (weather.storm > 0.4 && p.y > cv.treeline - 40) hint = 'Lightning on the crest. Get below treeline.';
    const wxLabel = weather.label;
    if (wxLabel !== state.wxLabel) {
      const say = { Thunderstorm: 'Thunder rolls off the crest. Storm coming.', Rain: 'Rain moving in.', Snow: 'It\'s snowing.', Sleet: 'Sleet stinging your face.', Fog: 'Fog settling in.', Clear: state.wxLabel ? 'The sky is clearing.' : '' }[wxLabel];
      if (say && state.wxLabel) hud.toast(say, wxLabel === 'Thunderstorm' ? 'warn' : '');
      state.wxLabel = wxLabel;
    }
    hud.mode = input.mode;
    hud.update(hudState = {
      yaw: hiker.yaw, place, sub, elev: p.y, night: sky.sunDir.y < -0.03, coords: latLon(p),
      clock: `${calendar.dateLabel} · ${clock(state.hour)}`, tempC: env.tempC, wx: weather.label,
      stamina: hiker.stamina, warmth: hiker.warmth, grip: hiker.grip, climbing: hiker.mode === 'climb',
      hint, injured: hiker.injured > 0, status, tool: hiker.tool === 'fists' ? '' : TOOL_NAME[hiker.tool],
      discovered: state.discovered, tent: camp.tent, x: p.x, z: p.z,
      lakesFound: found, lakesTotal: lakeNames.length,
      friends: party.actors.map((a) => ({ name: a.name[0].toUpperCase() + a.name.slice(1), x: a.x, z: a.z })), km: state.km,
      peaksFound: peaks.filter((q) => state.discovered.has(`peak:${q.name}`)).length, peaksTotal: peaks.length,
    });
  }
  if (map.open && hudState) map.draw(hudState);
  if (state.started && (frameNo++ % 30 === 0)) feedFriends(p);
  // the sun's shadows only change slowly: redraw them every other frame (always while flying)
  perf.frame++;
  renderer.shadowMap.needsUpdate = settings.shadows && (perf.frame % 2 === 0 || !!state.travel);
  if (draw) renderer.render(scene, camera);
}

// Adaptive resolution: hold the frame rate by trading pixels, measured over
// ~1.5 s windows so it settles instead of hunting. The HUD stays crisp; only
// the 3-D view scales.
const basePR = Math.min(devicePixelRatio, Q.dpr);
const perf = { scale: 1, acc: 0, n: 0, frame: 0 };
function adapt(rawDt) {
  if (rawDt > 0.25 || document.hidden) return;   // ignore stalls and background tabs
  perf.acc += rawDt; perf.n++;
  if (perf.acc < 1.5) return;
  const avg = perf.acc / perf.n;
  perf.acc = 0; perf.n = 0;
  let s = perf.scale;
  if (avg > 1 / 45) s *= 0.85;
  else if (avg > 1 / 54) s *= 0.94;
  else if (avg < 1 / 58) s *= 1.06;
  s = clamp(s, SCALE.min, SCALE.max);
  if (Math.abs(s - perf.scale) > 0.01) {
    perf.scale = s;
    renderer.setPixelRatio(basePR * s);
    renderer.setSize(innerWidth, innerHeight);
  }
}

function loop(now) {
  const raw = (now - last) / 1000;
  const dt = Math.min(0.05, raw);
  last = now;
  adapt(raw);
  tick(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ------------------------------------------------------------------ dev hooks (local only)
if (DEV) {
  window.__rawah = {
    world, hiker, camp, state, flora, terrain, renderer, scene, camera,
    begin, tick, save, rig, avatar, party, input, props, mind, together: (o) => toggleTogether(o),
    hit(kind = 'side') { return hiker.receiveHit(kind); },
    cam() { return rig.toggle(); },
    teleport(x, z, yaw = hiker.yaw) { hiker.place(x, z, yaw); while (flora.update(hiker.pos, 8) > 0); },
    goto(name) { const pl = world.places.find((q) => q.name === name); if (pl) this.teleport(pl.x, pl.z); return pl; },
    setHour(h) { state.hour = h; weather.settle(state.day, h); },
    weather(name) { weather.override = name || null; weather.settle(state.day, state.hour); return weather; },
    wx: weather,
    look(yaw, pitch = 0) { hiker.yaw = yaw; hiker.pitch = pitch; },
    press(code) { pressed.add(code); },
    map() { toggleMap(); },
    gmap: map,
    travel(name) { if (!map.open) toggleMap(); const i = map.list.findIndex((d) => d.name === name); if (i >= 0) { map.pick(i); map.travel(); } return i; },
    hold(code, on = true) { if (on) keys.add(code); else keys.delete(code); },
    step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) tick(dt, i === n - 1); },
  };
}

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? { ...(fallback || {}), ...JSON.parse(v) } : fallback; } catch { return fallback; }
}

function storeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}
