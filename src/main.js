// src/main.js
// The product page: the three-body toy inside a retro handheld. Tap the screen to place three
// stars (or press RANDOM), press RUN, and watch gravity resolve them into a COLLAPSE (two stars
// collide) or a BREAKAWAY (one star is flung out and the camera settles on the pair that's left).
//
// All simulation visuals -- starfield, star sprites, trails, chase camera, pair zoom, COLLAPSE
// flare burst -- come from src/simCore.js, the same module the debug harness (debug.html) uses,
// so the two can't drift apart. This file only owns the device's buttons and the in-screen text.
//
// Easter egg: the D-pad looks decorative, but entering one of the sequences in DPAD_CODES
// (by tapping the pad's quadrants, or with the arrow keys) plays one of the debug harness's
// experimental orbit presets (see src/presetRunner.js). Nothing on the page mentions this.

import './style.css';
import { simulate, isValidPlacement, getPlaybackSchedule, constants } from './physics/index.js';
import {
  STAR_DEFS,
  CAMERA_TRANSITION_SECONDS,
  createSimView,
  prepareRun,
  runEndSeconds,
  randomValidPlacement,
} from './simCore.js';
import {
  ALL_PRESETS,
  preparePresetRun,
  drawPresetGhost,
  presetKindText,
  presetProgress,
  presetSummary,
} from './presetRunner.js';

const { MIN_SEPARATION } = constants;

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const screenEl = $('screen');
const statusEl = $('status');
const bannerEl = $('banner');
const bannerTitle = $('bannerTitle');
const bannerSub = $('bannerSub');
const led = $('led');
const runBtn = $('runBtn');
const randomBtn = $('randomBtn');
const clearBtn = $('clearBtn');
const dpad = $('dpad');
const dpadWell = $('dpadWell');

// A preset run draws its published pattern's faint "ghost" under the trails, as in the harness.
const view = createSimView(canvas, {
  underlay: (run, camera, tSeconds) => {
    if (run.preset) drawPresetGhost(view, run, camera, tSeconds);
  },
});

/** 'place' (tapping stars in) | 'computing' | 'playing' | 'done' */
let phase = 'place';
let placed = []; // normalized [x, y] positions, up to 3
let placedPreset = null; // set while `placed` holds a hidden preset (RUN then replays it)
let current = null; // the prepared run being shown
let revealed = false; // has this run's outcome banner been shown yet
let runToken = 0; // bumped by every new run / clear, so a superseded pending run never starts
let liveStatusHtml = ''; // last live preset status written, to skip redundant DOM writes
let toastTimer = null;

const OUTCOME_TEXT = {
  COLLAPSE: { title: 'COLLAPSE', sub: 'TWO STARS COLLIDED' },
  BREAKAWAY: { title: 'BREAKAWAY', sub: 'ONE STAR ESCAPED' },
};

const isReady = () => placedPreset !== null || (placed.length === 3 && isValidPlacement(placed, MIN_SEPARATION));

// ------------------------------------------------------------------ canvas sizing

/** Keep the canvas exactly filling the (square) screen, at full device-pixel resolution. */
function fitCanvas() {
  const size = screenEl.clientWidth;
  if (!size) return;
  if (view.setDisplaySize(size)) redraw();
}

/** Repaint whatever the screen should currently show (after a resize wiped the canvas). */
function redraw() {
  if (phase === 'done' && current) view.drawFrame(current, runEndSeconds(current));
  else if (phase === 'playing') return; // the next animation frame repaints
  else view.drawIdle(placed);
}

new ResizeObserver(fitCanvas).observe(screenEl);

// ------------------------------------------------------------------ in-screen text

function starDots() {
  return `<div class="dots">${STAR_DEFS.map((d, i) => {
    const cls = i < placed.length ? 'on' : i === placed.length ? 'next' : '';
    return `<i class="dot ${cls}" style="--c:${d.core}"></i>`;
  }).join('')}</div>`;
}

