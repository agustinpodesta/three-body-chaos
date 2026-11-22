// src/simCore.js
// Shared rendering / camera / playback core for the three-body toy, used by BOTH the product page
// (src/main.js, index.html) and the developer harness (src/debug.js, debug.html). Everything that
// makes a run *look* the way it does lives here, once: the procedural starfield, the yellow /
// blue / red star sprites, the per-star smooth fading trails, the chase camera (auto-framing,
// then the zoom into the surviving pair on BREAKAWAY), the COLLAPSE flare burst, the
// click-to-place mapping, and the requestAnimationFrame playback loop.
//
// What is NOT here (it's page-specific): buttons, hint/status text, the debug info panel, and the
// debug harness's experimental presets with their ghost / HUD overlays. The harness plugs those in
// through the `underlay` / `overlay` hooks of createSimView().
//
// Units: all drawing is done in fixed "design pixels" -- a VIEW_W x VIEW_H surface (600 x 600,
// the size the harness has always used and every px constant below was tuned at). A page that
// shows the canvas at a different on-screen size calls setDisplaySize(cssPx); the whole scene is
// then scaled uniformly (backing store = cssPx * devicePixelRatio, so it stays crisp), i.e. it
// looks exactly the same, just bigger or smaller. At the harness's native 600 px the scale is
// exactly 1 and every draw call is identical to the pre-refactor harness.

import { isValidPlacement, constants } from './physics/index.js';
import flareGoldStreakUrl from './assets/collapse-flares/flare-gold-streak.png';
import nebulaVioletWispUrl from './assets/collapse-flares/nebula-violet-wisp.png';
import spikeBlue8ptUrl from './assets/collapse-flares/spike-blue-8pt.png';
import nebulaLavenderUrl from './assets/collapse-flares/nebula-lavender.png';
import sparkleWhiteGoldUrl from './assets/collapse-flares/sparkle-white-gold.png';
import sparkleRedUrl from './assets/collapse-flares/sparkle-red.png';
import blackHoleGargantuaUrl from './assets/collapse-flares/blackhole-gargantua.png';

const { MIN_SEPARATION } = constants;

// One clearly yellow (G-type, Sun-like), one clearly blue (hot B/O-type), one clearly red
// (cool M-type) star. `core` is the solid disc (a pale, still clearly tinted version of the
// colour), `glow` the saturated tight halo, `trail` the matching trail colour. Names are only
// used in hint/info text (no on-canvas labels).
export const STAR_DEFS = [
  { name: 'yellow', core: '#ffe45a', glow: [255, 200, 30], trail: [255, 212, 70] },
  { name: 'blue', core: '#8cb4ff', glow: [60, 130, 255], trail: [105, 160, 255] },
  { name: 'red', core: '#ff6448', glow: [255, 50, 30], trail: [255, 88, 60] },
];

const PAD = 30;

// --- trails ---
// TRAIL_SECONDS / TRAIL_SUBSAMPLES were doubled (from 1.1 / 180) when BASE_SECONDS_PER_SIM_TIME
// was doubled, so a trail still spans the same stretch of simulated path (same on-screen shape)
// at the same sample density, instead of silently shrinking to half length.
const TRAIL_SECONDS = 2.2; // how far back the fading trail reaches, in playback seconds...
const TRAIL_MAX_LENGTH_PX = 320; // ...capped at this much on-screen arc length
const TRAIL_SUBSAMPLES = 360; // time samples per trail; smoothed with midpoint quadratic curves
const TRAIL_CHUNK = 12; // samples per separately-stroked alpha step (doubled with SUBSAMPLES: same ~30 steps)
const TRAIL_WIDTH = 2.0; // started at 1.5 * 1.2 = 1.8, nudged up to match the reference arcs
// (trail colour is per star: STAR_DEFS[i].trail)
const TRAIL_MAX_ALPHA = 0.85; // at the star end; fades to 0 at the tail
const TRAIL_FADE_EXPONENT = 1.4; // >1 = fades faster toward the tail

// --- camera ---
// The default camera shows a window 1.62x as wide as the [0,1] calibration square, so motion
// has breathing room and an ejected star stays in view longer before exiting frame. (Was 0.9 /
// 1.8x; tightened ~10%, with the chase bounds below scaled by the same factor.)
const DEFAULT_CENTER = [0.5, 0.5];
const DEFAULT_HALF_WIDTH = 0.81; // view spans 1.62 units, centered on the calibration square
const PAIR_ZOOM_HALF_WIDTH_MIN = 0.05; // never zoom in tighter than this
// Target half-width = the pair's *largest* separation over the whole epilogue * this. Using the
// epilogue max (≈ apoapsis) instead of the live separation keeps the zoom steady instead of
// pumping in and out every orbit of an eccentric pair. 1.15 => each star stays within ~45% of
// the half-width from the centre, leaving room for the trail arcs.
const PAIR_ZOOM_FACTOR = 1.15;
export const CAMERA_TRANSITION_SECONDS = 1.8;
// Chase phase: the camera follows the system's centre of mass, pulling back when stars wander
// out and settling in a little closer when the dance stays compact.
const CHASE_MIN_HALF_WIDTH = 0.45; // at most 1.8x zoomed in vs the placement view
const CHASE_MAX_HALF_WIDTH = 1.8; // at most ~2.2x zoomed out vs the placement view
const CHASE_FIT_MARGIN = 0.88; // keep stars within this fraction of the half-width
const CHASE_LOOKAHEAD_SECONDS = 0.7; // start pulling back this early
const CHASE_SMOOTH_SECONDS = 1.2; // moving-average window for the zoom track
const CHASE_RAMP_IN_SECONDS = 1.0; // blend out of the exact placement view over this long
// Stars/labels grow slightly when the camera zooms in (so the zoom reads as a zoom), but far
// less than the world does -- they stay point-like.
const STAR_ZOOM_SCALE_EXPONENT = 0.18;
const STAR_ZOOM_SCALE_MAX = 1.6;
const STAR_ZOOM_SCALE_MIN = 0.9;

// Clicks are accepted anywhere in the visible window, inset by this many design px so a star is
// never placed half off-screen.
const PLACEMENT_EDGE_INSET_PX = 12;

