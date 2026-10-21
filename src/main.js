import * as THREE from 'three';
import { World } from './world.js';
import { farTerrain, terrainMaterial, colorTexture, coverTexture, makeNoiseTexture } from './terrain.js';
import { CDLODTerrain } from './cdlod.js';
import { Flora } from './flora.js';
import { buildLakes, buildTrails, buildSigns, buildStreams } from './features.js';
import { Sky } from './sky.js';
import { Hiker } from './hiker.js';
import { Camp } from './camp.js';
import { Hud } from './hud.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { CameraRig } from './camera.js';
import { Avatar } from './avatar.js';
import { clamp, smoothstep, valueNoise } from './noise.js';

const SAVE_KEY = 'rawah-save-v2';
const $ = (id) => document.getElementById(id);
const DEV = ['localhost', '127.0.0.1', ''].includes(location.hostname);

const settings = loadJSON('rawah-settings', { sens: 1, fov: 72, shadows: true, volume: 0.8, timeScale: 1 });

// ------------------------------------------------------------------ renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = settings.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.1, 90000);
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

setLoad(0.02, 'Downloading the Rawah…');
const world = await World.load('./data', (f) => setLoad(f * 0.6));
setLoad(0.7, 'Raising the Medicine Bow crest…');
await frame();
const noiseTex = makeNoiseTexture();
const F = world.far;
const farMat = terrainMaterial(colorTexture(F.image), F.N * F.cell, noiseTex);
await frame();

const terrain = new CDLODTerrain(world, { colorMap: colorTexture(world.colorImage), coverMap: coverTexture(world.coverData, world.coverN), noise: noiseTex });
scene.add(terrain.group);
scene.add(farTerrain(world, farMat));
const sky = new Sky(scene);
const lakes = buildLakes(world);
scene.add(lakes.group);
scene.add(buildTrails(world));
scene.add(buildSigns(world));
const streams = buildStreams(world);
scene.add(streams.group);
const flora = new Flora(world, scene, renderer);
const camp = new Camp(world, flora, scene);
const hiker = new Hiker(world, flora);
const avatar = new Avatar(scene);
const rig = new CameraRig(camera, world, hiker, avatar);
const hud = new Hud(world);
const audio = new Audio();
setLoad(0.85, 'Drawing the map…');
await frame();
hud.buildMap(world.colorImage);

// ------------------------------------------------------------------ state
const lakeList = world.lakes.filter((l) => l.name);
const peaks = world.places.filter((p) => p.kind === 'peak');
const trailhead = world.mainTrailhead || world.places.find((p) => p.kind === 'trailhead');
const state = {
  hour: 7.25, day: 1, km: 0,
  discovered: new Set(),
  paused: true, started: false,
  sleeping: 0, resting: false,
  rescue: null,
};

function spawnAtCar() {
  const { x, z, toward } = world.startSpot || { ...trailhead, toward: [trailhead.x - 1, trailhead.z] };
  // face up the trail toward the mountains
  hiker.place(x, z, Math.atan2(-(toward[0] - x), -(toward[1] - z)));
}

function save() {
  const data = {
    x: hiker.pos.x, z: hiker.pos.z, yaw: hiker.yaw, hour: state.hour, day: state.day, km: state.km,
    discovered: [...state.discovered], camp: camp.save(),
    stamina: hiker.stamina, warmth: hiker.warmth,
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
  return true;
}

const hasSave = !!loadJSON(SAVE_KEY, null);
spawnAtCar();
$('btn-continue').classList.toggle('hidden', !hasSave);

// ------------------------------------------------------------------ input
const input = new Input(renderer.domElement);
const { keys, pressed } = input;
input.onPress = (code) => {
  if (!state.started) return;
  if (code === 'KeyM' || code === 'Tab') toggleMap();
  if (code === 'KeyV' && !state.paused) hud.toast(rig.toggle() === 'first' ? 'First person' : 'Third person · scroll to zoom');
  if (code === 'Escape' && input.usingPad) pause(!state.paused); // keyboard Escape releases pointer lock instead
};
renderer.domElement.addEventListener('click', () => { if (state.started && !state.paused) lockPointer(); });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement && state.started && !hud.mapOpen && !state.sleeping) pause(true);
});

function lockPointer() {
  try { renderer.domElement.requestPointerLock()?.catch?.(() => {}); } catch { /* headless */ }
}

function toggleMap() {
  hud.mapOpen = !hud.mapOpen;
  $('map').classList.toggle('hidden', !hud.mapOpen);
}

function pause(on) {
  state.paused = on;
  $('pause').classList.toggle('hidden', !on);
  if (on) { renderJournal(); keys.clear(); }
  else lockPointer();
}

