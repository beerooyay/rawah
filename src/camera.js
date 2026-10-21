import * as THREE from 'three';
import { clamp } from './noise.js';

// The camera rig. First person is the walking-sim view: the eye rides a
// critically damped spring over the ground (so lidar lumps don't jitter the
// view), and head motion is driven by the same stride phase as the footsteps:
// a dip at each footfall, a sway from foot to foot, a little roll into
// strafes, a lean and FOV lift when you push the pace, a dip when you land,
// and breathing that quickens when you're spent. Third person orbits a
// shoulder-offset camera behind the hiker and keeps it out of the hillside.

export class CameraRig {
  constructor(camera, world, hiker, avatar) {
    this.camera = camera;
    this.world = world;
    this.hiker = hiker;
    this.avatar = avatar;
    this.mode = 'first';
    this.baseFov = camera.fov;
    this.eyeY = null;         // smoothed eye height
    this.eyeVel = 0;
    this.dip = 0; this.dipVel = 0;
    this.roll = 0;
    this.fovKick = 0;
    this.breath = 0;
    this.dist = 3.4;          // third-person boom length
    this.boom = 3.4;
    this._eye = new THREE.Vector3();
    this._t = new THREE.Vector3();
    avatar.setFirstPerson(true);
  }

  toggle() {
    this.mode = this.mode === 'first' ? 'third' : 'first';
    this.avatar.setFirstPerson(this.mode === 'first');
    this.eyeY = null;
    return this.mode;
  }

  setFov(f) { this.baseFov = f; }

  /** Call when the hiker lands; `fall` in metres. */
  land(fall) { this.dipVel -= Math.min(3.2, 0.8 + fall * 0.55); }

  update(dt, { zoom = 0, sprinting = false, strafe = 0 } = {}) {
    const h = this.hiker, cam = this.camera;
    h.eye(this._eye);
    const speed = Math.hypot(h.vel.x, h.vel.z);
    const walkK = h.grounded && h.mode === 'walk' ? Math.min(1, speed / 2.5) * h.moving : 0;
    const run = clamp((speed - 3.2) / 1.3, 0, 1);

    // spring-follow the eye height: stiff enough to track slopes, soft over bumps
    if (this.eyeY === null || Math.abs(this._eye.y - this.eyeY) > 3 || h.mode === 'climb') { this.eyeY = this._eye.y; this.eyeVel = 0; }
    const w = 22;
    this.eyeVel += ((this._eye.y - this.eyeY) * w * w - 2 * w * this.eyeVel) * dt;
    this.eyeY += this.eyeVel * dt;

    // landing dip spring
    this.dipVel += (-this.dip * 140 - this.dipVel * 16) * dt;
    this.dip += this.dipVel * dt;

    // breathing: slow at rest, quicker and deeper when winded or high up
    const winded = 1 - h.stamina / 100;
    this.breath += dt * (1.6 + winded * 3.2 + Math.max(0, h.pos.y - 3200) / 900);
    const breathe = Math.sin(this.breath) * (0.004 + winded * 0.012);

    const ph = h.phase;
    const bobAmp = (0.028 + run * 0.03) * walkK;
    const bobY = (Math.abs(Math.sin(ph)) - 0.64) * bobAmp * 2;   // lowest at each footfall
    const sway = Math.sin(ph) * (0.016 + run * 0.012) * walkK;  // weight shifting foot to foot
    this.roll += ((-strafe * 0.026 + Math.sin(ph) * 0.006 * walkK) - this.roll) * Math.min(1, dt * 6);
    this.fovKick += ((sprinting ? 6 : 0) - this.fovKick) * Math.min(1, dt * 3);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }

    const yaw = h.yaw, pitch = h.pitch;
    if (this.mode === 'first') {
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      cam.position.set(this._eye.x + rx * sway, this.eyeY + bobY + this.dip + breathe, this._eye.z + rz * sway);
      cam.rotation.set(pitch - run * 0.03 * walkK + this.dip * 0.08, yaw, this.roll);
      return;
    }

    // third person: shoulder-offset orbit, pulled in so it never clips the slope
    this.dist = clamp(this.dist + zoom * 0.4, 1.6, 7);
    const pivot = this._t.set(h.pos.x, this.eyeY - 0.15 + this.dip * 0.5, h.pos.z);
    const back = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    let want = this.dist;
    for (let d = 0.6; d <= this.dist; d += 0.3) {
      const x = pivot.x + back.x * d + right.x * 0.45, z = pivot.z + back.z * d + right.z * 0.45;
      if (this.world.height(x, z) + 0.35 > pivot.y + back.y * d) { want = Math.max(0.6, d - 0.35); break; }
    }
    this.boom += (want - this.boom) * Math.min(1, dt * (want < this.boom ? 18 : 4));
    cam.position.set(pivot.x + back.x * this.boom + right.x * 0.45, pivot.y + back.y * this.boom + 0.25, pivot.z + back.z * this.boom + right.z * 0.45);
    const ground = this.world.height(cam.position.x, cam.position.z) + 0.3;
    if (cam.position.y < ground) cam.position.y = ground;
    cam.rotation.set(pitch, yaw, this.roll * 0.4);
  }
}