// --- collision beat: a short burst of light where a COLLAPSE happens. Render-only (the physics
// and its honest pacing are untouched) -- it just makes the ending read as an event rather
// than a freeze-frame, which matters most for the ~30% of random placements where the two
// closest stars fall straight together and collide within a fraction of a second.
// Each COLLAPSE run gets one of seven flare sprites (picked once, in prepareRun, weighted by
// `weight`). The first six are cut from the project's mood-board image and keyed to
// transparency by brightness, so drawn additively they reproduce the original glow. `width` =
// on-canvas width in design px at full size; (ax, ay) = the sprite's hot core / brightness
// centroid as a fraction of its size, placed on the collision point; `spin` = total rotation in
// radians while it settles (starbursts only); `grow` = extra scale gained while it settles
// (nebulae billow out more; negative = contracts).
//
// Every burst opens with a clearly visible "grow from a point" bloom: it starts at a few percent
// of its size and swells out over FLARE_IN_SECONDS (ease-out, so it reads as an outward burst but
// the small start is still on screen for several frames), keeps settling (grow / spin) until
// FLARE_SETTLE_SECONDS, and then STAYS -- frozen at that fully bloomed frame, full brightness, for
// the rest of the clip. The collapse leaves its mark rather than flashing and vanishing.
//
// The seventh, the rare black hole (~9% of collapses vs ~15% for each of the others), is a
// lensed accretion disk round a solid event-horizon shadow. Its sprite keeps the shadow opaque
// black (only the outer background was keyed to transparency, via a flood fill from the image
// border), so it's drawn 'source-over' (`opaque`) instead of additively -- the horizon actually
// hides what's behind it. It is a two-phase sequence (see the BH_* constants): first one of the
// six ordinary flares (picked once per run in prepareRun) blooms out, holds, then contracts and
// fades away into the collision point; then the hole grows out of that point and STAYS -- it
// never fades -- and the third, uninvolved star spirals into it and vanishes at the horizon. The
// clip ends on the fully formed, static hole. As the hole grows, the pre-collision trails are
// consumed too (drawn in toward it and dissolved), so the final frame is the hole alone. All of
// this is render-only: the physics still freezes at the collision moment; the third star's fall
// and the trails' consumption are cosmetic overlays.
//
// Optional per-flare overrides for the ordinary bloom: `inSeconds`, `startScale`. ---
// Length of an ordinary COLLAPSE's flare beat: bloom + settle, then a short look at the frozen,
// fully bloomed flare before the clip ends on it. (The black hole runs longer: BH_TOTAL_SECONDS.)
const FLARE_SETTLE_SECONDS = 1.1; // grow-in done at FLARE_IN_SECONDS, grow/spin settled here
const FLARE_FINAL_HOLD_SECONDS = 0.6;
export const COLLISION_FLASH_SECONDS = FLARE_SETTLE_SECONDS + FLARE_FINAL_HOLD_SECONDS;
const COLLAPSE_FLARES = [
  { url: flareGoldStreakUrl, w: 400, h: 195, ax: 0.4882, ay: 0.5049, width: 270, spin: 0, grow: 0.12, weight: 1 },
  { url: nebulaVioletWispUrl, w: 367, h: 284, ax: 0.5574, ay: 0.4663, width: 235, spin: 0, grow: 0.22, weight: 1 },
  { url: spikeBlue8ptUrl, w: 219, h: 233, ax: 0.4612, ay: 0.5021, width: 165, spin: 0.14, grow: 0.1, weight: 1 },
  { url: nebulaLavenderUrl, w: 252, h: 225, ax: 0.4297, ay: 0.51, width: 175, spin: 0, grow: 0.25, weight: 1 },
  { url: sparkleWhiteGoldUrl, w: 281, h: 258, ax: 0.5089, ay: 0.5736, width: 205, spin: 0.08, grow: 0.1, weight: 1 },
  { url: sparkleRedUrl, w: 294, h: 154, ax: 0.3844, ay: 0.5, width: 205, spin: 0.08, grow: 0.1, weight: 1 },
  {
    url: blackHoleGargantuaUrl,
    w: 635,
    h: 280,
    ax: 0.4969, // centre of the event horizon (not the brightness centroid)
    ay: 0.4875,
    width: 290,
    spin: 0.07, // total tilt of the disk while it grows in; it settles at 0 (static) once formed
    grow: 0,
    weight: 0.6, // 0.6 / 6.6 ≈ 9% of collapses
    opaque: true,
    blackHole: true, // two-phase persistent sequence instead of the ordinary burst envelope
  },
];
const FLARE_IN_SECONDS = 0.75; // bloom from a point to full size (ease-out): clearly visible growth
const FLARE_START_SCALE = 0.03; // starts as a tiny spark, a few % of full size
const FLARE_IN_ALPHA_FRACTION = 0.3; // of the bloom-in, over which it brightens from 0 to full
const FLARE_MIN_EDGE_FIT = 0.55; // near a screen edge, shrink (down to this) rather than clip
const FLARE_CORE_POP_SECONDS = 0.45; // the brief white brightening of the merged point

// --- black hole sequence (seconds since the collision) ---
// Phase 1: an ordinary flare blooms (FLARE_IN_SECONDS), holds until BH_INTRO_HOLD_END, then
// contracts to BH_INTRO_CONTRACT_TO of its size while fading out, fully gone at BH_INTRO_SECONDS.
const BH_INTRO_SECONDS = 1.9;
const BH_INTRO_HOLD_END = 0.95;
const BH_INTRO_CONTRACT_TO = 0.25;
// Phase 2: the hole grows from BH_START_SCALE to full size over BH_GROW_SECONDS (smoothstep, so
// the tiny start lingers a moment before it swells), then holds, full size and opacity, forever.
const BH_GROW_SECONDS = 1.7;
const BH_START_SCALE = 0.02;
const BH_FADE_IN_FRACTION = 0.15; // of the grow-in, over which it goes from invisible to opaque
// The third star's fall: starts once the hole is BH_SWALLOW_START of the way grown, spirals in
// (accelerating, BH_SWALLOW_SWIRL radians round the hole, in the sense it was already moving)
// over BH_SWALLOW_SECONDS, shrinking, and fades out as it reaches the horizon.
const BH_SWALLOW_START = 0.6;
const BH_SWALLOW_SECONDS = 1.5;
const BH_SWALLOW_SWIRL = 1.4;
const BH_SWALLOW_STREAK = 0.16; // length of the infall streak behind it, in swallow progress
const BH_HORIZON_FRACTION = 0.115; // event-horizon radius as a fraction of the sprite's width
const BH_FINAL_HOLD_SECONDS = 0.9; // static, fully formed hole before the clip ends
// The pre-collision trails are consumed while the hole grows: the colliding pair's trails are
// drawn in toward the hole (to BH_TRAIL_PULL_TO of their extent) and fade out, done by
// BH_TRAIL_CONSUMED of the grow-in; the third star's trail fades as it starts to fall, done by the
// same moment. After that, no trail geometry is left -- only the infalling star's own short streak
// until it crosses the horizon, and then the hole alone.
const BH_TRAIL_CONSUMED = 0.9;
const BH_TRAIL_PULL_TO = 0.35;
const BH_GROW_START = BH_INTRO_SECONDS;
const BH_SWALLOW_T0 = BH_GROW_START + BH_SWALLOW_START * BH_GROW_SECONDS;
const BH_TOTAL_SECONDS = Math.max(BH_GROW_START + BH_GROW_SECONDS, BH_SWALLOW_T0 + BH_SWALLOW_SECONDS) + BH_FINAL_HOLD_SECONDS;

