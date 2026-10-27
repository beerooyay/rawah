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
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const fov = 30, half = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const d = Math.max(size.y / 2 / half, Math.max(size.x, size.z) / 2 / half / (w / h)) * 1.1;
  const cam = new THREE.PerspectiveCamera(fov, w / h, 0.01, d + size.length() * 4);
  cam.position.set(center.x + Math.sin(yaw) * d, center.y + size.y * lift * 0.5, center.z + Math.cos(yaw) * d);
  cam.lookAt(center);
  renderer.render(scene, cam);
  const url = renderer.domElement.toDataURL('image/png');
  scene.remove(root);
  return url;
}