function renderStatus() {
  if (toastTimer) return; // a short-lived message is showing; it re-renders when it ends
  let html = '';
  if (phase === 'place') {
    if (placed.length === 0) {
      html = `${starDots()}<div>TAP TO PLACE 3 STARS</div><div class="muted">OR PRESS RANDOM</div>`;
    } else if (placed.length < 3) {
      html = `${starDots()}<div>PLACE STAR ${placed.length + 1} OF 3</div>`;
    } else {
      html = `${starDots()}<div class="blink">PRESS RUN</div>`;
    }
  } else if (phase === 'playing' && current && current.preset) {
    html = liveStatusHtml;
  } else if (phase === 'done') {
    const held = current && current.preset ? presetSummary(current).held : null;
    html =
      (held ? `<div class="muted">${held}</div>` : '') +
      `<div class="blink">PRESS RUN TO REPLAY</div><div class="muted">CLEAR FOR NEW STARS</div>`;
  }
  statusEl.innerHTML = html;
}

function toast(text) {
  clearTimeout(toastTimer);
  statusEl.innerHTML = `${phase === 'place' ? starDots() : ''}<div class="warn">${text}</div>`;
  toastTimer = setTimeout(() => {
    toastTimer = null;
    renderStatus();
  }, 1400);
}

function clearToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
}

/** Show (or swap) the banner's text, restarting its fade-in. `preset` = the smaller title size
 *  used for a preset's name. */
function setBanner(title, sub, { preset = false } = {}) {
  bannerEl.classList.remove('show');
  bannerTitle.textContent = title;
  bannerSub.textContent = sub;
  bannerEl.classList.toggle('preset', preset);
  void bannerEl.offsetWidth; // restart the transition
  bannerEl.classList.add('show');
}

function showBanner(outcome) {
  const text = OUTCOME_TEXT[outcome];
  if (!text) return;
  setBanner(text.title, text.sub);
}

function hideBanner() {
  bannerEl.classList.remove('show');
}

function updateUI() {
  const ready = isReady();
  runBtn.setAttribute('aria-disabled', String(!ready));
  runBtn.classList.toggle('ready', ready && phase === 'place');
  led.classList.toggle('busy', phase === 'playing' || phase === 'computing');
  screenEl.classList.toggle('locked', phase !== 'place' || placed.length >= 3);
  renderStatus();
}

// ------------------------------------------------------------------ actions

function place(e) {
  if (phase !== 'place' || placed.length >= 3) return;
  const pos = view.eventToPlacement(e);
  if (!pos) return;
  const next = [...placed, pos];
  if (!isValidPlacement(next, MIN_SEPARATION)) {
    // Refuse a star that would sit too close to another, instead of accepting it and making the
    // player clear all three.
    toast('TOO CLOSE - TRY AGAIN');
    return;
  }
  placed = next;
  clearToast();
  view.drawIdle(placed);
  updateUI();
}

/** Shared start of every run: stop whatever is showing, show the starting stars, and compute the
 *  run after the button press and cleared screen have painted (simulate() is synchronous --
 *  usually a few ms, up to ~1 s on a stubborn run or a stable preset). `compute` returns the
 *  prepared run; `onStart` / `onFrame` / `onEnd` hook the playback. */
function launch(compute, { onStart, onFrame, onEnd } = {}) {
  const token = ++runToken;
  clearToast();
  view.stop();
  hideBanner();
  phase = 'computing';
  current = null;
  revealed = false;
  liveStatusHtml = '';
  view.drawIdle(placed);
  updateUI();
  requestAnimationFrame(() =>
    setTimeout(() => {
      if (token !== runToken || phase !== 'computing') return; // cleared / superseded meanwhile
      current = compute();
      phase = 'playing';
      if (onStart) onStart(current);
      updateUI();
      view.play(current, {
        onFrame: (r, t) => {
          if (onFrame) onFrame(r, t);
          maybeReveal(r, t);
        },
        onEnd: (r) => {
          maybeReveal(r, Infinity);
          if (onEnd) onEnd(r);
          phase = 'done';
          updateUI();
        },
      });
    }, 0)
  );
}

