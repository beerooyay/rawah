// Gameplay clips. [`] (the Guide button on a pad, the round button top right
// on touch or with the pointer free) starts and stops a recording of the game
// canvas plus the synthesized sound (tapped off `Audio.master`). Frames are
// copied each animation frame into a fixed-size 2D canvas (at most 1080 high),
// so the dynamic resolution in `main.js` never resizes the stream; the HUD is
// not in the picture. MP4/H.264 where MediaRecorder can, otherwise WebM.
//
// Clips live in IndexedDB (`rawah-clips`), best effort: if storage fails they
// stay in memory for the session. The viewer trims (drag the ends), splits at
// the playhead and cuts pieces out; edits are kept with the clip, and the
// download re-records the kept ranges in real time from a hidden video
// element (canvas + MediaElementSource into a second MediaRecorder).

import { keyCap } from './hud.js';

const DB = 'rawah-clips', STORE = 'clips';
const MAX_SEC = 600;          // a recording stops itself after ten minutes
const OUT_H = 1080;
const VBR = 14e6, ABR = 160000;
const POP_MS = 6000;          // how long the saved-clip thumbnail stays
const STRIP = 10;             // frames in the viewer's filmstrip

const $ = (s, el = document) => el.querySelector(s);
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const once = (el, ev, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => { el.removeEventListener(ev, ok); rej(new Error(`${ev} timeout`)); }, ms);
  const ok = () => { clearTimeout(t); res(); };
  el.addEventListener(ev, ok, { once: true });
});
const fmt = (s) => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtFine = (s) => `${fmt(s)}.${Math.floor(((s || 0) % 1) * 10)}`;
const when = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const mb = (b) => b > 1e6 ? `${(b / 1e6).toFixed(b > 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
const ICON = {
  play: '<svg viewBox="0 0 16 16"><path d="M5 3.2v9.6L12.6 8z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><path d="M5.4 3.5v9M10.6 3.5v9"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13"/></svg>',
};

function pickMime(withAudio) {
  if (!window.MediaRecorder) return '';
  const list = withAudio
    ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || '';
}
const extOf = (mime) => (mime.includes('mp4') ? 'mp4' : 'webm');

// ------------------------------------------------------------ storage (best effort)
let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => res(req?.result);
    tx.onerror = tx.onabort = () => rej(tx.error);
  });
}

export class Recorder {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas the WebGL canvas
   * @param {object} o.audio `Audio` from audio.js (its `ctx` and `master` may appear later)
   * @param {object} o.hud for toasts and the input mode
   * @param {() => void} o.pause pause the game (the viewer opens over it)
   * @param {() => void} o.resume back to the game (the gallery's record button)
   */
  constructor({ canvas, audio, hud, pause, resume }) {
    Object.assign(this, { canvas, audio, hud, pauseGame: pause, resumeGame: resume });
    this.mr = null;
    this.clips = [];          // newest first; blobs included
    this.loaded = false;
    this.view = null;         // the viewer's state while it is open
    this.#build();
  }

  get recording() { return !!this.mr; }

  toggle() { if (this.mr) this.stop(); else this.start(); }

  // ---------------------------------------------------------- recording
  start() {
    if (this.mr || this.busy) return;
    const src = this.canvas;
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { this.hud.toast('Recording is not supported in this browser', 'warn'); return; }
    const k = Math.min(1, OUT_H / src.height);
    const frame = document.createElement('canvas');
    frame.width = even(src.width * k); frame.height = even(src.height * k);
    const g = frame.getContext('2d', { alpha: false });
    g.drawImage(src, 0, 0, frame.width, frame.height);
    const stream = frame.captureStream(60);
    const { ctx, master } = this.audio;
    if (ctx && master) {
      try {
        this.tap = ctx.createMediaStreamDestination();
        master.connect(this.tap);
        for (const t of this.tap.stream.getAudioTracks()) stream.addTrack(t);
      } catch { this.tap = null; }
    }
    const mime = pickMime(!!this.tap);
    let mr;
    try { mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VBR, audioBitsPerSecond: ABR }); } catch {
      try { mr = new MediaRecorder(stream); } catch { this.hud.toast('Could not start recording', 'warn'); this.#untap(); return; }
    }
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => this.#finish(chunks, mr.mimeType || mime, stream, frame);
    mr.start(1000);
    this.mr = mr; this.frame = frame; this.t0 = performance.now();
    // registered after the game loop's own frame callback, so the drawing buffer still holds this frame
    const pump = () => {
      if (this.mr !== mr) return;
      g.drawImage(src, 0, 0, frame.width, frame.height);
      this.raf = requestAnimationFrame(pump);
    };
    this.raf = requestAnimationFrame(pump);
    this.clock = setInterval(() => this.#tickLabel(), 250);
    this.#tickLabel();
    this.recBtn.classList.add('on');
    this.recBtn.setAttribute('aria-label', 'Stop recording');
  }

  stop() {
    if (!this.mr) return;
    const mr = this.mr;
    this.duration = (performance.now() - this.t0) / 1000;
    this.mr = null; this.busy = true;
    cancelAnimationFrame(this.raf); clearInterval(this.clock);
    this.recBtn.classList.remove('on');
    this.recBtn.setAttribute('aria-label', 'Record a clip');
    $('.rec-t', this.recBtn).textContent = '';
    try { mr.stop(); } catch { this.busy = false; }
  }

  #tickLabel() {
    const s = (performance.now() - this.t0) / 1000;
    $('.rec-t', this.recBtn).textContent = fmt(s);
    if (s >= MAX_SEC) this.stop();
  }

  #untap() {
    if (!this.tap) return;
    try { this.audio.master.disconnect(this.tap); } catch { /* already gone */ }
    this.tap = null;
  }

  async #finish(chunks, mime, stream, frame) {
    this.#untap();
    for (const t of stream.getTracks()) t.stop();
    const blob = new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' });
    this.busy = false;
    if (!blob.size) { this.hud.toast('Nothing was recorded', 'warn'); return; }
    const thumb = await this.#thumbFrom(frame);
    const clip = { id: `c${Date.now().toString(36)}`, created: Date.now(), duration: this.duration, mime: blob.type, size: blob.size, w: frame.width, h: frame.height, blob, thumb, edit: null };
    this.clips.unshift(clip);
    const stored = await this.#put(clip);
    if (!stored) this.hud.toast('Clip kept for this session only (storage unavailable)', 'warn');
    this.#pop(clip);
    if (this.galleryEl && !this.galleryEl.closest('.hidden')) this.gallery(this.galleryEl);
  }

  #thumbFrom(frame) {
    const c = document.createElement('canvas');
    c.width = 480; c.height = even(480 * frame.height / frame.width);
    c.getContext('2d').drawImage(frame, 0, 0, c.width, c.height);
    return new Promise((res) => { try { c.toBlob((b) => res(b), 'image/jpeg', 0.85); } catch { res(null); } });
  }

  async #put(clip) { try { await idb('readwrite', (s) => s.put(clip)); return true; } catch { return false; } }

  async #load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const all = (await idb('readonly', (s) => s.getAll())) || [];
      const have = new Set(this.clips.map((c) => c.id));
      for (const c of all) if (!have.has(c.id)) this.clips.push(c);
      this.clips.sort((a, b) => b.created - a.created);
    } catch { /* no storage: only this session's clips */ }
  }

  async remove(clip) {
    this.clips = this.clips.filter((c) => c !== clip);
    try { await idb('readwrite', (s) => s.delete(clip.id)); } catch { /* memory only */ }
    if (this.popClip === clip) this.pop.classList.remove('show');
  }

  // ---------------------------------------------------------- DOM
  #build() {
    const rec = this.recBtn = document.createElement('button');
    rec.id = 'rec';
    rec.className = 'glass-btn';
    rec.setAttribute('aria-label', 'Record a clip');
    rec.title = 'Record a clip';
    rec.innerHTML = '<i></i><span class="rec-t"></span>';
    rec.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    rec.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });

    const pop = this.pop = document.createElement('button');
    pop.id = 'clip-pop';
    pop.className = 'glass';
    pop.innerHTML = '<img alt="" /><span class="cp-text"><b>Clip saved</b><small></small></span>';
    pop.onclick = () => { if (this.popClip) { pop.classList.remove('show'); this.open(this.popClip); } };
    pop.onpointerenter = () => clearTimeout(this.popTimer);
    pop.onpointerleave = () => { if (pop.classList.contains('show')) this.popTimer = setTimeout(() => pop.classList.remove('show'), 2500); };

    const vw = this.viewer = document.createElement('div');
    vw.id = 'viewer';
    vw.className = 'screen hidden';
    vw.innerHTML = `
      <div class="sheet glass vw-sheet" role="dialog" aria-label="Clip">
        <header class="sheet-head">
          <div><div class="kicker vw-when"></div><h2>Clip</h2></div>
          <button class="round ghost vw-close" aria-label="Close">${ICON.close}</button>
        </header>
        <div class="vw-body">
          <div class="vw-stage"><video playsinline preload="auto"></video></div>
          <div class="vw-track">
            <canvas class="vw-strip"></canvas>
            <div class="vw-segs"></div>
            <div class="vw-shade l"></div><div class="vw-shade r"></div>
            <div class="vw-handle l" aria-label="Trim start"></div><div class="vw-handle r" aria-label="Trim end"></div>
            <div class="vw-head"></div>
          </div>
          <div class="vw-bar">
            <button class="round vw-play" aria-label="Play">${ICON.play}</button>
            <span class="vw-time"></span>
            <span class="vw-tools">
              <button class="vw-split">Split</button>
              <button class="vw-cut">Cut piece</button>
              <button class="ghost vw-reset">Reset</button>
            </span>
          </div>
          <p class="vw-hint"></p>
        </div>
        <footer class="sheet-foot">
          <button class="primary vw-dl">Download</button>
          <span class="vw-keeps"></span>
          <button class="ghost danger vw-del">Delete</button>
        </footer>
      </div>`;
    document.body.append(rec, pop, vw);
    this.#wireViewer();
  }

  #pop(clip) {
    const p = this.pop;
    if (this.popURL) URL.revokeObjectURL(this.popURL);
    this.popURL = clip.thumb ? URL.createObjectURL(clip.thumb) : '';
    $('img', p).src = this.popURL;
    $('small', p).textContent = `${fmt(clip.duration)} · ${document.pointerLockElement ? 'Clips in the menu' : 'Click to watch'}`;
    this.popClip = clip;
    p.classList.remove('show'); void p.offsetWidth; p.classList.add('show');
    clearTimeout(this.popTimer);
    this.popTimer = setTimeout(() => p.classList.remove('show'), POP_MS);
  }

  // ---------------------------------------------------------- gallery (pause menu, Clips tab)
  async gallery(el) {
    this.galleryEl = el;
    await this.#load();
    for (const u of this.galleryURLs || []) URL.revokeObjectURL(u);
    this.galleryURLs = [];
    const mode = this.hud.mode;
    const how = mode === 'pad' ? '<span class="key pad">Guide</span>' : mode === 'touch' ? 'the record button' : keyCap('`', 'kbm');
    const cards = this.clips.map((c, i) => {
      const u = c.thumb ? URL.createObjectURL(c.thumb) : '';
      if (u) this.galleryURLs.push(u);
      const len = c.edit ? keptLength(c.edit, c.duration) : c.duration;
      return `<article class="clip-card" data-i="${i}">
        <button class="cc-open" aria-label="Watch clip from ${when(c.created)}">${u ? `<img src="${u}" alt="" />` : ''}<span class="cc-dur">${fmt(len)}</span></button>
        <div class="cc-meta"><span>${when(c.created)}</span><small>${c.edit ? 'Edited · ' : ''}${mb(c.size)}</small></div>
        <button class="ghost danger cc-del">Delete</button>
      </article>`;
    }).join('');
    el.innerHTML = `<div class="clips-head"><p>Press ${how} while hiking to record. Clips stay in this browser.</p><button class="primary clips-rec">Record a clip</button></div>
      ${cards ? `<div class="clips-grid">${cards}</div>` : '<p class="clips-empty">No clips yet.</p>'}`;
    $('.clips-rec', el).onclick = () => { this.resumeGame?.(); this.start(); };
    for (const card of el.querySelectorAll('.clip-card')) {
      const clip = this.clips[Number(card.dataset.i)];
      $('.cc-open', card).onclick = () => this.open(clip);
      const del = $('.cc-del', card);
      del.onclick = async () => {
        if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = 'Delete for good?'; return; }
        await this.remove(clip);
        this.gallery(el);
      };
    }
  }

  // ---------------------------------------------------------- viewer
  async open(clip) {
    if (this.view) this.close();
    this.pauseGame?.();
    if (document.pointerLockElement) document.exitPointerLock();
    const vw = this.viewer, video = $('video', vw);
    const url = URL.createObjectURL(clip.blob);
    const v = this.view = { clip, url, dur: clip.duration, sel: -1, edit: clip.edit ? { ...clip.edit, splits: [...clip.edit.splits], cut: [...clip.edit.cut] } : null };
    $('.vw-when', vw).textContent = when(clip.created);
    this.#armDelete(false);
    vw.classList.remove('hidden');
    video.src = url;
    try {
      await once(video, 'loadedmetadata');
      if (!Number.isFinite(video.duration)) {   // MediaRecorder WebM carries no duration: seek far to make the browser find it
        video.currentTime = 1e9;
        await once(video, 'durationchange').catch(() => {});
        video.currentTime = 0;
      }
    } catch { /* keep the measured length */ }
    if (this.view !== v) return;
    if (Number.isFinite(video.duration) && video.duration > 0) v.dur = video.duration;
    v.edit ||= { a: 0, b: v.dur, splits: [], cut: [] };
    v.edit.b = Math.min(v.edit.b, v.dur);
    this.#render();
    this.#strip(url, v);
  }

  close() {
    const v = this.view;
    if (!v) return;
    const video = $('video', this.viewer);
    video.pause(); video.removeAttribute('src'); video.load();
    URL.revokeObjectURL(v.url);
    cancelAnimationFrame(v.raf);
    v.closed = true;
    this.view = null;
    this.viewer.classList.add('hidden');
    // keep the edit with the clip (null when it is the whole clip again)
    const e = v.edit;
    const whole = e && e.a <= 0.01 && e.b >= v.dur - 0.01 && !e.cut.length;
    const next = whole ? null : e;
    if (JSON.stringify(next) !== JSON.stringify(v.clip.edit)) { v.clip.edit = next; this.#put(v.clip); }
    if (this.galleryEl && !this.galleryEl.closest('.hidden')) this.gallery(this.galleryEl);
  }

  /** Gamepad: Guide records; in the viewer A plays, X splits, Y cuts, left/right seek, B closes. Returns true when used. */
  pad(name) {
    if (!this.view) {
      if (name === 'Guide') { this.toggle(); return true; }
      return false;
    }
    const video = $('video', this.viewer);
    if (name === 'A') this.#playToggle();
    else if (name === 'B' || name === 'Start') this.close();
    else if (name === 'X') this.#split();
    else if (name === 'Y') this.#cut();
    else if (name === 'Left' || name === 'Right') this.#seek(video.currentTime + (name === 'Right' ? 1 : -1));
    return true;
  }

  #wireViewer() {
    const vw = this.viewer, video = $('video', vw), track = $('.vw-track', vw);
    $('.vw-close', vw).onclick = () => this.close();
    vw.addEventListener('pointerdown', (e) => { if (e.target === vw) this.close(); });
    $('.vw-play', vw).onclick = () => this.#playToggle();
    video.onclick = () => this.#playToggle();
    $('.vw-split', vw).onclick = () => this.#split();
    $('.vw-cut', vw).onclick = () => this.#cut();
    $('.vw-reset', vw).onclick = () => { const v = this.view; if (!v) return; v.edit = { a: 0, b: v.dur, splits: [], cut: [] }; v.sel = -1; this.#render(); };
    $('.vw-dl', vw).onclick = () => this.#download();
    $('.vw-del', vw).onclick = async () => {
      const v = this.view;
      if (!v) return;
      if (!this.delArmed) { this.#armDelete(true); return; }
      const clip = v.clip;
      v.edit = clip.edit;   // nothing to save
      this.close();
      await this.remove(clip);
      if (this.galleryEl) this.gallery(this.galleryEl);
    };
    video.addEventListener('play', () => this.#follow());
    video.addEventListener('pause', () => this.#render());
    video.addEventListener('seeked', () => this.#render());

    // the track: drag a trim handle, or press anywhere else to scrub and pick the piece under it
    const at = (e) => { const r = track.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (this.view?.dur || 0); };
    track.addEventListener('pointerdown', (e) => {
      const v = this.view;
      if (!v) return;
      e.preventDefault();
      track.setPointerCapture(e.pointerId);
      const h = e.target.closest('.vw-handle');
      const drag = h ? (h.classList.contains('l') ? 'a' : 'b') : 'head';
      const move = (ev) => {
        const t = at(ev);
        if (drag === 'a') { v.edit.a = Math.min(t, v.edit.b - 0.2); this.#seek(v.edit.a, true); }
        else if (drag === 'b') { v.edit.b = Math.max(t, v.edit.a + 0.2); this.#seek(v.edit.b, true); }
        else { this.#seek(t, true); v.sel = pieceAt(v.edit, v.dur, t); }
        this.#render();
      };
      move(e);
      const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('pointercancel', up); };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });

    // keys while the viewer is open never reach the game
    addEventListener('keydown', (e) => {
      if (!this.view) return;
      const video2 = video;
      const used = {
        Space: () => this.#playToggle(), KeyK: () => this.#playToggle(), Escape: () => this.close(),
        KeyS: () => this.#split(), Delete: () => this.#cut(), Backspace: () => this.#cut(), KeyX: () => this.#cut(),
        ArrowLeft: () => this.#seek(video2.currentTime - (e.shiftKey ? 5 : 1)), ArrowRight: () => this.#seek(video2.currentTime + (e.shiftKey ? 5 : 1)),
      }[e.code];
      if (e.target.tagName === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) { e.stopImmediatePropagation(); return; }
      e.stopImmediatePropagation();
      if (used) { e.preventDefault(); if (!e.repeat || e.code.startsWith('Arrow')) used(); }
    }, true);
  }

  #armDelete(on) {
    this.delArmed = on;
    $('.vw-del', this.viewer).textContent = on ? 'Delete for good?' : 'Delete';
  }

  #seek(t, quiet) {
    const v = this.view;
    if (!v) return;
    const video = $('video', this.viewer);
    video.currentTime = Math.min(Math.max(0, t), v.dur - 0.01);
    if (!quiet) this.#render();
  }

  #playToggle() {
    const v = this.view;
    if (!v) return;
    const video = $('video', this.viewer);
    if (!video.paused) { video.pause(); return; }
    const ranges = kept(v.edit, v.dur);
    if (!ranges.length) return;
    const t = video.currentTime;
    if (!ranges.some(([a, b]) => t >= a && t < b - 0.05)) video.currentTime = (ranges.find(([a]) => a > t) || ranges[0])[0];
    video.play().catch(() => {});
  }

  /** While playing, skip the parts that are cut and stop at the end of what is kept. */
  #follow() {
    const v = this.view;
    if (!v) return;
    const video = $('video', this.viewer);
    cancelAnimationFrame(v.raf);
    const step = () => {
      if (this.view !== v || video.paused) return;
      const ranges = kept(v.edit, v.dur), t = video.currentTime;
      if (!ranges.some(([a, b]) => t >= a - 0.02 && t < b)) {
        const next = ranges.find(([a]) => a > t);
        if (next) video.currentTime = next[0];
        else { video.pause(); video.currentTime = ranges[0]?.[0] || 0; }
      }
      this.#render();
      v.raf = requestAnimationFrame(step);
    };
    v.raf = requestAnimationFrame(step);
  }

  #split() {
    const v = this.view;
    if (!v) return;
    const t = $('video', this.viewer).currentTime, e = v.edit;
    if (t <= e.a + 0.1 || t >= e.b - 0.1 || e.splits.some((s) => Math.abs(s - t) < 0.1)) return;
    const i = pieceAt(e, v.dur, t);
    const wasCut = e.cut.includes(pieceStart(e, i));
    e.splits = [...e.splits, t].sort((x, y) => x - y);
    if (wasCut) e.cut.push(t);   // both halves of a cut piece stay cut
    v.sel = pieceAt(e, v.dur, t);
    this.#render();
  }

  #cut() {
    const v = this.view;
    if (!v) return;
    const e = v.edit;
    if (v.sel < 0) v.sel = pieceAt(e, v.dur, $('video', this.viewer).currentTime);
    const s = pieceStart(e, v.sel);
    if (e.cut.includes(s)) e.cut = e.cut.filter((x) => x !== s);
    else if (pieces(e, v.dur).length > 1) e.cut.push(s);
    else return;
    this.#render();
  }

  #render() {
    const v = this.view;
    if (!v) return;
    const vw = this.viewer, video = $('video', vw), e = v.edit || { a: 0, b: v.dur, splits: [], cut: [] }, D = v.dur || 1;
    const pct = (t) => `${(t / D) * 100}%`;
    const ps = pieces(e, v.dur);
    $('.vw-segs', vw).innerHTML = ps.map(([a, b], i) => `<i class="${e.cut.includes(a) ? 'cut' : ''} ${i === v.sel ? 'sel' : ''}" style="left:${pct(a)};width:${pct(b - a)}"></i>`).join('');
    $('.vw-shade.l', vw).style.width = pct(e.a);
    $('.vw-shade.r', vw).style.width = pct(D - e.b);
    $('.vw-handle.l', vw).style.left = pct(e.a);
    $('.vw-handle.r', vw).style.left = pct(e.b);
    $('.vw-head', vw).style.left = pct(video.currentTime || 0);
    $('.vw-time', vw).textContent = `${fmtFine(video.currentTime)} / ${fmtFine(v.dur)}`;
    const playing = !video.paused;
    const play = $('.vw-play', vw);
    play.innerHTML = playing ? ICON.pause : ICON.play;
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const selCut = v.sel >= 0 && e.cut.includes(pieceStart(e, v.sel));
    $('.vw-cut', vw).textContent = selCut ? 'Keep piece' : 'Cut piece';
    $('.vw-cut', vw).disabled = ps.length < 2 && !selCut;
    const len = keptLength(e, v.dur);
    const edited = len < v.dur - 0.05;
    $('.vw-keeps', vw).textContent = edited ? `Keeps ${fmt(len)} of ${fmt(v.dur)}` : `${fmt(v.dur)} · ${mb(v.clip.size)}`;
    if (!this.exporting) $('.vw-dl', vw).textContent = edited ? 'Download edit' : 'Download';
    const mode = this.hud.mode;
    $('.vw-hint', vw).innerHTML = mode === 'pad'
      ? '<span class="key pad a">A</span> play · <span class="key pad x">X</span> split · <span class="key pad y">Y</span> cut the piece · <span class="key pad">◀ ▶</span> seek · <span class="key pad b">B</span> close'
      : `Drag the ends to trim. Split at the playhead, pick a piece and cut it. ${mode === 'touch' ? '' : `${keyCap('Space', 'kbm')} play · ${keyCap('S', 'kbm')} split · ${keyCap('X', 'kbm')} cut`}`;
  }

  /** A row of frames behind the track, from a second, silent video element. Best effort. */
  async #strip(url, v) {
    const c = $('.vw-strip', this.viewer);
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * devicePixelRatio)); c.height = Math.max(1, Math.round(r.height * devicePixelRatio));
    const g = c.getContext('2d');
    g.fillStyle = '#151a22'; g.fillRect(0, 0, c.width, c.height);
    const vid = document.createElement('video');
    vid.muted = true; vid.preload = 'auto'; vid.src = url;
    try {
      await once(vid, 'loadeddata');
      const cw = c.width / STRIP;
      for (let i = 0; i < STRIP; i++) {
        if (this.view !== v) break;
        vid.currentTime = Math.min(v.dur - 0.05, (i + 0.5) * v.dur / STRIP);
        await once(vid, 'seeked', 2500);
        const s = Math.max(cw / vid.videoWidth, c.height / vid.videoHeight);
        const w = vid.videoWidth * s, h = vid.videoHeight * s;
        g.save(); g.beginPath(); g.rect(i * cw, 0, cw, c.height); g.clip();
        g.drawImage(vid, i * cw + (cw - w) / 2, (c.height - h) / 2, w, h);
        g.restore();
      }
    } catch { /* plain track */ }
    vid.removeAttribute('src'); vid.load();
  }

  async #download() {
    const v = this.view;
    if (!v || this.exporting) return;
    const clip = v.clip, ranges = kept(v.edit, v.dur);
    const whole = ranges.length === 1 && ranges[0][0] <= 0.05 && ranges[0][1] >= v.dur - 0.05;
    let blob = clip.blob;
    if (!whole) {
      const btn = $('.vw-dl', this.viewer);
      this.exporting = true;
      $('video', this.viewer).pause();
      btn.disabled = true;
      try {
        blob = await this.#export(v.url, ranges, clip, (f) => { btn.textContent = `Making the edit ${Math.round(f * 100)}%`; });
      } catch (err) {
        console.warn('clip export failed', err);
        this.hud.toast('Could not make the edit', 'warn');
        blob = null;
      }
      this.exporting = false;
      btn.disabled = false;
      this.#render();
      if (!blob) return;
    }
    const d = new Date(clip.created), p2 = (n) => String(n).padStart(2, '0');
    const name = `rawah-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${whole ? '' : '-edit'}.${extOf(blob.type || clip.mime)}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    this.lastExport = { name, size: blob.size, type: blob.type, blob };
  }

  /** Re-record the kept ranges in real time: seek, play, copy frames to a canvas, pause the recorder over each jump. */
  async #export(url, ranges, clip, progress) {
    const vid = document.createElement('video');
    vid.className = 'vw-ghost';
    vid.playsInline = true; vid.preload = 'auto'; vid.src = url;
    document.body.append(vid);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    let mr;
    try {
      await once(vid, 'loadedmetadata');
      const c = document.createElement('canvas');
      c.width = vid.videoWidth || clip.w || 1280; c.height = vid.videoHeight || clip.h || 720;
      const g = c.getContext('2d', { alpha: false });
      const stream = c.captureStream(60);
      const dst = ac.createMediaStreamDestination();
      ac.createMediaElementSource(vid).connect(dst);   // not to the speakers
      await ac.resume();
      for (const t of dst.stream.getAudioTracks()) stream.addTrack(t);
      const mime = pickMime(true);
      try { mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VBR, audioBitsPerSecond: ABR }); } catch { mr = new MediaRecorder(stream); }
      const chunks = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const total = ranges.reduce((s, [a, b]) => s + b - a, 0);
      let done = 0;
      for (const [a, b] of ranges) {
        vid.currentTime = a;
        await once(vid, 'seeked', 6000);
        g.drawImage(vid, 0, 0, c.width, c.height);
        if (mr.state === 'inactive') mr.start(1000); else mr.resume();
        await vid.play();
        await new Promise((res) => {
          const step = () => {
            g.drawImage(vid, 0, 0, c.width, c.height);
            progress(Math.min(1, (done + Math.max(0, vid.currentTime - a)) / total));
            if (vid.currentTime >= b - 0.01 || vid.ended || vid.paused) { vid.pause(); res(); return; }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        });
        mr.pause();
        done += b - a;
      }
      mr.resume();
      await new Promise((res) => { mr.onstop = res; mr.stop(); });
      for (const t of stream.getTracks()) t.stop();
      return new Blob(chunks, { type: (mr.mimeType || mime).split(';')[0] });
    } finally {
      if (mr && mr.state !== 'inactive') try { mr.stop(); } catch { /* done */ }
      vid.pause(); vid.remove();
      ac.close().catch(() => {});
    }
  }
}

// ------------------------------------------------------------ edit decision list
// edit = { a, b: trim in/out; splits: sorted split times; cut: start times of the pieces taken out }
function pieces(e, dur) {
  const cuts = [0, ...e.splits, dur];
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) out.push([cuts[i], cuts[i + 1]]);
  return out;
}
function pieceAt(e, dur, t) { const ps = pieces(e, dur); const i = ps.findIndex(([a, b]) => t >= a && t < b); return i < 0 ? ps.length - 1 : i; }
function pieceStart(e, i) { return i <= 0 ? 0 : e.splits[i - 1]; }
/** The kept time ranges, trimmed and merged. */
function kept(e, dur) {
  const out = [];
  for (const [a0, b0] of pieces(e, dur)) {
    if (e.cut.includes(a0)) continue;
    const a = Math.max(a0, e.a), b = Math.min(b0, e.b);
    if (b - a < 0.05) continue;
    const last = out[out.length - 1];
    if (last && a - last[1] < 0.01) last[1] = b; else out.push([a, b]);
  }
  return out;
}
function keptLength(e, dur) { return kept(e, dur).reduce((s, [a, b]) => s + b - a, 0); }
