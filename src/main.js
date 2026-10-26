import * as THREE from 'three';
import { World } from './world.js';
import { farTerrain, terrainMaterial, colorTexture, coverTexture, makeNoiseTexture, ROCK, BOXEL } from './terrain.js';
import { CDLODTerrain } from './cdlod.js';
import { Flora } from './flora.js';
import { buildLakes, buildTrails, buildSigns, buildStreams } from './features.js';
import { Sky, setSun, MOONS } from './sky.js';
import { Calendar, SEASONS } from './calendar.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildTitle } from './title.js';
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
import { Guide } from './guide.js';
import { TOOL_NAME } from './tools.js';
import { clamp, smoothstep, lerp } from './noise.js';
import { Grass } from './grass.js';
import { Boxels } from './boxels.js';
import { updateAtmosphere, atmosphere } from './atmosphere.js';
import { Weather, REGIMES } from './weather.js';
import { Precip } from './precip.js';
import { skyViewTexture } from './skyview.js';
import { gustAt, WIND_DIR } from './wind.js';
import { PRESETS, resolveQuality, isTouch, SCALE } from './quality.js';
import { setRangeK } from './cdlod.js';
import { HorizonMap } from './culling.js';
import { ATV } from './atv.js';
import { Fishing } from './fishing.js';
import { Roast } from './roast.js';
import { Wood } from './wood.js';
import { Coffee } from './coffee.js';
import { Dump } from './dump.js';
import { Breakfast } from './breakfast.js';
import { Plume } from './plume.js';
import { WaveField, WATER } from './waves.js';
import { Fireworks } from './fireworks.js';

const SAVE_KEY = 'rawah-save-v2';
const $ = (id) => document.getElementById(id);
const DEV = ['localhost', '127.0.0.1', ''].includes(location.hostname);

