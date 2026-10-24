// Keyboard, mouse and gamepad, folded into one state per frame. Gamepad
// buttons are mapped onto the same key codes the keyboard uses, so game code
// only ever asks "is KeyE pressed"; the sticks add analog movement (a light
// push is a slow amble) and look. Menus and the map also get the raw pad:
// named button presses (`onPad`), and the left stick and D-pad folded into
// repeating Up/Down/Left/Right like a held arrow key. Layout is the browser's
// standard mapping, which is what an Xbox controller reports.

const PAD = {
  0: 'Space',      // A: hop / lunge
  1: 'KeyE',       // B: grab rock / let go
  2: 'KeyC',       // X: pitch / pack tent
  3: 'KeyU',       // Y: ride / get off the ATV
  4: 'KeyH',       // LB: call the friends together (the together menu)
  5: 'KeyF',       // RB: campfire
  6: 'KeyZ',       // LT: rest / sleep
  7: 'ShiftLeft',  // RT: hike fast
  8: 'KeyM',       // Back: map
  9: 'Escape',     // Start: pause
  10: 'KeyK',      // L3: cook at the fire, or drop your firewood
  11: 'KeyV',      // R3: first / third person
  12: 'KeyT',      // D-pad up: tool (hands, axe, machete)
  13: 'KeyB',      // D-pad down: fish
  14: 'KeyN',      // D-pad left: roast
  15: 'KeyR',      // D-pad right: hook
};
const NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Guide'];
const DEAD = 0.14;
const REPEAT = [0.38, 0.11]; // first delay, then repeat rate for held directions

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
    this.mode = 'kbm';           // 'kbm' | 'pad' | 'touch'
    this.touchMove = [0, 0];
    this.pad = null;             // the raw Gamepad this frame, if any
    this.onPress = () => {};
    this.onPad = () => {};       // (name, stickOnly) for every pad button press, plus repeating directions
    this.dirHeld = { Up: 0, Down: 0, Left: 0, Right: 0 };
    addEventListener('keydown', (e) => {
      if (e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.usingPad = false;
      this.mode = 'kbm';
      this.keys.add(e.code);
      this.pressed.add(e.code);
      this.onPress(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    addEventListener('mousemove', (e) => {
      // pointer lock where the host allows it; otherwise hold a button and drag to look
      const dragging = e.buttons && document.body.classList.contains('playing') && e.target === element;
      if (document.pointerLockElement !== element && !dragging) return;
      this.mouse.x += e.movementX; this.mouse.y += e.movementY;
    });
    // fighting: left click punches and right click hooks, while the pointer is locked
    addEventListener('mousedown', (e) => {
      if (document.pointerLockElement !== element) return;
      const code = `Mouse${e.button}`;
      this.usingPad = false;
      this.mode = 'kbm';
      this.keys.add(code);
      this.pressed.add(code);
      this.onPress(code);
    });
    addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
  }

  /** Read the gamepad; call once per frame before reading state. */
  poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    this.padMove = [0, 0]; this.padLook = [0, 0];
    this.pad = pad || null;
    if (!pad) return;
    const ax = pad.axes;
    this.padMove = stick(ax[0] || 0, ax[1] || 0);
    this.padLook = stick(ax[2] || 0, ax[3] || 0);
    pad.buttons.forEach((b, i) => {
      const down = b.pressed || b.value > 0.5;
      const was = this.padHeld.has(i);
      if (down === was) return;
      const code = PAD[i];
      if (down) {
        this.padHeld.add(i);
        this.usingPad = true;
        this.mode = 'pad';
        if (code) { this.keys.add(code); this.pressed.add(code); }
        if (i < 12 || i > 15) this.onPad(NAMES[i]);
        if (code) this.onPress(code);
      } else {
        this.padHeld.delete(i);
        if (code && ![...this.padHeld].some((j) => PAD[j] === code)) this.keys.delete(code);
      }
    });
    // D-pad and left stick as repeating arrows, for menus and the map list
    const [mx, my] = this.padMove;
    const dirs = {
      Up: [this.padHeld.has(12), my < -0.6], Down: [this.padHeld.has(13), my > 0.6],
      Left: [this.padHeld.has(14), mx < -0.6], Right: [this.padHeld.has(15), mx > 0.6],
    };
    const now = performance.now() / 1000;
    for (const [name, [dpad, stk]] of Object.entries(dirs)) {
      const t = this.dirHeld[name];
      if (!dpad && !stk) { this.dirHeld[name] = 0; continue; }
      // second argument: true when only the stick is pushing (the map uses the stick as a cursor)
      if (!t) { this.dirHeld[name] = now + REPEAT[0]; this.onPad(name, !dpad); }
      else if (now >= t) { this.dirHeld[name] = now + REPEAT[1]; this.onPad(name, !dpad); }
    }
    if (Math.hypot(...this.padMove) + Math.hypot(...this.padLook) > 0) { this.usingPad = true; this.mode = 'pad'; }
  }

  /** Analog trigger value 0..1 (6 = LT, 7 = RT). */
  trigger(i) { return this.pad?.buttons[i]?.value || 0; }

  /** Rumble, where the browser and pad support it. */
  rumble(strong = 0.5, weak = 0.5, ms = 200) {
    try { this.pad?.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak })?.catch?.(() => {}); } catch { /* unsupported */ }
  }

  /** Movement: x right, y forward, magnitude 0..1. */
  move(out) {
    const kx = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const ky = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    out.set(kx + this.padMove[0] + this.touchMove[0], ky - this.padMove[1] - this.touchMove[1]);
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

  /**
   * Touch controls: a floating joystick wherever the left thumb lands, drag
   * anywhere on the right to look, and a few buttons mapped to key codes.
   */
  enableTouch(root) {
    document.body.classList.add('touch');
    const ui = document.createElement('div');
    ui.id = 'touch';
    // every control is an icon: movement on the left thumb, the action cluster
    // under the right, camp chores tucked low-left, menus along the top rail
    const icon = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
    const IC = {
      sprint: '<path d="M10 2 4 9h3l-2 6 8-9h-3l2-4z"/>',
      duck: '<path d="M3 7.5l5 4.5 5-4.5"/>',
      act: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2.4M8 11.8v2.4M1.8 8h2.4M11.8 8h2.4"/>',
      hop: '<path d="M8 14V3M3.6 7.4 8 3l4.4 4.4"/>',
      camp: '<path d="M2 12.5 8 3.5l6 9zM6.5 12.5 8 10l1.5 2.5"/>',
      fire: '<path d="M8 2c1 2.4 4 3.8 4 7a4 4 0 0 1-8 0c0-1.8 1.4-3.3 2.4-4.8.7.9 1.5 1 1.6-2.2z"/>',
      rest: '<path d="M12.5 2.8a5.8 5.8 0 1 0 1.7 10.6A6.8 6.8 0 0 1 12.5 2.8z"/>',
      together: '<circle cx="5.3" cy="5.5" r="1.9"/><circle cx="10.7" cy="5.5" r="1.9"/><path d="M2 12.6c0-2 1.5-3 3.3-3s3.3 1 3.3 3M6.2 12.6c.2-1.8 1.7-3 4.5-3 1.8 0 3.3 1 3.3 3"/>',
      cam: '<rect x="1.8" y="5" width="8.4" height="6.5" rx="1.4"/><path d="M10.2 8l4-2v5.5l-4-2"/>',
      tool: '<path d="M10.3 2.4a3.2 3.2 0 0 0-4.1 4.1L2.5 10.2l2.3 2.3 3.7-3.7a3.2 3.2 0 0 0 4.1-4.1l-2 2-1.8-1.8z"/>',
      map: '<path d="M5 3 8 4.4l3-1.4 3 1.5v8l-3-1.5-3 1.5-3-1.5-3 1.5v-8zM8 4.4v8.6M11 3v7.5"/>',
      pause: '<path d="M5.4 3.5v9M10.6 3.5v9"/>',
      ride: '<circle cx="12" cy="14" r="7"/><circle cx="12" cy="14" r="2.6"/><path d="M12 7v4.4M6.2 16.6l3.9-1.7M17.8 16.6l-3.9-1.7M9 4.5h6"/>',
      fish: '<path d="M3 12c2.8-3.6 6-5 9.5-5L21 4.5v15L12.5 17C9 17 5.8 15.6 3 12z"/><circle cx="9" cy="11" r="0.9"/>',
      roast: '<path d="M3.5 20.5 14 10"/><rect x="13" y="3.5" width="8" height="8" rx="2.2" transform="rotate(45 17 7.5)"/>',
      cook: '<path d="M3 7h10v4.5a2.5 2.5 0 0 1-2.5 2.5h-5A2.5 2.5 0 0 1 3 11.5zM13 8.5h1.5M5.5 2.5c.5.8-.5 1.5 0 2.5M8.5 2.5c.5.8-.5 1.5 0 2.5"/>',
      sip: '<path d="M3.5 6h7v4a3 3 0 0 1-3 3h-1a3 3 0 0 1-3-3zM10.5 7h1.2a1.6 1.6 0 0 1 0 3.2h-1.2"/>',
      drop: '<path d="M8 2.5v6M5.3 6 8 8.7 10.7 6M3 12.5h10"/>',
    };
    const btn = (code, ic, label, cls = '') => `<button data-code="${code}" class="${cls}" aria-label="${label}">${icon(IC[ic])}</button>`;
    ui.innerHTML = `
      <div class="t-stick"><i></i></div>
      <div class="t-acts">
        <div class="t-stack">${btn('ShiftLeft', 'sprint', 'Sprint', 'tog')}${btn('KeyX', 'duck', 'Duck')}</div>
        ${btn('KeyU', 'ride', 'Ride', 'mid')}
        ${btn('KeyE', 'act', 'Grab', 'mid')}
        ${btn('Space', 'hop', 'Hop', 'big')}
      </div>
      <div class="t-camp">
        ${btn('KeyC', 'camp', 'Camp')}
        ${btn('KeyF', 'fire', 'Fire')}
        ${btn('KeyZ', 'rest', 'Rest')}
        ${btn('KeyK', 'cook', 'Cook')}
        ${btn('KeyO', 'sip', 'Sip coffee')}
        ${btn('KeyJ', 'drop', 'Drop firewood')}
      </div>
      <div class="t-top">
        ${btn('KeyB', 'fish', 'Fish')}
        ${btn('KeyN', 'roast', 'Roast')}
        ${btn('KeyH', 'together', 'Together')}
        ${btn('KeyV', 'cam', 'Camera')}
        ${btn('KeyT', 'tool', 'Tool')}
        ${btn('KeyM', 'map', 'Map')}
        ${btn('Escape', 'pause', 'Menu')}
      </div>`;
    ui.querySelector('.tog').dataset.toggle = '';
    root.appendChild(ui);
    const stick = ui.querySelector('.t-stick'), knob = stick.querySelector('i');
    const R = 56;
    let stickId = null, lookId = null, ox = 0, oy = 0, lx = 0, ly = 0;
    const press = (code) => { this.mode = 'touch'; this.keys.add(code); this.pressed.add(code); this.onPress(code); };
    for (const b of ui.querySelectorAll('button')) {
      const code = b.dataset.code;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (b.dataset.toggle !== undefined) {
          const on = !this.keys.has(code);
          if (on) press(code); else this.keys.delete(code);
          b.classList.toggle('on', on);
        } else press(code);
      });
      const up = (e) => { e.preventDefault(); if (b.dataset.toggle === undefined) this.keys.delete(code); };
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
    }
    root.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || !document.body.classList.contains('playing')) return;
      this.mode = 'touch';
      if (e.clientX < innerWidth * 0.45 && stickId === null) {
        stickId = e.pointerId; ox = e.clientX; oy = e.clientY;
        stick.style.left = `${ox}px`; stick.style.top = `${oy}px`;
        stick.classList.add('on');
      } else if (lookId === null) {
        lookId = e.pointerId; lx = e.clientX; ly = e.clientY;
      }
    });
    root.addEventListener('pointermove', (e) => {
      if (e.pointerId === stickId) {
        let dx = e.clientX - ox, dy = e.clientY - oy;
        const m = Math.hypot(dx, dy);
        if (m > R) { dx *= R / m; dy *= R / m; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        this.touchMove = [dx / R, dy / R];
      } else if (e.pointerId === lookId) {
        this.mouse.x += (e.clientX - lx) * 1.9; this.mouse.y += (e.clientY - ly) * 1.9;
        lx = e.clientX; ly = e.clientY;
      }
    });
    const end = (e) => {
      if (e.pointerId === stickId) {
        stickId = null; this.touchMove = [0, 0];
        knob.style.transform = ''; stick.classList.remove('on');
      }
      if (e.pointerId === lookId) lookId = null;
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    this.touchUI = ui;
  }

  takeWheel() { const w = this.wheel; this.wheel = 0; return w; }

  endFrame() { this.pressed.clear(); }
}
