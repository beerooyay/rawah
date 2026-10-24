import * as THREE from 'three';
import { CLOUD_GLSL, atmosphere } from './atmosphere.js';

// The night sky as it really is: about sixteen thousand stars scattered over
// the celestial sphere (more of them toward the Milky Way), and the Milky Way
// itself, painted once at startup into a cube map in galactic coordinates:
// the bright bulge toward Sagittarius, the star clouds along the disc, the
// Great Rift of dust that splits it, dark nebulae and a little pink
// emission. Both turn with real local sidereal time for the date and the
// clock, at the trailhead's latitude, so the galactic centre stands low in
// the south on a September evening and the band runs overhead from Cygnus
// to Cassiopeia, as it does from the Medicine Bow Mountains.

const LAT = 40.65 * Math.PI / 180;
const EPS = 23.4393 * Math.PI / 180;

// equatorial (J2000) -> galactic. The standard matrix has x toward the galactic centre, y toward l = 90 and z toward the
// galactic pole; the shaders want the pole up (y), so the last two rows are swapped (a lookup by direction doesn't care
// about handedness, and l and b stay true)
const TO_GALACTIC = new THREE.Matrix3().set(
  -0.0548755604, -0.8734370902, -0.4838350155,
  -0.8676661490, -0.1980763734, 0.4559837762,
  0.4941094279, -0.4448296300, 0.7469822445);

