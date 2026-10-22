import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Avatar } from './avatar.js';

// The two hikers: Blaize and Grant, Mixamo-rigged glTF models. Animation comes
// from two places:
//
//  - Clips, when there are any: in the model itself or in
//    assets/characters/anims/ (any Mixamo clip exported to glTF, listed in
//    anims.json by role: idle, walk, run, sit, swim, climb, wave). They play on either character because both share the Mixamo
//    skeleton.
//  - A procedural animator for everything else. It poses the skeleton in
//    character space (forward, up, sideways) and converts down the chain to
//    each bone's local frame, so it doesn't care how the rig's bones are
//    oriented. Walk and run swing from the same stride phase as the
//    footsteps; idle breathes; sitting, swimming and climbing have poses.
//
// With no model at all the primitive stand-in is used, in their colours.

export const CHARACTERS = {
  blaize: {
    name: 'Blaize', height: 1.8, model: './assets/characters/blaize/blaize.glb',
    colors: { jacket: 0x3d6b5a, pants: 0x4b4a45, skin: 0xc99a78, pack: 0xb4532a, cap: 0x8a2f24 },
  },
  grant: {
    name: 'Grant', height: 1.82, model: './assets/characters/grant/grant.glb',
    colors: { jacket: 0x2f4f7a, pants: 0x5a4b3a, skin: 0xd2a685, pack: 0x5b6b2e, cap: 0x2c2c2c },
  },
};

// clip roles and the words that pick a clip for each from a model's animations
const ROLES = {
  idle: ['idle', 'breath', 'stand'],
  walk: ['walk'],
  run: ['run', 'jog', 'sprint'],
  sit: ['sit'],
  swim: ['swim', 'tread'],
  climb: ['climb'],
  jump: ['jump'],
  wave: ['wave', 'greet'],
};

export class Character {
  constructor(scene, key) {
    this.key = key;
    this.def = CHARACTERS[key];
    this.scene = scene;
    this.avatar = new Avatar(scene, this.def.colors);   // stand-in until (unless) a model loads
    this.model = null;
    this.firstPerson = false;
    this.heading = 0;
  }

  /** Try the rigged model; keep the stand-in if there isn't one. */
  async load() {
    try {
      const head = await fetch(this.def.model, { method: 'HEAD' });
      if (!head.ok) return false;
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(this.def.model);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const s = this.def.height / Math.max(0.1, box.max.y - box.min.y);
      root.scale.multiplyScalar(s);
      root.position.y = -box.min.y * s;
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        // scanned/generated models often come through fully metallic, which reads as black outdoors
        for (const m of [].concat(o.material)) { m.metalness = 0; m.roughness = Math.max(0.75, m.roughness ?? 1); m.envMapIntensity = 0; }
      });
      const facing = new THREE.Group();   // turns the model to face +z with its left on +x
      facing.add(root);
      const holder = new THREE.Group();
      holder.add(facing);
      this.scene.add(holder);
      this.rig = new Rig(root, facing);
      this.mixer = new THREE.AnimationMixer(root);
      this.clips = {};
      const anims = [...gltf.animations];
      // shared Mixamo clips, if any were exported next to the models
      // anims/anims.json lists them: { "walk": "walk.glb", "idle": "idle.glb", ... }
      const list = await fetch('./assets/characters/anims/anims.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      await Promise.all(Object.entries(list).map(async ([role, file]) => {
        try {
          const a = await loader.loadAsync(`./assets/characters/anims/${file}`);
          for (const c of a.animations) { c.name = `${role} ${c.name}`; anims.push(c); }
        } catch (e) { console.warn(`animation ${file} didn't load`, e); }
      }));
      for (const [role, words] of Object.entries(ROLES)) {
        const clip = anims.find((c) => words.some((w) => c.name.toLowerCase().includes(w)));
        if (clip) this.clips[role] = this.mixer.clipAction(stripRootMotion(clip));
      }
      this.model = holder;
      this.current = null;
      this.avatar.root.removeFromParent();
      this.setFirstPerson(this.firstPerson);
      return true;
    } catch (e) {
      console.warn(`${this.def.name}: model not loaded, using the stand-in`, e);
      return false;
    }
  }

  setFirstPerson(on) {
    this.firstPerson = on;
    if (!this.model) { this.avatar.setFirstPerson(on); return; }
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.material.colorWrite = !on;
      o.material.depthWrite = !on;
    });
  }

  /** Play a clip for the role; false if there isn't one (the procedural animator takes over). */
  #play(role, speed = 1) {
    const a = this.clips[role] || (role === 'run' && this.clips.walk);
    if (!a) { if (this.current) { this.current.fadeOut(0.2); this.current = null; } return false; }
    a.timeScale = speed;
    if (a === this.current) return;
    a.reset().fadeIn(0.25).play();
    if (this.current) this.current.fadeOut(0.25);
    this.current = a;
    return true;
  }

  /** Pose from a body: anything with pos, vel, phase, moving, mode, sitting (Hiker or Companion). */
  update(dt, body) {
    if (!this.model) { this.avatar.update(dt, body); this.heading = this.avatar.heading; return; }
    const v = body.vel, speed = Math.hypot(v.x, v.z);
    const want = speed > 0.3 ? Math.atan2(-v.x, -v.z) : this.heading;
    let d = want - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * 8);
    this.model.position.set(body.pos.x, body.pos.y + (body.mode === 'swim' ? 1.0 : 0), body.pos.z);
    // models face +z by convention; we face -z
    this.model.rotation.y = this.heading + Math.PI;
    const role = body.mode === 'swim' ? 'swim' : body.mode === 'climb' ? 'climb' : body.sitting ? 'sit'
      : speed > 3.3 ? 'run' : speed > 0.25 ? 'walk' : 'idle';
    const clipped = this.#play(role, role === 'run' ? speed / 4.2 : role === 'walk' ? speed / 1.5 : 1);
    if (clipped) this.mixer.update(dt);
    else this.model.position.y += this.rig.pose(dt, body, speed);
  }
}

