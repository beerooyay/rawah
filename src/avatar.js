import * as THREE from 'three';

// A placeholder hiker: primitives for body, pack and limbs, posed procedurally
// from the controller's stride phase. In first person it renders only into
// the shadow map, so you see your own shadow walking beside you; in third
// person it's the character. Built so a rigged model can replace it later.

const mat = (color) => new THREE.MeshLambertMaterial({ color });

function limb(len, r, color) {
  const pivot = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len - r * 2, 3, 8), mat(color));
  m.position.y = -len / 2;
  pivot.add(m);
  return pivot;
}

export class Avatar {
  constructor(scene, { jacket = 0x3d6b5a, pants = 0x4b4a45, skin = 0xc99a78, pack = 0xb4532a, cap = 0x8a2f24 } = {}) {
    this.root = new THREE.Group();
    this.hips = new THREE.Group();
    this.hips.position.y = 0.95;
    this.root.add(this.hips);
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 4, 10), mat(jacket));
    torso.position.y = 0.33;
    torso.scale.set(1.05, 1, 0.75);
    this.torso = new THREE.Group();
    this.torso.add(torso);
    this.hips.add(this.torso);
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.55, 0.22), mat(pack));
    bag.position.set(0, 0.38, 0.2);
    this.torso.add(bag);
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.42, 10), mat(0x2e4a5c));
    roll.rotation.z = Math.PI / 2;
    roll.position.set(0, 0.7, 0.2);
    this.torso.add(roll);
    this.head = new THREE.Group();
    this.head.position.y = 0.72;
    const face = new THREE.Mesh(new THREE.SphereGeometry(0.12, 14, 10), mat(skin));
    face.position.y = 0.1;
    const capM = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(cap));
    capM.position.y = 0.12;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.015, 12, 1, false, 0, Math.PI), mat(cap));
    brim.position.set(0, 0.12, -0.08);
    brim.rotation.y = Math.PI / 2;
    this.head.add(face, capM, brim);
    this.torso.add(this.head);
    this.legL = limb(0.9, 0.075, pants); this.legL.position.set(-0.1, 0, 0);
    this.legR = limb(0.9, 0.075, pants); this.legR.position.set(0.1, 0, 0);
    this.hips.add(this.legL, this.legR);
    this.armL = limb(0.62, 0.055, jacket); this.armL.position.set(-0.25, 0.58, 0);
    this.armR = limb(0.62, 0.055, jacket); this.armR.position.set(0.25, 0.58, 0);
    this.torso.add(this.armL, this.armR);
    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(this.root);
    this.heading = 0;
    this.firstPerson = true;
  }

  /** Show fully (third person) or only as a shadow caster (first person). */
  setFirstPerson(on) {
    this.firstPerson = on;
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.material.colorWrite = !on;
      o.material.depthWrite = !on;
    });
  }

  update(dt, hiker) {
    const p = hiker.pos, v = hiker.vel;
    const speed = Math.hypot(v.x, v.z);
    // face where you're going; when standing still, face where you look
    const want = speed > 0.3 && hiker.mode !== 'climb' ? Math.atan2(-v.x, -v.z) : hiker.mode === 'climb' ? Math.atan2(-hiker.wallUp.x, -hiker.wallUp.y) : this.heading;
    let d = want - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * 10);
    this.root.position.set(p.x, p.y + (hiker.mode === 'swim' ? 1.0 : 0), p.z);
    this.root.rotation.y = this.heading;

    const phase = hiker.phase, k = Math.min(1, speed / 2.5) * hiker.moving;
    const run = Math.min(1, Math.max(0, (speed - 3.2) / 1.3));
    const swing = Math.sin(phase) * (0.55 + run * 0.35) * k;
    if (hiker.mode === 'climb') {
      this.armL.rotation.x = 2.6 + Math.sin(phase) * 0.3; this.armR.rotation.x = 2.6 - Math.sin(phase) * 0.3;
      this.legL.rotation.x = -0.5 + Math.sin(phase) * 0.3; this.legR.rotation.x = -0.5 - Math.sin(phase) * 0.3;
      this.torso.rotation.x = -0.25;
    } else if (hiker.mode === 'swim') {
      this.armL.rotation.x = 1.6 + Math.sin(phase * 1.5) * 1.2; this.armR.rotation.x = 1.6 - Math.sin(phase * 1.5) * 1.2;
      this.legL.rotation.x = Math.sin(phase * 2) * 0.4; this.legR.rotation.x = -Math.sin(phase * 2) * 0.4;
      this.torso.rotation.x = -1.1;
    } else if (hiker.sitting) {
      // sitting on the ground, knees up, leaning back on the hands
      this.legL.rotation.x = this.legR.rotation.x = -1.35;
      this.armL.rotation.x = this.armR.rotation.x = 0.5;
      this.torso.rotation.x = 0.18;
      this.hips.position.y = 0.2;
      this.torso.rotation.z = 0;
      return;
    } else {
      this.legL.rotation.x = swing; this.legR.rotation.x = -swing;
      this.armL.rotation.x = -swing * 0.8; this.armR.rotation.x = swing * 0.8;
      this.torso.rotation.x = -0.06 - run * 0.18 - Math.max(0, hiker.lastGrade || 0) * 0.25;
    }
    this.hips.position.y = 0.95 - Math.abs(Math.cos(phase)) * 0.05 * k;
    this.torso.rotation.z = Math.sin(phase) * 0.04 * k;
  }
}