/** Local sidereal angle (radians): the sun's right ascension for the day plus its hour angle for the clock. */
export function siderealAngle(doy, hour, noon) {
  const d = doy;
  const g = (357.528 + 0.9856003 * d) * Math.PI / 180;
  const L = (280.46 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const ra = Math.atan2(Math.cos(EPS) * Math.sin(L), Math.cos(L));
  return ra + (hour - noon) * 15 * Math.PI / 180;
}

const NOISE = /* glsl */ `
float h13(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p, int oct) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * vn(p); p = p * 2.03 + 1.7; a *= 0.5; }
  return s / (1.0 - pow(0.5, float(oct)));
}
`;

// the baked Milky Way, in galactic coordinates (+x toward the galactic centre, +y the north galactic pole);
// radiance is stored square-rooted so eight bits are enough
const MW_FRAG = /* glsl */ `
varying vec3 vP;
${NOISE}
float sq(float x) { return x * x; }   // (pow with a negative base is undefined in GLSL, and gives NaN on some GPUs)
void main() {
  vec3 g = normalize(vP);
  float b = asin(clamp(g.y, -1.0, 1.0));
  float l = atan(g.z, g.x);
  float lr = abs(l);
  float r = acos(clamp(g.x, -1.0, 1.0));                       // angle from the galactic centre
  // the band meanders, and is fatter and brighter toward the centre
  float width = mix(0.085, 0.16, smoothstep(2.4, 0.0, lr));
  float warp = (fbm(g * 3.0 + 1.7, 3) - 0.5) * 0.11 + 0.03 * sin(l * 2.0 + 0.5);
  float bb = b - warp;
  float disc = exp(-sq(bb / width));
  float broad = exp(-sq(bb / (width * 2.8))) * 0.22;     // the faint, wide halo of the disc
  // star clouds: knots of brightness along the band
  float cl = fbm(g * 7.0 + 11.0, 4);
  float clouds = smoothstep(0.28, 0.78, cl);
  float fine = fbm(g * 42.0, 4);
  float bulgeR = sqrt(l * l + sq(b * 1.8));
  float bulge = exp(-sq(bulgeR / 0.30)) * 1.5;
  float I = disc * (0.38 + 1.0 * clouds * (0.55 + 0.45 * fine)) + broad + bulge * (0.55 + 0.45 * fine);
  I *= mix(1.0, 0.42, smoothstep(1.4, 3.0, lr));              // the outer galaxy is dimmer
  // dust: the Great Rift splits the band from Cygnus through Aquila to Ophiuchus, with dark clouds along it
  float laneC = bb - 0.012 + (fbm(g * 9.0 + 3.3, 3) - 0.5) * 0.07;
  float lane = exp(-sq(laneC / 0.034));
  float riftL = smoothstep(-1.25, -0.15, l) * (1.0 - smoothstep(0.9, 1.6, l));
  float dpatch = smoothstep(0.56, 0.82, fbm(g * 13.0 + 9.0, 4)) * smoothstep(0.0, 0.5, disc + bulge * 0.4);
  float coal = smoothstep(0.62, 0.9, fbm(g * 30.0 + 4.0, 3)) * disc;   // small dark nebulae
  float dust = clamp(lane * riftL * 0.88 + dpatch * 0.6 + coal * 0.5, 0.0, 0.94);
  I *= 1.0 - dust;
  I *= 0.8 + 0.4 * fbm(g * 170.0, 2);                            // unresolved stars: grain
  // colour: yellow toward the bulge, blue-white across the disc, reddened by dust
  vec3 warm = vec3(1.0, 0.8, 0.55), cool = vec3(0.66, 0.77, 1.0);
  float wm = clamp(exp(-sq(bulgeR / 0.9)) * 1.25, 0.0, 1.0);
  vec3 col = mix(cool, warm, wm);
  col = mix(col, vec3(1.0, 0.58, 0.4), dust * 0.55);
  // a little pink emission (Lagoon, Eagle, North America) along the plane toward the centre and Cygnus
  float neb = smoothstep(0.64, 0.84, fbm(g * 22.0 + 5.5, 3)) * disc * smoothstep(-0.5, 0.3, l) * (1.0 - smoothstep(0.7, 1.2, l));
  col = mix(col, vec3(1.0, 0.42, 0.52), neb * 0.45);
  float v = I * 0.5;
  gl_FragColor = vec4(col * sqrt(max(v, 0.0)), 1.0);
}`;

const STAR_VERT = /* glsl */ `
attribute float aMag;
attribute vec3 aCol;
attribute float aSeed;
uniform mat3 uEq;
uniform float uTime, uPx, uNight;
${CLOUD_GLSL}
varying vec3 vCol;
varying float vI;
void main() {
  vec3 d = normalize(uEq * position);
  vec4 mv = modelViewMatrix * vec4(d * 500.0, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w;
  float bright = pow(10.0, -0.4 * (aMag - 1.5));
  float I = clamp(0.2 + 0.7 * pow(bright, 0.28), 0.0, 1.6);
  // twinkle, more near the horizon where the air is thick; dimmer there too
  float h = d.y;
  float tw = 1.0 - (0.12 + 0.3 * smoothstep(0.5, 0.0, h)) * (0.5 + 0.5 * sin(uTime * (2.5 + aSeed * 6.0) + aSeed * 60.0));
  I *= tw * smoothstep(-0.03, 0.22, h) * (0.55 + 0.45 * smoothstep(0.0, 0.5, h));
  // cloud in front of it
  float cloud = 0.0;
  if (h > 0.0 && uCloudCover > 0.005) {
    float dh = max(uCloudAlt - cameraPosition.y, 350.0);
    float tt = dh / max(h, 0.015);
    cloud = cloudDensity(cameraPosition.xz + d.xz * tt, 2) * smoothstep(0.0, 0.07, h);
  }
  vI = I * uNight * (1.0 - cloud);
  vCol = aCol;
  gl_PointSize = (2.0 + 2.6 * pow(clamp(bright, 0.0, 8.0), 0.3)) * uPx;
}`;

const STAR_FRAG = /* glsl */ `
varying vec3 vCol;
varying float vI;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r2 = dot(q, q) * 4.0;
  float core = exp(-r2 * 7.0);
  float halo = exp(-r2 * 2.2) * 0.22;
  float a = (core + halo) * vI;
  gl_FragColor = vec4(vCol, a);
}`;

const COLORS = [   // blue-white .. white .. yellow .. orange .. red, roughly the mix of naked-eye stars
  [0.68, 0.8, 1.0], [0.8, 0.88, 1.0], [0.95, 0.97, 1.0], [1.0, 0.96, 0.86], [1.0, 0.9, 0.7], [1.0, 0.8, 0.58], [1.0, 0.68, 0.5],
];

export class Starfield {
  constructor(renderer, count = 16000) {
    this.uniforms = {
      uEq: { value: new THREE.Matrix3() },
      uTime: { value: 0 }, uPx: { value: 1 }, uNight: { value: 0 },
      uCloudTex: atmosphere.uCloudTex, uCloudOff: atmosphere.uCloudOff, uCloudCover: atmosphere.uCloudCover, uCloudAlt: atmosphere.uCloudAlt,
    };
    this.gal = new THREE.Matrix3();          // world -> galactic, for the sky shader
    this.rt = this.#makeTarget();
    this.mw = this.rt.texture;
    this.baked = false;
    this.points = this.#stars(count);
    this._r = new THREE.Matrix3();
  }

  /** Make the cube map the Milky Way is painted into. */
  #makeTarget(size = 1024) {
    return new THREE.WebGLCubeRenderTarget(size, { type: THREE.UnsignedByteType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  }

  /** Paint the Milky Way into the cube map. Called a frame or two into the game, once the renderer is warm. */
  bake(renderer) {
    const scene = new THREE.Scene();
    const mat = new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vP; void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: MW_FRAG, side: THREE.BackSide, depthTest: false, depthWrite: false,
    });
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat));
    const prev = renderer.getRenderTarget();
    new THREE.CubeCamera(0.1, 10, this.rt).update(renderer, scene);
    renderer.setRenderTarget(prev);
    mat.dispose();
    this.baked = true;
  }

  #stars(n) {
    const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3), seed = new Float32Array(n);
    let rs = 12345;
    const rnd = () => ((rs = Math.imul(rs ^ (rs >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296);
    const A = TO_GALACTIC.elements;     // column-major
    let k = 0;
    while (k < n) {
      // uniform on the sphere, thinned away from the galactic plane so the Milky Way is richer in stars
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      const x = s * Math.cos(a), y = s * Math.sin(a);
      const gy = A[1] * x + A[4] * y + A[7] * z;       // galactic y = sin(b)
      const b = Math.asin(gy);
      if (rnd() > 0.38 + 0.62 * Math.exp(-(b * b) / 0.18)) continue;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      // magnitudes: many faint ones, a few bright (counts rise ~ 10^(0.45 m))
      const u = rnd(), m0 = -0.4, m1 = 6.8;
      mag[k] = m0 + Math.log10(1 + u * (Math.pow(10, 0.45 * (m1 - m0)) - 1)) / 0.45;
      const c = COLORS[Math.min(COLORS.length - 1, Math.floor(Math.pow(rnd(), 0.8) * COLORS.length))];
      col[k * 3] = c[0]; col[k * 3 + 1] = c[1]; col[k * 3 + 2] = c[2];
      seed[k] = rnd();
      k++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, uniforms: this.uniforms,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false, fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -0.5;
    return pts;
  }

  /** Turn the sky to this sidereal angle; `night` (0..1) is shared with the dome. */
  update(theta, camPos, pixelRatio) {
    const s = Math.sin(theta), c = Math.cos(theta), sp = Math.sin(LAT), cp = Math.cos(LAT);
    // equatorial -> world (x east, y up, z south)
    const R = this._r.set(
      -s, c, 0,
      c * cp, s * cp, sp,
      c * sp, s * sp, -cp);
    this.uniforms.uEq.value.copy(R);
    this.gal.copy(TO_GALACTIC).multiply(R.clone().transpose());   // world -> equatorial -> galactic
    this.points.position.copy(camPos);
    this.uniforms.uPx.value = pixelRatio;
  }
}
