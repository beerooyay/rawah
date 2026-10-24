import * as THREE from 'three';

// What Grant leaves behind when he ducks behind a tree. Droppings fall from
// where he squats, land with a plop and make a little pile; after a few
// seconds the flies find it and circle until it fades away.

const LIFE = 200;          // seconds a pile stays
const FADE = 18;           // and the last seconds it shrinks away
const FLIES = 8;
const G = 9.8;

const mat = new THREE.MeshStandardMaterial({ color: 0x45290f, roughness: 0.55, metalness: 0 });
const geo = new THREE.CapsuleGeometry(0.024, 0.1, 3, 8);
geo.rotateZ(Math.PI / 2);                 // lying along x

export class Dump {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.falling = [];
    this.piles = [];
    this.events = [];
    this.buzzIn = 0;
  }

  /** One piece dropped from (x, y, z): lands on the pile for this spot, starting one if needed. */
  drop(x, y, z) {
    const gy = this.world.height(x, z);
    let pile = this.piles.find((q) => Math.hypot(q.x - x, q.z - z) < 0.6 && q.age < LIFE - FADE);
    if (!pile) {
      const group = new THREE.Group();
      group.position.set(x, gy, z);
      this.scene.add(group);
      const fp = new Float32Array(FLIES * 3);
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.BufferAttribute(fp, 3));
      fg.setDrawRange(0, 0);
      const flies = new THREE.Points(fg, new THREE.PointsMaterial({ color: 0x0e0e0e, size: 0.03, sizeAttenuation: true }));
      flies.frustumCulled = false;
      this.scene.add(flies);
      pile = { x, z, gy, group, flies, fp, age: 0, n: 0, seed: Math.random() * 100 };
      this.piles.push(pile);
      if (this.piles.length > 6) this.#remove(this.piles.shift());
    }
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.position.set(x, y, z);
    m.rotation.set(Math.random() * 0.6, Math.random() * Math.PI * 2, Math.random() * 0.6);
    this.scene.add(m);
    this.falling.push({ m, pile, vy: 0, spin: (Math.random() - 0.5) * 3 });
  }

  #remove(pile) {
    pile.group.removeFromParent();
    pile.flies.removeFromParent();
    pile.flies.geometry.dispose();
  }

  /** Grass bare around the two piles nearest `p`, so they can be seen: circles for `grass.clear`. */
  clearings(p) {
    return this.piles.filter((q) => q.age < LIFE - FADE).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))
      .slice(0, 2).map((q) => [q.x, q.z, 0.55]);
  }

  /** `p`: where you stand, for the buzzing. Returns events: { type: 'sound', name, v }. */
  update(dt, p) {
    this.events.length = 0;
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i], q = f.pile;
      f.vy -= G * dt;
      f.m.position.y += f.vy * dt;
      f.m.rotation.y += f.spin * dt;
      // the pile builds up: each piece comes to rest a little higher than the last
      const rest = q.gy + 0.022 + Math.min(2, q.n) * 0.034;
      if (f.m.position.y <= rest) {
        const k = q.n++;
        f.m.removeFromParent();
        f.m.position.set(q.x + (k === 0 ? 0 : (Math.random() - 0.5) * 0.07), rest, q.z + (k === 0 ? 0 : (Math.random() - 0.5) * 0.07));
        f.m.rotation.set(0, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.3);
        f.m.scale.set(1.15 - k * 0.12, 0.85, 1.05);
        q.group.add(f.m);
        f.m.position.sub(q.group.position);
        this.falling.splice(i, 1);
        this.events.push({ type: 'sound', name: 'plop' });
      }
    }
    let near = 0;
    for (let i = this.piles.length - 1; i >= 0; i--) {
      const q = this.piles[i];
      q.age += dt;
      if (q.age > LIFE) { this.#remove(q); this.piles.splice(i, 1); continue; }
      // shrink away at the end
      const s = q.age > LIFE - FADE ? Math.max(0.001, (LIFE - q.age) / FADE) : 1;
      q.group.scale.setScalar(s);
      // flies arrive a few seconds after it lands and drift off before it goes
      const n = Math.max(0, Math.min(FLIES, Math.floor((q.age - 4) * 1.2), Math.floor((LIFE - 40 - q.age) * 0.4)));
      q.flies.geometry.setDrawRange(0, q.n > 0 ? n : 0);
      if (n > 0) {
        const t = q.age, cx = q.x, cz = q.z, cy = q.gy + 0.12;
        for (let k = 0; k < n; k++) {
          const a = q.seed + k * 7.31;
          q.fp[k * 3] = cx + 0.24 * Math.sin(t * (2.3 + (k % 3) * 0.9) + a) * Math.cos(t * 1.3 + a * 2) + (Math.random() - 0.5) * 0.012;
          q.fp[k * 3 + 1] = cy + 0.1 + 0.11 * Math.sin(t * (3.7 + k * 0.23) + a * 3) + (Math.random() - 0.5) * 0.012;
          q.fp[k * 3 + 2] = cz + 0.24 * Math.cos(t * (2.9 + (k % 4) * 0.7) + a * 1.7) * Math.sin(t * 1.1 + a) + (Math.random() - 0.5) * 0.012;
        }
        q.flies.geometry.attributes.position.needsUpdate = true;
        near = Math.max(near, 1 - Math.hypot(p.x - cx, p.z - cz) / 7);
      }
    }
    this.buzzIn -= dt;
    if (near > 0 && this.buzzIn <= 0) { this.buzzIn = 0.12 + Math.random() * 0.1; this.events.push({ type: 'sound', name: 'buzz', v: near }); }
  }
}
