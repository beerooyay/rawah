import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The Mixamo clip library. Every clip is one FBX in assets/characters/anims/,
// loaded on demand and cleaned up so it can be driven by the hiker instead of
// by the clip: hip travel along x/z is removed (the controller moves the body,
// the clip only poses it), and a few clips get their vertical travel tamed.
// Bone names match the characters' skeletons, so tracks bind without remapping.

export const BODY_SCALE = 1.68;       // the 1.04 m character becomes a 1.75 m hiker
const DIR = 'assets/characters/anims/';
const HIPS_CM = 54;                   // standing hip height in clip units (cm)

// loaded before the character appears
export const CORE = [
  'Neutral Idle', 'Swagger Walk', 'Jogging', 'Sprint', 'Walk Backwards', 'Injured Jog',
  'Jumping (1)', 'Jumping', 'Falling To Landing', 'Front Flip',
  'Crouch Idle 01', 'Crouched Walking', 'Crawling', 'Fallen Idle', 'Situp To Idle', 'Sitting Idle',
  'Swimming', 'Treading Water',
];
// streamed in once the character is up
export const EXTRA = [
  'Looking', 'Happy Idle', 'Fighting Idle', 'Injured Hurting Idle', 'Injured Wave Idle',
  'Swimming To Edge', 'Wiping Sweat', 'Searching Pockets', 'Swatting Bugs', 'Climbing', 'Slipping',
  'Punching', 'Punching (1)', 'Punch Combo', 'Hook', 'Stomp',
  'Big Side Hit', 'Kidney Hit', 'Light Hit To Head', 'Receiving An Uppercut', 'Receive Uppercut To The Face',
  'Carrying', 'Pushing', 'Stable Sword Outward Slash',
  'Chop_Start_Fast', 'Chop_Loop_Fast',
];

// the chop clips come from chop.glb (a Sketchfab rig), whose bones carry their
// own names: retarget maps each mixamorig bone to the bone that animates it.
const CHOP_MAP = new Map([['mixamorigSpine2', 'spine_upper_01']]);
for (const [S, s, names] of [
  ['Left', 'l', ['clavicle_l_02', 'arm_upper_l_03', 'arm_lower_l_04', 'hand_l_05',
    'finger_index_01_l_00', 'finger_index_02_l_07', 'finger_index_03_l_08',
    'finger_middle_01_l_013', 'finger_middle_02_l_014', 'finger_middle_03_l_015',
    'finger_ring_01_l_017', 'finger_ring_02_l_018', 'finger_ring_03_l_019',
    'finger_pinky_01_l_021', 'finger_pinky_02_l_022', 'finger_pinky_03_l_023',
    'thumb_01_l_09', 'thumb_02_l_010', 'thumb_03_l_011']],
  ['Right', 'r', ['clavicle_r_027', 'arm_upper_r_028', 'arm_lower_r_029', 'hand_r_030',
    'finger_index_01_r_032', 'finger_index_02_r_033', 'finger_index_03_r_034',
    'finger_middle_01_r_039', 'finger_middle_02_r_040', 'finger_middle_03_r_041',
    'finger_ring_01_r_043', 'finger_ring_02_r_044', 'finger_ring_03_r_045',
    'finger_pinky_01_r_047', 'finger_pinky_02_r_048', 'finger_pinky_03_r_049',
    'thumb_01_r_035', 'thumb_02_r_036', 'thumb_03_r_037']],
]) {
  const L = `mixamorig${S}`, chain = ['Shoulder', 'Arm', 'ForeArm', 'Hand',
    'HandIndex1', 'HandIndex2', 'HandIndex3', 'HandMiddle1', 'HandMiddle2', 'HandMiddle3',
    'HandRing1', 'HandRing2', 'HandRing3', 'HandPinky1', 'HandPinky2', 'HandPinky3',
    'HandThumb1', 'HandThumb2', 'HandThumb3'];
  chain.forEach((b, i) => CHOP_MAP.set(`${L}${b}`, names[i]));
}

// per-clip fixes. `cap` limits hip height so a jump the controller already
// lifts isn't lifted twice; `detrend` removes net vertical travel so a climb
// cycle loops in place.
const FIX = {
  'Jumping': { cap: HIPS_CM },
  'Jumping (1)': { cap: HIPS_CM },
  'Front Flip': { cap: HIPS_CM },
  'Falling To Landing': { cap: HIPS_CM },
  'Climbing': { detrend: true },
};