// the title screen picks the date (day of year), the starting hour and the trailhead; a new date reloads the world
const settings = loadJSON('rawah-settings', { sens: 1, fov: 80, fovfx: 1, volume: 0.8, timeScale: 1, quality: 'auto', doy: SEASONS.autumn.doy, hour: 7.25, trailhead: 'West Branch Trailhead', moon: 'new' });
if (settings.fov === 72) settings.fov = 80;      // the old default: a little wider now
const calendar = new Calendar(settings.doy);
const QUALITY = resolveQuality(settings.quality);
const Q = PRESETS[QUALITY];
if (settings.depth === 'extended') Q.logDepth = true;
if (DEV) {
  // local only, for A/B timing a preset: ?aa=0&logdepth=0&shadows=0&dpr=1&grass=30 (grass radius in metres)
  const u = new URLSearchParams(location.search);
  if (u.has('aa')) Q.aa = u.get('aa') === '1';
  if (u.has('logdepth')) Q.logDepth = u.get('logdepth') === '1';
  if (u.has('shadows')) Q.shadows = u.get('shadows') === '1';
  if (u.has('dpr')) Q.dpr = Number(u.get('dpr'));
  if (u.has('grass')) Q.grass = { ...Q.grass, radius: Number(u.get('grass')) };
}
settings.shadows ??= Q.shadows;
if (settings.tent !== 'family') settings.tent = 'solo';
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
// the rock photograph for steep faces and the far ridges (ROCK in terrain.js)
ROCK.value = await new THREE.TextureLoader().loadAsync('./assets/terrain/rock.jpg').then((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; });
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
const sky = new Sky(scene, renderer);
sky.moon = MOONS[settings.moon] || MOONS.new;
sky.sun.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
const waves = new WaveField(renderer);   // wading, rain, fish and wakes ripple the lakes and streams (src/waves.js)
const lakes = buildLakes(world);
const _flow = { x: 0, z: 0 };
/** The stream's current at a point (m/s, world x, z), or nothing. */
function currentAt(x, z) {
  const st = world.nearestStream(x, z);
  _flow.x = _flow.z = 0;
  if (st.stream && st.seg && st.d < st.stream.width / 2 + 8) {
    const s = st.seg;
    let dx = s.bx - s.ax, dz = s.bz - s.az;
    if (s.ay < s.by) { dx = -dx; dz = -dz; }   // downhill
    const l = Math.hypot(dx, dz) || 1;
    _flow.x = dx / l * 0.55; _flow.z = dz / l * 0.55;
  }
  return _flow;
}
/** Open water at a point: an unfrozen lake with some depth, or a stream. */
function waterAt(x, z) {
  const lk = world.lakeAt(x, z);
  if (lk) return lk.level < world.iceLine && lk.level - world.height(x, z) > 0.05;
  const st = world.nearestStream(x, z);
  return !!st.stream && st.d < st.stream.width / 2 + 0.2;
}
let rainAcc = 0, atvWake = null;
scene.add(lakes.group);
const trails = buildTrails(world);
scene.add(trails);
// the two cars (parked nose to tail at every trailhead) and the landmarks: outhouse and signs
const modelFiles = {
  civic: './assets/cars/civic.glb', maverick: './assets/cars/maverick.glb',
  outhouse: './assets/landmarks/outhouse.glb', wildernessSign: './assets/landmarks/wilderness-sign.glb', trailheadSign: './assets/landmarks/trailhead-sign.glb',
};
const models = Object.fromEntries(await Promise.all(Object.entries(modelFiles).map(async ([k, u]) => [k, (await new GLTFLoader().loadAsync(u)).scene])));
scene.add(buildSigns(world, models));
const streams = buildStreams(world);
scene.add(streams.group);
const flora = new Flora(world, scene, renderer, Q.flora, calendar.leaves);
const weather = new Weather();
weather.override = REGIMES[settings.weather] ? settings.weather : null;
const precip = new Precip(Q.precip);
scene.add(precip.mesh);
const grass = new Grass(terrain, Q.grass, flora.uniforms);
const horizon = new HorizonMap(world);
terrain.horizon = horizon;
const atv = new ATV(world, flora, scene);
const fishing = new Fishing(world, scene);
fishing.onRipple = (x, z, size) => waves.drop(x, z, 0.2 + 0.16 * size, 0.006 + 0.012 * size);
const roast = new Roast(scene);
scene.add(grass.mesh);
const boxels = new Boxels(world, { n: 512 });
BOXEL.value = boxels.texture;
let bxLast = null, bxAcc = 0, bxRain = 0;
const camp = new Camp(world, flora, scene);
const hiker = new Hiker(world, flora);
const charParam = new URLSearchParams(location.search).get('char');
const playerName = CHARACTERS[charParam] ? charParam : CHARACTERS[settings.character] ? settings.character : 'blaize';
// the trailhead chosen on the title screen: its start spot and your car become the world's
const trailhead = world.places.find((p) => p.kind === 'trailhead' && p.name === settings.trailhead) || world.mainTrailhead;
world.mainTrailhead = trailhead;
const parked = world.starts[trailhead.name];
const yours = parked && parked.cars[0];   // anyone can drive either car: the first one is the one you start beside
if (yours) { world.carSpot = { x: yours.x, z: yours.z }; world.startSpot = yours.start; }
{
  const s0 = world.startSpot || { x: trailhead.x, z: trailhead.z, yaw: 0 };
  const cy = s0.yaw ?? 0, rx = -Math.cos(cy), rz = Math.sin(cy), cs = world.carSpot || s0;
  let px = cs.x + rx * 3.4, pz = cs.z + rz * 3.4;
  if (world.lakeAt(px, pz) || world.localGrade(px, pz) > 0.3) { px = cs.x - rx * 3.4; pz = cs.z - rz * 3.4; }
  atv.place(px, pz, cy);
}
const avatar = new Character(scene, playerName);
const party = new Party(world, flora, scene, avatar.lib, playerName);   // the other two friends
avatar.ground = (x, z) => world.height(x, z);                           // feet meet the slope
for (const a of party.actors) a.char.ground = avatar.ground;
party.camera = camera;
party.onRace = (r) => raceEnded(r);
const rig = new CameraRig(camera, world, hiker, avatar);
// the family tent's walls and floor
for (const b of [hiker, atv, party]) b.solids = (p, r) => camp.collide(p, r);
for (const b of [hiker, party]) b.floorAt = (x, z) => camp.floorAt(x, z);
party.onDrop = (x, y, z) => dump.drop(x, y, z);
const props = new Props({ world, flora, scene, camera, hiker, rig, avatar, hud: null, audio: null });
const wood = new Wood(world, flora, scene, props);
props.wood = wood;
const coffee = new Coffee(world, scene);
const dump = new Dump(scene, world);
const plume = new Plume(world, scene);
let smokeToast = -99;
const _pw = new THREE.Vector3();
const fireworks = new Fireworks(world, scene);
const breakfast = new Breakfast(coffee.stand, scene);
let coffeeBoost = 0;     // stamina from a sip, still working its way in
const hud = new Hud(world);
const mind = new Mind({ scene, world, hiker, camera, hud, audio: null });
// ground that was reshaped: trees and rocks that stood on it are replanted at the new height
const shaped = (rect) => { flora.reground(rect); props.settle(rect); camp.settle(rect); };
// the field guide: wildlife, plants and checkpoints, with a checkpoint for each trailhead
const checkpoints = world.places.filter((q) => q.kind === 'trailhead').map((q, i) => ({
  id: `checkpoint:${i}`, group: 'Checkpoints', name: q.name, chance: 1, when: () => false,
  note: 'A trailhead, where the trail starts. Everything in the Rawah begins at one of these.',
}));
const guide = new Guide(checkpoints);
const map = new GameMap(world, guide);
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
const state = {
  hour: settings.hour, day: 1, km: 0,
  discovered: new Set(),
  paused: true, started: false,
  sleeping: 0, resting: false,
  rescue: null, travel: null,
  seat: -1,      // which camp stool you're on, or -1
  ask: null,     // a yes/no question on screen
  cut: null,     // the scripted walk to the tent
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
    atv: { x: atv.pos.x, z: atv.pos.z, yaw: atv.yaw }, fish: fishing.save(), roast: { eaten: roast.eaten, perfect: roast.perfect }, wood: wood.save(), coffee: coffee.save(), breakfast: breakfast.save(),
    stamina: hiker.stamina, warmth: hiker.warmth, weather: weather.save(), props: props.save(), sculpt: mind.save(), races: party.races, guide: guide.save(), slept: state.slept || 0,
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
  wood.setCamp(camp.tent);
  wood.load(s.wood);
  coffee.load(s.coffee);
  breakfast.load(s.breakfast);
  if (s.atv) atv.place(s.atv.x, s.atv.z, s.atv.yaw);
  fishing.load(s.fish);
  roast.eaten = s.roast?.eaten || 0; roast.perfect = s.roast?.perfect || 0;
  weather.load(s.weather);
  props.load(s.props);
  if (s.races) party.races = s.races;
  guide.load(s.guide);
  state.slept = s.slept || 0;
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
  if (state.ask) {
    if (code === 'KeyY' || code === 'Enter') answerAsk(true);
    else if (code === 'KeyN' || code === 'Escape') answerAsk(false);
    return;
  }
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
$('btn-guide').onclick = () => { pause(false); toggleMap(); map.guideTab(); };

function pause(on) {
  state.paused = on;
  document.body.classList.toggle('playing', state.started && !on);
  $('pause').classList.toggle('hidden', !on);
  if (on) { renderJournal(); keys.clear(); showTab('journal'); $('bubble').classList.add('hidden'); }
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
      [k('C') + k('F'), 'Tent, campfire (a log feeds it)'], [k('U'), 'Sit, ride, take firewood, pour, eat'], [k('B'), 'Cast a line'], [k('N'), 'Marshmallow'], [k('K'), 'Cook: coffee, then breakfast'], [k('O'), 'Sip coffee'], [k('J'), 'Drop firewood'], [k('M'), 'Map'], [k('H'), 'Call the friends together'], [k('P'), 'Play as the next friend'], [k('Esc'), 'Pause']],
    pad: [[p('LS'), 'Walk'], [p('RS'), 'Look'], [p('RT'), 'Hike fast'], [p('A', 'a'), 'Hop'], [p('B', 'b'), 'Pick up, grab, level'], [p('↑'), 'Tool'],
      [p('LB'), 'Together'], [p('Y', 'y'), 'Sit, ride, take firewood, pour, eat'], [p('↓'), 'Cast a line'], [p('←'), 'Marshmallow, or sip coffee'], [p('L3'), 'Cook, or drop firewood'], [p('R3'), 'Camera'], [p('X', 'x'), 'Tent'], [p('RB'), 'Campfire'], [p('LT'), 'Rest'], [p('D-pad'), 'Crouch, punch, hook'], [p('View'), 'Map'], [p('Menu'), 'Pause']],
    touch: [['Left thumb', 'Walk'], ['Right thumb', 'Look'], [t('Hop') + t('Fast'), 'Hop, hike fast'], [t('Duck'), 'Crouch'], [t('Punch'), 'Punch, swing, lift'], [t('Hook'), 'Hook, sink'],
      [t('Grab'), 'Pick up, grab, level'], [ t('Ride'), 'Sit, ride, take firewood'], [t('Fish'), 'Cast a line'], [t('Roast'), 'Marshmallow'], [t('Cook') + t('Sip') + t('Drop'), 'Camp cooking, coffee, firewood'], [t('Tool'), 'Tool'], [t('Together'), 'Call the friends together'], [t('Camp') + t('Fire'), 'Tent, campfire'], [t('Rest'), 'Hold to rest'], [t('Map'), 'Map']],
  };
  const names = { kbm: 'Keyboard', pad: 'Controller', touch: 'Touch' };
  el.innerHTML = `<div class="seg" role="tablist">${Object.keys(names).map((m) => `<button data-mode="${m}" class="${m === mode ? 'on' : ''}">${names[m]}</button>`).join('')}</div>
    <dl>${rows[mode].map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>
    <p class="more">Tools (${mode === 'touch' ? t('Tool') : mode === 'pad' ? p('↑') : k('T')}): hands, axe, machete, fireworks, telekinesis. Fireworks: click sets a tube down, ${mode === 'kbm' ? k('R') : 'Cook'} lights it, and tubes beside it catch. Telekinesis lifts, sinks and levels the ground; the wheel sets the brush size.</p>`;
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
    wood.reset();
    fireworks.clear();
    Object.assign(state, { hour: settings.hour, day: 1, km: 0 });
    state.discovered = new Set();
    hiker.stamina = hiker.warmth = 100;
    props.reset();
    party.races = { won: 0, lost: 0 };
    guide.load([]);
    state.slept = 0;
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

$('btn-start').onclick = () => startFresh();
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

// title screen: the date, hour, trailhead and character are picked there and applied by Start hiking
const pick = { doy: settings.doy, hour: settings.hour, trailhead: trailhead.name, character: playerName };
const booted = { doy: settings.doy, trailhead: trailhead.name, character: playerName };
buildTitle({ trailheads: world.places.filter((p) => p.kind === 'trailhead'), pick, characters: CHARACTERS });
function startFresh() {
  Object.assign(settings, { doy: pick.doy, hour: pick.hour, trailhead: pick.trailhead, character: pick.character });
  storeJSON('rawah-settings', settings);
  const changed = pick.doy !== booted.doy || pick.trailhead !== booted.trailhead || pick.character !== booted.character;
  if (!changed) { begin(true); return; }
  // the date, trailhead and character are built at boot, so a new choice reloads and starts itself
  try { sessionStorage.setItem('rawah-autostart', '1'); } catch { /* private mode */ }
  $('loading').classList.remove('hidden');
  $('load-text').textContent = 'Setting out…';
  const url = new URL(location.href);
  url.searchParams.delete('char');
  location.href = url.href;
}
// who you play as, from the settings menu: the other two walk with you. Changing it reloads (the party is built at boot); Continue picks up your save as the new hiker
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
  const opt = document.createElement('option');
  opt.value = name; opt.textContent = cap(name);
  $('set-character').appendChild(opt);
}
$('set-character').value = playerName;
$('set-character').onchange = () => setCharacter($('set-character').value);

