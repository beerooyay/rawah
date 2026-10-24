import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Avatar } from './avatar.js';
import { AnimLibrary, BODY_SCALE, CORE, EXTRA, retarget, straighten } from './anims.js';
import { buildTool } from './tools.js';
import { clamp } from './noise.js';
import { withAtmosphere } from './atmosphere.js';

// The player's body: a Mixamo-rigged character posed by the animation library.
// It only reads the hiker (never writes it), so the controller stays the one
// source of truth: each frame the hiker's mode, stance, action and speed pick a
// clip, and clips crossfade into each other. Until the model and the core clips
// have loaded, the procedural placeholder avatar stands in. Like the
// placeholder, in first person it draws only into the shadow map.
//
// The same class poses the companions (companions.js), which hand it a body
// that looks like a hiker: they share one animation library and have no
// placeholder, and `face` and `emote` let a script turn them to each other
// or hold a clip.

export const CHARACTERS = {
  blaize: 'assets/characters/blaize/blaize.glb',
  grant: 'assets/characters/grant/grant.glb',
  corey: 'assets/characters/corey/corey.glb',
  taylor: 'assets/characters/taylor.glb',
  trey: 'assets/characters/trey/trey.glb',
};

// world-space scale for the torso and arms (see #bulk); Corey has the least to start with
const BULK = {
  mixamorigSpine1: 1.04, mixamorigSpine2: 1.1, mixamorigNeck: 1, mixamorigHead: 1,
  mixamorigLeftArm: 1.14, mixamorigRightArm: 1.14, mixamorigLeftForeArm: 1.1, mixamorigRightForeArm: 1.1,
  mixamorigLeftHand: 1, mixamorigRightHand: 1,
};
const BULK_SCALE = { corey: 1.3, grant: 1, blaize: 1 };

const ACTION_CLIP = {
  jab: 'Punching', cross: 'Punching (1)', combo: 'Punch Combo', hook: 'Hook', stomp: 'Stomp',
  chop: 'Stable Sword Outward Slash', slash: 'Stable Sword Outward Slash',   // the one swing clip we have serves axe and machete
  hitSide: 'Big Side Hit', hitKidney: 'Kidney Hit', hitHead: 'Light Hit To Head',
  hitUpper: 'Receiving An Uppercut', hitFace: 'Receive Uppercut To The Face',
  climbOut: 'Swimming To Edge',
};
// the part of the clip an action plays, as shares of its length (climbing out starts with swimming; the slash has a long lead-in and follow-through)
const ACTION_SPAN = { climbOut: [0.25, 1], chop: [0.12, 0.74], slash: [0.12, 0.74] };
const FIDGETS = ['Wiping Sweat', 'Searching Pockets', 'Swatting Bugs', 'Looking', 'Happy Idle'];
const GUARD = 4;   // s the fists stay up after a punch
/**
 * Light a character like the rest of the world: fogged and cloud-shadowed with
 * everything else, lit from the sky as well as the sun, with a soft sky-tinted
 * rim so a figure doesn't go flat against a bright background, and the
 * highlights photographed into the texture eased down so the game's own light
 * does the shading.
 */
function skinLight(m) {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float tl = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          diffuseColor.rgb *= 1.0 - 0.3 * smoothstep(0.38, 0.8, tl);      // baked glints and sheen
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(tl), 0.06) + 0.012;   // a touch of lift so black cloth keeps its folds
        }`)
      .replace('#include <opaque_fragment>', `
        {
          float rim = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 2.6);
          #ifdef USE_FOG
            vec3 rimCol = fogColor;
          #else
            vec3 rimCol = vec3(0.6, 0.7, 0.85);
          #endif
          outgoingLight += diffuseColor.rgb * rimCol * rim * 0.42 * (0.35 + 0.65 * clamp(dot(normalize(normal), vec3(0.0, 1.0, 0.0)) * 0.5 + 0.7, 0.0, 1.0));
        }
        #include <opaque_fragment>`);
    withAtmosphere(shader, { weather: 0.7, occlusion: 0.85, translucency: 0.12 });
  };
  m.customProgramCacheKey = () => 'rawah-skin';
  m.needsUpdate = true;
}

