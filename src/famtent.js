import * as THREE from 'three';

// A family cabin tent for six that you can walk into, modelled on the real
// "2 bedroom plus screen room" tents (Coleman WeatherMaster 6, Eureka Copper
// Canyon, Columbia Mammoth Creek, Core 6-person cabin): straight walls, a peak
// about 2 m high, a main room about 3.3 x 2.8 m with a removable divider that
// makes two bedrooms, and an attached screen porch. Laid out here along z:
//
//     back -3.0 ........ -0.4 ........ 1.7 ........ 3.0 front (door)
//          [ bedroom L | bedroom R ]   [ living ]   [ screen porch ]
//
// Width 3.2 m (x -1.6..1.6). Fabric walls are solid (`collide`), with door
// openings through the room partitions and the front. Local +z is the door; the
// group is turned by the tent's yaw like the small tent.

export const HW = 1.6;            // half width
export const Z0 = -3.0, Z1 = 3.0; // back and front
export const EAVE = 1.55, RIDGE = 2.05;
const BED_Z = -0.4;               // wall between the bedrooms and the living room
const PORCH_Z = 1.7;              // wall between the living room and the screen porch
const DOOR_W = 0.55;              // half width of the front door
const DOOR_H = 1.75;
const SKIRT = 0.4;                // fabric hangs this far below the floor

/** Wall segments on the plan (local x1, z1, x2, z2), with the door gaps left out. */
const WALLS = [
  [-HW, Z0, -HW, Z1], [HW, Z0, HW, Z1], [-HW, Z0, HW, Z0],                  // left, right, back
  [-HW, Z1, -DOOR_W, Z1], [DOOR_W, Z1, HW, Z1],                             // front, door gap between
  [-HW, PORCH_Z, -0.5, PORCH_Z], [0.5, PORCH_Z, HW, PORCH_Z],               // porch / living, door gap
  [-HW, BED_Z, -1.2, BED_Z], [-0.4, BED_Z, 0.4, BED_Z], [1.2, BED_Z, HW, BED_Z],   // bedrooms / living, two doors
  [0, Z0, 0, BED_Z],                                                        // bedroom divider
];

const fabric = (color, side = THREE.DoubleSide) => new THREE.MeshLambertMaterial({ color, side });
const MAT = {
  shell: fabric(0xb8a27a), inner: fabric(0xe6dec8), floor: fabric(0x4b5046),
  mesh: new THREE.MeshLambertMaterial({ color: 0x1d201c, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false }),
  pole: new THREE.MeshLambertMaterial({ color: 0x3a3d3f }), trim: fabric(0x4e402c),
};

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** A flat panel from an outline and holes (2D points), placed on the plane z = at (axis 'z') or x = at (axis 'x'). */
function panel(outline, holes, axis, at, mat) {
  const sh = new THREE.Shape(outline.map(([u, v]) => new THREE.Vector2(u, v)));
  for (const h of holes) sh.holes.push(new THREE.Path(h.map(([u, v]) => new THREE.Vector2(u, v))));
  const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), mat);
  if (axis === 'z') m.position.z = at; else { m.rotation.y = Math.PI / 2; m.position.x = at; }
  m.castShadow = m.receiveShadow = true;
  return m;
}

/** The gable-end outline: straight walls, then the roof pitch up to the ridge. */
const gable = (inset = 0) => [[-HW + inset, -SKIRT], [HW - inset, -SKIRT], [HW - inset, EAVE], [0, RIDGE], [-HW + inset, EAVE]];

function box(w, h, d, color, x, y, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  return m;
}

function cyl(r, len, x, y, z, axis, mat = MAT.pole) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
  m.position.set(x, y, z);
  if (axis === 'z') m.rotation.x = Math.PI / 2; else if (axis === 'x') m.rotation.z = Math.PI / 2;
  m.castShadow = true;
  return m;
}

/** An airbed with pillows and a folded blanket. */
function bed(w, l, color, x, z, pillows = 1) {
  const g = new THREE.Group();
  g.add(box(w, 0.2, l, 0x37424f, 0, 0.12, 0));
  g.add(box(w - 0.04, 0.06, l - 0.04, color, 0, 0.25, 0));
  for (let i = 0; i < pillows; i++) g.add(box(Math.min(0.5, w / pillows - 0.1), 0.1, 0.32, 0xefeae0, (i - (pillows - 1) / 2) * (w / pillows), 0.33, -l / 2 + 0.26));
  g.add(box(w - 0.1, 0.07, 0.5, 0x6b3b2d, 0, 0.32, l / 2 - 0.45));
  g.position.set(x, 0, z);
  return g;
}

