import * as THREE from 'three';

// Rain and snow with no per-particle CPU work. Each drop or flake gets its
// spot from gl_InstanceID inside a box that wraps around the camera, falling
// and drifting with the wind in world space (so walking through it doesn't
// drag it along). Rain is a thin streak stretched along its velocity; snow is
// a soft flake that tumbles. How many of them show follows the intensity, and
// each one is rain or snow by the temperature.

const VERT = /* glsl */ `
uniform vec3 uCam;
uniform float uTime, uAmount, uSnow, uBox;
uniform vec2 uWind;
varying vec2 vUv;
varying float vFade, vSnow;
float hash(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  float id = float(gl_InstanceID);
  float h1 = hash(id * 1.17), h2 = hash(id * 2.31 + 4.1), h3 = hash(id * 3.73 + 1.7), h4 = hash(id * 0.71 + 9.3);
  vSnow = step(h4, uSnow);
  if (h1 * 0.999 > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float B = uBox * mix(1.0, 0.7, vSnow);
  float fall = mix(8.5 + h2 * 2.5, 0.9 + h2 * 0.6, vSnow);
  vec3 vel = vec3(uWind.x, -fall, uWind.y) * vec3(mix(1.0, 0.55, vSnow), 1.0, mix(1.0, 0.55, vSnow));
  vec3 seed = vec3(h1, h2, h3) * B * 7.0;
  vec3 p = seed + vel * uTime;
  // flakes wander
  p.xz += vSnow * vec2(sin(uTime * (0.9 + h3) + id), cos(uTime * (0.7 + h1) + id * 1.3)) * 0.35;
  p = uCam + (fract((p - uCam) / B) - 0.5) * B;
  vec3 toCam = normalize(cameraPosition - p);
  vec3 axis, side;
  if (vSnow > 0.5) {
    side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
    axis = cross(toCam, side);
    float s = 0.018 + h3 * 0.02;
    p += (side * (position.x) + axis * (position.y - 0.5)) * s * 2.0;
  } else {
    axis = normalize(vel);
    side = normalize(cross(axis, toCam));
    p += side * position.x * 0.012 + axis * (position.y - 0.5) * (0.38 + h3 * 0.2);
  }
  vUv = vec2(position.x + 0.5, position.y);
  float d = distance(p, cameraPosition);
  vFade = smoothstep(0.4, 1.5, d) * (1.0 - smoothstep(B * 0.3, B * 0.5, d));
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uLight;
varying vec2 vUv;
varying float vFade, vSnow;
void main() {
  float a;
  if (vSnow > 0.5) a = smoothstep(0.5, 0.15, length(vUv - 0.5)) * 0.9;
  else a = (1.0 - abs(vUv.x - 0.5) * 2.0) * smoothstep(0.0, 0.3, vUv.y) * 0.32;
  a *= vFade;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uLight * mix(0.85, 1.25, vSnow), a);
  #include <colorspace_fragment>
}`;

export class Precip {
  constructor(count = 6000, box = 30) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3));
    g.setIndex([0, 1, 2, 1, 3, 2]);
    g.instanceCount = count;
    this.uniforms = {
      uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uAmount: { value: 0 }, uSnow: { value: 0 },
      uBox: { value: box }, uWind: { value: new THREE.Vector2() }, uLight: { value: new THREE.Color() },
    };
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
      transparent: true, depthWrite: false, fog: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  update(dt, camera, wx, wind, light) {
    const u = this.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(camera.position);
    u.uAmount.value = Math.min(1, wx.precip * 1.15);
    u.uSnow.value = wx.snowK;
    u.uWind.value.set(wind[0], wind[1]);
    u.uLight.value.copy(light);
    this.mesh.visible = wx.precip > 0.01;
  }
}
