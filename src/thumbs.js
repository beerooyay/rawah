import * as THREE from 'three';

// Small offscreen renders for the title screen: a car or a character, framed from a three-quarter view.
// One renderer is shared; each call draws a root once and returns it as a PNG data URL.

let renderer = null;

/** A PNG data URL of `root` (any Object3D) seen from `yaw` radians around it, framed to fit. */
export function renderThumb(root, { w = 360, h = 220, yaw = 0.6, lift = 0.4 } = {}) {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
  }
  renderer.setSize(w, h, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x3a3328, 1.7));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
  sun.position.set(3, 5, 4);
  scene.add(sun);
  scene.add(root);
  root.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(root).getBoundingSphere(new THREE.Sphere());
  const cam = new THREE.PerspectiveCamera(28, w / h, 0.01, sphere.radius * 60);
  const d = sphere.radius * 3.1;
  cam.position.set(sphere.center.x + Math.sin(yaw) * d, sphere.center.y + sphere.radius * lift, sphere.center.z + Math.cos(yaw) * d);
  cam.lookAt(sphere.center);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(root);
  return url;
}