function prepare(name, clip) {
  clip.name = name;
  const hips = clip.tracks.find((t) => t.name === 'mixamorigHips.position');
  const info = { speed: 0, low: 0 };
  if (hips) {
    const v = hips.values, n = hips.times.length, fix = FIX[name] || {};
    const x0 = v[0], y0 = v[1], z0 = v[2];
    const drift = v[(n - 1) * 3 + 1] - y0;
    info.speed = Math.abs(v[(n - 1) * 3 + 2] - z0) / 100 / clip.duration * BODY_SCALE;
    let low = Infinity;
    for (let i = 0; i < n; i++) {
      v[i * 3] = x0; v[i * 3 + 2] = z0;
      if (fix.detrend) v[i * 3 + 1] -= drift * (i / (n - 1));
      if (fix.cap) v[i * 3 + 1] = Math.min(v[i * 3 + 1], fix.cap);
      if (i < n * 0.6 && v[i * 3 + 1] < low) { low = v[i * 3 + 1]; info.low = hips.times[i]; }
    }
  }
  clip.userData = info;   // speed: m/s the clip's feet cover at BODY_SCALE; low: time of the lowest hip in the first part
  return clip;
}

/** The clips' own skeleton at rest: each bone's parent and its rotation in the world. Retargeting measures from this. */
function restOf(group) {
  group.updateMatrixWorld(true);
  const rest = new Map();
  group.traverse((o) => {
    if (!o.isBone) return;
    rest.set(o.name, { parent: o.parent?.isBone ? o.parent.name : null, wq: o.getWorldQuaternion(new THREE.Quaternion()), lq: o.quaternion.clone(), hips: o.position.y, wp: o.getWorldPosition(new THREE.Vector3()) });
  });
  return rest;
}

const _a = new THREE.Quaternion(), _b = new THREE.Quaternion(), _c = new THREE.Quaternion();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// the arm chain, each bone with the one it points at. The clips are authored on a straight T-pose; a rig
// whose arms rest bent or lowered would carry that bend into every pose, so these bones are first turned
// (about their own origin) until they point the way the clips' bones do at rest.
const ARM_CHAIN = [['Shoulder', 'Arm'], ['Arm', 'ForeArm'], ['ForeArm', 'Hand'], ['Hand', 'HandMiddle1']];
// how far past the clips' rest the upper arms sit, so the arms hang off the ribs instead of hugging them
const SPREAD = 0.24;

/** For each arm bone of the target, its rest orientation with the bone turned to point where the clips' bone does. */
export function straighten(srcRest, target) {
  const out = new Map(), pos = new Map(target.bones.map((b) => [b.name, b.wp]));
  const d1 = new THREE.Vector3(), d2 = new THREE.Vector3();
  for (const side of ['Left', 'Right']) {
    for (const [a, b] of ARM_CHAIN) {
      const na = `mixamorig${side}${a}`, nb = `mixamorig${side}${b}`;
      const sa = srcRest.get(na)?.wp, sb = srcRest.get(nb)?.wp, ta = pos.get(na), tb = pos.get(nb);
      const bone = target.bones.find((x) => x.name === na);
      if (!sa || !sb || !ta || !tb || !bone) continue;
      d1.copy(tb).sub(ta).normalize(); d2.copy(sb).sub(sa).normalize();
      if (a === 'Arm') d2.applyAxisAngle(Z_AXIS, side === 'Left' ? SPREAD : -SPREAD);
      out.set(na, new THREE.Quaternion().setFromUnitVectors(d1, d2).multiply(bone.wq));
    }
  }
  return out;
}

/**
 * Re-aim a clip at another skeleton. The clips store absolute local rotations
 * for Mixamo's own rest frames, and a character rigged from a differently
 * oriented file (Z-up, other pre-rotations, other proportions) has different
 * ones, which twists the body. So each bone's rotation is carried over as how
 * far it turned from rest in the world, and applied to the target's rest
 * orientation; the hips height scales with the body.
 *   target: { bones: [{ name, parent, wq, wp }] parents first, rootQ (world rotation above the hips), hips (rest height in clip units) }
 */