const RETARGET = globalThis.RAWAH_RETARGET ?? true;   // fit each clip to the rig it plays on (the rigs and the clips disagree about up and about bone frames)
const Y_AXIS = new THREE.Vector3(0, 1, 0), X_AXIS = new THREE.Vector3(1, 0, 0);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const UPRIGHT_SKIP = /sit|lie|lying|fall|prone|climb|swim|hang|crawl|kneel|crouch|down|knock|flip|stomp/i;
const UPRIGHT_WEIGHT = 0.97;
const FLIP_AIR = 2 * 7.4 / 18;   // seconds a flip jump spends in the air (launch speed over gravity)

export class Character {
  constructor(scene, name = 'blaize', { lib = null, placeholder = true, firstPerson = true } = {}) {
    this.scene = scene;
    this.fallback = placeholder ? new Avatar(scene) : null;
    this.lib = lib || new AnimLibrary();
    this.group = null; this.mixer = null; this.cur = null;
    this.ready = false; this.firstPerson = firstPerson;
    this.key = ''; this.hold = 0;
    this.heading = 0; this.vs = 0; this.back = false;
    this.wasGrounded = true; this.airKind = '';
    this.prevStance = 'stand'; this.getup = 0; this.guard = 0; this.yoff = 0;
    this.idleT = 0; this.nextFidget = 7 + Math.random() * 6; this.fidget = null; this.fidgetT = 0;
    this.gait = 'walk';
    this.hand = null; this.tool = 'fists'; this.toolObj = null; this.grip = null;
    this.target = null; this.fitted = new Map();
    this.arms = []; this.reachW = 0;
    this.head = null; this.neck = null; this.lookYaw = 0; this.lookPitch = 0; this.lookW = 0;
    this.#load(CHARACTERS[name] ? name : 'blaize');
  }

  get root() { return this.ready ? this.group : this.fallback?.root; }