function run() {
  if (phase === 'computing') return;
  if (placedPreset) {
    startPreset(placedPreset);
    return;
  }
  if (!isReady()) {
    toast(placed.length < 3 ? `PLACE ${3 - placed.length} MORE STAR${placed.length === 2 ? '' : 'S'}` : 'TOO CLOSE');
    return;
  }
  const positions = placed;
  launch(() => {
    const record = simulate(positions);
    return prepareRun(record, getPlaybackSchedule(record));
  });
}

/** Play one of the hidden experimental presets: its fixed starting stars (and velocities /
 *  masses), run exactly as the debug harness runs it. Cancels anything in progress. */
function startPreset(preset) {
  placed = preset.positions.map((p) => [p[0], p[1]]);
  placedPreset = preset;
  launch(() => preparePresetRun(preset), {
    onStart: (r) => {
      setBanner(preset.label.toUpperCase(), presetKindText(preset), { preset: true });
      updatePresetStatus(r, 0);
    },
    onFrame: updatePresetStatus,
    onEnd: (r) => {
      // A linearly stable orbit's clip ends with no outcome: say so rather than invent one.
      const { clipPeriods } = presetSummary(r);
      if (clipPeriods) setBanner('STABLE', `STILL ON THE PATTERN AFTER ${clipPeriods} PERIODS`);
    },
  });
}

/** Live preset status (period / orbit count, holding or broken), like the harness's HUD. */
function updatePresetStatus(r, t) {
  const { count, state, broken } = presetProgress(r, t);
  const html = `<div>${count}</div><div class="${broken ? 'warn' : 'ok'}">${state}</div>`;
  if (html === liveStatusHtml) return;
  liveStatusHtml = html;
  renderStatus();
}

/** Name the outcome as it happens: with the collision flash on a COLLAPSE, and part-way into the
 *  camera's move onto the surviving pair on a BREAKAWAY. (A stable preset clip has no outcome.) */
function maybeReveal(r, t) {
  const { outcome } = r.record;
  if (revealed || !outcome) return;
  const delay = outcome === 'BREAKAWAY' ? CAMERA_TRANSITION_SECONDS * 0.5 : 0.1;
  if (t >= r.schedule.resolvedAtPlaybackSeconds + delay) {
    revealed = true;
    showBanner(outcome);
  }
}

function randomRun() {
  if (phase === 'computing') return;
  view.stop();
  placed = randomValidPlacement();
  placedPreset = null;
  phase = 'place';
  run();
}

function clear() {
  runToken++;
  view.stop();
  clearToast();
  hideBanner();
  placed = [];
  placedPreset = null;
  current = null;
  phase = 'place';
  view.drawIdle(placed);
  updateUI();
}

canvas.addEventListener('click', place);
runBtn.addEventListener('click', run);
randomBtn.addEventListener('click', randomRun);
clearBtn.addEventListener('click', clear);

// ------------------------------------------------------------------ hidden D-pad codes
// Konami-style: keep the last few presses and, after each one, check whether the buffer ends
// with a code. That handles codes of different lengths and ignores any presses before a code.
// No code is a prefix, suffix or substring of another, so a shorter one can never fire while a
// longer one is being entered. Wrong or partial sequences get no feedback at all.

const DPAD_CODES = [
  { preset: 'hristov-516', seq: ['down', 'down', 'left', 'down'] },
  { preset: 'figure-eight', seq: ['down', 'up', 'down', 'up', 'left'] },
  { preset: 'broucke-a2', seq: ['right', 'left', 'right', 'left', 'down'] },
  { preset: 'broucke-a11', seq: ['right', 'right', 'left', 'left', 'down'] },
  { preset: 'hier-triple', seq: ['up', 'up', 'down', 'down', 'right'] },
].map(({ preset, seq }) => ({ seq, preset: ALL_PRESETS.find((p) => p.id === preset) }));
const DPAD_BUFFER_SIZE = Math.max(...DPAD_CODES.map((c) => c.seq.length));
let dpadBuffer = [];
let unlockTimer = null;