// --- star sprites: a crisp tinted pinpoint core with a tight, fast-falling saturated halo
// (plus a very faint wider skirt), instead of a big soft bloom. Built at DPR resolution. All
// four size constants were scaled together by 1.3x (from 56 / 2.6 / 2.6 / 8) so the whole
// sprite design grows proportionally rather than the halo alone blooming out. ---
const SPRITE_SIZE = 73; // design px at scale 1
const CORE_RADIUS = 3.4; // design px, solid core
const HALO_SCALE = 3.4; // design px e-folding length of the bright halo
const HALO_PEAK = 0.85;
const SKIRT_SIGMA = 10.4; // design px, faint wide skirt
const SKIRT_PEAK = 0.13;
const CORE_TINT_BLEND_PX = 2.6; // core colour blends into the halo tint over this distance
const SPRITE_RES = 2; // extra supersampling so sprites stay sharp when drawn at scale > 1
const HOT_CENTRE_FRACTION = 0.5; // of CORE_RADIUS
const HOT_CENTRE_WHITE_MIX = 0.55; // 0 = core colour, 1 = white

// --- background: sparse procedural starfield (flat black, small dim dots, no nebulosity),
// rendered once to an offscreen canvas. Seeded so it's identical every load. ---
const BG_STAR_COUNT = 95;
const BG_FAINT_COUNT = 70; // extra barely-visible specks for depth

const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

// ---------------------------------------------------------------------------------------------
// Pure helpers (no canvas)
// ---------------------------------------------------------------------------------------------

function easeInOutCubic(x) {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function smoothstep01(x) {
  const u = Math.max(0, Math.min(1, x));
  return u * u * (3 - 2 * u);
}

export const WIDE_CAMERA = { center: DEFAULT_CENTER, halfWidth: DEFAULT_HALF_WIDTH };

/** Mass-weighted centre of mass of the given positions (the plain centroid for equal masses). */
export function centreOfMass(positions, masses) {
  const M = masses.reduce((a, b) => a + b, 0);
  let x = 0;
  let y = 0;
  positions.forEach((p, i) => {
    x += p[0] * masses[i];
    y += p[1] * masses[i];
  });
  return [x / M, y / M];
}

/** Chase-phase camera track, precomputed once per run. Centre: eases from the placement view's
 *  centre to the system's centre of mass (fixed for the whole run, since the stars start at
 *  rest; mass-weighted, which for the product's equal masses is just the placement centroid).
 *  Zoom: the half-width needed to keep all three stars inside CHASE_FIT_MARGIN of the view,
 *  clamped to
 *  [CHASE_MIN_HALF_WIDTH, CHASE_MAX_HALF_WIDTH] -- so compact dances are shown a little
 *  closer, wanderers are kept in frame, and a truly escaping star does eventually leave. A
 *  look-ahead running max makes the camera start pulling back *before* a star reaches the
 *  edge, then a moving average smooths it into a slow, even breathe. The first
 *  CHASE_RAMP_IN_SECONDS blend out of the exact placement view so there's no jump on RUN. */
function computeChaseTrack(schedule, masses) {
  const T = Math.max(1e-6, schedule.resolvedAtPlaybackSeconds);
  const N = 480;
  const dt = T / N;
  const com = centreOfMass(schedule.sampleAt(0), masses);
  const ramp = new Float64Array(N + 1);
  const cx = new Float64Array(N + 1);
  const cy = new Float64Array(N + 1);
  const req = new Float64Array(N + 1);
  for (let s = 0; s <= N; s++) {
    const u = Math.min(1, (s * dt) / CHASE_RAMP_IN_SECONDS);
    ramp[s] = u * u * (3 - 2 * u);
    cx[s] = DEFAULT_CENTER[0] + (com[0] - DEFAULT_CENTER[0]) * ramp[s];
    cy[s] = DEFAULT_CENTER[1] + (com[1] - DEFAULT_CENTER[1]) * ramp[s];
    const q = schedule.sampleAt(s * dt);
    let ext = 0;
    for (const p of q) ext = Math.max(ext, Math.abs(p[0] - cx[s]), Math.abs(p[1] - cy[s]));
    req[s] = Math.min(CHASE_MAX_HALF_WIDTH, Math.max(CHASE_MIN_HALF_WIDTH, ext / CHASE_FIT_MARGIN));
  }
  const ahead = Math.max(1, Math.round(CHASE_LOOKAHEAD_SECONDS / dt));
  let h = new Float64Array(N + 1);
  for (let s = 0; s <= N; s++) {
    let m = 0;
    for (let k = s; k <= Math.min(N, s + ahead); k++) m = Math.max(m, req[k]);
    h[s] = m;
  }
  const half = Math.max(1, Math.round(CHASE_SMOOTH_SECONDS / 2 / dt));
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float64Array(N + 1);
    for (let s = 0; s <= N; s++) {
      let sum = 0;
      let cnt = 0;
      for (let k = Math.max(0, s - half); k <= Math.min(N, s + half); k++) {
        sum += h[k];
        cnt++;
      }
      next[s] = sum / cnt;
    }
    h = next;
  }
  for (let s = 0; s <= N; s++) {
    // Blend geometrically so zooming in and out ease at the same perceived rate.
    h[s] = DEFAULT_HALF_WIDTH * Math.pow(h[s] / DEFAULT_HALF_WIDTH, ramp[s]);
  }
  return { dt, N, h, cx, cy };
}

function chaseCameraAt(track, t) {
  const x = Math.max(0, Math.min(track.N, t / track.dt));
  const i = Math.min(track.N - 1, Math.floor(x));
  const f = x - i;
  const lerp = (arr) => arr[i] + (arr[i + 1] - arr[i]) * f;
  return { center: [lerp(track.cx), lerp(track.cy)], halfWidth: lerp(track.h) };
}