function begin(fresh) {
  if (fresh) {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    camp.strike();
    Object.assign(state, { hour: 7.25, day: 1, km: 0 });
    state.discovered = new Set();
    hiker.stamina = hiker.warmth = 100;
    spawnAtCar();
  } else restore();
  state.started = true;
  $('title').classList.add('hidden');
  $('hud').classList.remove('hidden');
  audio.start();
  audio.setVolume(settings.volume);
  pause(false);
  if (fresh) {
    const hello = `${trailhead.name} · ${ft(hiker.pos.y)} ft. Twin Crater Lakes are up the West Branch and Rawah trails.`;
    setTimeout(() => hud.toast(hello), 600);
    setTimeout(() => hud.toast('[M] map · [C] camp · [F] fire · [Z] sleep · [E] climb'), 5200);
  }
}

$('btn-start').onclick = () => begin(true);
$('btn-continue').onclick = () => begin(false);
$('btn-resume').onclick = () => pause(false);
$('btn-restart').onclick = () => { if (confirm('Start over at the trailhead? Your journal will be cleared.')) begin(true); };

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
  const found = lakeList.filter((l) => state.discovered.has(l.label)).length;
  const bagged = peaks.filter((q) => state.discovered.has(`peak:${q.name}`)).length;
  $('journal-summary').textContent = `Day ${state.day} · ${found} of ${lakeList.length} lakes · ${bagged} of ${peaks.length} summits · ${state.km.toFixed(1)} km hiked`;
  const add = (text, done) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = done ? 'done' : '';
    list.appendChild(li);
  };
  [...peaks].sort((a, b) => b.elev - a.elev).forEach((q) => add(`${q.name} · ${ft(q.elev)} ft`, state.discovered.has(`peak:${q.name}`)));
  [...lakeList].sort((a, b) => b.level - a.level).forEach((l) => add(`${l.label} · ${ft(l.level)} ft`, state.discovered.has(l.label)));
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
  hiker.stamina = 100; hiker.warmth = Math.max(hiker.warmth, 85); hiker.injured = 0; hiker.wet = 0;
  camp.douse();
  state.sleeping = 0;
  $('fade').classList.remove('on');
  hud.toast(s.night ? `Morning, day ${state.day}. Frost on the fly.` : 'Rested.');
  save();
}

function advanceClock(mins) {
  state.hour += mins / 60;
  while (state.hour >= 24) { state.hour -= 24; state.day++; }
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

// ------------------------------------------------------------------ world queries
function tempC(hour, elev) {
  const valley = 7.5 + 9.5 * Math.cos(((hour - 15) / 24) * Math.PI * 2);
  return valley - ((elev - 2700) / 1000) * 6.5;
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
      const n = lakeList.filter((q) => state.discovered.has(q.label)).length;
      hud.discovery(l.label, `${ft(l.level)} ft · lake ${n} of ${lakeList.length}`);
      save();
    }
  }
  for (const q of peaks) {
    const key = `peak:${q.name}`;
    if (state.discovered.has(key) || Math.hypot(q.x - p.x, q.z - p.z) > 35 || p.y < q.elev - 12) continue;
    state.discovered.add(key);
    const n = peaks.filter((o) => state.discovered.has(`peak:${o.name}`)).length;
    hud.discovery(q.name, `${ft(q.elev)} ft · summit ${n} of ${peaks.length}${q.elev === Math.max(...peaks.map((o) => o.elev)) ? ' · the roof of the Rawah' : ''}`);
    save();
  }
}

// ------------------------------------------------------------------ loop
const eye = new THREE.Vector3();
const ctl = { move: new THREE.Vector2(), sprint: false, jump: false, grab: false, lookX: 0, lookY: 0 };
let last = performance.now(), saveTimer = 0, floraTimer = 0, t = 0;

while (flora.update(hiker.pos, 8) > 0) { /* fill the first ring of trees */ }
setLoad(1, 'Ready');
$('loading').classList.add('hidden');
$('title').classList.remove('hidden');

