import * as THREE from 'three';
import { Fire } from './fire.js';

// Camp: pitch a tent on flat ground (Leave No Trace distances from water and
// trail), build a fire below treeline where there is deadfall, and sleep
// through to morning. The tent is also where you come to after a bad fall.

const CAMP_FROM_WATER = 61;  // 200 ft
const CAMP_FROM_TRAIL = 30;

function tentMesh() {
  const g = new THREE.Group();
  const fly = new THREE.MeshLambertMaterial({ color: 0xd8692a, side: THREE.DoubleSide });
  const floor = new THREE.MeshLambertMaterial({ color: 0x3a3f36 });
  const w = 1.5, h = 1.15, l = 2.3;
  const shape = new THREE.Shape([new THREE.Vector2(-w / 2 - 0.15, 0), new THREE.Vector2(0, h), new THREE.Vector2(w / 2 + 0.15, 0)]);
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: l, bevelEnabled: false }), fly);
  body.position.z = -l / 2;
  const base = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.04, l + 0.2), floor);
  base.position.y = 0.02;
  const door = new THREE.Mesh(new THREE.CircleGeometry(0.42, 3), new THREE.MeshLambertMaterial({ color: 0x2a2620 }));
  door.position.set(0, 0.33, l / 2 + 0.01);
  door.rotation.z = Math.PI / 2;
  door.scale.set(1, 1.4, 1);
  g.add(body, base, door);
  g.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  return g;
}

/** A three-legged folding camp stool, seat 45 cm up. */
function stoolMesh() {
  const g = new THREE.Group();
  const fabric = new THREE.MeshLambertMaterial({ color: 0x2c4a6e });
  const metal = new THREE.MeshLambertMaterial({ color: 0x9aa0a6 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x15181b });
  const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.035, 22), fabric);
  seat.position.y = 0.432;
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.212, 0.012, 6, 28), dark);
  rim.rotation.x = Math.PI / 2; rim.position.y = 0.43;
  g.add(seat, rim);
  const leg = (a) => {
    const top = new THREE.Vector3(Math.cos(a) * 0.12, 0.42, Math.sin(a) * 0.12), bot = new THREE.Vector3(Math.cos(a) * 0.27, 0.01, Math.sin(a) * 0.27);
    const d = top.clone().sub(bot), len = d.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, len, 6), metal);
    m.position.copy(bot).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 5), dark);
    foot.position.copy(bot);
    g.add(m, foot);
  };
  for (let i = 0; i < 3; i++) leg(i * Math.PI * 2 / 3 + Math.PI / 2);
  const brace = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.008, 5, 24), metal);
  brace.rotation.x = Math.PI / 2; brace.position.y = 0.17;
  g.add(brace);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

const FUEL = 300;        // game minutes a fire burns
const STOOL_R = 1.4;     // how far from the fire the stools sit

export class Camp {
  constructor(world, flora, scene) {
    this.world = world;
    this.flora = flora;
    this.scene = scene;
    this.tent = null;    // {x, z, yaw}
    this.fire = null;    // {x, z, life}
    this.tentObj = tentMesh();
    this.fireObj = new Fire();
    this.tentObj.visible = false;
    this.fireObj.visible = false;
    scene.add(this.tentObj, this.fireObj.group);
    // two stools to sit on, set out when the fire is lit
    this.stools = [0, 1].map(() => {
      const obj = stoolMesh();
      obj.visible = false;
      scene.add(obj);
      return { x: 0, z: 0, yaw: 0, obj };
    });
  }

  near(p, what, r = 3.2) {
    const t = this[what];
    return t ? Math.hypot(t.x - p.x, t.z - p.z) < r : false;
  }

  /** Why you cannot camp here, or null if you can. */
  campProblem(x, z) {
    const w = this.world;
    if (w.localGrade(x, z) > 0.2 || w.localGrade(x + 1, z) > 0.2 || w.localGrade(x, z + 1.2) > 0.2) return 'Too sloped to pitch a tent.';
    if (w.nearWater(x, z, CAMP_FROM_WATER)) return 'Camp at least 200 ft (61 m) from lakes.';
    const t = w.nearestTrail(x, z);
    if (t.trail && t.d < CAMP_FROM_TRAIL) return 'Too close to the trail — find a spot out of sight.';
    if (this.flora.collide({ x, z }, 1.3, Infinity) > -Infinity) return 'A boulder is in the way.';
    return null;
  }

  pitch(x, z, yaw) {
    this.tent = { x, z, yaw };
    this.tentObj.position.set(x, this.world.height(x, z), z);
    this.tentObj.rotation.y = yaw;
    this.tentObj.visible = true;
  }

  strike() {
    this.tent = null;
    this.tentObj.visible = false;
    this.douse();
    for (const st of this.stools) st.obj.visible = false;
  }