/** Largest separation of the bound pair over the epilogue, sampled once per run. */
function computePairZoomHalfWidth(schedule, record) {
  const [i, j] = record.pair;
  const t0 = schedule.resolvedAtPlaybackSeconds;
  const t1 = schedule.durationSeconds;
  let maxSep = 0;
  const N = 240;
  for (let s = 0; s <= N; s++) {
    const p = schedule.sampleAt(t0 + ((t1 - t0) * s) / N);
    maxSep = Math.max(maxSep, Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1]));
  }
  return Math.max(PAIR_ZOOM_HALF_WIDTH_MIN, Math.min(DEFAULT_HALF_WIDTH, maxSep * PAIR_ZOOM_FACTOR));
}

/** Camera for a given playback moment. Stays on the default wide view the whole time, except
 *  after a BREAKAWAY's resolution moment, when it eases into tracking the remaining bound
 *  pair's live centre of mass at a fixed zoom sized to the pair's orbit. Zoom is interpolated
 *  geometrically (perceptually even), and the pan is done in screen space so the pair never
 *  slides out of frame mid-zoom. */
function computeCamera(tSeconds, schedule, record, pairHalfWidth, chaseTrack) {
  const chase = chaseCameraAt(chaseTrack, Math.min(tSeconds, schedule.resolvedAtPlaybackSeconds));
  if (record.outcome !== 'BREAKAWAY' || !record.pair || tSeconds < schedule.resolvedAtPlaybackSeconds) {
    return chase;
  }
  const elapsed = tSeconds - schedule.resolvedAtPlaybackSeconds;
  const e = easeInOutCubic(Math.min(1, elapsed / CAMERA_TRANSITION_SECONDS));

  const positions = schedule.sampleAt(tSeconds);
  const [i, j] = record.pair;
  const masses = record.masses || [1, 1, 1];
  const mid = centreOfMass([positions[i], positions[j]], [masses[i], masses[j]]);

  const h0 = chase.halfWidth;
  const c0 = chase.center;
  const halfWidth = h0 * Math.pow(pairHalfWidth / h0, e);
  // mid's screen-space offset from the view centre, as a fraction of half-width, goes linearly
  // from its wide-view value to 0.
  const s0 = [(mid[0] - c0[0]) / h0, (mid[1] - c0[1]) / h0];
  return {
    center: [mid[0] - s0[0] * (1 - e) * halfWidth, mid[1] - s0[1] * (1 - e) * halfWidth],
    halfWidth,
  };
}

/** Everything a run's renderer needs, computed once per run from a simulate() record and its
 *  getPlaybackSchedule(). Callers may attach extra fields (the harness adds preset overlays). */
export function prepareRun(record, schedule) {
  const masses = record.masses || [1, 1, 1];
  const meanMass = masses.reduce((a, b) => a + b, 0) / masses.length;
  const pairHalfWidth =
    record.outcome === 'BREAKAWAY' && record.pair ? computePairZoomHalfWidth(schedule, record) : DEFAULT_HALF_WIDTH;
  const collapseFlareIndex =
    record.outcome === 'COLLAPSE' ? pickWeightedIndex(COLLAPSE_FLARES.map((f) => f.weight)) : null;
  // A black hole opens with one of the ordinary flares as its explosion phase: also picked once
  // per run (uniformly among the non-black-hole flares) so it's stable across frames and seeks.
  let collapseIntroFlareIndex = null;
  if (collapseFlareIndex !== null && COLLAPSE_FLARES[collapseFlareIndex].blackHole) {
    const ordinary = COLLAPSE_FLARES.map((f, i) => i).filter((i) => !COLLAPSE_FLARES[i].blackHole);
    collapseIntroFlareIndex = ordinary[Math.floor(Math.random() * ordinary.length)];
  }
  return {
    record,
    schedule,
    pairHalfWidth,
    chaseTrack: computeChaseTrack(schedule, masses),
    // Sprite size ~ cube root of mass (radius ~ volume^(1/3)): exactly 1 for the product's
    // equal masses, only visibly different for the unequal-mass experimental presets.
    sizeFactors: masses.map((m) => Math.cbrt(m / meanMass)),
    // Which flare sprite this COLLAPSE's burst uses: picked once per run (weighted, so the black
    // hole is the rare one), so it stays the same across every frame, seek and redraw of the run.
    collapseFlareIndex,
    collapseIntroFlareIndex,
  };
}

function isBlackHoleRun(run) {
  return run.collapseFlareIndex !== null && run.collapseFlareIndex !== undefined && !!COLLAPSE_FLARES[run.collapseFlareIndex].blackHole;
}

/** Index i with probability weights[i] / sum(weights). `rand` returns a uniform [0, 1). */
export function pickWeightedIndex(weights, rand = Math.random) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1; // only reachable through float round-off
}

/** How long a COLLAPSE's flare beat runs past the collision, in playback seconds: the ordinary
 *  flare's bloom + settle + a short hold (COLLISION_FLASH_SECONDS), or for the black hole the
 *  whole explosion -> grow-in -> swallow -> static-hold sequence. Either way the flare / hole
 *  itself persists past this -- the clip just ends (and freezes) on it here. */
export function collisionFlashSeconds(run) {
  return isBlackHoleRun(run) ? BH_TOTAL_SECONDS : COLLISION_FLASH_SECONDS;
}

/** Progress (0..1) of the third star's fall into the black hole at `sinceCollision`, or null
 *  when this run has no black hole / the fall hasn't started. */
function blackHoleSwallowProgress(run, sinceCollision) {
  if (!isBlackHoleRun(run) || sinceCollision < BH_SWALLOW_T0) return null;
  return Math.min(1, (sinceCollision - BH_SWALLOW_T0) / BH_SWALLOW_SECONDS);
}

/** Playback second at which a run's clip ends. A COLLAPSE's flash may run a little past the
 *  schedule's end (frozen positions). */
export function runEndSeconds(run) {
  const { record, schedule } = run;
  return record.outcome === 'COLLAPSE'
    ? Math.max(schedule.durationSeconds, schedule.resolvedAtPlaybackSeconds + collisionFlashSeconds(run))
    : schedule.durationSeconds;
}