// settings controls
const bindRange = (id, key, apply, fmt = (v) => v) => {
  const el = $(id), val = $(`val-${id.slice(4)}`);
  const show = () => { if (val) val.textContent = fmt(settings[key]); };
  el.value = settings[key]; show();
  el.oninput = () => { settings[key] = Number(el.value); show(); apply?.(); storeJSON('rawah-settings', settings); };
};
bindRange('set-sens', 'sens', null, (v) => `${v.toFixed(2)}×`);
bindRange('set-fov', 'fov', () => rig.setFov(settings.fov), (v) => `${Math.round(v)}°`);
bindRange('set-fovfx', 'fovfx', () => { rig.fovFx = settings.fovfx; }, (v) => (v < 0.05 ? 'Off' : `${Math.round(v * 100)}%`));
rig.fovFx = settings.fovfx;
bindRange('set-volume', 'volume', () => audio.setVolume(settings.volume), (v) => `${Math.round(v * 100)}%`);
bindRange('set-time', 'timeScale', null, (v) => `${v.toFixed(1)}×`);
$('set-depth').value = settings.depth === 'extended' ? 'extended' : 'standard';
$('set-depth').onchange = () => {
  settings.depth = $('set-depth').value;
  storeJSON('rawah-settings', settings);
  if (state.started) save();
  location.reload();     // the depth buffer is chosen when the renderer is made
};
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
$('set-tent').value = settings.tent;
$('set-tent').onchange = () => { settings.tent = $('set-tent').value; storeJSON('rawah-settings', settings); hud.toast(settings.tent === 'family' ? 'Next camp: the family tent for six. Needs level ground.' : 'Next camp: the backpacking tent.'); };
$('set-moon').value = settings.moon;
$('set-moon').onchange = () => { settings.moon = $('set-moon').value; sky.moon = MOONS[settings.moon]; storeJSON('rawah-settings', settings); };
$('set-hour').onchange = () => { const v = parseFloat($('set-hour').value); if (v) { state.hour = v; save(); } $('set-hour').value = ''; };
{
  const sel = $('set-season');
  for (const [k, v] of Object.entries(SEASONS)) sel.appendChild(Object.assign(document.createElement('option'), { value: k, textContent: v.label || k }));
  sel.value = Object.keys(SEASONS).find((k) => SEASONS[k].doy === settings.doy) || 'autumn';
  sel.onchange = () => { settings.doy = SEASONS[sel.value].doy; storeJSON('rawah-settings', settings); location.reload(); };
}
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
    + stat(state.km.toFixed(1), 'Km hiked') + stat(`${party.races.won}–${party.races.lost}`, 'Races won–lost') + stat(wood.cutTotal, 'Logs');
  list.classList.add('hidden');   // everything found lives in the field guide now
}

// ------------------------------------------------------------------ actions
function act() {
  const p = hiker.pos;
  const fx = -Math.sin(hiker.yaw), fz = -Math.cos(hiker.yaw);
  // the quad, a stool, a fishing line, a marshmallow
  if (pressed.has('KeyU')) {
    if (atv.riding) dismountATV();
    else if (state.seat >= 0) standUp();
    else if (hiker.mode === 'walk' && hiker.grounded && !fishing.busy && !state.cut) {
      const si = freeStool(p), dStool = si >= 0 ? Math.hypot(camp.stools[si].x - p.x, camp.stools[si].z - p.z) : Infinity;
      const dAtv = atv.near(p) ? Math.hypot(atv.pos.x - p.x, atv.pos.z - p.z) : Infinity;
      const dWood = Math.min(wood.stackDist(p), wood.carried > 0 || wood.campCount > 0 ? wood.pileDist(p) : Infinity);
      const dCof = coffee.reach(p, hiker.yaw), dBrk = breakfast.reach(p, hiker.yaw);
      if (dBrk < dCof) { if (breakfast.interact()) save(); }
      else if (dCof < Infinity) { if (coffee.interact(p)) save(); }
      else if (dWood < 3.2 && dWood < dStool && dWood < dAtv) { if (wood.interact(p)) save(); }
      else if (dAtv < dStool && dAtv < Infinity) mountATV();
      else if (si >= 0) sitDown(si);
    }
  } else if (state.seat >= 0 && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].some((k) => pressed.has(k))) standUp();
  if (pressed.has('KeyB') && !atv.riding && !state.cut && !togetherOpen) {
    fishing.toggle({ pos: p, yaw: hiker.yaw, mode: hiker.mode, grounded: hiker.grounded });
  }
  if (pressed.has('KeyN') && !atv.riding && !fishing.busy && !state.cut && hiker.tool !== 'fireworks') marshmallow();
  if (state.cut || fishing.locked || atv.riding || state.seat >= 0) return;
  if (pressed.has('KeyC')) {
    if (camp.near(p, 'tent', 4)) {
      camp.strike(); const kept = wood.packUpCamp(); audio.zip(); hud.toast(kept ? `Camp packed up. ${kept} logs into your pack.` : 'Camp packed up.');
    } else if (hiker.mode !== 'walk' || !hiker.grounded) {
      hud.toast('Find solid ground first.');
    } else {
      const family = settings.tent === 'family', ahead = family ? 5.0 : 3;
      const x = p.x + fx * ahead, z = p.z + fz * ahead;
      const why = camp.campProblem(x, z, settings.tent, Math.atan2(-fx, -fz));
      if (why) hud.toast(why, 'warn');
      else {
        if (camp.tent) hud.toast('You packed up your old camp and moved it here.');
        camp.strike();
        camp.pitch(x, z, Math.atan2(-fx, -fz), settings.tent);
        wood.setCamp(camp.tent);
        party.event('camp');
        audio.zip();
        hud.toast(family ? 'Family tent up: walk in through the screen porch. [Z] inside to sleep.' : 'Tent pitched. [Z] near the tent to sleep.');
        save();
      }
    }
  }
  if (pressed.has('KeyF')) {
    if (camp.fire && camp.near(p, 'fire', 5)) {
      // a log on the fire, if you have one; otherwise put it out
      if (wood.available(p) > 0) {
        if (camp.addFuel(60)) { wood.consume(p, 1); audio.strike(); hud.toast('You lay a log on the fire.'); }
        else hud.toast('The fire is roaring already.');
      } else { camp.douse(); hud.toast('Fire drowned and stirred cold. Nice.'); }
    } else {
      const x = p.x + fx * 2, z = p.z + fz * 2;
      const why = camp.fireProblem(x, z) || (wood.available(p) < 3 ? 'You need firewood: three logs. Fell a tree with the axe ([T]) and cut it up.' : null);
      if (why) hud.toast(why, 'warn');
      else { wood.consume(p, 3); camp.light(x, z); audio.strike(); hud.toast('Fire lit — stools out. [U] to sit · [N] for a marshmallow.'); party.event('fire'); boxels.dry(x, z, 0.9, 3); boxels.wear(x, z, 0.55); }
    }
  }
  if (pressed.has('KeyZ') && camp.near(p, 'tent', 4.5) && !state.sleeping) startSleep();
  if (pressed.has('KeyL')) { state.lamp = !state.lamp; audio.step('rock', 0); }
  state.resting = keys.has('KeyZ') && !camp.near(p, 'tent', 4.5) && hiker.mode === 'walk' && hiker.grounded && hiker.moving < 0.2;
}

