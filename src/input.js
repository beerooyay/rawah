// Keyboard, mouse and gamepad, folded into one state per frame. Gamepad
// buttons are mapped onto the same key codes the keyboard uses, so game code
// only ever asks "is KeyE pressed"; the sticks add analog movement (a light
// push is a slow amble) and look.

const PAD = {
  0: 'Space',      // A: hop / lunge
  1: 'KeyE',       // B: grab rock / let go
  2: 'KeyC',       // X: pitch / pack tent
  3: 'KeyV',       // Y: first / third person
  4: 'KeyL',       // LB: headlamp
  5: 'KeyF',       // RB: campfire
  6: 'KeyZ',       // LT: rest / sleep
  7: 'ShiftLeft',  // RT: hike fast
  8: 'KeyM',       // Back: map
  9: 'Escape',     // Start: pause
  10: 'ShiftLeft', // L3: hike fast
  11: 'KeyV',      // R3: camera
};
const DEAD = 0.14;

function stick(x, y) {
  const m = Math.hypot(x, y);
  if (m < DEAD) return [0, 0];
  const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
  return [x * k, y * k];
}

export class Input {
  constructor(element) {
    this.element = element;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouse = { x: 0, y: 0 };
    this.wheel = 0;
    this.padMove = [0, 0];
    this.padLook = [0, 0];
    this.padHeld = new Set();
    this.usingPad = false;
    this.onPress = () => {};
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.usingPad = false;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      this.onPress(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== element) return;
      this.mouse.x += e.movementX; this.mouse.y += e.movementY;
    });
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }

  /** Read the gamepad; call once per frame before reading state. */
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    this.padMove = [0, 0]; this.padLook = [0, 0];
    if (!pad) return;
    const ax = pad.axes;
    this.padMove = stick(ax[0] || 0, ax[1] || 0);
    this.padLook = stick(ax[2] || 0, ax[3] || 0);
    pad.buttons.forEach((b, i) => {
      const code = PAD[i];
      if (!code) return;
      const down = b.pressed || b.value > 0.5;
      const was = this.padHeld.has(i);
      if (down && !was) {
        this.padHeld.add(i);
        this.keys.add(code); this.pressed.add(code);
        this.usingPad = true;
        this.onPress(code);
      } else if (!down && was) {
        this.padHeld.delete(i);
        if (![...this.padHeld].some((j) => PAD[j] === code)) this.keys.delete(code);
      }
    });
    if (Math.hypot(...this.padMove) + Math.hypot(...this.padLook) > 0) this.usingPad = true;
  }

  /** Movement: x right, y forward, magnitude 0..1. */
  move(out) {
    const kx = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const ky = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    out.set(kx + this.padMove[0], ky - this.padMove[1]);
    if (out.length() > 1) out.normalize();
    return out;
  }

  /** Look deltas in radians this frame. Mouse is raw; the stick has a response curve. */
  look(dt, sens) {
    const m = 0.0022 * sens;
    const lx = this.padLook[0], ly = this.padLook[1];
    const curve = (v) => Math.sign(v) * Math.pow(Math.abs(v), 1.8);
    const out = [this.mouse.x * m + curve(lx) * 2.6 * sens * dt, this.mouse.y * m + curve(ly) * 1.8 * sens * dt];
    this.mouse.x = this.mouse.y = 0;
    return out;
  }

  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  endFrame() { this.pressed.clear(); }
}