/** Three random stars that pass isValidPlacement, inside the calibration square's inner 70%. */
export function randomValidPlacement() {
  while (true) {
    const positions = [0, 1, 2].map(() => [
      0.15 + Math.random() * 0.7,
      0.15 + Math.random() * 0.7,
    ]);
    if (isValidPlacement(positions, MIN_SEPARATION)) return positions;
  }
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function buildGlowSprite({ core, glow }) {
  const px = Math.round(SPRITE_SIZE * DPR * SPRITE_RES);
  const off = document.createElement('canvas');
  off.width = px;
  off.height = px;
  const octx = off.getContext('2d');
  const c = px / 2;
  const R = SPRITE_SIZE / 2; // design px
  const grad = octx.createRadialGradient(c, c, 0, c, c, c);
  const STOPS = 40;
  for (let s = 0; s <= STOPS; s++) {
    const u = s / STOPS;
    const r = u * R; // design px
    let rgb;
    let a;
    if (r <= CORE_RADIUS) {
      rgb = hexToRgb(core);
      a = 1;
    } else {
      const d = r - CORE_RADIUS;
      const halo = HALO_PEAK * Math.exp(-d / HALO_SCALE);
      const skirt = SKIRT_PEAK * Math.exp(-(r * r) / (2 * SKIRT_SIGMA * SKIRT_SIGMA));
      a = Math.min(1, halo + skirt) * (1 - u * u * u); // force exactly 0 at the sprite edge
      // Blend from the core colour into the saturated tint over the first few px of halo.
      const k = Math.min(1, d / CORE_TINT_BLEND_PX);
      const cr = hexToRgb(core);
      rgb = cr.map((v, idx) => Math.round(v + (glow[idx] - v) * k));
    }
    grad.addColorStop(u, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(4)})`);
  }
  octx.fillStyle = grad;
  octx.fillRect(0, 0, px, px);
  return off;
}

// Sprites depend only on DPR (not on the display scale), so they're built once per page.
let glowSprites = null;
let hotCentres = null;
let flareImages = null; // COLLAPSE flare sprites, requested once per page (drawn once decoded)
function ensureSprites() {
  if (glowSprites) return;
  flareImages = COLLAPSE_FLARES.map(({ url }) => {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    return img;
  });
  glowSprites = STAR_DEFS.map(buildGlowSprite);
  hotCentres = STAR_DEFS.map(({ core }) => {
    const [r, g, b] = hexToRgb(core).map((v) => Math.round(v + (255 - v) * HOT_CENTRE_WHITE_MIX));
    return `rgb(${r},${g},${b})`;
  });
}

// ---------------------------------------------------------------------------------------------
// The view: one canvas, its starfield, and every draw call
// ---------------------------------------------------------------------------------------------

/**
 * @param {HTMLCanvasElement} canvas - its width/height attributes set the design surface
 *   (600 x 600 in both pages).
 * @param {object} [hooks]
 * @param {(run, camera, tSeconds) => void} [hooks.underlay] - drawn right after the background,
 *   before trails (the harness draws its preset "ghost" paths here).
 * @param {(run, tSeconds) => void} [hooks.overlay] - drawn last, on top of everything (the
 *   harness draws its preset HUD here).
 */
export function createSimView(canvas, hooks = {}) {
  const ctx = canvas.getContext('2d');
  const VIEW_W = canvas.width;
  const VIEW_H = canvas.height;
  let displayScale = 1; // on-screen CSS px per design px
  let starfield = null;
  let animHandle = null;

  function applySize(cssWidth) {
    displayScale = cssWidth / VIEW_W;
    const k = DPR * displayScale;
    canvas.style.width = `${VIEW_W * displayScale}px`;
    canvas.style.height = `${VIEW_H * displayScale}px`;
    canvas.width = Math.round(VIEW_W * k);
    canvas.height = Math.round(VIEW_H * k);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    starfield = buildStarfield();
  }

  function buildStarfield() {
    const off = document.createElement('canvas');
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext('2d');
    const k = DPR * displayScale;
    octx.setTransform(k, 0, 0, k, 0, 0);
    octx.fillStyle = '#000';
    octx.fillRect(0, 0, VIEW_W, VIEW_H);
    const rand = mulberry32(20260923);
    const dot = (x, y, r, a, tint) => {
      octx.fillStyle = `rgba(${tint[0]},${tint[1]},${tint[2]},${a.toFixed(3)})`;
      octx.beginPath();
      octx.arc(x, y, r, 0, Math.PI * 2);
      octx.fill();
    };
    for (let n = 0; n < BG_FAINT_COUNT; n++) {
      dot(rand() * VIEW_W, rand() * VIEW_H, 0.45 + rand() * 0.2, 0.12 + rand() * 0.14, [220, 225, 240]);
    }
    for (let n = 0; n < BG_STAR_COUNT; n++) {
      // Skewed brightness: most are faint, a handful are clearly visible.
      const b = Math.pow(rand(), 1.7);
      const r = 0.55 + b * 0.8;
      const a = 0.28 + b * 0.62;
      // Mostly neutral white, occasional faint warm/cool cast.
      const c = rand();
      const tint = c < 0.12 ? [255, 228, 200] : c < 0.24 ? [210, 222, 255] : [240, 242, 250];
      dot(rand() * VIEW_W, rand() * VIEW_H, r, a, tint);
    }
    return off;
  }

  function toCanvas(pos, camera) {
    const left = camera.center[0] - camera.halfWidth;
    const top = camera.center[1] - camera.halfWidth;
    const span = camera.halfWidth * 2;
    const w = VIEW_W - PAD * 2;
    const h = VIEW_H - PAD * 2;
    return [PAD + ((pos[0] - left) / span) * w, PAD + ((pos[1] - top) / span) * h];
  }

  function toNormalized(px, py, camera) {
    const left = camera.center[0] - camera.halfWidth;
    const top = camera.center[1] - camera.halfWidth;
    const span = camera.halfWidth * 2;
    const w = VIEW_W - PAD * 2;
    const h = VIEW_H - PAD * 2;
    return [left + ((px - PAD) / w) * span, top + ((py - PAD) / h) * span];
  }

  function drawBackground() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(starfield, 0, 0);
    ctx.restore();
  }

  function drawStar(idx, canvasPos, scale = 1) {
    const sprite = glowSprites[idx];
    const size = SPRITE_SIZE * scale;
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(sprite, canvasPos[0] - size / 2, canvasPos[1] - size / 2, size, size);
    ctx.globalCompositeOperation = 'source-over';

    // Crisp pinpoint on top of the sprite's core, with a small lighter hot centre so it reads as
    // a luminous point rather than a flat coloured disc (while staying clearly tinted).
    ctx.fillStyle = STAR_DEFS[idx].core;
    ctx.beginPath();
    ctx.arc(canvasPos[0], canvasPos[1], CORE_RADIUS * scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = hotCentres[idx];
    ctx.beginPath();
    ctx.arc(canvasPos[0], canvasPos[1], CORE_RADIUS * HOT_CENTRE_FRACTION * scale, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Background plus the placed (not yet running) stars, in the placement view. */
  function drawIdle(placed) {
    drawBackground();
    placed.forEach((p, idx) => drawStar(idx, toCanvas(p, WIDE_CAMERA)));
  }

  /** Normalized placement position for a click/tap on the canvas, or null if it landed in the
   *  edge inset (so a star is never placed half off-screen). */
  function eventToPlacement(e) {
    const rect = canvas.getBoundingClientRect();
    // Exclude the CSS border so clicks map onto the drawing surface exactly, then undo the
    // display scale to get design px.
    const px = (e.clientX - rect.left - canvas.clientLeft) / displayScale;
    const py = (e.clientY - rect.top - canvas.clientTop) / displayScale;
    const inset = PLACEMENT_EDGE_INSET_PX;
    if (px < inset || px > VIEW_W - inset || py < inset || py > VIEW_H - inset) return null;
    return toNormalized(px, py, WIDE_CAMERA);
  }

  /** Stroke one body's trail as a smooth curve (quadratic segments between sample midpoints,
   *  so the curve is tangent-continuous -- no polyline corners), split into chunks of rising
   *  alpha. Chunks meet at midpoints with butt caps, where both sides share the same tangent,
   *  so the seams line up. */
  function strokeTrail(points, rgb, alphaScale = 1) {
    const n = points.length;
    if (n < 3 || alphaScale <= 0) return;
    const mids = [];
    for (let s = 0; s < n - 1; s++) {
      mids.push([(points[s][0] + points[s + 1][0]) / 2, (points[s][1] + points[s + 1][1]) / 2]);
    }
    // Segment k (1..n-2) runs mids[k-1] -> mids[k] with control point points[k]; the first/last
    // half-segments are straight from the endpoints so the head touches the star exactly.
    //
    // The fade (by arc length, tail -> head) is built from overlapping layers: layer k strokes
    // from chunk k's start all the way to the head, with its alpha chosen so the *accumulated*
    // alpha over chunk k is exactly the target. Every layer sits on top of a continuous stroke,
    // so there are no butt-end seams/gaps between chunks -- just imperceptibly small steps.
    const cum = [0];
    for (let s = 1; s < n; s++) {
      cum.push(cum[s - 1] + Math.hypot(points[s][0] - points[s - 1][0], points[s][1] - points[s - 1][1]));
    }
    const total = cum[n - 1] || 1;
    const [r, g, b] = rgb;
    ctx.lineWidth = TRAIL_WIDTH;
    ctx.lineJoin = 'round';
    // Butt caps: layer starts must not leave dots on the stroke beneath, and the head end is
    // hidden under the star sprite anyway. The tail end is already faded to ~0.
    ctx.lineCap = 'butt';
    let prevA = 0;
    for (let start = 0; start < n - 1; start += TRAIL_CHUNK) {
      const end = Math.min(n - 1, start + TRAIL_CHUNK);
      const u = (cum[start] + cum[end]) / 2 / total; // 0 = tail, 1 = head
      const A = alphaScale * TRAIL_MAX_ALPHA * Math.pow(u, TRAIL_FADE_EXPONENT);
      if (A < 0.006) continue;
      const layerAlpha = 1 - (1 - A) / (1 - prevA);
      prevA = A;
      ctx.strokeStyle = `rgba(${r},${g},${b},${layerAlpha.toFixed(4)})`;
      ctx.beginPath();
      const from = start === 0 ? points[0] : mids[start - 1];
      ctx.moveTo(from[0], from[1]);
      if (start === 0) ctx.lineTo(mids[0][0], mids[0][1]);
      for (let k = Math.max(1, start); k < n - 1; k++) {
        ctx.quadraticCurveTo(points[k][0], points[k][1], mids[k][0], mids[k][1]);
      }
      ctx.lineTo(points[n - 1][0], points[n - 1][1]);
      ctx.stroke();
    }
  }

  /** Draw COLLAPSE_FLARES[idx] with its hot core / horizon centre at `c`, at `growth` x its full
   *  width, rotated by `angle`, additively ('lighter', like the star sprites) or, for an `opaque`
   *  flare (the black hole), 'source-over' so its black shadow occludes. Near a screen edge it's
   *  shrunk (down to FLARE_MIN_EDGE_FIT) rather than sliced off by the frame. Returns the
   *  on-canvas width actually drawn, or null while the sprite is still decoding. */
  function drawFlareSprite(idx, c, growth, alpha, angle) {
    const flare = COLLAPSE_FLARES[idx];
    const img = flareImages[idx];
    if (!img.complete || img.naturalWidth === 0) return null;
    const w = flare.width * growth;
    if (!(w > 0)) return 0;
    const h = (w * flare.h) / flare.w;
    const room = Math.min(
      c[0] / (flare.ax * w),
      (VIEW_W - c[0]) / ((1 - flare.ax) * w),
      c[1] / (flare.ay * h),
      (VIEW_H - c[1]) / ((1 - flare.ay) * h)
    );
    const fit = Math.max(FLARE_MIN_EDGE_FIT, Math.min(1, room));
    const a = Math.max(0, Math.min(1, alpha));
    if (a > 0) {
      ctx.save();
      ctx.globalCompositeOperation = flare.opaque ? 'source-over' : 'lighter';
      ctx.globalAlpha = a;
      ctx.translate(c[0], c[1]);
      if (angle) ctx.rotate(angle);
      ctx.scale(fit, fit);
      ctx.drawImage(img, -flare.ax * w, -flare.ay * h, w, h);
      ctx.restore();
    }
    return w * fit;
  }

  /** The COLLAPSE burst, drawn at the colliding pair's midpoint. An ordinary flare grows out of
   *  the collision point from a tiny spark (FLARE_START_SCALE -> full over FLARE_IN_SECONDS,
   *  brightening over the first part of that), keeps settling (grow / spin) until
   *  FLARE_SETTLE_SECONDS, then stays frozen at that frame, full brightness. The black hole instead runs its two-phase sequence (an ordinary flare blooms, then
   *  contracts and fades into the point; the hole grows out of it and stays). A short white pop
   *  on the merged point sells the impact. Returns { center, horizonR } for a black-hole run (so
   *  drawFrame can pull the third star into it), otherwise null. */
  function drawCollisionFlash(run, canvasPositions, sinceCollision, scale) {
    if (sinceCollision < 0) return null;
    const [i, j] = run.record.pair;
    const c = [(canvasPositions[i][0] + canvasPositions[j][0]) / 2, (canvasPositions[i][1] + canvasPositions[j][1]) / 2];
    const flareIdx = run.collapseFlareIndex ?? 0;
    const flare = COLLAPSE_FLARES[flareIdx];
    let result = null;

    if (flare.blackHole) {
      // Phase 1: the explosion -- bloom out, hold, then contract and fade into the point.
      if (sinceCollision < BH_INTRO_SECONDS) {
        const introIdx = run.collapseIntroFlareIndex ?? 0;
        const intro = COLLAPSE_FLARES[introIdx];
        const tIn = Math.min(1, sinceCollision / FLARE_IN_SECONDS);
        const bloom = 1 - (1 - tIn) * (1 - tIn); // ease-out
        const alphaIn = smoothstep01(tIn / FLARE_IN_ALPHA_FRACTION);
        const k = smoothstep01((sinceCollision - BH_INTRO_HOLD_END) / (BH_INTRO_SECONDS - BH_INTRO_HOLD_END));
        const growth = (FLARE_START_SCALE + (1 - FLARE_START_SCALE) * bloom) * (1 - (1 - BH_INTRO_CONTRACT_TO) * k);
        const alpha = alphaIn * (1 - k * k); // stays bright while it starts to contract, 0 at the end
        drawFlareSprite(introIdx, c, growth, alpha, intro.spin * (sinceCollision / BH_INTRO_SECONDS - 0.5));
      }
      // Phase 2: the hole grows out of the point, then holds -- full size, full opacity, static.
      const g = Math.max(0, Math.min(1, (sinceCollision - BH_GROW_START) / BH_GROW_SECONDS));
      const ge = smoothstep01(g);
      const growth = BH_START_SCALE + (1 - BH_START_SCALE) * ge;
      let drawnW = null;
      if (sinceCollision >= BH_GROW_START) {
        drawnW = drawFlareSprite(flareIdx, c, growth, smoothstep01(g / BH_FADE_IN_FRACTION), flare.spin * (ge - 1));
      }
      result = { center: c, horizonR: BH_HORIZON_FRACTION * (drawnW ?? flare.width * growth) };
    } else {
      // Time is clamped (tIn, settle both saturate at 1), so from FLARE_SETTLE_SECONDS on this
      // draws the same fully bloomed frame forever -- no fade, no cutoff.
      const startScale = flare.startScale ?? FLARE_START_SCALE;
      const tIn = Math.min(1, sinceCollision / (flare.inSeconds ?? FLARE_IN_SECONDS));
      const bloom = 1 - (1 - tIn) * (1 - tIn); // ease-out: bursts out, but the small start stays visible
      const alpha = smoothstep01(tIn / FLARE_IN_ALPHA_FRACTION);
      const settle = Math.min(1, sinceCollision / FLARE_SETTLE_SECONDS);
      const settleE = 1 - (1 - settle) * (1 - settle); // ease-out, so it comes to rest smoothly
      const growth = startScale + (1 - startScale) * bloom + flare.grow * settleE;
      drawFlareSprite(flareIdx, c, growth, alpha, flare.spin * (settleE - 0.5));
    }

    // A brief brightening of the merged point itself.
    ctx.globalCompositeOperation = 'lighter';
    if (sinceCollision < FLARE_CORE_POP_SECONDS) {
      const v = 1 - sinceCollision / FLARE_CORE_POP_SECONDS;
      const glowR = CORE_RADIUS * 3.5 * scale;
      const g = ctx.createRadialGradient(c[0], c[1], 0, c[0], c[1], glowR);
      g.addColorStop(0, `rgba(255,255,255,${(0.85 * v * v).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c[0], c[1], glowR, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    return result;
  }

  /** Render-only: the third (non-colliding) star spiralling into the black hole. It leaves its
   *  frozen position with progress `p` (0..1), accelerating inward (radius ~ 1 - p^2) while
   *  swinging BH_SWALLOW_SWIRL radians round the hole in the sense it was already moving, trailing
   *  a short streak, shrinking, and fading out as it reaches the event horizon. */
  function drawInfallingStar(run, b, fromPos, prevPos, hole, p, scale) {
    const c = hole.center;
    const rx = fromPos[0] - c[0];
    const ry = fromPos[1] - c[1];
    const r0 = Math.hypot(rx, ry);
    const th0 = Math.atan2(ry, rx);
    const vx = fromPos[0] - prevPos[0];
    const vy = fromPos[1] - prevPos[1];
    const dir = rx * vy - ry * vx < 0 ? -1 : 1;
    const at = (q) => {
      const e = q * q;
      const r = r0 * (1 - e);
      const th = th0 + dir * BH_SWALLOW_SWIRL * e;
      return [c[0] + r * Math.cos(th), c[1] + r * Math.sin(th)];
    };
    const r = r0 * (1 - p * p);
    const hR = Math.max(1, hole.horizonR);
    const fade = smoothstep01((r - 0.6 * hR) / (1.4 * hR)); // gone by just inside the horizon
    if (fade <= 0) return;
    if (p > 0.01) {
      const q0 = Math.max(0, p - BH_SWALLOW_STREAK);
      const pts = [];
      for (let s = 0; s <= 20; s++) pts.push(at(q0 + ((p - q0) * s) / 20));
      strokeTrail(pts, STAR_DEFS[b].trail, fade);
    }
    ctx.save();
    ctx.globalAlpha = fade;
    drawStar(b, at(p), scale * run.sizeFactors[b] * (0.45 + 0.55 * (1 - p * p)));
    ctx.restore();
  }

  function drawFrame(run, tSeconds) {
    const { record, schedule, pairHalfWidth, chaseTrack } = run;
    // Motion stops at the last simulated moment; frames drawn after it (the MIN_PLAYBACK_SECONDS
    // hold, the collision flash) keep the trails exactly as they were at that moment instead of
    // letting the trail window slide past the end and eat them.
    const motionEnd = record.outcome === 'COLLAPSE' ? schedule.resolvedAtPlaybackSeconds : schedule.durationSeconds;
    const tMotion = Math.min(tSeconds, motionEnd);
    const camera = computeCamera(tSeconds, schedule, record, pairHalfWidth, chaseTrack);
    drawBackground();
    if (hooks.underlay) hooks.underlay(run, camera, tSeconds);

    // Walk backwards from "now" at a fixed time step. Each body's trail stops at TRAIL_SECONDS
    // or at TRAIL_MAX_LENGTH_PX of on-screen arc length, whichever comes first -- so during a
    // fast close encounter the trail shortens instead of piling up into a tangle of loops.
    const dt = TRAIL_SECONDS / TRAIL_SUBSAMPLES;
    const trails = [[], [], []];
    const lengths = [0, 0, 0];
    const done = [false, false, false];
    let prevKey = null;
    for (let s = 0; s <= TRAIL_SUBSAMPLES; s++) {
      const sampleT = tMotion - s * dt;
      if (sampleT < 0) break;
      const snap = schedule.sampleAt(sampleT);
      // Drop exact duplicates (e.g. during a hold at the end) so the curve math stays sane.
      const key = snap[0][0] + ',' + snap[0][1] + ',' + snap[1][0];
      if (key === prevKey) continue;
      prevKey = key;
      for (let b = 0; b < 3; b++) {
        if (done[b]) continue;
        const p = toCanvas(snap[b], camera);
        const tr = trails[b];
        if (tr.length) {
          const last = tr[tr.length - 1];
          lengths[b] += Math.hypot(p[0] - last[0], p[1] - last[1]);
          if (lengths[b] > TRAIL_MAX_LENGTH_PX) done[b] = true;
        }
        tr.push(p);
      }
      if (done[0] && done[1] && done[2]) break;
    }
    const positions = schedule.sampleAt(tMotion).map((p) => toCanvas(p, camera));
    // Black-hole runs: the hole consumes every pre-collision trail as it grows (pair trails drawn
    // in toward it and dissolved; the third star's trail dissolving as it starts to fall), all
    // gone by BH_TRAIL_CONSUMED of the grow-in. Once the third star starts falling in, its real
    // (frozen) position isn't drawn -- an animated infalling one is, after the hole. Ordinary
    // COLLAPSE runs keep all three trails frozen as they were at the collision.
    const isCollapse = record.outcome === 'COLLAPSE' && record.pair;
    const sinceCollision = tSeconds - schedule.resolvedAtPlaybackSeconds;
    const blackHole = isCollapse && isBlackHoleRun(run);
    const swallow = blackHole ? blackHoleSwallowProgress(run, sinceCollision) : null;
    const third = isCollapse ? [0, 1, 2].find((b) => !record.pair.includes(b)) : -1;
    const holeCentre = isCollapse
      ? [(positions[record.pair[0]][0] + positions[record.pair[1]][0]) / 2, (positions[record.pair[0]][1] + positions[record.pair[1]][1]) / 2]
      : null;
    const consumedAt = BH_GROW_START + BH_TRAIL_CONSUMED * BH_GROW_SECONDS;
    for (let b = 0; b < 3; b++) {
      let pts = trails[b].reverse();
      let trailAlpha = 1;
      if (blackHole && b === third) {
        trailAlpha = 1 - smoothstep01((sinceCollision - BH_SWALLOW_T0) / (consumedAt - BH_SWALLOW_T0));
      } else if (blackHole) {
        const k = smoothstep01((sinceCollision - BH_GROW_START) / (consumedAt - BH_GROW_START));
        const pull = 1 - (1 - BH_TRAIL_PULL_TO) * k;
        trailAlpha = 1 - k;
        if (k > 0) pts = pts.map((q) => [holeCentre[0] + (q[0] - holeCentre[0]) * pull, holeCentre[1] + (q[1] - holeCentre[1]) * pull]);
      }
      strokeTrail(pts, STAR_DEFS[b].trail, trailAlpha);
    }

    const scale = Math.max(
      STAR_ZOOM_SCALE_MIN,
      Math.min(STAR_ZOOM_SCALE_MAX, Math.pow(DEFAULT_HALF_WIDTH / camera.halfWidth, STAR_ZOOM_SCALE_EXPONENT))
    );
    for (let b = 0; b < 3; b++) {
      if (!(b === third && swallow !== null)) drawStar(b, positions[b], scale * run.sizeFactors[b]);
    }

    if (isCollapse) {
      const hole = drawCollisionFlash(run, positions, sinceCollision, scale);
      if (hole && swallow !== null && swallow < 1) {
        // Its frozen on-screen velocity sets which way round the hole it spirals.
        const prevPos = toCanvas(schedule.sampleAt(Math.max(0, motionEnd - 0.05))[third], camera);
        drawInfallingStar(run, third, positions[third], prevPos, hole, swallow, scale);
      }
    }
    if (hooks.overlay) hooks.overlay(run, tSeconds);
  }

  function stop() {
    if (animHandle) cancelAnimationFrame(animHandle);
    animHandle = null;
  }

  /** Play a prepared run in real time from t = 0. `onEnd(run)` fires once, after the final
   *  frame (at runEndSeconds) has been drawn; `onFrame(run, t)` after every other frame. */
  function play(run, { onFrame, onEnd } = {}) {
    stop();
    const endSeconds = runEndSeconds(run);
    const start = performance.now();
    function frame(now) {
      const tSeconds = (now - start) / 1000;
      if (tSeconds >= endSeconds) {
        animHandle = null;
        drawFrame(run, endSeconds);
        if (onEnd) onEnd(run);
        return;
      }
      drawFrame(run, tSeconds);
      if (onFrame) onFrame(run, tSeconds);
      animHandle = requestAnimationFrame(frame);
    }
    animHandle = requestAnimationFrame(frame);
  }

  ensureSprites();
  applySize(VIEW_W); // native size (scale 1) until a page asks for another

  return {
    ctx,
    VIEW_W,
    VIEW_H,
    toCanvas,
    toNormalized,
    drawBackground,
    drawStar,
    drawIdle,
    drawFrame,
    eventToPlacement,
    play,
    stop,
    isPlaying: () => animHandle !== null,
    /** Show the canvas at `cssWidth` CSS px wide (height follows the design aspect). Resets the
     *  canvas, so the caller must redraw whatever should be on it afterwards. */
    setDisplaySize(cssWidth) {
      if (Math.abs(cssWidth - VIEW_W * displayScale) < 0.5 && starfield) return false;
      applySize(cssWidth);
      return true;
    },
  };
}