function tick(dt, draw = true) {
  t += dt;
  const live = state.started && !state.paused && !state.sleeping && !state.rescue;
  if (state.sleeping) {
    state.sleeping.t += dt;
    if (state.sleeping.t > 2.2) finishSleep();
  } else if (state.rescue) {
    state.rescue.t += dt;
    if (state.rescue.t > 2.6) finishRescue();
  }

  input.poll();
  const [lx, ly] = input.look(dt, settings.sens);
  ctl.lookX = live && !hud.mapOpen ? lx : 0;
  ctl.lookY = live && !hud.mapOpen ? ly : 0;
  input.move(ctl.move);
  if (!live || hud.mapOpen) ctl.move.set(0, 0);
  ctl.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
  ctl.jump = live && pressed.has('Space');
  ctl.grab = live && pressed.has('KeyE');

  const p = hiker.pos;
  const env = {
    tempC: tempC(state.hour, p.y) - (p.y > world.treeline(p.x, p.z) ? 3 : 0),
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
      else if (e.type === 'toast') hud.toast(e.text, e.warn ? 'warn' : '');
      else if (e.type === 'fall') {
        if (e.severe) rescue(e.why);
        else { audio.thud(true); rig.land(8); hud.toast(e.why, 'warn'); }
      }
    }
    act();
    const scale = (state.resting ? 8 : 1) * settings.timeScale;
    advanceClock((dt * scale));
    camp.update(dt, dt * scale, t);
    if (t - lastDiscoveryCheck > 0.5) { lastDiscoveryCheck = t; checkDiscoveries(); }
    saveTimer += dt;
    if (saveTimer > 10) { saveTimer = 0; save(); }
  } else {
    camp.update(dt, 0, t);
  }
  input.endFrame();

  avatar.update(dt, hiker);
  rig.update(dt, { zoom: input.takeWheel(), sprinting: ctl.sprint && hiker.moving > 0.5 && hiker.stamina > 2, strafe: ctl.move.x });
  eye.copy(camera.position);

  camera.updateMatrixWorld();
  terrain.update(camera);
  floraTimer += dt;
  flora.update(p, floraTimer > 0.12 ? 1 : 0, dt);
  if (floraTimer > 0.12) floraTimer = 0;
  sky.update(state.hour, eye, p, t);
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
  const gust = valueNoise(t * 0.15, 3.7) ** 2;
  const exposure = smoothstep(cv.treeline - 120, cv.treeline + 200, p.y);
  audio.update(dt, {
    exposure, gust, forest: cv.forest, daylight: sky.light,
    dusk: (state.hour > 17.8 && state.hour < 20.5) || (state.hour > 5.8 && state.hour < 7.5),
    elevation: p.y, creek,
    fireDist: camp.fire ? Math.hypot(camp.fire.x - p.x, camp.fire.z - p.z) : 999,
  });

  if (state.started) {
    const [place, sub] = locate(p, cv);
    const found = lakeList.filter((l) => state.discovered.has(l.label)).length;
    const status = [hiker.mode === 'climb' ? 'Climbing' : hiker.mode === 'swim' ? 'Swimming' : hiker.sliding ? 'Sliding' : '',
      hiker.injured > 0 ? 'Sore ankle' : '', hiker.wet > 0 ? 'Wet' : '', hiker.cold ? 'Cold' : '', state.resting ? 'Resting' : '']
      .filter(Boolean).join(' · ');
    let hint = hiker.hint;
    if (!hint && camp.near(p, 'tent', 4.5)) hint = state.hour >= 19 || state.hour < 5 ? '[Z] sleep until morning · [F] fire · [C] pack up' : '[Z] nap · [F] fire · [C] pack up';
    if (!hint && sky.light < 0.35 && !camp.tent && hiker.mode === 'walk') hint = 'Getting dark — find flat ground away from water and [C] make camp';
    if (!hint && sky.light < 0.2 && !state.lamp) hint = '[L] headlamp';
    hud.update({
      yaw: hiker.yaw, place, sub: `${sub} · ${latLon(p)}`, elev: p.y,
      clock: `Day ${state.day} · ${clock(state.hour)}`, tempC: env.tempC,
      stamina: hiker.stamina, warmth: hiker.warmth, grip: hiker.grip, climbing: hiker.mode === 'climb',
      hint, injured: hiker.injured > 0, status,
      discovered: state.discovered, tent: camp.tent, x: p.x, z: p.z,
      lakesFound: found, lakesTotal: lakeList.length, km: state.km,
      peaksFound: peaks.filter((q) => state.discovered.has(`peak:${q.name}`)).length, peaksTotal: peaks.length,
    });
  }
  if (draw) renderer.render(scene, camera);
}

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ------------------------------------------------------------------ dev hooks (local only)
if (DEV) {
  window.__rawah = {
    world, hiker, camp, state, flora, terrain, renderer, scene, camera,
    begin, tick, save, rig, avatar, input,
    cam() { return rig.toggle(); },
    teleport(x, z, yaw = hiker.yaw) { hiker.place(x, z, yaw); while (flora.update(hiker.pos, 8) > 0); },
    goto(name) { const pl = world.places.find((q) => q.name === name); if (pl) this.teleport(pl.x, pl.z); return pl; },
    setHour(h) { state.hour = h; },
    look(yaw, pitch = 0) { hiker.yaw = yaw; hiker.pitch = pitch; },
    press(code) { pressed.add(code); },
    map() { toggleMap(); },
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
