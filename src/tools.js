import * as THREE from 'three';
import { withAtmosphere } from './atmosphere.js';

// The hand tools, built from boxes and flat extrusions: an axe and a machete.
// Each is modelled in metres with the grip at the origin, the head along +Y and
// the cutting edge toward +X, so one transform puts it in a hand (character.js)
// and another in front of the camera (props.js).

export const TOOLS = ['fists', 'axe', 'machete'];
export const TOOL_NAME = { fists: 'Bare hands', axe: 'Axe', machete: 'Machete' };

let mats = null;
function materials() {
  if (mats) return mats;
  const lit = (color, key) => {
    const m = new THREE.MeshLambertMaterial({ color });
    m.onBeforeCompile = (shader) => withAtmosphere(shader, { weather: 0.5, occlusion: 0.6 });
    m.customProgramCacheKey = () => `rawah-tool-${key}`;
    return m;
  };
  mats = { wood: lit(0x7a5632, 'wood'), steel: lit(0x9aa0a6, 'steel'), edge: lit(0xc9ced2, 'edge'), grip: lit(0x25221f, 'grip') };
  return mats;
}

/** A flat shape from [x, y] points, extruded `t` metres thick and centred on z = 0. */
function plate(points, t) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y))), { depth: t, bevelEnabled: false });
  g.translate(0, 0, -t / 2);
  return g;
}

export function buildTool(kind) {
  const m = materials(), g = new THREE.Group();
  const part = (geo, mat) => { const o = new THREE.Mesh(geo, mat); o.castShadow = true; g.add(o); return o; };
  if (kind === 'axe') {
    // a hickory haft, and a steel head with a poll behind the bit
    const haft = part(new THREE.BoxGeometry(0.034, 0.78, 0.03), m.wood);
    haft.position.y = 0.2;
    part(plate([[-0.035, 0.44], [-0.035, 0.58], [0.03, 0.58], [0.135, 0.64], [0.145, 0.37], [0.03, 0.44]], 0.032), m.steel);
    part(plate([[0.135, 0.64], [0.15, 0.505], [0.145, 0.37], [0.125, 0.4], [0.128, 0.61]], 0.034), m.edge);
  } else if (kind === 'machete') {
    // a long, broad blade with a clipped point, and a black handle
    const handle = part(new THREE.BoxGeometry(0.03, 0.14, 0.026), m.grip);
    handle.position.y = -0.02;
    part(plate([[-0.012, 0.05], [0.03, 0.055], [0.05, 0.4], [0.045, 0.5], [0.005, 0.56], [-0.012, 0.5]], 0.006), m.steel);
    part(plate([[0.03, 0.055], [0.036, 0.055], [0.056, 0.4], [0.05, 0.5], [0.044, 0.5], [0.05, 0.4]], 0.007), m.edge);
  }
  return g;
}
