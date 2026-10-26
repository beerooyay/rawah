import * as THREE from 'three';

// A planar mirror for the lakes: the world above the water, drawn again from where the camera would be if it sat under
// the surface (the camera reflected in the water plane), so the shore, the trees and the skyline are really in the lake.
// The technique is the usual one (three's own Reflector): a virtual camera at the reflected position with an oblique near
// plane that cuts away everything under the water, and the lake shader finds its pixel by projecting the water point
// through the virtual camera (`uMirrorVP`). Everything the lake shader needs is a uniform on `LakeMirror.uniforms`.
//
// One plane at a time: the nearest lake in view that you stand above (lakes whose surface is within 2.5 m of that level
// share it; the rest keep the plain sky tint). It is drawn at half resolution, every other frame, with the grass, the light
// shafts, the streams and the lakes themselves hidden, and without a new shadow pass (the shadow map from the main
// frame is reused). Atmosphere uniforms that depend on the camera are recomputed for the virtual camera and put back.

const RANGE = 1100;       // metres: farther lakes are too small to matter
const WIDEN = 1.22;       // the mirror's view is this much wider than the camera's
const SHARE = 2.5;        // other lakes within this many metres of the plane's height use it too

export class LakeMirror {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.on = true;
    this.uniforms = {
      uMirror: { value: null }, uMirrorVP: { value: new THREE.Matrix4() }, uMirrorY: { value: 0 }, uMirrorOn: { value: 0 },
    };
    this.rt = null;
    this.cam = new THREE.PerspectiveCamera();
    this.frustum = new THREE.Frustum();
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3(); this._t = new THREE.Vector3(); this._u = new THREE.Vector3(); this._plane = new THREE.Plane();
    this._q = new THREE.Vector4(); this._clip = new THREE.Vector4(); this._size = new THREE.Vector2();
    this.frame = 0;
    this.drawn = 0;
    // every lake's footprint: a centre, a radius and a level, from its scanline runs
    const half = world.N / 2, cell = world.cell;
    this.lakes = world.lakes.map((lake) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, area = 0;
      for (const [r, c0, c1] of lake.runs) {
        x0 = Math.min(x0, (c0 - half - 0.5) * cell); x1 = Math.max(x1, (c1 - half + 0.5) * cell);
        z0 = Math.min(z0, (r - half - 0.5) * cell); z1 = Math.max(z1, (r - half + 0.5) * cell);
        area += (c1 - c0 + 1) * cell * cell;
      }
      return { level: lake.level, x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, r: Math.hypot(x1 - x0, z1 - z0) / 2, area };
    }).filter((l) => l.area > 1500);          // puddles are not worth a second render
  }

  #resize() {
    this.renderer.getDrawingBufferSize(this._size);
    const w = Math.max(256, Math.round(this._size.x * 0.5)), h = Math.max(256, Math.round(this._size.y * 0.5));
    if (this.rt && this.rt.width === w && this.rt.height === h) return;
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt.texture.generateMipmaps = false;
    this.uniforms.uMirror.value = this.rt.texture;
  }

  /** The lake to mirror this frame, or null. */
  #pick(camera) {
    const p = camera.position;
    let best = null, bestD = Infinity;
    for (const l of this.lakes) {
      if (p.y < l.level + 0.25) continue;                                  // swimming, or below the surface
      const dx = Math.max(l.x0 - p.x, 0, p.x - l.x1), dz = Math.max(l.z0 - p.z, 0, p.z - l.z1);
      const d = Math.hypot(dx, dz);
      if (d > RANGE || d >= bestD) continue;
      if (!this.frustum.intersectsSphere(new THREE.Sphere(new THREE.Vector3(l.cx, l.level, l.cz), l.r))) continue;
      best = l; bestD = d;
    }
    return best;
  }

  /**
   * Draw the mirror for this frame if a lake needs it. `hide` are the objects not worth drawing in it; `atmosphere(cam)` puts
   * the camera-dependent shared uniforms for that camera. Call before the main render, after everything has been updated.
   */
  update({ scene, camera, hide = [], atmosphere, enabled = true }) {
    const U = this.uniforms;
    this._m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._m);
    const lake = this.on && enabled ? this.#pick(camera) : null;
    if (!lake) { U.uMirrorOn.value = 0; return; }
    U.uMirrorY.value = lake.level;
    U.uMirrorOn.value = 1;
    this.#resize();
    if (this.frame++ % 2) return;                                          // every other frame: the picture changes slowly
    const L = lake.level, rend = this.renderer, vc = this.cam;
    // the virtual camera: the real one reflected in the plane y = L
    camera.updateMatrixWorld();
    const pos = this._v.setFromMatrixPosition(camera.matrixWorld);
    vc.position.set(pos.x, 2 * L - pos.y, pos.z);
    const rot = this._m.extractRotation(camera.matrixWorld);
    const up = this._u.set(0, 1, 0).applyMatrix4(rot); up.y = -up.y;
    const look = this._t.set(0, 0, -1).applyMatrix4(rot).add(pos);
    look.y = 2 * L - look.y;
    vc.up.copy(up);
    vc.lookAt(look);
    vc.near = camera.near; vc.far = camera.far; vc.fov = camera.fov; vc.aspect = camera.aspect;
    vc.updateMatrixWorld();
    // a little wider than the real view, so the water at the screen edges still finds its reflection inside the picture
    vc.projectionMatrix.copy(camera.projectionMatrix);
    vc.projectionMatrix.elements[0] /= WIDEN; vc.projectionMatrix.elements[5] /= WIDEN;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
    // what the lake shader projects the water point with (before the oblique clip below)
    U.uMirrorVP.value.multiplyMatrices(vc.projectionMatrix, vc.matrixWorldInverse);
    // oblique near plane: nothing under the water gets into the reflection
    this._plane.set(new THREE.Vector3(0, 1, 0), -L).applyMatrix4(vc.matrixWorldInverse);
    const c = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const pm = vc.projectionMatrix, e = pm.elements, q = this._q;
    q.x = (Math.sign(c.x) + e[8]) / e[0];
    q.y = (Math.sign(c.y) + e[9]) / e[5];
    q.z = -1;
    q.w = (1 + e[10]) / e[14];
    c.multiplyScalar(2 / c.dot(q));
    e[2] = c.x; e[6] = c.y; e[10] = c.z + 1 - 0.003; e[14] = c.w;
    // draw
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    const prev = { rt: rend.getRenderTarget(), shadowNeeds: rend.shadowMap.needsUpdate, auto: rend.shadowMap.autoUpdate };
    rend.shadowMap.autoUpdate = false; rend.shadowMap.needsUpdate = false;
    atmosphere(vc);
    rend.setRenderTarget(this.rt);
    rend.clear();
    rend.render(scene, vc);
    rend.setRenderTarget(prev.rt);
    rend.shadowMap.needsUpdate = prev.shadowNeeds; rend.shadowMap.autoUpdate = prev.auto;
    atmosphere(camera);
    hide.forEach((o, i) => { o.visible = vis[i]; });
    this.drawn++;
  }
}