export class FamilyTent {
  constructor(scene) {
    const g = this.group = new THREE.Group();
    const { shell, inner, floor, mesh, trim } = MAT;

    // floor tub and rugs
    g.add(box(2 * HW, 0.04, Z1 - Z0, 0x4b5046, 0, -0.01, 0));
    g.add(box(2.3, 0.012, 1.3, 0x6c3a2c, 0, 0.03, 0.55));
    g.add(box(2.1, 0.014, 1.1, 0xb9a77f, 0, 0.034, 0.55));

    // roof: two slopes along the ridge, with a darker band at the eaves
    const slope = (s) => {
      const len = Math.hypot(HW, RIDGE - EAVE);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, Z1 - Z0 + 0.3), shell);
      m.rotation.set(-Math.PI / 2, 0, 0);
      const a = Math.atan2(RIDGE - EAVE, HW);
      const o = new THREE.Group();
      o.add(m);
      o.rotation.z = -s * a;
      o.position.set(s * HW / 2, (RIDGE + EAVE) / 2, 0);
      m.castShadow = m.receiveShadow = true;
      return o;
    };
    g.add(slope(1), slope(-1));

    // side walls: a bedroom window, a living-room window, big screen panels on the porch
    const sideWall = (x) => {
      // the panel is drawn in (u = -z, v = y)
      const hole = (z0, z1, y0, y1) => rect(-z1, y0, -z0, y1);
      const holes = [hole(-2.5, -1.4, 0.8, 1.35), hole(-0.2, 0.9, 0.8, 1.35), hole(1.85, 2.85, 0.45, 1.45)];
      g.add(panel(rect(-Z1, -SKIRT, -Z0, EAVE), holes, 'x', x, shell));
      for (const [z0, z1, y0, y1] of [[-2.5, -1.4, 0.8, 1.35], [-0.2, 0.9, 0.8, 1.35], [1.85, 2.85, 0.45, 1.45]]) {
        const w = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0, y1 - y0), mesh);
        w.rotation.y = Math.PI / 2;
        w.position.set(x, (y0 + y1) / 2, (z0 + z1) / 2);
        g.add(w);
      }
    };
    sideWall(-HW); sideWall(HW);

    // back wall with a small window
    g.add(panel(gable(), [rect(-0.5, 0.9, 0.5, 1.45)], 'z', Z0, shell));
    // front: a door opening and a screen window either side
    const fw = [rect(-DOOR_W, 0, DOOR_W, DOOR_H), rect(-1.35, 0.55, -0.8, 1.4), rect(0.8, 0.55, 1.35, 1.4)];
    g.add(panel(gable(), fw, 'z', Z1, shell));
    for (const x of [-1.075, 1.075]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.85), mesh);
      w.position.set(x, 0.975, Z1 + 0.005);
      g.add(w);
    }
    // the door flaps rolled back and tied either side, and the zipper edge
    for (const s of [-1, 1]) {
      const flap = new THREE.Mesh(new THREE.PlaneGeometry(0.2, DOOR_H), trim);
      flap.position.set(s * (DOOR_W + 0.1), DOOR_H / 2, Z1 + 0.02);
      g.add(flap);
    }

    // inside: the partitions are lighter fabric, with doorways
    const part = (z, doors) => g.add(panel(gable(0.02), doors.map(([a, b]) => rect(a, 0, b, 1.85)), 'z', z, inner));
    part(BED_Z, [[-1.2, -0.4], [0.4, 1.2]]);
    part(PORCH_Z, [[-0.5, 0.5]]);
    const div = new THREE.Mesh(new THREE.PlaneGeometry(BED_Z - Z0, RIDGE + SKIRT - 0.05), inner);
    div.rotation.y = Math.PI / 2; div.position.set(0, (RIDGE - SKIRT) / 2 - 0.02, (Z0 + BED_Z) / 2);
    g.add(div);

    // frame: ridge and eave poles, corner posts, the door arch
    g.add(cyl(0.017, Z1 - Z0 + 0.3, 0, RIDGE + 0.02, 0, 'z'));
    for (const x of [-HW, HW]) {
      g.add(cyl(0.016, Z1 - Z0 + 0.3, x, EAVE + 0.01, 0, 'z'));
      for (const z of [Z0, Z1]) g.add(cyl(0.016, EAVE + SKIRT, x, (EAVE - SKIRT) / 2, z));
    }
    // guy lines and stakes
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [-1, 0], [1, 0]]) {
      const from = new THREE.Vector3(sx * HW, EAVE, sz * (Z1 - 0.1)), to = new THREE.Vector3(sx * (HW + 1.1), 0, sz * (Z1 + 0.9) + (sz === 0 ? 0 : 0));
      const d = to.clone().sub(from), line = cyl(0.004, d.length(), 0, 0, 0);
      line.position.copy(from).addScaledVector(d, 0.5);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      line.material = new THREE.MeshLambertMaterial({ color: 0xe8e2d0 });
      g.add(line, box(0.03, 0.2, 0.03, 0xd9622b, to.x, 0.02, to.z));
    }

    // furnishings: a queen bed in the left bedroom, two singles in the right, a table and lantern, a cooler on the porch
    g.add(bed(1.45, 2.0, 0x8a2f34, -0.8, -1.75, 2));
    g.add(bed(0.68, 1.9, 0x2f5a7a, 0.4, -1.75, 1));
    g.add(bed(0.68, 1.9, 0x3e6b46, 1.2, -1.75, 1));
    g.add(box(0.7, 0.04, 0.7, 0x7a5a3a, 0.9, 0.62, 0.65));
    for (const [x, z] of [[0.6, 0.35], [1.2, 0.35], [0.6, 0.95], [1.2, 0.95]]) g.add(box(0.04, 0.6, 0.04, 0x2b2b2b, x, 0.3, z));
    g.add(box(0.5, 0.34, 0.34, 0xb6382c, -0.9, 0.17, 2.4));
    g.add(box(0.52, 0.04, 0.36, 0xeeeeee, -0.9, 0.36, 2.4));
    // a lantern hanging from the ridge in the living room
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x4a3a28 });
    const lamp = new THREE.Group();
    lamp.add(cyl(0.002, 0.3, 0, 0.15, 0));
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 10), this.lampMat);
    glass.position.y = -0.02;
    lamp.add(glass, box(0.09, 0.02, 0.09, 0x222222, 0, 0.04, 0), box(0.09, 0.02, 0.09, 0x222222, 0, -0.08, 0));
    lamp.position.set(0, RIDGE - 0.33, 0.55);
    g.add(lamp);
    this.light = new THREE.PointLight(0xffc27a, 0, 9, 1.6);
    this.light.position.set(0, RIDGE - 0.5, 0.55);
    g.add(this.light);

    g.traverse((o) => { if (o.isMesh && o.material !== mesh) o.receiveShadow = true; });
    g.visible = false;
    scene.add(g);

    this.x = 0; this.z = 0; this.yaw = 0; this.floor = 0; this.active = false;
  }

  get position() { return this.group.position; }
  get rotation() { return this.group.rotation; }
  get visible() { return this.group.visible; }
  set visible(v) { this.group.visible = v; this.active = v; }

  /** Pitch it: the floor sits just above the highest ground under it. */
  place(world, x, z, yaw) {
    this.x = x; this.z = z; this.yaw = yaw;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let top = -Infinity;
    for (let lx = -HW; lx <= HW; lx += HW / 2) for (let lz = Z0; lz <= Z1; lz += (Z1 - Z0) / 6) top = Math.max(top, world.height(x + lx * c + lz * s, z - lx * s + lz * c));
    this.floor = top + 0.03;
    this.group.position.set(x, this.floor, z);
    this.group.rotation.set(0, yaw, 0);
  }

  #local(x, z, out) {
    const dx = x - this.x, dz = z - this.z, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    out.x = dx * c - dz * s; out.z = dx * s + dz * c;
    return out;
  }

  /** Is the point inside the footprint? */
  inside(x, z) {
    if (!this.active) return false;
    const l = this.#local(x, z, _l);
    return Math.abs(l.x) < HW + 0.05 && l.z > Z0 - 0.05 && l.z < Z1 + 0.05;
  }

  /** The floor's height where you stand on it, else -Infinity. */
  floorAt(x, z) { return this.inside(x, z) ? this.floor : -Infinity; }

  /** Push (x, z) out of the walls: radius r. Mutates p. */
  collide(p, r = 0.3) {
    if (!this.active) return;
    const l = this.#local(p.x, p.z, _l);
    if (Math.abs(l.x) > HW + r + 0.2 || l.z < Z0 - r - 0.2 || l.z > Z1 + r + 0.2) return;
    let px = l.x, pz = l.z;
    for (let pass = 0; pass < 2; pass++) {
      for (const [x1, z1, x2, z2] of WALLS) {
        const dx = x2 - x1, dz = z2 - z1, len2 = dx * dx + dz * dz;
        let t = ((px - x1) * dx + (pz - z1) * dz) / len2;
        t = Math.max(0, Math.min(1, t));
        const qx = x1 + dx * t, qz = z1 + dz * t, ox = px - qx, oz = pz - qz, d = Math.hypot(ox, oz);
        if (d < r) {
          if (d > 1e-5) { px = qx + (ox / d) * r; pz = qz + (oz / d) * r; }
          else { const nx = -dz / Math.sqrt(len2), nz = dx / Math.sqrt(len2); px = qx + nx * r; pz = qz + nz * r; }
        }
      }
    }
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    p.x = this.x + px * c + pz * s;
    p.z = this.z - px * s + pz * c;
  }

  /** The lantern glows at night or in the gloom, brighter when someone is inside. */
  update(dark, someoneInside) {
    const on = dark ? (someoneInside ? 1 : 0.55) : 0;
    this.light.intensity += (on * 7 - this.light.intensity) * 0.1;
    this.lampMat.color.setRGB(0.3 + 0.7 * on, 0.23 + 0.55 * on, 0.15 + 0.3 * on);
  }
}

const _l = { x: 0, z: 0 };
