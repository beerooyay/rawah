import * as THREE from 'three';

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

function fireMesh() {
  const g = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: 0x77726c });
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.17, 0), stone);
    const a = (i / 9) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.55, 0.06, Math.sin(a) * 0.55);
    s.scale.y = 0.7;
    g.add(s);
  }
  const wood = new THREE.MeshLambertMaterial({ color: 0x4a3322 });
  for (let i = 0; i < 4; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.8, 5), wood);
    log.rotation.z = Math.PI / 2 - 0.55;
    log.rotation.y = (i / 4) * Math.PI * 2;
    log.position.y = 0.2;
    g.add(log);
  }
  const flameMat = new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const flames = [];
  for (let i = 0; i < 5; i++) {
    const f = new THREE.Mesh(new THREE.ConeGeometry(0.16 - i * 0.015, 0.7, 6), flameMat);
    f.position.set((Math.random() - 0.5) * 0.2, 0.4, (Math.random() - 0.5) * 0.2);
    g.add(f);
    flames.push(f);
  }
  const light = new THREE.PointLight(0xff8a3a, 0, 22, 1.6);
  light.position.y = 0.8;
  g.add(light);
  return { group: g, flames, light };
}

export class Camp {
  constructor(world, flora, scene) {
    this.world = world;
    this.flora = flora;
    this.scene = scene;
    this.tent = null;    // {x, z, yaw}
    this.fire = null;    // {x, z, life}
    this.tentObj = tentMesh();
    this.fireObj = fireMesh();
    this.tentObj.visible = false;
    this.fireObj.group.visible = false;
    scene.add(this.tentObj, this.fireObj.group);
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
  }

  fireProblem(x, z) {
    const w = this.world;
    if (!this.tent || Math.hypot(this.tent.x - x, this.tent.z - z) > 12) return 'Build a fire at your camp.';
    if (w.height(x, z) > w.treeline(x, z) - 20) return 'No deadfall up here — you are above treeline.';
    if (!this.flora.treeNear(x, z, 45)) return 'No firewood nearby.';
    return null;
  }

  light(x, z) {
    this.fire = { x, z, life: 90 }; // game minutes of fuel
    this.fireObj.group.position.set(x, this.world.height(x, z), z);
    this.fireObj.group.visible = true;
  }

  douse() {
    this.fire = null;
    this.fireObj.group.visible = false;
    this.fireObj.light.intensity = 0;
  }

  update(dt, gameMinutes, t) {
    if (!this.fire) return;
    this.fire.life -= gameMinutes;
    if (this.fire.life <= 0) { this.douse(); return; }
    const fade = Math.min(1, this.fire.life / 15);
    const flick = 0.75 + Math.sin(t * 13) * 0.08 + Math.sin(t * 29 + 1) * 0.06 + Math.random() * 0.1;
    this.fireObj.light.intensity = 45 * flick * fade;
    this.fireObj.flames.forEach((f, i) => {
      f.scale.set(1, (0.6 + Math.sin(t * (8 + i * 2.3) + i) * 0.25 + Math.random() * 0.15) * fade, 1);
      f.position.y = 0.2 + f.scale.y * 0.35;
      f.rotation.y = t * (1 + i * 0.3);
    });
  }

  /** Ground under this area was reshaped: the tent and fire sit on it again. */
  settle({ x0, z0, x1, z1 }) {
    for (const o of [this.tentObj, this.fireObj?.group]) {
      if (!o?.parent) continue;
      const { x, z } = o.position;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) o.position.y = this.world.height(x, z);
    }
  }

  save() {
    return { tent: this.tent, fire: this.fire };
  }

  load(s) {
    if (s?.tent) this.pitch(s.tent.x, s.tent.z, s.tent.yaw);
    if (s?.fire && this.tent) { this.light(s.fire.x, s.fire.z); this.fire.life = s.fire.life; }
  }
}