function dpadInput(dir) {
  dpadBuffer.push(dir);
  if (dpadBuffer.length > DPAD_BUFFER_SIZE) dpadBuffer.shift();
  const match = DPAD_CODES.find(
    ({ seq }) => dpadBuffer.length >= seq.length && seq.every((d, i) => dpadBuffer[dpadBuffer.length - seq.length + i] === d)
  );
  if (!match) return;
  dpadBuffer = [];
  acknowledgeUnlock();
  startPreset(match.preset);
}

/** A brief glow round the D-pad and a flash of the screen glass. */
function acknowledgeUnlock() {
  clearTimeout(unlockTimer);
  for (const el of [dpadWell, screenEl]) {
    el.classList.remove('unlocked');
    void el.offsetWidth; // restart the animation on a quick second unlock
    el.classList.add('unlocked');
  }
  unlockTimer = setTimeout(() => {
    dpadWell.classList.remove('unlocked');
    screenEl.classList.remove('unlocked');
  }, 950);
}

/** Which arm a press on the pad means: the quadrant (split along the diagonals) it landed in. */
function dpadDirection(e) {
  // Measured on the well (same centre as the pad), which never tilts.
  const b = dpadWell.getBoundingClientRect();
  const dx = e.clientX - (b.left + b.width / 2);
  const dy = e.clientY - (b.top + b.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'up' : 'down';
}

// Keyboard: Enter = RUN, R = RANDOM, Esc / C = CLEAR (Enter/Space on a focused button already
// clicks it, so those are left alone); the arrow keys press the D-pad.
const ARROW_DIRS = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const onButton = e.target instanceof HTMLButtonElement;
  const key = e.key.toLowerCase();
  if (ARROW_DIRS[key]) {
    e.preventDefault();
    flashDpad(ARROW_DIRS[key]);
    dpadInput(ARROW_DIRS[key]);
    return;
  }
  let btn = null;
  if (key === 'enter' && !onButton) btn = runBtn;
  else if (key === 'r') btn = randomBtn;
  else if (key === 'escape' || key === 'c') btn = clearBtn;
  if (!btn) return;
  e.preventDefault();
  flashPress(btn);
  btn.click();
});

// ------------------------------------------------------------------ tactile presses
// :active is unreliable on touch screens (and too brief to see on a quick tap), so every
// control -- functional or decorative -- gets a pointer-driven pressed state that lasts at least
// a beat.

const MIN_PRESS_MS = 110;

function pressable(el, onDown, onUp) {
  let downAt = 0;
  let upTimer = null;
  const release = () => {
    if (!downAt) return;
    const held = performance.now() - downAt;
    downAt = 0;
    clearTimeout(upTimer);
    upTimer = setTimeout(onUp, Math.max(0, MIN_PRESS_MS - held));
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    clearTimeout(upTimer);
    downAt = performance.now();
    onDown(e);
  });
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
}

function flashPress(btn) {
  btn.classList.add('is-pressed');
  setTimeout(() => btn.classList.remove('is-pressed'), MIN_PRESS_MS);
}

let dpadFlashTimer = null;
function flashDpad(dir) {
  clearTimeout(dpadFlashTimer);
  dpad.dataset.press = dir;
  dpadFlashTimer = setTimeout(() => delete dpad.dataset.press, MIN_PRESS_MS);
}

for (const btn of [runBtn, randomBtn, clearBtn, ...document.querySelectorAll('.pill')]) {
  pressable(
    btn,
    () => btn.classList.add('is-pressed'),
    () => btn.classList.remove('is-pressed')
  );
}

// The D-pad tilts toward the pressed arm and registers that direction on press-down.
pressable(
  dpad,
  (e) => {
    const dir = dpadDirection(e);
    clearTimeout(dpadFlashTimer);
    dpad.dataset.press = dir;
    dpadInput(dir);
  },
  () => delete dpad.dataset.press
);

// ------------------------------------------------------------------ boot

fitCanvas();
view.drawIdle(placed);
updateUI();