export function retarget(clip, srcRest, target, bmap = null) {
  const hipsQ = clip.tracks.find((t) => t.name === 'mixamorigHips.quaternion') || clip.tracks.find((t) => t.name.endsWith('.quaternion'));
  if (!hipsQ) return clip;
  const times = hipsQ.times, n = times.length;
  const tracks = new Map();
  for (const t of clip.tracks) {
    if (!t.name.endsWith('.quaternion')) continue;
    const v = t.times.length === n ? t.values : (() => {
      const out = new Float32Array(n * 4), it = t.createInterpolant();
      for (let i = 0; i < n; i++) { const r = it.evaluate(times[i]); out.set(r, i * 4); }
      return out;
    })();
    tracks.set(t.name.slice(0, -11), v);
  }
  const sbones = [...srcRest.keys()];
  const aligned = straighten(srcRest, target);
  const out = new Map(target.bones.map((b) => [b.name, new Float32Array(n * 4)]));
  const Ws = new Map(), Wt = new Map(), D = new Map();
  for (let i = 0; i < n; i++) {
    // the clip's pose in the world, then how far each bone has turned from its rest
    for (const name of sbones) {
      const r = srcRest.get(name), v = tracks.get(name);
      const local = v ? _a.fromArray(v, i * 4) : _a.copy(r.lq);
      const world = (Ws.get(name) || Ws.set(name, new THREE.Quaternion()).get(name));
      if (r.parent) world.copy(Ws.get(r.parent)).multiply(local); else world.copy(local);
      (D.get(name) || D.set(name, new THREE.Quaternion()).get(name)).copy(world).multiply(_b.copy(r.wq).invert());
    }
    for (const b of target.bones) {
      const srcName = bmap ? bmap.get(b.name) : b.name;
      const srcParent = bmap && b.parent ? bmap.get(b.parent) : b.parent;
      const d = (srcName && D.get(srcName)) || (srcParent && D.get(srcParent)) || null;
      const pose = (Wt.get(b.name) || Wt.set(b.name, new THREE.Quaternion()).get(b.name));
      if (d) pose.copy(d).multiply(aligned.get(b.name) || b.wq); else pose.copy(b.wq);
      const parent = b.parent ? Wt.get(b.parent) : target.rootQ;
      _c.copy(parent).invert().multiply(pose).toArray(out.get(b.name), i * 4);
    }
  }
  const tracksOut = target.bones.map((b) => new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, out.get(b.name)));
  const hp = clip.tracks.find((t) => t.name === 'mixamorigHips.position');
  if (hp) {
    const k = target.hips / (srcRest.get('mixamorigHips')?.hips || 54.2), inv = target.rootQ.clone().invert(), v = new THREE.Vector3();
    const pos = new Float32Array(hp.values.length);
    for (let i = 0; i < hp.values.length; i += 3) v.fromArray(hp.values, i).multiplyScalar(k).applyQuaternion(inv).toArray(pos, i);
    tracksOut.push(new THREE.VectorKeyframeTrack('mixamorigHips.position', hp.times, pos));
  }
  const res = new THREE.AnimationClip(clip.name, clip.duration, tracksOut);
  res.userData = clip.userData;
  return res;
}

export class AnimLibrary {
  constructor() {
    this.srcRest = null;
    this.clips = new Map();
    this.pending = new Map();
    this.loader = new FBXLoader();
  }

  get(name) { return this.clips.get(name) || null; }

  load(names) { return Promise.all(names.map((n) => this.#one(n))); }

  #one(name) {
    if (!this.pending.has(name)) {
      const job = name.startsWith('Chop_')
        ? new GLTFLoader().loadAsync(`${DIR}chop.glb`).then((g) => {
            if (!this.chopRest) this.chopRest = restOf(g.scene);
            const clip = g.animations.find((a) => a.name === name);
            if (clip) { const p = prepare(name, clip); Object.assign(p.userData, { srcRest: this.chopRest, bmap: CHOP_MAP }); this.clips.set(name, p); }
          })
        : this.loader.loadAsync(`${DIR}${encodeURIComponent(name)}.fbx`)
          .then((g) => {
            if (!this.srcRest) this.srcRest = restOf(g);
            this.clips.set(name, prepare(name, g.animations[0]));
          });
      this.pending.set(name, job.catch((err) => console.warn(`animation ${name} failed to load`, err)));
    }
    return this.pending.get(name);
  }
}