// ------------------------------------------------------------------ the camp: stools and marshmallows
const _sp = new THREE.Vector3(), _zero = new THREE.Vector3(0, 0, 0), _v = new THREE.Vector3(), _eye2 = new THREE.Vector3();
const _rh = new THREE.Vector3(), _rf = new THREE.Vector3(), _rr = new THREE.Vector3();
const showChar = (c, on) => { if (!c) return; if (c.group) c.group.visible = on; c.fallback?.root && (c.fallback.root.visible = on); };

/** The nearest stool within reach that a friend isn't on. */
function freeStool(p) {
  let best = -1, bd = 2.4;
  camp.stools.forEach((st, i) => {
    if (!st.obj.visible) return;
    if (party.actors.some((a) => a.seat === st)) return;
    const d = Math.hypot(st.x - p.x, st.z - p.z);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function sitDown(i) {
  const st = camp.stools[i];
  hiker.place(st.x, st.z, st.yaw);
  hiker.sitting = true;
  state.seat = i;
  avatar.heading = st.yaw;
  rig.eyeY = null;
  hud.toast(camp.fire ? '[U] stand up · [N] roast a marshmallow' : '[U] stand up');
  party.sitOn(camp.stools[i === 0 ? 1 : 0]);
}

function standUp() {
  if (state.seat < 0) return;
  const st = camp.stools[state.seat];
  hiker.sitting = false;
  state.seat = -1;
  const fx = camp.fire ? camp.fire.x : st.x - Math.sin(st.yaw), fz = camp.fire ? camp.fire.z : st.z - Math.cos(st.yaw);
  const ax = st.x - fx, az = st.z - fz, al = Math.hypot(ax, az) || 1;
  hiker.place(st.x + (ax / al) * 0.7, st.z + (az / al) * 0.7, st.yaw);
  rig.eyeY = null;
  party.clearSeat();
}

/** One frame sitting: you look around, the stool holds you. */
function seatedStep(dt, env) {
  const st = camp.stools[state.seat];
  hiker.yaw -= ctl.lookX;
  hiker.pitch = clamp(hiker.pitch - ctl.lookY, -1.5, 1.5);
  _sp.set(st.x, world.height(st.x, st.z), st.z);
  const ev = hiker.carried(dt, _sp, _zero, env);
  hiker.sitting = true;
  return ev;
}

/** [N]: a marshmallow on a stick, or eat the one you have. */
function marshmallow() {
  if (roast.active) {
    if (roast.extend > 0.35) { hud.toast('Pull it back from the flames first (let go of [Space]).'); return; }
    const r = roast.eat();
    audio.step('grass', 0.3);
    hud.discovery(r.label, r.perfect ? 'The perfect marshmallow' : `Marshmallow ${roast.eaten}`, 'You ate it');
    if (r.perfect) hiker.warmth = Math.min(100, hiker.warmth + 3);
    party.event('smore');
    save();
    return;
  }
  const nearFire = camp.fire && Math.hypot(camp.fire.x - hiker.pos.x, camp.fire.z - hiker.pos.z) <= 4.8;
  if (!nearFire && coffee.cup.sips > 0 && hiker.mode === 'walk') { coffee.sip(); return; }   // (the gamepad's only sip button)
  if (!camp.fire) { hud.toast('Light a campfire first: [F].'); return; }
  if (!nearFire) { hud.toast('Get closer to the fire.'); return; }
  roast.start();
  hud.toast('Hold [Space] to put it over the flames.');
}

/** [K] cook (coffee, then bacon and eggs; or drop your firewood away from the fire), [O] sip, [J] drop firewood. */
function camping() {
  if (atv.riding || fishing.busy || state.cut || hiker.mode !== 'walk') return;
  const fireNear = camp.fire && Math.hypot(camp.fire.x - hiker.pos.x, camp.fire.z - hiker.pos.z) < 4.5;
  const heading = rig.mode === 'first' ? hiker.yaw : avatar.heading;
  if (pressed.has('KeyK') && state.seat < 0 && hiker.tool !== 'fireworks') {
    if (fireNear || wood.carried <= 0) { if (coffee.rigged ? breakfast.start(true, camp.fire, hiker.pos) : coffee.rig(camp.fire, hiker.pos)) save(); }
    else if (wood.drop({ pos: hiker.pos, yaw: hiker.yaw }, heading)) save();
  }
  if (pressed.has('KeyJ') && state.seat < 0 && wood.drop({ pos: hiker.pos, yaw: hiker.yaw }, heading)) save();
  if (pressed.has('KeyO') && !state.sleeping) coffee.sip();
}

/** The fireworks tool: [Click] (or [N]) sets a tube down, [R] (or [K]) lights the one you are by, [I] changes style, [U] takes the unlit ones back. */
function fireworksInput() {
  if (hiker.tool !== 'fireworks' || atv.riding || fishing.busy || state.cut || state.seat >= 0 || hiker.mode !== 'walk') return;
  if (pressed.has('KeyI')) hud.toast(`Firework: ${fireworks.nextStyle()}`);
  if (pressed.has('Mouse0') || pressed.has('KeyQ') || pressed.has('KeyN')) {
    const why = fireworks.place(hiker.pos, hiker.yaw);
    if (why) hud.toast(why, 'warn');
    else if (input.mode !== 'kbm') fireworks.nextStyle();     // no style key on a pad or touch: they come round in turn
  }
  if (pressed.has('KeyR') || pressed.has('Mouse2') || pressed.has('KeyK')) {
    if (!fireworks.light(hiker.pos, hiker.yaw)) hud.toast('Set a tube down first, then stand next to it to light it.');
  }
  if (pressed.has('KeyU') && fireworks.pickUp(hiker.pos)) hud.toast('Picked up.');
}

// ------------------------------------------------------------------ "want to smash?"
const smash = { t: 0, wait: 16, cool: 0 };

/** While you toast marshmallows by the fire, the nearer friend sometimes has an idea. */
function smashClock(dt) {
  smash.cool = Math.max(0, smash.cool - dt);
  const bud = party.near(hiker.pos);
  const near = bud && Math.hypot(bud.x - hiker.pos.x, bud.z - hiker.pos.z) < 8;
  const ok = roast.active && camp.tent && camp.fire && near && !state.ask && !state.cut && !atv.riding && !fishing.busy
    && Math.hypot(camp.tent.x - hiker.pos.x, camp.tent.z - hiker.pos.z) < 16 && smash.cool <= 0;
  if (!ok) { smash.t = Math.max(0, smash.t - dt * 0.5); return; }
  smash.t += dt;
  if (smash.t > smash.wait) askSmash(bud);
}

function askSmash(bud) {
  companionBud = bud;
  party.tell(`${playerName}, want to smash?`, bud, 22);
  state.ask = { t: 0 };
  $('ask').querySelector('.ak-q').textContent = `${bud.name}: “${playerName}, want to smash?”`;
  $('ask').classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  smash.cool = 150; smash.t = 0; smash.wait = 14 + Math.random() * 10;
}
let companionBud = null;

function answerAsk(yes) {
  if (!state.ask) return;
  state.ask = null;
  $('ask').classList.add('hidden');
  lockPointer();
  if (yes && camp.tent) startScene();
  else { const arr = ['Your loss. More marshmallows for me.', 'Suit yourself. Pass the marshmallows.', 'Fair enough. Eyes on your stick, it\'s burning.']; party.tell(arr[Math.floor(Math.random() * arr.length)], companionBud); }
}
$('ask-yes').onclick = () => answerAsk(true);
$('ask-no').onclick = () => answerAsk(false);

/** You both get up, walk to the tent door and go in; the tent shakes for ten seconds; you come out. */
function startScene() {
  const t = camp.tent;
  standUp(); roast.drop(); fishing.cancel();
  const dx = Math.sin(t.yaw), dz = Math.cos(t.yaw), sx = Math.cos(t.yaw), sz = -Math.sin(t.yaw);
  const door = (side) => ({ x: t.x + dx * camp.doorDist + sx * side * 0.3, z: t.z + dz * camp.doorDist + sz * side * 0.3 });
  state.cut = { phase: 'walk', t: 0, a: door(1), b: door(-1), view: rig.mode };
  party.go = { ...state.cut.b, who: companionBud || party.actors[0] };
  if (rig.mode === 'first') { rig.toggle(); avatar.setFirstPerson(false); }
  rig.dist = Math.max(rig.dist, 5);
  keys.clear();
}

function endScene() {
  const C = state.cut;
  if (!C) return;
  showChar(avatar, true); showChar(companionBud?.char, true);
  party.go = null;
  if (C.view === 'first' && rig.mode === 'third') { rig.toggle(); avatar.setFirstPerson(true); }
  state.cut = null;
}

/** One frame of the scripted walk, the wait inside, and the way out. */
function cutStep(dt, env) {
  const C = state.cut, t = camp.tent, hp = hiker.pos;
  C.t += dt;
  const turn = (to, k) => { let d = to - hiker.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); hiker.yaw += d * Math.min(1, dt * k); };
  if (C.phase === 'walk') {
    const dx = C.a.x - hp.x, dz = C.a.z - hp.z, d = Math.hypot(dx, dz);
    const sp = d > 0.3 ? 2.1 : 0;
    _v.set(sp ? (dx / d) * sp : 0, 0, sp ? (dz / d) * sp : 0);
    _sp.set(hp.x + _v.x * dt, 0, hp.z + _v.z * dt); _sp.y = world.height(_sp.x, _sp.z);
    if (sp) turn(Math.atan2(-dx, -dz), 8);
    hiker.carried(dt, _sp, _v, env);
    hiker.moving = sp ? 1 : 0;
    hiker.phase += sp * dt * (Math.PI / 1.4);
    const bp = companionBud?.b.pos;
    const cd = bp ? Math.hypot(bp.x - C.b.x, bp.z - C.b.z) : 0;
    if ((d < 0.35 && cd < 0.5) || C.t > 14) {
      C.phase = 'shake'; C.t = 0;
      audio.zip();
      showChar(avatar, false); showChar(companionBud?.char, false);
      camp.shake(10);
    }
  } else if (C.phase === 'shake') {
    turn(t.yaw, 3);
    hiker.pitch += (-0.1 - hiker.pitch) * Math.min(1, dt * 2);
    _sp.set(hp.x, hp.y, hp.z);
    hiker.carried(dt, _sp, _zero, env);
    if (C.t > 10.4) {
      audio.zip();
      endScene();
      party.tell('Ahhh… like old times.', companionBud, 2);
      hud.toast('…and out they come.');
    }
  }
  return hiker.events;
}

// ------------------------------------------------------------------ the four-wheeler
const _seat = new THREE.Vector3();
const rider = { pos: _seat, vel: new THREE.Vector3(), phase: 0, moving: 0, mode: 'walk', sitting: true, resting: true, stance: 'stand', grounded: true, lastGrade: 0, face: 0, action: null, lookAt: null, stamina: 100, injured: 0, channel: 0, load: null, pushing: false, flip: false, sliding: false, recover: 0, wallUp: { x: 0, y: 0 }, climbSpeed: 0, emote: '', lookX: 0 };
let lookIdle = 0, rideCam = null, rideTold = true, rideD = 0;

function mountATV() {
  fishing.cancel();
  standUp(); roast.drop();
  atv.mount();
  hiker.yaw = atv.yaw; hiker.pitch = -0.2;
  rideCam = rig.mode;
  if (rig.mode === 'first') { rig.toggle(); avatar.setFirstPerson(false); }
  rig.dist = Math.max(rig.dist, 5.2);
  rig.eyeY = null;
  const company = party.boardATV(atv);
  atv.hold = company;
  rideTold = !company;
  hud.toast(company ? `${party.near(atv.pos).name} is hopping on the back…` : '[W/S] throttle · [A/D] steer · [Shift] boost · [U] get off');
}

function dismountATV() {
  if (!atv.riding) return;
  audio.engine(false, 0, 0);
  const spot = atv.dismount();
  atv.hold = false;
  party.leaveATV(atv);
  hiker.place(spot.x, spot.z, spot.yaw);
  hiker.sitting = false;
  if (rideCam === 'first' && rig.mode === 'third') { rig.toggle(); avatar.setFirstPerson(true); }
  rideCam = null;
  rig.eyeY = null;
}

/** One frame of riding; returns the hiker's events. */
function rideStep(dt, env) {
  atv.hold = party.boarding;
  if (!rideTold && party.riding) { rideTold = true; hud.toast('[W/S] throttle · [A/D] steer · [Shift] boost · [U] get off'); }
  hiker.yaw -= ctl.lookX;
  hiker.pitch = clamp(hiker.pitch - ctl.lookY, -1.5, 1.5);
  for (const e of atv.update(dt, ctl)) {
    if (e.type === 'bump') audio.thud(e.hard);
    else if (e.type === 'splash') { audio.splash(); hud.toast('Too deep for the ATV.', 'warn'); }
  }
  // tires carve wear into the ground the boxels remembers — and twin tread trenches while the snow lasts
  // a quad through a creek throws a wake behind it
  if (Math.abs(atv.speed) > 1.2 && waterAt(atv.pos.x, atv.pos.z)) {
    if (atvWake) waves.line(atvWake.x, atvWake.z, atv.pos.x, atv.pos.z, 0.5, 0.012 + 0.012 * Math.min(1, Math.abs(atv.speed) / 8));
    atvWake = { x: atv.pos.x, z: atv.pos.z };
  } else atvWake = null;
  rideD += Math.abs(atv.speed) * dt;
  if (rideD > 2.2) {
    rideD = 0; boxels.wear(atv.pos.x, atv.pos.z, 0.35);
    if (onSnowAt(atv.pos.y) > 0.3) {
      const sx = -Math.cos(atv.yaw), sz = Math.sin(atv.yaw);
      world.sculpt.press(atv.pos.x + sx * 0.45, atv.pos.z + sz * 0.45, 0.4, 0.05);
      world.sculpt.press(atv.pos.x - sx * 0.45, atv.pos.z - sz * 0.45, 0.4, 0.05);
    }
  }
  audio.engine(true, clamp(Math.abs(atv.speed) / 18, 0, 1), Math.abs(ctl.move.y));
  lookIdle = Math.abs(ctl.lookX) + Math.abs(ctl.lookY) > 0.002 ? 0 : lookIdle + dt;
  if (lookIdle > 0.5 && atv.speed > 1) {
    let d = atv.yaw - hiker.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    hiker.yaw += d * Math.min(1, dt * 2.4);
    hiker.pitch += (-0.2 - hiker.pitch) * Math.min(1, dt * 1.5);
  }
  const fx = -Math.sin(atv.yaw), fz = -Math.cos(atv.yaw);
  const vel = _v.set(fx * atv.speed, 0, fz * atv.speed);
  return hiker.carried(dt, atv.pos, vel, env);
}

/** Pixels per metre at one metre, for the fire's point sprites. */
const _v2 = new THREE.Vector2();
function flameScale() {
  renderer.getDrawingBufferSize(_v2);
  return _v2.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}

/** The certified horizon decides what terrain, flora, trails and grass even bother to exist this frame. */
function cullView() {
  horizon.update(camera.position, !state.travel);
  flora.setView(camera, horizon, sky.sunDir);
  trails.chunks?.cull(horizon);
  streams.chunks?.cull(horizon);
}

function startSleep() {
  dismountATV(); fishing.cancel(); standUp(); roast.drop();
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
  if (s.night) state.slept = (state.slept || 0) + 1;
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
    hiker.place(t.x + Math.sin(t.yaw) * (camp.doorDist + 1.05), t.z + Math.cos(t.yaw) * (camp.doorDist + 1.05), t.yaw);
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
    return { x: t.x + Math.sin(t.yaw) * (camp.doorDist + 1.05), z: t.z + Math.cos(t.yaw) * (camp.doorDist + 1.05), yaw: t.yaw };
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

/** How much snow lies at an altitude right now: the weather's fresh cover plus the seasonal pack, smoothed over the line. */
function onSnowAt(y) {
  return atmosphere.uSnow.value * smoothstep(atmosphere.uSnowLine.value - 60, atmosphere.uSnowLine.value + 60, y);
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

// ------------------------------------------------------------------ field guide
/** What the guide can see, checked twice a second: where you stand, the time, and what you have done. */
function feedGuide(p) {
  const c = world.cover(p.x, p.z), h = state.hour;
  const f = {
    cover: { forest: c.forest, krumm: c.krumm, aspen: c.aspen, snag: c.snag, meadow: c.meadow, rock: c.rock },
    elev: p.y, treeline: world.treeline(p.x, p.z), alpine: c.alpine > 0.5,
    dusk: (h >= 18 && h < 20.5) || (h >= 5 && h < 6.5), dawn: h >= 5 && h < 7, night: h >= 20.5 || h < 5,
    rain: /Rain|Thunder|Sleet/.test(weather.label), km: state.km,
    felled: props.stumps.length / 4, carried: !!props.carry, lifted: world.sculpt.count,
    raced: party.races.won, slept: state.slept || 0, fire: !!camp.fire,
  };
  for (const cp of checkpoints) {
    const q = world.places.find((x) => x.name === cp.name && x.kind === 'trailhead');
    if (q && Math.hypot(q.x - p.x, q.z - p.z) < 60) { const e = guide.mark(cp.id); if (e) hud.toast(`Field guide · ${e.name}`); }
  }
  for (const e of guide.check(f)) hud.toast(`Field guide · ${e.name}`);
}

// ------------------------------------------------------------------ friends
/** What the friends can see, refreshed twice a second: weather, the hour, where you stand. */
function feedFriends(p) {
  const c = world.cover(p.x, p.z), h = state.hour;
  Object.assign(party.ctx, {
    weather: weather.label, warmth: hiker.warmth,
    dusk: (h >= 18 && h < 20.5) || (h >= 5 && h < 6.5), night: h >= 20.5 || h < 5,
    alpine: c.alpine > 0.5, meadow: c.meadow > 0.6, forest: c.forest > 0.5, burn: c.snag > 0.4,
    fire: camp.fire, tent: camp.tent,
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

// ------------------------------------------------------------------ loop
const eye = new THREE.Vector3(), flyFocus = new THREE.Vector3(), precipLight = new THREE.Color(), _snowBounce = new THREE.Color();
const ctl = { move: new THREE.Vector2(), sprint: false, jump: false, grab: false, crouch: false, punch: false, hook: false, stomp: false, lookX: 0, lookY: 0 };
let last = performance.now(), saveTimer = 0, floraTimer = 0, t = 0;

while (flora.update(hiker.pos, 8) > 0) { /* fill the first ring of trees */ }
setLoad(1, 'Ready');
$('loading').classList.add('hidden');
$('title').classList.remove('hidden');
// a new date, trailhead or character reloaded the page so the world is built for it: start straight away
if (sessionStorage.getItem('rawah-autostart')) { sessionStorage.removeItem('rawah-autostart'); begin(true); }


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
  // a blade keeps swinging while the button is held; fists still take one press per punch
  const held = hiker.tool === 'axe' || hiker.tool === 'machete';
  const fwOn = hiker.tool === 'fireworks';
  ctl.punch = live && !mindOn && !fwOn && (held ? (keys.has('KeyQ') || keys.has('Mouse0')) : (pressed.has('KeyQ') || pressed.has('Mouse0')));
  if (ctl.punch && props.throwStone()) ctl.punch = false;
  ctl.hook = live && !mindOn && !fwOn && (pressed.has('KeyR') || pressed.has('Mouse2'));
  ctl.stomp = live && pressed.has('KeyG');
  // fishing: the lean (A/D or a mouse swing), the reel (held Space) and the hook (Space pressed)
  const fishInp = { x: clamp(ctl.move.x + (ctl.lookX / Math.max(dt, 0.001)) / 3, -1, 1), reel: live && keys.has('Space'), hook: live && pressed.has('Space') };
  if (fishing.locked) { ctl.move.set(0, 0); ctl.jump = false; ctl.lookX = 0; ctl.lookY = 0; }
  if (roast.active || state.seat >= 0) ctl.jump = false;
  if (state.seat >= 0 || state.cut || atv.riding) { ctl.move.set(0, 0); ctl.punch = ctl.hook = ctl.stomp = ctl.grab = false; ctl.jump = false; }

  const p = hiker.pos;
  const env = {
    tempC: tempC(state.hour, p.y) - (p.y > world.treeline(p.x, p.z) ? 3 : 0) - Math.max(0, weather.wind) * 3,
    nearFire: !!camp.fire && camp.near(p, 'fire', 6),
    fireWarm: Math.min(1, plume.at(p.x, p.z).heat / 0.2),   // heat from the fire's certified field, thinning with distance and blown downwind
    inTent: !!state.sleeping,
    resting: state.resting,
  };
  if (live) {
    const before = hiker.pos.clone();
    const events = state.cut ? cutStep(dt, env) : state.seat >= 0 ? seatedStep(dt, env) : atv.riding ? rideStep(dt, env) : hiker.update(dt, ctl, env);
    state.km += Math.hypot(p.x - before.x, p.z - before.z) / 1000;
    for (const e of events) {
      if (e.type === 'step') {
        audio.step(e.surface, e.speed);
        if (e.surface === 'water') { lakes.ripple(p.x, p.z, 0.8); waves.drop(p.x, p.z, 0.22 + 0.04 * Math.min(4, e.speed), 0.006 + 0.004 * Math.min(4, e.speed)); }
        else if (e.surface === 'snow' || onSnowAt(p.y) > 0.35) world.sculpt.press(p.x, p.z, 0.55, 0.05);
      }
      else if (e.type === 'land') { audio.thud(e.hard); rig.land(e.fall); }
      else if (e.type === 'splash') { audio.splash(); hud.toast('Brrr — snowmelt water.', 'warn'); lakes.ripple(p.x, p.z, 1.6); waves.drop(p.x, p.z, 0.65, 0.05); }
      else if (e.type === 'grab') audio.step('rock', 2);
      else if (e.type === 'strike' && (e.kind === 'chop' || e.kind === 'slash')) props.strike(e);
      else if (e.type === 'toast') hud.toast(e.text, e.warn ? 'warn' : '');
      else if (e.type === 'fall') {
        if (e.severe) rescue(e.why);
        else { audio.thud(true); rig.land(8); hud.toast(e.why, 'warn'); }
      }
    }
    act();
    camping();
    fireworksInput();
    // caught out in it: rain soaks you (less under thick forest), wet snow too
    const soak = weather.precip * (1 - weather.snowK * 0.6) * (1 - world.coverAt(p.x, p.z, 0) * 0.5);
    if (soak > 0.2 && hiker.mode !== 'swim') hiker.wet = Math.max(hiker.wet, 30 * soak);
    const scale = (state.resting ? 8 : 1) * settings.timeScale;
    gameMin = dt * scale;
    advanceClock(gameMin);
    camp.update(dt, dt * scale, t, flameScale());
    smashClock(dt);
    if (t - lastDiscoveryCheck > 0.5) { lastDiscoveryCheck = t; checkDiscoveries(); }
    saveTimer += dt;
    if (saveTimer > 10) { saveTimer = 0; save(); }
  } else {
    camp.update(dt, 0, t, flameScale());
  }
  input.endFrame();

  if (atv.riding) { atv.seat(_seat); avatar.heading = atv.yaw; avatar.update(dt, rider); }
  else avatar.update(dt, hiker);
  const wheel = input.takeWheel();
  mind.resize(live && mindOn ? wheel : 0);
  mind.update(dt, live, {
    lift: keys.has('KeyQ') || keys.has('Mouse0'), sink: keys.has('KeyR') || keys.has('Mouse2'), level: keys.has('KeyE'),
  }, shaped);
  props.update(dt, live);
  if (state.started) party.update(live ? dt : 0, hiker);
  if (state.started && !state.paused && !state.travel && !state.sleeping) {
    for (const e of wood.update(dt, { pos: hiker.pos, yaw: hiker.yaw }, { axe: props.tool === 'axe', carryVisible: state.seat < 0 && !atv.riding && !state.cut, heading: avatar.heading, first: rig.mode === 'first' })) {
      if (e.type === 'toast') hud.toast(e.text, e.warn ? 'warn' : '');
      else if (e.type === 'sound') { if (e.name === 'chop') audio.chop(true); else audio[e.name]?.(); }
    }
  }
  if (state.started) {
    coffee.update(state.paused ? 0 : dt, {
      fire: camp.fire, tent: camp.tent, p: hiker.pos, yaw: hiker.yaw, heading: state.seat >= 0 ? camp.stools[state.seat].yaw : (rig.mode === 'first' ? hiker.yaw : avatar.heading),
      first: rig.mode === 'first', camera, seated: state.seat >= 0, minutes: state.paused ? 0 : gameMin,
    });
    camp.fireObj.setTeepee(!coffee.rigged);
    camp.lantern(sky.light < 0.4, hiker.pos);
    {   // the fire's smoke and heat, and the smoke you stand in
      const wind = Math.min(1, 0.2 + Math.max(0, weather.wind) * 0.9), pan = breakfast.pan.visible && breakfast.cook > 1.1 ? breakfast.pan.getWorldPosition(_pw) : null;
      plume.update(state.paused ? 0 : dt, { fire: camp.fire, pan: pan && { x: pan.x, z: pan.z, level: Math.min(0.8, (breakfast.cook - 1.1) * 1.4) }, wind, p: hiker.pos });
      camp.fireObj.smoke.material.uniforms.uDrift.value.set(plume.dir[0] * (0.5 + 2.2 * wind), plume.dir[1] * (0.5 + 2.2 * wind));
      const air = plume.at(hiker.pos.x, hiker.pos.z);
      if (air.smoke > 0.12 && !state.paused) {
        hiker.stamina = Math.min(hiker.stamina, 100 - 70 * air.smoke);   // you cannot catch your breath in it
        if (Math.random() < dt * 3 * air.smoke) audio.cough();
        if (t - smokeToast > 25) { smokeToast = t; hud.toast('Smoke in your eyes. Move upwind of the fire.', 'warn'); }
      }
    }
    breakfast.update(state.paused ? 0 : dt, { on: coffee.rigged && !!camp.fire, fire: camp.fire, p: hiker.pos, yaw: hiker.yaw, seated: state.seat >= 0, coffeeReach: coffee.reach(hiker.pos, hiker.yaw) });
    const nearBud = () => { const b = party.near(hiker.pos); return b && Math.hypot(b.x - hiker.pos.x, b.z - hiker.pos.z) < 12 ? b : null; };
    for (const e of breakfast.events) {
      if (e.type === 'toast') hud.toast(e.text, e.warn ? 'warn' : '');
      else if (e.type === 'sound') audio[e.name]?.();
      else if (e.type === 'ready') {
        audio.ready();
        hud.discovery('Breakfast is ready', 'Bacon and eggs, hot off the grate', 'Cooked');
        if (nearBud()) party.tell('That smells amazing. Save me some!', nearBud());
      } else if (e.type === 'eat') {
        audio.sip();
        coffeeBoost += 45 * e.q; hiker.warmth = Math.min(100, hiker.warmth + 12 * e.q);
        hud.discovery(e.label, `Breakfast ${breakfast.eaten}`, 'You ate');
        party.event('smore');
        save();
      }
    }
    for (const e of coffee.events) {
      if (e.type === 'toast') hud.toast(e.text, e.warn ? 'warn' : '');
      else if (e.type === 'sound') audio[e.name]?.();
      else if (e.type === 'ready') {
        audio.ready();
        hud.discovery('Coffee is ready', 'The percolator has finished perking', 'Brewed');
        if (nearBud()) party.tell('Coffee smells ready!', nearBud());
      } else if (e.type === 'sip') {
        audio.sip();
        coffeeBoost += 24 * e.q; hiker.warmth = Math.min(100, hiker.warmth + 3 * e.q);
        hud.toast(e.left > 0 ? `${e.q > 0.75 ? 'Hot' : e.q > 0.55 ? 'Warm' : 'Lukewarm'} coffee · ${e.left} sip${e.left > 1 ? 's' : ''} left` : 'That was the last sip. Brew more at the fire.');
        save();
      }
    }
    if (coffeeBoost > 0 && !state.paused) { const d = Math.min(coffeeBoost, 14 * dt); hiker.stamina = Math.min(100, hiker.stamina + d); coffeeBoost -= d; }
    dump.update(state.paused ? 0 : dt, p);
    for (const e of dump.events) audio[e.name]?.(e.v);
    for (const e of fireworks.update(state.paused ? 0 : dt, { p: hiker.pos, camera, scale: flameScale() })) {
      if (e.type === 'toast') hud.toast(e.text);
      else if (e.type === 'sound') audio[e.name]?.(e.v, e.delay || 0, e);
      else if (e.type === 'shake') { if (e.amount > 0.05) rig.land(4 * e.amount); }
    }
  }
  // the friends press snow too, a print every stride or so
  if (live && onSnowAt(p.y) > 0.35) for (const a of party.actors) {
    const d = a._px === undefined ? 99 : Math.hypot(a.x - a._px, a.z - a._pz);
    if (d > 1.1) { world.sculpt.press(a.x, a.z, 0.5, 0.04); a._px = a.x; a._pz = a.z; }
  }
  if (fishing.locked && live) {
    const eyeP = hiker.eye(_eye2), dx = fishing.focus.x - eyeP.x, dz = fishing.focus.z - eyeP.z, dy = fishing.focus.y - eyeP.y;
    const k = Math.min(1, dt * 2.5), horiz = Math.hypot(dx, dz);
    let dyaw = Math.atan2(-dx, -dz) - hiker.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    if (horiz > 1.2) hiker.yaw += dyaw * k * 0.8;
    hiker.pitch += (clamp(Math.atan2(dy, Math.max(horiz, 0.5)) + 0.12, -1.1, 0.2) - hiker.pitch) * k;
  }
  if (roast.active) {
    const sy = Math.sin(hiker.yaw), cy = Math.cos(hiker.yaw);
    const f = camp.fire;
    _rf.set(-sy, 0, -cy); _rr.set(cy, 0, -sy);
    _rh.set(hiker.pos.x + _rr.x * 0.26 + _rf.x * 0.3, hiker.pos.y + (state.seat >= 0 ? 0.8 : 1.08), hiker.pos.z + _rr.z * 0.26 + _rf.z * 0.3);
    roast.update(state.paused ? 0 : dt, {
      hand: _rh, fwd: _rf, right: _rr, t,
      fire: f ? { x: f.x, z: f.z, y: camp.flameBase, fuel: Math.min(1, f.life / 25) } : null,
      hold: live && keys.has('Space'),
    });
  }
  if (state.started && !state.paused && !state.travel && !state.sleeping) {
    for (const e of fishing.update(dt, { pos: hiker.pos, yaw: hiker.yaw, pitch: hiker.pitch, mode: hiker.mode }, fishInp)) {
      if (e.type === 'toast') hud.toast(e.text, e.warn ? 'warn' : '');
      else if (e.type === 'sound') { if (e.name === 'splash') audio.splash(); else if (e.name === 'reel') audio.reel(); else audio.whoosh?.(0.35); }
      else if (e.type === 'catch') {
        const f = e.fish;
        hud.discovery(f.name, `${f.cm} cm · ${f.kg} kg · fish ${f.n}${f.record ? ' · your biggest yet' : ''}`, 'Caught');
        party.event('fish');
        boxels.wear(hiker.pos.x, hiker.pos.z, 0.3);   // the bank remembers where you stood
        save();
      }
    }
  }
  const zoom = mindOn ? 0 : wheel;
  let focus = p;
  if (state.travel) {
    // stream trees under the flight first, then around where you'll land
    const u = flyStep(dt, flyFocus);
    focus = flyFocus;
    cullView();
    flora.update(u < 0.55 ? flyFocus : p, 2, dt);
  } else {
    // the view opens up with speed: a little when you sprint, and more and more as the quad gets going
    rig.update(dt, { zoom: map.open ? 0 : zoom, sprinting: !atv.riding && ctl.sprint && hiker.moving > 0.5 && hiker.stamina > 2, strafe: ctl.move.x, fovBoost: atv.riding ? clamp(Math.abs(atv.speed) / 17, 0, 1) ** 1.3 * 16 + (ctl.sprint && atv.speed > 6 ? 4 : 0) : 0 });
    floraTimer += dt;
    cullView();
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
  // cold air pools in the valleys at dawn and burns off by midmorning; wet ground breathes extra mist into it
  const damp = boxels.sample(p.x, p.z).u;
  atmosphere.uValley.value = 0.00004 * (1 + 2.2 * Math.exp(-((state.hour - 6.6) ** 2) / 4.5) * (1 + damp * 1.4)) * (1 - 0.5 * smoothstep(0.4, 1, weather.cloud));
  sky.update(state.hour, eye, focus, t, weather);
  // snow underfoot bounces light back up into the shadows
  const onSnow = onSnowAt(p.y);
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
  grass.clear(camp.fire && [camp.fire.x, camp.fire.z, 1.9], camp.tent && (camp.tent.kind === 'family' ? [camp.tent.x - Math.sin(camp.tent.yaw) * 3.3, camp.tent.z - Math.cos(camp.tent.yaw) * 3.3, camp.tent.x + Math.sin(camp.tent.yaw) * 3.6, camp.tent.z + Math.cos(camp.tent.yaw) * 3.6, 2.3] : [camp.tent.x, camp.tent.z, 3.0]), ...wood.clearings(hiker.pos), ...dump.clearings(hiker.pos));
  grass.update(camera, hiker, clamp((1.5 - tC) / 4, 0, 1) * (1 - smoothstep(8.5, 10.5, h)) * (h > 3 ? 1 : 0), calendar.cure, avatar.heading, renderer);
  // the ground remembers: footsteps wear it, rain wets it, sun dries it —
  // every event's certified cone decides which cells the sim may skip
  if (live) {
    if (!bxLast) bxLast = { x: p.x, z: p.z };
    bxAcc += Math.hypot(p.x - bxLast.x, p.z - bxLast.z);
    bxLast = { x: p.x, z: p.z };
    if (bxAcc > 1.4 && hiker.grounded) { bxAcc = 0; boxels.wear(p.x, p.z, 0.3); }
    if (weather.precip > 0.25 && t - bxRain > 2.5) { bxRain = t; boxels.wet(p.x + (Math.random() - 0.5) * 170, p.z + (Math.random() - 0.5) * 170, 0.5, 5); }
  }
  // rain pocks the open water around you; the field sleeps itself when nothing is left to see
  if (live && weather.precip > 0.05) {
    rainAcc += dt * weather.precip * 26;
    for (; rainAcc >= 1; rainAcc--) {
      const x = p.x + (Math.random() - 0.5) * 34, z = p.z + (Math.random() - 0.5) * 34;
      if (waterAt(x, z)) waves.drop(x, z, 0.13, 0.0025 + Math.random() * 0.002);
    }
  }
  waves.update(state.paused ? 0 : dt, p.x, p.z, currentAt(p.x, p.z));
  boxels.update(dt, live ? (0.35 + 0.65 * (1 - weather.cloud)) * (state.resting ? 4 : 1) : 0);
  headlamp.intensity = state.lamp ? 60 : 0;
  lakes.uniforms.uSky.value.copy(sky.uniforms.uHorizon.value).lerp(sky.uniforms.uZenith.value, 0.3);
  lakes.uniforms.uRain.value = weather.precip;
  WATER.uWT.value = t; WATER.uWind.value = clamp(0.1 + Math.max(0, weather.wind) * 0.95, 0, 1); WATER.uRainAmt.value = weather.precip * (1 - weather.snowK);
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
      hiker.injured > 0 ? 'Sore ankle' : '', hiker.wet > 0 ? 'Wet' : '', hiker.cold ? 'Cold' : '', state.resting ? 'Resting' : '', wood.carried > 0 ? `Firewood ×${wood.carried}` : '', plume.at(p.x, p.z).smoke > 0.12 ? 'Smoky' : '', coffee.cup.sips > 0 ? `Coffee ×${coffee.cup.sips}` : '']
      .filter(Boolean).join(' · ');
    let hint = hiker.hint || props.hint;
    if (!hint && hiker.tool === 'fireworks') hint = fireworks.toolHint(p);
    if (!hint && wood.hint) hint = wood.hint;
    if (!hint && breakfast.hint) hint = breakfast.hint;
    if (!hint && (coffee.hint || breakfast.tip)) hint = [coffee.hint, breakfast.tip].filter(Boolean).join('  ·  ');
    if (!hint && state.seat >= 0 && coffee.cup.sips > 0) hint = '[U] stand up  ·  [O] sip coffee';
    if (!hint && camp.near(p, 'tent', 4.5)) hint = state.hour >= 19 || state.hour < 5 ? '[Z] sleep until morning · [F] fire · [C] pack up' : '[Z] nap · [F] fire · [C] pack up';
    if (!hint && sky.light < 0.35 && !camp.tent && hiker.mode === 'walk') hint = 'Getting dark — find flat ground away from water and [C] make camp';
    if (!hint && sky.light < 0.2 && !state.lamp) hint = '[L] headlamp';
    if (!hint && fishing.hint) hint = fishing.hint;
    if (!hint && state.seat < 0 && camp.fire && Math.hypot(camp.fire.x - p.x, camp.fire.z - p.z) < 3.8 && !fishing.busy) hint = '[U] sit · [N] roast a marshmallow';
    if (!hint && !atv.riding && !fishing.busy && fishing.spotAhead({ pos: p, yaw: hiker.yaw, mode: hiker.mode })) hint = '[B] cast a line';
    if (!hint && !atv.riding && atv.near(p)) hint = '[U] ride the quad';
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
  if (state.started && (frameNo++ % 30 === 0)) { feedFriends(p); feedGuide(p); }
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
    world, hiker, camp, state, flora, terrain, renderer, scene, camera, boxels,
    bench(o) { return boxels.bench(o); },
    benchQ(o) { return boxels.benchQ(o); },
    benchMulti(o) { return boxels.benchMulti(o); },
    benchRain(o) { return boxels.benchRain(o); },
    plume, waves, waterAt,
    benchPlume(o) { return plume.smoke.bench(o); },
    begin, tick, save, rig, avatar, party, input, props, mind, guide, wood, fireworks, coffee, dump, breakfast, camp, atv, fishing, roast, sky, grass, horizon, together: (o) => toggleTogether(o),
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