// Mixamo clips walk off on their own (root motion on the hips): keep only the bob.
function stripRootMotion(clip) {
  for (const t of clip.tracks) {
    if (!/Hips\.position$/.test(t.name)) continue;
    const v = t.values;
    for (let i = 0; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
  }
  return clip;
}

// ------------------------------------------------------------------ procedural rig
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);
const rx = (a) => new THREE.Quaternion().setFromAxisAngle(X, a);
const rz = (a) => new THREE.Quaternion().setFromAxisAngle(Z, a);
const DRIVEN = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder',
  'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];

/**
 * Poses a Mixamo skeleton in character space. Every bone's rotation is given
 * as a rotation about the character's own axes (x = to its left, y = up,
 * z = forward) applied at the joint, accumulated down the chain:
 * C(bone) = R(bone) * C(parent), world(bone) = C(bone) * bind(bone),
 * local(bone) = world(parent)^-1 * world(bone).
 */
class Rig {
  constructor(root, facing) {
    this.bones = {};
    root.traverse((o) => {
      if (!o.isBone) return;
      const name = o.name.replace(/^mixamorig[:_]?/, '');
      if (DRIVEN.includes(name)) this.bones[name] = o;
    });
    const b = this.bones;
    root.updateMatrixWorld(true);
    // which way is the model facing? toes point forward, the left leg is on the left
    const wp = (o) => o.getWorldPosition(new THREE.Vector3());
    if (b.LeftFoot && b.LeftUpLeg && b.RightUpLeg) {
      const toe = b.LeftFoot.children[0] ? wp(b.LeftFoot.children[0]) : wp(b.LeftFoot).add(new THREE.Vector3(0, 0, 1));
      const fwd = toe.sub(wp(b.LeftFoot)).setY(0).normalize();
      facing.rotation.y = -Math.atan2(fwd.x, fwd.z);
      facing.updateMatrixWorld(true);
      // forward is now +z: make sure the left leg ended up on +x, else turn around
      if (wp(b.LeftUpLeg).x < wp(b.RightUpLeg).x) { facing.rotation.y += Math.PI; facing.updateMatrixWorld(true); }
    }
    this.facing = facing;
    // bind pose world rotations, in character space (relative to the facing group)
    const inv = facing.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.bind = {};
    this.order = [];
    root.traverse((o) => {
      const name = Object.keys(b).find((k) => b[k] === o);
      if (!name) return;
      this.bind[name] = inv.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()));
      this.order.push(name);
    });
    this.parentOf = {};
    for (const n of this.order) {
      let p = b[n].parent;
      while (p && !Object.values(b).includes(p)) p = p.parent;
      this.parentOf[n] = p ? Object.keys(b).find((k) => b[k] === p) : null;
      // the first driven bone's parent frame (armature, model root), in character space
      if (!p) this.rootParent = inv.clone().multiply(b[n].parent.getWorldQuaternion(new THREE.Quaternion()));
    }
    this.hipsY = b.Hips ? wp(b.Hips).y : 1;
    this.t = 0;
    this.sit = 0;
  }

  /** Pose for this frame; returns how far to drop the body (sitting). */
  pose(dt, body, speed) {
    this.t += dt;
    const R = {};
    const ph = body.phase || 0, s = Math.sin(ph);
    const k = Math.min(1, speed / 2.5) * (body.moving ?? 1);
    const run = THREE.MathUtils.clamp((speed - 3.2) / 1.3, 0, 1);
    const breathe = Math.sin(this.t * 1.7) * 0.02;
    this.sit += ((body.sitting ? 1 : 0) - this.sit) * Math.min(1, dt * 4);
    const sit = this.sit;
    const armDown = 1.25;   // from T-pose to by-the-sides
    if (body.mode === 'swim') {
      const sw = Math.sin(ph * 1.5);
      R.Hips = rx(1.2);
      R.LeftArm = rx(-1.6 - sw * 1.1).multiply(rz(-0.4)); R.RightArm = rx(-1.6 + sw * 1.1).multiply(rz(0.4));
      R.LeftUpLeg = rx(Math.sin(ph * 2) * 0.35); R.RightUpLeg = rx(-Math.sin(ph * 2) * 0.35);
      R.Head = rx(-0.9);
    } else if (body.mode === 'climb') {
      R.LeftArm = rx(-2.6 - s * 0.3).multiply(rz(-0.3)); R.RightArm = rx(-2.6 + s * 0.3).multiply(rz(0.3));
      R.LeftUpLeg = rx(-0.6 + s * 0.35); R.RightUpLeg = rx(-0.6 - s * 0.35);
      R.LeftLeg = rx(0.9); R.RightLeg = rx(0.9);
      R.Spine = rx(0.15);
    } else {
      // walking and running from the stride phase, blended with sitting
      const swing = s * (0.5 + run * 0.35) * k;
      const knee = (x) => Math.max(0, x) * (0.9 + run * 0.6) * k + 0.05;
      R.LeftUpLeg = rx(-swing * (1 - sit) - 1.45 * sit);
      R.RightUpLeg = rx(swing * (1 - sit) - 1.45 * sit);
      R.LeftLeg = rx(knee(-Math.cos(ph)) * (1 - sit) + 1.45 * sit);
      R.RightLeg = rx(knee(Math.cos(ph)) * (1 - sit) + 1.45 * sit);
      R.LeftFoot = rx(-0.1 * k);
      R.RightFoot = rx(-0.1 * k);
      const lean = 0.05 + run * 0.18 + Math.max(0, body.lastGrade || 0) * 0.25;
      R.Spine = rx(lean * (1 - sit) - 0.12 * sit + breathe);
      R.Spine1 = rx(breathe * 0.5);
      R.Hips = new THREE.Quaternion().setFromEuler(_e.set(0, s * 0.08 * k, Math.sin(ph) * 0.03 * k));
      R.LeftArm = rx(swing * 0.8 * (1 - sit) + 0.35 * sit).multiply(rz(-armDown + sit * 0.15));
      R.RightArm = rx(-swing * 0.8 * (1 - sit) + 0.35 * sit).multiply(rz(armDown - sit * 0.15));
      R.LeftForeArm = rx(-0.25 - run * 0.9 - sit * 0.5);
      R.RightForeArm = rx(-0.25 - run * 0.9 - sit * 0.5);
      R.Head = rx(-lean * 0.5 + Math.sin(this.t * 0.3) * 0.04);
    }
    this.#apply(R);
    // bob on each footfall; drop to the ground to sit
    const bob = (Math.abs(Math.cos(ph)) - 0.6) * 0.04 * k;
    return bob - sit * this.hipsY * 0.5;
  }

  #apply(R) {
    const C = {}, W = {};
    for (const n of this.order) {
      const p = this.parentOf[n];
      const cp = p ? C[p] : _q2.identity();
      C[n] = (R[n] ? R[n].clone() : new THREE.Quaternion()).multiply(cp);
      W[n] = C[n].clone().multiply(this.bind[n]);
      const pw = p ? W[p] : cp.clone().multiply(this.rootParent);
      this.bones[n].quaternion.copy(_q.copy(pw).invert().multiply(W[n]));
    }
  }
}
