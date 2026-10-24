import * as THREE from 'three';
import { clamp } from './noise.js';

// Roasting a marshmallow. [Q] near the fire takes a marshmallow on a stick;
// hold [Space] to push it out over the flames and let go to pull it back and
// look at it. It goes white, cream, golden, brown, black, and if you leave it
// in the flames it catches fire. [Q] again to eat it.

const STICK = 1.5;
const RAMP = [   // cook -> colour
  [0, [0.97, 0.96, 0.93]], [0.3, [0.96, 0.89, 0.68]], [0.55, [0.88, 0.6, 0.27]], [0.8, [0.5, 0.27, 0.1]], [1.0, [0.17, 0.1, 0.06]], [1.3, [0.04, 0.035, 0.035]],
];
const _c = new THREE.Color();

function ramp(cook, out) {
  let i = 0;
  while (i < RAMP.length - 2 && cook > RAMP[i + 1][0]) i++;
  const [c0, a] = RAMP[i], [c1, b] = RAMP[i + 1], u = clamp((cook - c0) / (c1 - c0), 0, 1);
  return out.setRGB(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u);
}

export class Roast {
  constructor(scene) {
    this.state = 'none';       // none | held
    this.cook = 0;
    this.extend = 0;           // 0 pulled back .. 1 out over the fire
    this.burning = false;
    this.out = 0;              // seconds out of the flames since it caught fire
    this.hint = '';
    this.eaten = 0; this.perfect = 0;
    this.tip = new THREE.Vector3();

    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    const wood = new THREE.MeshLambertMaterial({ color: 0x6b4a32 });
    const geo = new THREE.CylinderGeometry(0.01, 0.005, 1, 6);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, -0.5);          // base at the hand, tip at z = -1 (scaled to the stick's reach)
    this.stick = new THREE.Mesh(geo, wood);
    this.stick.castShadow = true;
    this.mallow = new THREE.Group();
    this.mat = new THREE.MeshLambertMaterial({ color: 0xf7f4ee, emissive: 0x000000 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.024, 0.036, 4, 12), this.mat);
    body.rotation.x = Math.PI / 2;
    body.castShadow = true;
    this.body = body;
    this.mallow.add(body);
    // flame on the marshmallow when it catches
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.2, 7, 1, true), new THREE.MeshBasicMaterial({ color: 0xff9a30, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.flame.position.y = 0.1;
    this.flame.visible = false;
    this.mallow.add(this.flame);
    this.root.add(this.stick, this.mallow);
    this.root.visible = false;
    scene.add(this.root);
    this._d = new THREE.Vector3(); this._e = new THREE.Vector3(); this._t = new THREE.Vector3();
  }

  get active() { return this.state === 'held'; }

  start() {
    this.state = 'held'; this.cook = 0; this.extend = 0; this.burning = false; this.out = 0;
    this.root.visible = true;
  }

  drop() {
    this.state = 'none';
    this.root.visible = false;
    this.hint = '';
  }

  /** Eat it: how it came out. */
  eat() {
    const c = this.cook;
    const [label, perfect] = c < 0.12 ? ['Cold and squishy', false] : c < 0.3 ? ['Barely warm', false] : c < 0.45 ? ['Lightly toasted', false]
      : c < 0.75 ? ['Perfectly golden', true] : c < 0.95 ? ['Dark and crispy', false] : c < 1.2 ? ['Burnt to a crisp', false] : ['A lump of charcoal', false];
    this.eaten++;
    if (perfect) this.perfect++;
    this.drop();
    return { cook: c, label, perfect };
  }

  /**
   * hand: world position of the hand; fwd, right: unit vectors on the ground; fire: { x, z, y, fuel } or null;
   * hold: reach out over the flames.
   */
  update(dt, { hand, fwd, right, fire, hold, t }) {
    if (!this.active) return;
    this.extend += ((hold && fire ? 1 : 0) - this.extend) * Math.min(1, dt * 4.5);
    const e = this.extend;
    // pulled back: up and forward where you can look at it; out: toward the middle of the flames
    const back = this._d.set(fwd.x * 0.8 + right.x * -0.06, 0.5, fwd.z * 0.8 + right.z * -0.06).normalize();
    let dir = back, len = STICK * 0.72, tooFar = false;
    if (fire) {
      const aim = this._e.set(fire.x - hand.x, fire.y + 0.3 - hand.y, fire.z - hand.z);
      const dist = aim.length();
      aim.normalize();
      dir = this._t.copy(back).lerp(aim, e).normalize();
      len += (clamp(dist, 0.7, STICK) - len) * e;
      tooFar = dist > STICK + 0.12;
    }
    this.root.position.copy(hand);
    // aim the stick (it points along -z) at dir
    const yaw = Math.atan2(-dir.x, -dir.z), pitch = Math.asin(clamp(dir.y, -1, 1));
    this.root.rotation.set(pitch, yaw, 0);
    this.stick.scale.z = len;
    this.mallow.position.set(0, 0, -len);
    this.tip.copy(hand).addScaledVector(dir, len);

    // heat
    let inFlame = false;
    if (fire && e > 0.55) {
      const dh = Math.hypot(this.tip.x - fire.x, this.tip.z - fire.z), hy = this.tip.y - fire.y;
      inFlame = dh < 0.3 && hy > 0.07 && hy < 0.85;
      const near = dh < 0.8 && hy < 1.0;
      const heat = (inFlame ? 0.075 * (1.15 - Math.abs(hy - 0.32) * 1.2) : near ? 0.012 : 0) * clamp(fire.fuel, 0.2, 1);
      this.cook = Math.min(1.6, this.cook + heat * dt);
    }
    if (this.burning) this.cook = Math.min(1.6, this.cook + 0.1 * dt);
    if (!this.burning && inFlame && this.cook > 0.9 && Math.random() < dt * 1.2) this.burning = true;
    if (this.burning) {
      this.out = inFlame ? 0 : this.out + dt;
      if (this.out > 2.2) this.burning = false;   // it burns itself out once you've pulled it clear
    }

    // looks: colour, puffing up, glow, and the little flame
    ramp(this.cook, _c);
    this.mat.color.copy(_c);
    const glow = (inFlame ? 0.5 : 0) + (this.burning ? 0.6 : 0) + (this.cook > 0.2 ? 0.12 * Math.min(1, e) : 0);
    this.mat.emissive.setRGB(1, 0.45, 0.12).multiplyScalar(glow * 0.6);
    const puff = 1 + Math.min(0.35, this.cook * 0.45) - (this.cook > 1 ? (this.cook - 1) * 0.4 : 0);
    this.body.scale.set(puff, puff * 0.96, puff);
    this.flame.visible = this.burning;
    if (this.burning) this.flame.scale.set(0.8 + Math.random() * 0.5, 0.8 + Math.random() * 0.7, 0.8 + Math.random() * 0.5);
    this.hint = !fire ? 'The fire has died down.  [Q] eat it'
      : this.burning ? 'It\'s on fire! Pull it back.  [Q] eat'
        : e > 0.5 && tooFar ? 'Too far from the flames. Step closer, or sit on a stool.'
        : e > 0.5 ? 'Toasting…  let go of [Space] to look' : 'Hold [Space] over the flames  ·  [Q] eat';
  }
}