  async #load(name) {
    try {
      const [gltf] = await Promise.all([new GLTFLoader().loadAsync(CHARACTERS[name]), this.lib.load(CORE)]);
      // without its clips a rig just stands in its T-pose: better to keep the placeholder than show that
      if (!this.lib.get('Neutral Idle') || !this.lib.srcRest) throw new Error('animation clips did not load');
      const model = gltf.scene;
      model.scale.setScalar(BODY_SCALE);
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        o.frustumCulled = false;   // skinned bounds don't follow the pose
        for (const m of [].concat(o.material)) { m.metalness = 0; m.roughness = 0.88; m.specularIntensity = 0.2; skinLight(m); }
      });
      this.group = new THREE.Group();
      this.group.add(model);
      this.scene.add(this.group);
      this.target = this.#measure(model);
      this.mixer = new THREE.AnimationMixer(model);
      this.head = model.getObjectByName('mixamorigHead'); this.neck = model.getObjectByName('mixamorigNeck');
      this.hand = model.getObjectByName('mixamorigRightHand');
      this.hips = model.getObjectByName('mixamorigHips');
      this.arms = [['Left', -1], ['Right', 1]].map(([side, sx]) => ({ sx, bones: ['Arm', 'ForeArm', 'Hand'].map((n) => model.getObjectByName(`mixamorig${side}${n}`)) })).filter((a) => a.bones.every(Boolean));
      this.grip = this.#gripOf();
      this.#bulk(model, name);
      if (this.fallback) this.fallback.root.visible = false;
      this.ready = true;
      this.setFirstPerson(this.firstPerson);
      this.#mountTool();
      this.lib.load(EXTRA);
    } catch (err) {
      console.warn('character failed to load; keeping the placeholder', err);
    }
  }

  /** The model's skeleton at rest, in the shape `retarget` wants. */
  #measure(model) {
    model.updateMatrixWorld(true);
    const bones = [];
    model.traverse((o) => { if (o.isBone) bones.push(o); });
    const hips = bones.find((b) => b.name === 'mixamorigHips');
    const list = bones.map((b) => ({ name: b.name, parent: b.parent?.isBone ? b.parent.name : null, wq: b.getWorldQuaternion(new THREE.Quaternion()), wp: b.getWorldPosition(new THREE.Vector3()) }));
    const up = new THREE.Vector3(), root = new THREE.Quaternion();
    hips.parent.getWorldQuaternion(root);
    const worldY = hips.getWorldPosition(up).y / model.scale.y;   // metres at rest, before BODY_SCALE
    return { bones: list, rootQ: root, hips: worldY * 100 };
  }

  /**
   * Where a tool sits in the right hand, in the hand bone's own frame. The clips pose
   * the hand from a straightened rest (see `straighten`), so the grip is worked out
   * there: handle across the fist (thumb to little finger), head up past the thumb
   * and angled toward the fingers, cutting edge toward the fingertips.
   */
  #gripOf() {
    if (!this.hand || !this.lib.srcRest) return null;
    const rest = straighten(this.lib.srcRest, this.target).get('mixamorigRightHand');
    if (!rest) return null;
    const bones = new Map(this.target.bones.map((b) => [b.name, b]));
    const wrist = bones.get('mixamorigRightHand'), knuckle = bones.get('mixamorigRightHandMiddle1');
    const scale = this.hand.getWorldScale(new THREE.Vector3()).x;      // bone units to metres
    const finger = new THREE.Vector3(-1, 0, 0), thumb = new THREE.Vector3(0, 0, 1);
    const head = thumb.clone().multiplyScalar(Math.cos(0.7)).addScaledVector(finger, Math.sin(0.7)).normalize();
    const edge = finger.clone().addScaledVector(head, -finger.dot(head)).normalize();
    const across = new THREE.Vector3().crossVectors(edge, head);
    const world = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(edge, head, across));
    const inv = rest.clone().invert();
    const palm = finger.clone().multiplyScalar(wrist.wp.distanceTo(knuckle.wp) * 0.5).applyQuaternion(inv).divideScalar(scale);
    return { q: inv.multiply(world), pos: palm, scale: 1 / scale };
  }

  /**
   * A sturdier build. Each listed bone gets the world-space scale it should end
   * up with (its own turned into a local one by what its parents already apply),
   * so the chest broadens, the shoulders move out and the arms thicken while the
   * head, hands and legs keep their size and the feet keep their ground. Done
   * after the rig is measured, so the retarget still sees the original skeleton.
   */
  #bulk(model, name) {
    const k = BULK_SCALE[name] ?? 1;
    model.traverse((b) => {
      if (!b.isBone) return;
      const parent = b.parent?.userData.bulk ?? 1;
      const want = BULK[b.name] === undefined ? parent : 1 + (BULK[b.name] - 1) * k;
      b.userData.bulk = want;
      if (want !== parent) b.scale.setScalar(want / parent);
    });
  }

  #mountTool() {
    if (!this.hand) return;
    if (this.toolObj) { this.hand.remove(this.toolObj); this.toolObj = null; }
    if (this.tool === 'fists' || this.tool === 'mind' || !this.grip) return;
    const t = buildTool(this.tool);
    t.quaternion.copy(this.grip.q); t.position.copy(this.grip.pos); t.scale.setScalar(this.grip.scale);
    t.visible = !this.firstPerson;
    this.hand.add(t);
    this.toolObj = t;
  }

  setTool(kind) { this.tool = kind; this.#mountTool(); }

  /** A clip fitted to this skeleton, made once. */
  #clip(name) {
    const src = this.lib.get(name);
    if (!RETARGET || !src || !this.target || !this.lib.srcRest) return src;
    let c = this.fitted.get(name);
    if (!c) { c = retarget(src, this.lib.srcRest, this.target); this.fitted.set(name, c); }
    return c;
  }

  /** Show fully (third person) or only as a shadow caster (first person). */
  setFirstPerson(on) {
    this.firstPerson = on;
    this.fallback?.setFirstPerson(on);
    if (this.toolObj) this.toolObj.visible = !on;
    this.group?.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) { m.colorWrite = !on; m.depthWrite = !on; }
    });
  }

  update(dt, h) {
    if (!this.ready) { this.fallback?.update(dt, h); return; }
    const speed = Math.hypot(h.vel.x, h.vel.z);
    this.vs += (speed - this.vs) * Math.min(1, dt * 10);
    // walking backwards: face the way you look instead of turning round
    const fx = -Math.sin(h.yaw), fz = -Math.cos(h.yaw);
    this.back = h.grounded && h.mode === 'walk' && h.stance === 'stand' && speed > 0.3 && (h.vel.x * fx + h.vel.z * fz) < -0.55 * speed;
    this.#place(dt, h, speed);
    const w = this.#want(dt, h, this.vs);
    if (w) this.#apply(w);
    this.mixer.update(dt);
    this.#upright(h);
    this.#look(dt, h);
    this.#reach(dt, h);
    // a held pose: freeze a one-shot partway through
    if (this.hold && this.cur && this.cur.time >= this.hold) { this.cur.time = this.hold; this.cur.timeScale = 0; }
  }

  /**
   * Turn the head toward `h.lookAt` (a world point) on top of whatever the clip
   * is doing: eased in and out, split between neck and head, and let go of
   * when the target is behind or the body is busy.
   */
  /**
   * Stand up straight. The retargeted clips carry a few degrees of forward and
   * sideways lean into the spine (about 10 degrees in idle on every rig), so the
   * hips are turned back until the spine runs along world up. Only while on
   * their feet: lying, sitting, climbing and swimming keep their own lean.
   */
  #upright(h) {
    const hips = this.hips, neck = this.neck;
    if (!hips || !neck || !this.group || UPRIGHT_SKIP.test(this.key)) return;
    this.group.updateMatrixWorld(true);
    const spine = _v3.subVectors(neck.getWorldPosition(_v2), hips.getWorldPosition(_v1)).normalize();
    if (spine.y > 0.99995) return;
    // a part of the turn to world up, so a walk keeps a little of its natural forward lean
    const turn = new THREE.Quaternion().setFromUnitVectors(spine, Y_AXIS);
    const part = new THREE.Quaternion().slerp(turn, UPRIGHT_WEIGHT);
    const world = hips.getWorldQuaternion(new THREE.Quaternion());
    const parentInv = hips.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    hips.quaternion.copy(parentInv.multiply(part.multiply(world)));
    hips.updateMatrixWorld(true);
  }

  /**
   * Telekinesis: both arms lift forward and a little outward, over whatever clip
   * is playing. Each bone is turned in the world so its child points where
   * wanted, then written back as a local rotation.
   */
  #reach(dt, h) {
    this.reachW += ((h.channel ? 1 : 0) - this.reachW) * Math.min(1, dt * 6);
    if (this.reachW < 0.01 || !this.cur) return;
    this.group.updateMatrixWorld(true);
    const face = this.group.getWorldQuaternion(_q1);
    for (const { sx, bones } of this.arms) {
      for (let i = 0; i < 2; i++) {
        const bone = bones[i], child = bones[i + 1];
        const want = _v1.set(sx * (i ? 0.2 : 0.45), i ? 0.45 : 0.3, 0.85).applyQuaternion(face).normalize();
        const cur = _v2.setFromMatrixPosition(child.matrixWorld).sub(_v3.setFromMatrixPosition(bone.matrixWorld)).normalize();
        _q2.setFromUnitVectors(cur, want);
        _q3.identity().slerp(_q2, this.reachW);
        const world = bone.getWorldQuaternion(_q4).premultiply(_q3);
        const parent = bone.parent.getWorldQuaternion(_q2).invert();
        bone.quaternion.copy(parent.multiply(world));
        bone.updateMatrixWorld(true);
      }
    }
  }

  #look(dt, h) {
    if (!this.head || !this.neck || !this.cur) return;   // the turn is added on top of a clip's pose; with no clip driving the bones it would pile up every frame
    const t = h.lookAt, busy = h.action || h.mode !== 'walk' || h.stance !== 'stand' || !h.grounded || this.vs > 0.7;
    let yaw = 0, pitch = 0, on = 0;
    if (t && !busy) {
      const eye = this.head.getWorldPosition(_v1);
      const local = this.group.worldToLocal(_v2.copy(t));
      const ey = this.group.worldToLocal(eye).y;
      yaw = Math.atan2(local.x, local.z);
      pitch = Math.atan2(local.y - ey, Math.hypot(local.x, local.z));
      on = Math.abs(yaw) < 1.9 ? 1 : 0;      // not over the shoulder
      yaw = clamp(yaw, -1.05, 1.05); pitch = clamp(pitch, -0.45, 0.5);
    }
    const k = Math.min(1, dt * 5);
    this.lookYaw += (yaw - this.lookYaw) * k; this.lookPitch += (pitch - this.lookPitch) * k; this.lookW += (on - this.lookW) * k;
    if (this.lookW < 0.01) return;
    for (const [bone, share] of [[this.neck, 0.4], [this.head, 0.6]]) {
      // measured against the rig: turning about the bone's Y needs the opposite sign to the model's own yaw
      _q1.setFromAxisAngle(Y_AXIS, -this.lookYaw * share * this.lookW);
      _q2.setFromAxisAngle(X_AXIS, -this.lookPitch * share * this.lookW);
      bone.quaternion.multiply(_q1).multiply(_q2);
    }
  }

  #place(dt, h, speed) {
    let want = this.heading;
    if (h.mode === 'climb') want = Math.atan2(-h.wallUp.x, -h.wallUp.y);
    else if (h.action || this.back || h.face) want = h.yaw;
    else if (speed > 0.3) want = Math.atan2(-h.vel.x, -h.vel.z);
    let d = want - this.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.heading += d * Math.min(1, dt * (h.action ? 18 : 10));
    const g = this.group;
    // in the water the clip floats the body: swimming rides the surface, treading water sits chest deep
    let lift = h.mode === 'swim' ? (this.key === 'tread' ? 0.04 : 0.56) : 0;
    // hauling out: the body starts at the waterline and comes up onto the bank
    if (h.action?.kind === 'climbOut') { const u = clamp((h.action.t / h.action.dur - 0.25) / 0.55, 0, 1); lift = -0.15 * (1 - u * u * (3 - 2 * u)); }
    this.yoff += (lift - this.yoff) * Math.min(1, dt * 8);
    g.position.set(h.pos.x, h.pos.y + this.yoff, h.pos.z);
    if (h.mode === 'climb') { g.position.x -= h.wallUp.x * 0.3; g.position.z -= h.wallUp.y * 0.3; }
    g.rotation.y = this.heading + Math.PI;   // the models face +z
  }

  /** What the body should be doing right now, as a clip request, or null to keep the current one. */
  #want(dt, h, v) {
    const L = this.lib;
    const air = !h.grounded && h.mode === 'walk';
    const was = this.wasGrounded;
    this.wasGrounded = !air;
    if (air && was) this.airKind = h.vel.y > 1.5 ? (h.flip ? 'flip' : v > 2.2 ? 'jumpRun' : 'jumpStand') : 'fall';
    const rate = (clip, lo = 0.5, hi = 1.9) => clamp(v / (L.get(clip)?.userData.speed || 1.5), lo, hi);

    if (h.mode === 'swim') {
      if (v < 0.3) return { key: 'tread', clip: 'Treading Water', fade: 0.4 };
      return { key: 'swim', clip: 'Swimming', rate: rate('Swimming', 0.8, 2.2), fade: 0.4, live: true };
    }
    if (h.mode === 'climb') return { key: 'climb', clip: 'Climbing', rate: clamp(h.climbSpeed / 0.5, 0, 2.4), fade: 0.25, live: true };

    if (h.action?.hits.length) this.guard = GUARD;
    if (h.action) {
      const clip = ACTION_CLIP[h.action.kind], src = L.get(clip);
      if (!src) return null;
      const [from, to] = ACTION_SPAN[h.action.kind] || [0, 1];
      return { key: `act${h.action.id}`, clip, loop: false, at: src.duration * from, rate: src.duration * (to - from) / h.action.dur, fade: h.action.kind.startsWith('hit') ? 0.05 : h.action.kind === 'climbOut' ? 0.3 : 0.1 };
    }

    if (air) {
      if ((this.airKind === 'jumpStand' || this.airKind === 'jumpRun') && h.vel.y < -3) this.airKind = 'fall';
      if (this.airKind === 'flip') return { key: 'flip', clip: 'Front Flip', loop: false, rate: (L.get('Front Flip')?.duration || 1.67) / FLIP_AIR, fade: 0.08 };
      if (this.airKind === 'jumpStand') return { key: 'jump', clip: 'Jumping (1)', loop: false, at: L.get('Jumping (1)')?.userData.low, rate: 1.3, fade: 0.1 };
      if (this.airKind === 'jumpRun') return { key: 'jumpr', clip: 'Jumping', loop: false, at: L.get('Jumping')?.userData.low, rate: 1.3, fade: 0.1 };
      return { key: 'fall', clip: 'Falling To Landing', loop: false, hold: 0.4, fade: 0.2 };
    }
    if (h.recover > 0) return { key: 'land', clip: 'Falling To Landing', loop: false, at: 0.42, rate: 1.3, fade: 0.06 };
    if (h.sliding) return { key: 'slide', clip: 'Slipping', loop: false, hold: 0.55, fade: 0.2 };

    if (h.load || h.channel) return { key: 'carry', clip: 'Carrying', rate: v < 0.3 ? 0 : rate('Carrying', 0.6, 1.6), fade: 0.3, live: true };
    if (h.pushing && v > 0.12) return { key: 'push', clip: 'Pushing', rate: rate('Pushing', 0.5, 1.5), fade: 0.2, live: true };

    // getting up from lying down plays the sit-up
    if (this.prevStance === 'prone' && h.stance !== 'prone') this.getup = 1.3;
    this.prevStance = h.stance;
    if (this.getup > 0) { this.getup -= dt; return { key: 'getup', clip: 'Situp To Idle', loop: false, rate: 3.4, fade: 0.1 }; }

    if (h.stance === 'prone') {
      if (v > 0.12) return { key: 'crawl', clip: 'Crawling', rate: rate('Crawling', 0.5, 1.5), fade: 0.2, live: true };
      return { key: 'prone', clip: 'Fallen Idle', fade: 0.4 };
    }
    if (h.stance === 'crouch') {
      if (v > 0.12) return { key: 'sneak', clip: 'Crouched Walking', rate: rate('Crouched Walking', 0.6, 1.6), fade: 0.2, live: true };
      return { key: 'crouch', clip: 'Crouch Idle 01', fade: 0.3 };
    }
    if (v < 0.3) {
      if (h.resting) return { key: 'sit', clip: 'Sitting Idle', fade: 0.5 };
      return this.#idle(dt, h);
    }
    this.idleT = 0; this.fidget = null; this.guard = 0;
    if (this.back) return { key: 'back', clip: 'Walk Backwards', rate: rate('Walk Backwards', 0.6, 1.9), fade: 0.25, live: true };
    if (h.injured > 0) return { key: 'hurt', clip: 'Injured Jog', rate: rate('Injured Jog'), fade: 0.25, live: true };
    // change gait only once clearly past the boundary, so a speed hovering on it doesn't flicker between clips
    const g = this.gait;
    if (g === 'walk' && v > 1.65) this.gait = 'jog';
    else if (g === 'jog' && v < 1.3) this.gait = 'walk';
    else if (g === 'jog' && v > 3.55) this.gait = 'sprint';
    else if (g === 'sprint' && v < 3.2) this.gait = 'jog';
    const clip = { walk: 'Swagger Walk', jog: 'Jogging', sprint: 'Sprint' }[this.gait];
    return { key: clip, clip, rate: rate(clip), fade: 0.25, live: true };
  }

  /** Standing still: breathe in the idle, and every so often fidget. */
  #idle(dt, h) {
    const hurt = h.injured > 0;
    // a script holding a clip (companions chatting or squaring up)
    if (h.emote && this.lib.get(h.emote)) return { key: `emo${h.emote}`, clip: h.emote, fade: 0.35 };
    // fists up for a few seconds after a punch
    if (this.guard > 0 && !hurt) { this.guard -= dt; return { key: 'guard', clip: 'Fighting Idle', fade: 0.2 }; }
    this.idleT += dt;
    if (this.fidget) {
      this.fidgetT -= dt;
      if (this.fidgetT > 0) return { key: `fid${this.fidget}`, clip: this.fidget, loop: false, fade: 0.35 };
      this.fidget = null; this.idleT = 0; this.nextFidget = 7 + Math.random() * 8;
    } else if (this.idleT > this.nextFidget) {
      // winded hikers wipe their brow; otherwise anything goes
      this.fidget = hurt ? 'Injured Wave Idle' : h.stamina < 60 ? FIDGETS[0] : FIDGETS[Math.floor(Math.random() * FIDGETS.length)];
      const src = this.lib.get(this.fidget);
      if (!src) this.fidget = null; else this.fidgetT = src.duration - 0.35;
    }
    return hurt ? { key: 'hurt-idle', clip: 'Injured Hurting Idle', fade: 0.3 } : { key: 'idle', clip: 'Neutral Idle', fade: 0.3 };
  }

  #apply(w) {
    const clip = this.#clip(w.clip);
    if (!clip) return;
    const rate = w.rate ?? 1;
    if (w.key === this.key) {
      if (w.live && this.cur) this.cur.timeScale = rate;
      return;
    }
    const next = this.mixer.clipAction(clip), prev = this.cur;
    next.reset();
    next.setLoop(w.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = w.loop === false;
    next.timeScale = rate;
    next.time = w.at ?? 0;
    next.play();
    if (prev && prev !== next) next.crossFadeFrom(prev, w.fade ?? 0.2, false);
    else next.fadeIn(w.fade ?? 0.2);
    this.cur = next; this.key = w.key; this.hold = w.hold || 0;
  }
}