  /** The stool within reach of `p` (nearest first), or -1. */
  stoolNear(p, r = 2.3) {
    let best = -1, bd = r;
    this.stools.forEach((st, i) => {
      if (!st.obj.visible) return;
      const d = Math.hypot(st.x - p.x, st.z - p.z);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Set the two stools either side of the fire, facing it, off the tent and clear of rocks and water. */
  #setStools(x, z) {
    const w = this.world;
    const toTent = this.tent ? Math.atan2(this.tent.z - z, this.tent.x - x) : 0;
    const ok = (sx, sz) => !w.lakeAt(sx, sz) && w.localGrade(sx, sz) < 0.45 && this.flora.collide({ x: sx, z: sz }, 0.4, Infinity) === -Infinity
      && !(this.tent && Math.hypot(this.tent.x - sx, this.tent.z - sz) < 1.7);
    this.stools.forEach((st, i) => {
      const base = toTent + (i ? -1 : 1) * 1.65;
      let at = [x + Math.cos(base) * STOOL_R, z + Math.sin(base) * STOOL_R];
      for (const da of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9, 1.3, -1.3]) {
        const a = base + da, sx = x + Math.cos(a) * STOOL_R, sz = z + Math.sin(a) * STOOL_R;
        if (ok(sx, sz)) { at = [sx, sz]; break; }
      }
      st.x = at[0]; st.z = at[1];
      st.yaw = Math.atan2(-(x - st.x), -(z - st.z));      // facing the fire
      st.obj.position.set(st.x, w.height(st.x, st.z), st.z);
      st.obj.rotation.y = st.yaw;
      st.obj.visible = true;
    });
  }

  fireProblem(x, z) {
    const w = this.world;
    if (!this.tent || Math.hypot(this.tent.x - x, this.tent.z - z) > 12) return 'Build a fire at your camp.';
    if (Math.hypot(this.tent.x - x, this.tent.z - z) < 3.2) return 'Too close to the tent — build the fire a few steps away.';
    if (w.height(x, z) > w.treeline(x, z) - 20) return 'No deadfall up here — you are above treeline.';
    if (!this.flora.treeNear(x, z, 45)) return 'No firewood nearby.';
    return null;
  }

  light(x, z) {
    this.fire = { x, z, life: FUEL }; // game minutes of fuel
    this.fireObj.group.position.set(x, this.world.height(x, z), z);
    this.fireObj.visible = true;
    this.#setStools(x, z);
  }

  douse() {
    this.fire = null;
    this.fireObj.visible = false;
  }

  /** `scale`: viewport height in pixels over 2 tan(fov / 2), for the flame sprites. */
  /** Shake the tent for this many seconds. */
  shake(seconds) {
    this.shakeFor = this.shakeLeft = seconds;
    if (this.tent) this.shakeBase = { x: this.tentObj.position.x, y: this.tentObj.position.y, z: this.tentObj.position.z };
  }

  #shakeTent(dt) {
    if (!this.shakeLeft || !this.tent) return;
    this.shakeLeft = Math.max(0, this.shakeLeft - dt);
    const t = this.shakeFor - this.shakeLeft, b = this.shakeBase, o = this.tentObj;
    // builds for a couple of seconds, surges in waves, and settles at the end
    const env = Math.min(1, t / 1.6) * Math.min(1, this.shakeLeft / 1.2) * (0.65 + 0.35 * Math.sin(t * 1.9));
    o.position.set(b.x + Math.sin(t * 31) * 0.035 * env, b.y + Math.abs(Math.sin(t * 17)) * 0.04 * env, b.z + Math.cos(t * 27) * 0.035 * env);
    o.rotation.set(Math.sin(t * 29 + 1) * 0.045 * env, this.tent.yaw + Math.sin(t * 13) * 0.03 * env, Math.sin(t * 23) * 0.06 * env);
    if (this.shakeLeft === 0) { o.position.set(b.x, b.y, b.z); o.rotation.set(0, this.tent.yaw, 0); }
  }

  update(dt, gameMinutes, t, scale = 800) {
    this.#shakeTent(dt);
    if (!this.fire) return;
    this.fire.life -= gameMinutes;
    if (this.fire.life <= 0) { this.douse(); return; }
    this.fireObj.update(t, Math.min(1, this.fire.life / 25), scale);
  }

  /** Ground under this area was reshaped: the tent and fire sit on it again. */
  settle({ x0, z0, x1, z1 }) {
    for (const o of [this.tentObj, this.fireObj?.group]) {
      if (!o?.parent) continue;
      const { x, z } = o.position;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) o.position.y = this.world.height(x, z);
    }
  }

  /** Height of the flames' centre above the world, for the roasting stick. */
  get flameBase() { return this.fireObj.group.position.y; }

  save() {
    return { tent: this.tent, fire: this.fire };
  }

  load(s) {
    if (s?.tent) this.pitch(s.tent.x, s.tent.z, s.tent.yaw);
    if (s?.fire && this.tent) { this.light(s.fire.x, s.fire.z); this.fire.life = s.fire.life; }
  }
}
