// src/debug.js
// Developer/testing harness -- not the product (that's index.html + src/main.js). Click to place
// 3 stars (anywhere in the visible window), press RUN, and watch it play back over a sparse
// procedural starfield with small crisp yellow / blue / red star sprites, each trailed by a thin
// smooth fading trail in its own colour. On a BREAKAWAY outcome, the camera smoothly zooms into
// the remaining bound pair for the epilogue the physics engine simulates past the resolution
// moment; on a COLLAPSE, a brief flare burst (one of seven, random per run; the black hole is
// the rare one) marks the collision.
// All of that rendering lives in src/simCore.js, shared with the product page; this file adds
// only the harness's own extras: the info panel, the hint line, and the experimental presets
// below.
//
// Separately, an EXPERIMENTAL row of preset buttons runs a published periodic free-fall orbit
// (src/periodicOrbits.js) through the same engine, to watch it hold its pattern for a few
// periods and then break into ordinary chaos. The same row also holds a constructed (not
// published) hierarchical triple (src/hierarchicalTriples.js), and three published periodic
// orbits that start with real orbital velocities (src/nonFreeFallOrbits.js: Broucke A2, the
// figure-eight, Broucke A11) -- linearly stable, so they get a natural-speed clip of their first
// few periods instead of a compressed run to the engine's cutoff. Console helpers:
// debugRun(positions), debugPreset(id), debugSeek(t), debugCurrent().

import { simulate, isValidPlacement, getPlaybackSchedule, constants } from './physics/index.js';
import {
  STAR_DEFS,
  COLLISION_FLASH_SECONDS,
  runEndSeconds,
  createSimView,
  prepareRun,
  centreOfMass,
  randomValidPlacement,
} from './simCore.js';
import { PERIODIC_ORBITS } from './periodicOrbits.js';
import { HIERARCHICAL_TRIPLES, HIERARCHY_BAND } from './hierarchicalTriples.js';
import { NON_FREE_FALL_ORBITS } from './nonFreeFallOrbits.js';
const ALL_PRESETS = [...PERIODIC_ORBITS, ...HIERARCHICAL_TRIPLES, ...NON_FREE_FALL_ORBITS];
const { MIN_SEPARATION, BASE_SECONDS_PER_SIM_TIME, MAX_CROSSING_TIMES } = constants;

const canvas = document.getElementById('c');
const info = document.getElementById('info');
const hint = document.getElementById('hint');
const runBtn = document.getElementById('run');
const randomRunBtn = document.getElementById('randomRun');
const clearBtn = document.getElementById('clear');
const presetBox = document.getElementById('presets');

// The shared renderer, drawing at the canvas's native 600 x 600 (display scale 1). The harness
// hooks its preset ghost paths in under the trails and its preset HUD on top.
const view = createSimView(canvas, {
  underlay: (run, camera, tSeconds) => {
    if (run.preset) (run.preset.kind === 'hierarchical' ? drawHierarchyGhost : drawGhost)(run, camera, tSeconds);
  },
  overlay: (run, tSeconds) => {
    if (run.preset) (run.preset.kind === 'hierarchical' ? drawHierarchyHud : drawPresetHud)(run, tSeconds);
  },
});
const { ctx, toCanvas } = view;

// --- placement state ---
let placed = []; // array of [x,y] normalized positions, up to 3
let placedPreset = null; // set while `placed` holds an experimental preset (RUN re-runs it as such)

function drawIdle() {
  view.drawIdle(placed);
  updateHint();
}

function updateHint() {
  if (placed.length < 3) {
    hint.textContent = `click anywhere to place the ${STAR_DEFS[placed.length].name} star (${placed.length}/3 placed)`;
  } else {
    hint.textContent = isValidPlacement(placed, MIN_SEPARATION)
      ? 'ready -- press RUN'
      : 'too close together -- clear and try again';
  }
}

canvas.addEventListener('click', (e) => {
  if (placed.length >= 3) return;
  const pos = view.eventToPlacement(e);
  if (!pos) return;
  placed.push(pos);
  drawIdle();
});

clearBtn.addEventListener('click', () => {
  placed = [];
  placedPreset = null;
  view.stop();
  drawIdle();
});

// --- experimental periodic-orbit presets (see src/periodicOrbits.js) ---
// A preset run additionally gets (a) a faint "ghost" of the published orbit's path -- the
// engine's own first half-period, which is accurate to ~1e-5 -- so it's easy to see whether the
// stars are still on the pattern, and (b) a small HUD with the period count and live drift from
// that pattern. Neither affects the physics.
const PRESET_PLAYBACK_MAX_SECONDS = 45; // presets are showcases -- give long ones room to breathe
const PATTERN_BROKEN_DRIFT = 0.05; // drift (fraction of starting system size) that counts as "broken"
const GHOST_SAMPLES = 500;
const GHOST_ALPHA = 0.16;

/** Linear interpolation of a record's trajectory at a sim time (same scheme as playback.js). */
function trajectoryAt(trajectory, simTime) {
  const n = trajectory.length;
  if (simTime <= trajectory[0].t) return trajectory[0].positions;
  if (simTime >= trajectory[n - 1].t) return trajectory[n - 1].positions;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trajectory[mid].t <= simTime) lo = mid;
    else hi = mid;
  }
  const a = trajectory[lo];
  const b = trajectory[hi];
  const f = (simTime - a.t) / (b.t - a.t || 1);
  return a.positions.map((p, k) => [p[0] + (b.positions[k][0] - p[0]) * f, p[1] + (b.positions[k][1] - p[1]) * f]);
}

function maxPairwise(positions) {
  let m = 0;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) m = Math.max(m, Math.hypot(positions[i][0] - positions[j][0], positions[i][1] - positions[j][1]));
  }
  return m;
}

/** A published orbit's period in the engine's sim-time units (the non-free-fall presets are
 *  display-rescaled, so their published T is converted -- see src/nonFreeFallOrbits.js). */
function presetPeriod(preset) {
  return preset.kind === 'moving-periodic' ? preset.Tsim : preset.T;
}

/** Everything the preset overlay needs, computed once per run. */
function buildPresetOverlay(preset, record) {
  const T = presetPeriod(preset);
  const traj = record.trajectory;
  const size = maxPairwise(traj[0].positions);
  const drift = (simTime) => {
    const now = trajectoryAt(traj, simTime);
    const ref = trajectoryAt(traj, simTime % T);
    let d = 0;
    for (let b = 0; b < 3; b++) d = Math.max(d, Math.hypot(now[b][0] - ref[b][0], now[b][1] - ref[b][1]));
    return d / size;
  };
  // Free-fall periodic orbits are "brake" orbits: out along a path to a momentary stop at T/2,
  // then back along the same path -- so half a period traces the whole pattern. Orbits that
  // start moving never retrace, so they need the whole period (and more samples for the
  // many-looped ones).
  const moving = preset.kind === 'moving-periodic';
  const ghostSpan = moving ? T : T / 2;
  const ghostSamples = moving ? GHOST_SAMPLES * 4 : GHOST_SAMPLES;
  const ghost = [[], [], []];
  for (let s = 0; s <= ghostSamples; s++) {
    const p = trajectoryAt(traj, ghostSpan * (s / ghostSamples));
    for (let b = 0; b < 3; b++) ghost[b].push(p);
  }
  for (let b = 0; b < 3; b++) ghost[b] = ghost[b].map((p) => p[b]);
  // Drift at each t = kT, when the system should be back exactly at its starting triangle.
  const periodDrifts = [];
  for (let k = 1; k * T <= record.resolvedAtSimTime; k++) periodDrifts.push(drift(k * T));
  // The HUD shows the running *maximum* drift, so it only ever grows (the live value can dip
  // back under the threshold for a moment while the stars wander chaotically, which would make
  // "pattern broken" flicker). brokenAtSimTime = first moment it crosses the threshold.
  const SCAN = 4000;
  const scanDt = record.resolvedAtSimTime / SCAN;
  const maxDrift = new Float64Array(SCAN + 1);
  let brokenAtSimTime = Infinity;
  for (let s = 0; s <= SCAN; s++) {
    maxDrift[s] = Math.max(s > 0 ? maxDrift[s - 1] : 0, drift(s * scanDt));
    if (maxDrift[s] >= PATTERN_BROKEN_DRIFT && !Number.isFinite(brokenAtSimTime)) brokenAtSimTime = s * scanDt;
  }
  const maxDriftAt = (simTime) => maxDrift[Math.max(0, Math.min(SCAN, Math.floor(simTime / (scanDt || 1))))];
  return { maxDriftAt, ghost, periodDrifts, brokenAtSimTime };
}

function drawGhost(run, camera, tSeconds) {
  const { ghost, brokenAtSimTime } = run.overlay;
  // Dim the published pattern once the stars have left it, so it reads as "where they were".
  const alpha = chaseSimTime(run, tSeconds) >= brokenAtSimTime ? GHOST_ALPHA * 0.5 : GHOST_ALPHA;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  for (let b = 0; b < 3; b++) {
    const [r, g, bl] = STAR_DEFS[b].trail;
    ctx.strokeStyle = `rgba(${r},${g},${bl},${alpha})`;
    ctx.beginPath();
    ghost[b].forEach((p, k) => {
      const c = toCanvas(p, camera);
      if (k === 0) ctx.moveTo(c[0], c[1]);
      else ctx.lineTo(c[0], c[1]);
    });
    ctx.stroke();
  }
}

function formatPct(fraction) {
  const pct = fraction * 100;
  if (pct < 0.01) return '<0.01%';
  return pct < 10 ? `${pct.toFixed(2)}%` : `${pct.toFixed(0)}%`;
}

/** Sim time shown at a playback moment, chase phase only (the chase is uniformly paced). */
function chaseSimTime(run, tSeconds) {
  const chaseEnd = run.schedule.resolvedAtPlaybackSeconds;
  return chaseEnd > 0 ? (Math.min(tSeconds, chaseEnd) / chaseEnd) * run.record.resolvedAtSimTime : 0;
}

function drawPresetHud(run, tSeconds) {
  const { preset, overlay } = run;
  const simTime = chaseSimTime(run, tSeconds);
  const d = overlay.maxDriftAt(simTime);
  const broken = simTime >= overlay.brokenAtSimTime;
  const driftText = formatPct(d);
  ctx.font = '11px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(207,211,230,0.6)';
  const kindText = preset.kind === 'moving-periodic' ? 'published periodic orbit, moving start' : 'published periodic free-fall orbit';
  ctx.fillText(`experimental preset: ${preset.label} (${kindText})`, 10, 10);
  ctx.fillStyle = broken ? 'rgba(255,150,90,0.85)' : 'rgba(150,230,170,0.85)';
  const status = broken ? 'pattern broken -- ordinary chaos now' : 'holding the pattern';
  ctx.fillText(`period ${(simTime / presetPeriod(preset)).toFixed(1)}  ·  max drift ${driftText}  ·  ${status}`, 10, 25);
}

// --- experimental hierarchical-triple preset (see src/hierarchicalTriples.js) ---
// Not a periodic orbit, so there's no single closed pattern to ghost or to measure drift
// against (the inner binary's loops never line up with the outer orbit the same way twice).
// Instead the ghost is the outer star's ideal Kepler ellipse (what it would trace forever
// around a point-mass pair), and the HUD counts nominal inner/outer orbits and says whether the
// hierarchy is still intact: inner separation and outer distance inside their Keplerian
// [periapsis, apoapsis] ranges, widened by HIERARCHY_BAND.

/** First sim time at which the triple leaves its Keplerian band (Infinity if it never does). */
function buildHierarchyOverlay(preset, record) {
  const { innerPair: [a, b], outer, masses, aIn, eIn, aOut, eOut } = preset;
  const m12 = masses[a] + masses[b];
  const dLo = aIn * (1 - eIn) * HIERARCHY_BAND.innerLow;
  const dHi = aIn * (1 + eIn) * HIERARCHY_BAND.innerHigh;
  const RLo = aOut * (1 - eOut) * HIERARCHY_BAND.outerLow;
  const RHi = aOut * (1 + eOut) * HIERARCHY_BAND.outerHigh;
  let brokenAtSimTime = Infinity;
  for (const { t, positions: p } of record.trajectory) {
    if (t > record.resolvedAtSimTime) break;
    const d = Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1]);
    const cx = (p[a][0] * masses[a] + p[b][0] * masses[b]) / m12;
    const cy = (p[a][1] * masses[a] + p[b][1] * masses[b]) / m12;
    const R = Math.hypot(p[outer][0] - cx, p[outer][1] - cy);
    if (d < dLo || d > dHi || R < RLo || R > RHi) {
      brokenAtSimTime = t;
      break;
    }
  }
  // Ideal outer ellipse in the barycentric frame: the outer star sits at (m12 / M) of the
  // pair-to-star vector, with the barycentre (the view's fixed centre) at the focus. Periapsis
  // is along +x, where the preset starts it.
  const M = masses.reduce((s, m) => s + m, 0);
  const k = m12 / M;
  const bary = centreOfMass(record.trajectory[0].positions, masses);
  const ghost = [];
  for (let s = 0; s <= GHOST_SAMPLES; s++) {
    const nu = (2 * Math.PI * s) / GHOST_SAMPLES;
    const r = (aOut * (1 - eOut * eOut)) / (1 + eOut * Math.cos(nu));
    ghost.push([bary[0] + k * r * Math.cos(nu), bary[1] + k * r * Math.sin(nu)]);
  }
  return { brokenAtSimTime, ghost };
}

function drawHierarchyGhost(run, camera, tSeconds) {
  const { ghost, brokenAtSimTime } = run.overlay;
  const alpha = chaseSimTime(run, tSeconds) >= brokenAtSimTime ? GHOST_ALPHA * 0.5 : GHOST_ALPHA;
  const [r, g, b] = STAR_DEFS[run.preset.outer].trail;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
  ctx.beginPath();
  ghost.forEach((p, k) => {
    const c = toCanvas(p, camera);
    if (k === 0) ctx.moveTo(c[0], c[1]);
    else ctx.lineTo(c[0], c[1]);
  });
  ctx.stroke();
}

function drawHierarchyHud(run, tSeconds) {
  const { preset, overlay } = run;
  const simTime = chaseSimTime(run, tSeconds);
  const broken = simTime >= overlay.brokenAtSimTime;
  ctx.font = '11px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(207,211,230,0.6)';
  ctx.fillText(`experimental preset: ${preset.label} (constructed Keplerian orbits)`, 10, 10);
  ctx.fillStyle = broken ? 'rgba(255,150,90,0.85)' : 'rgba(150,230,170,0.85)';
  const status = broken ? 'hierarchy broken -- ordinary chaos now' : 'hierarchy holding';
  ctx.fillText(
    `outer orbit ${(simTime / preset.Pout).toFixed(1)}  ·  inner orbit ${Math.floor(simTime / preset.Pin)}  ·  ${status}`,
    10,
    25
  );
}

// Current run, exposed for poking at from the console (e.g. debugSeek(4.2) to freeze on a
// frame). Debug harness only.
let current = null;

/** `fullRecord` (moving-periodic presets only): the engine's whole run, when `record` is just the
 *  natural-speed clip being played -- the overlay/info report on the whole run. */
function animate(record, schedule, preset = null, fullRecord = record) {
  const run = {
    ...prepareRun(record, schedule),
    preset,
    fullRecord,
    overlay: !preset
      ? null
      : preset.kind === 'hierarchical'
        ? buildHierarchyOverlay(preset, record)
        : buildPresetOverlay(preset, fullRecord),
  };
  current = run;
  view.play(run, {
    onEnd: () => {
      const ending = record.clipPeriods
        ? `still on the pattern -- clip ends after ${record.clipPeriods} periods (no outcome: see above)`
        : record.outcome;
      info.textContent = formatInfo(run) + `\n\n>>> ${ending} <<<`;
      hint.textContent = 'done -- RUN to replay, or clear placement to place new stars';
    },
  });
}

window.debugSeek = (t) => {
  if (!current) return null;
  view.stop();
  const { record, schedule, pairHalfWidth } = current;
  view.drawFrame(current, Math.min(t, Math.max(schedule.durationSeconds + COLLISION_FLASH_SECONDS, runEndSeconds(current))));
  info.textContent = formatInfo(current) + '\n\n(paused by debugSeek)';
  hint.textContent = 'paused (debugSeek) -- RUN to replay';
  return {
    outcome: record.outcome,
    duration: schedule.durationSeconds,
    resolvedAt: schedule.resolvedAtPlaybackSeconds,
    pairHalfWidth,
  };
};
window.debugCurrent = () => current;
window.debugRun = (positions) => {
  placed = positions;
  placedPreset = null;
  drawIdle();
  runWith(positions);
  return window.debugSeek(0);
};

/** `reveal` = false while playing: the outcome (and a preset's break point) stays hidden until
 *  the clip ends, so the info panel doesn't spoil what's about to happen on the canvas. */
function formatInfo(run, reveal = true) {
  const { record, schedule, preset, overlay } = run;
  const lines = [];
  if (preset && preset.kind === 'hierarchical') {
    const outerAt = (t) => (t / preset.Pout).toFixed(2);
    lines.push(
      `EXPERIMENTAL PRESET: ${preset.label} -- ${preset.citation}`,
      `masses (yellow, blue, red): ${record.masses.join(', ')}   inner pair: ${preset.innerPair.map((i) => STAR_DEFS[i].name).join(' + ')}, outer: ${STAR_DEFS[preset.outer].name}`,
      `inner orbit a = ${preset.aIn}, e = ${preset.eIn} (Kepler period ${preset.Pin.toFixed(4)})   ` +
        `outer orbit a = ${preset.aOut}, e = ${preset.eOut} (Kepler period ${preset.Pout.toFixed(4)})   a_out / a_in = ${(preset.aOut / preset.aIn).toFixed(2)}`
    );
    if (reveal) {
      lines.push(
        Number.isFinite(overlay.brokenAtSimTime)
          ? `held the hierarchy for ${outerAt(overlay.brokenAtSimTime)} outer orbits (${Math.floor(overlay.brokenAtSimTime / preset.Pin)} inner), ` +
              `then ordinary chaos until ${record.outcome} at outer orbit ${outerAt(record.resolvedAtSimTime)}`
          : `still hierarchical when the run ended at outer orbit ${outerAt(record.resolvedAtSimTime)}`
      );
    }
    lines.push('');
  } else if (preset && preset.kind === 'moving-periodic') {
    const T = preset.Tsim;
    const full = run.fullRecord;
    const fmtV = (arr) => arr.map((p) => `(${p[0]}, ${p[1]})`).join(' ');
    lines.push(
      `EXPERIMENTAL PRESET: ${preset.label} -- ${preset.citation}`,
      `reference image cell ${preset.refCell}   masses (yellow, blue, red): ${record.masses.join(', ')}`,
      `published: T = ${preset.T}${preset.E !== null ? `, E = ${preset.E}` : ''}, L = ${preset.L}   ` +
        `(shown at scale s = ${preset.scale}: r*s, v/sqrt(s), so T_sim = s^1.5 T = ${T.toFixed(4)})`,
      `published i.c. (body order as published) -- positions: ${fmtV(preset.bodies)}`,
      `                                           velocities: ${fmtV(preset.publishedVelocities)}`
    );
    if (reveal) {
      const ranPeriods = (full.resolvedAtSimTime / T).toFixed(2);
      const cutoffReached = full.outcome === 'BREAKAWAY' && full.epilogueEndSimTime === full.resolvedAtSimTime;
      lines.push(
        Number.isFinite(overlay.brokenAtSimTime)
          ? `held the pattern (<${PATTERN_BROKEN_DRIFT * 100}% drift) for ${(overlay.brokenAtSimTime / T).toFixed(2)} periods, ` +
              `then ordinary chaos until ${full.outcome} at period ${ranPeriods}`
          : `held the pattern (<${PATTERN_BROKEN_DRIFT * 100}% drift) for all ${ranPeriods} periods the engine ran ` +
              (cutoffReached
                ? `-- it never resolved, so simulate() stopped at its cutoff (${MAX_CROSSING_TIMES} crossing times or its wall-clock cap) ` +
                  `and returned its forced fallback label "${full.outcome}"; that is NOT a real breakaway`
                : `-- then ${full.outcome}`),
        `max drift over the whole run: ${formatPct(overlay.maxDriftAt(full.resolvedAtSimTime))}   ` +
          `drift at t = T, 2T, ...: ${overlay.periodDrifts.slice(0, 12).map(formatPct).join('  ')}` +
          (overlay.periodDrifts.length > 12 ? `  ...  ${overlay.periodDrifts.slice(-3).map(formatPct).join('  ')}` : ''),
        record.clipPeriods
          ? `the clip plays the first ${record.clipPeriods} periods at natural speed (the whole run would be compressed x${((full.resolvedAtSimTime * BASE_SECONDS_PER_SIM_TIME) / PRESET_PLAYBACK_MAX_SECONDS).toFixed(1)} into ${PRESET_PLAYBACK_MAX_SECONDS}s)`
          : 'the clip plays the whole run'
      );
    }
    lines.push('');
    if (!reveal) {
      lines.push(`outcome: (shown when the clip ends)`, `crossingTime: ${record.crossingTime.toFixed(4)}`, `retriesUsed: ${record.retriesUsed}`);
      return lines.join('\n');
    }
    lines.push(
      `engine run: outcome label ${full.outcome}, resolvedAtSimTime ${full.resolvedAtSimTime.toFixed(4)}, crossingTime ${full.crossingTime.toFixed(4)}, ` +
        `steps ${full.stepsTaken}, energy error ${full.energyError.toExponential(1)}, retriesUsed ${full.retriesUsed}`,
      `playback duration: ${schedule.durationSeconds.toFixed(2)}s (chase compression x${schedule.compressionMultiplier.toFixed(2)})`
    );
    return lines.join('\n');
  } else if (preset && !reveal) {
    lines.push(
      `EXPERIMENTAL PRESET: ${preset.label} -- ${preset.citation}`,
      `masses (yellow, blue, red): ${record.masses.join(', ')}   published period T = ${preset.T.toFixed(4)}`,
      ''
    );
  } else if (preset) {
    lines.push(
      `EXPERIMENTAL PRESET: ${preset.label} -- ${preset.citation}`,
      `masses (yellow, blue, red): ${record.masses.join(', ')}   published period T = ${preset.T.toFixed(4)}`,
      Number.isFinite(overlay.brokenAtSimTime)
        ? `held the pattern (<${PATTERN_BROKEN_DRIFT * 100}% drift) for ${(overlay.brokenAtSimTime / preset.T).toFixed(2)} periods, ` +
            `then ordinary chaos until ${record.outcome} at period ${(record.resolvedAtSimTime / preset.T).toFixed(2)}`
        : `still on the pattern (<${PATTERN_BROKEN_DRIFT * 100}% drift) when the run resolved at period ${(record.resolvedAtSimTime / preset.T).toFixed(2)}`,
      `drift at t = T, 2T, ...: ${overlay.periodDrifts.map(formatPct).join('  ')}`,
      ''
    );
  }
  if (!reveal) {
    lines.push(`outcome: (shown when the clip ends)`, `crossingTime: ${record.crossingTime.toFixed(4)}`, `retriesUsed: ${record.retriesUsed}`);
    return lines.join('\n');
  }
  lines.push(
    `outcome: ${record.outcome}`,
    `pair: ${record.pair ? record.pair.map((i) => STAR_DEFS[i].name).join(', ') : '-'}`,
    `single: ${record.single !== null && record.single !== undefined ? STAR_DEFS[record.single].name : '-'}`,
    `resolvedAtSimTime: ${record.resolvedAtSimTime.toFixed(4)}`,
    `epilogueEndSimTime: ${record.epilogueEndSimTime.toFixed(4)}`,
    `crossingTime: ${record.crossingTime.toFixed(4)}`,
    `trajectory samples: ${record.trajectory.length}`,
    `retriesUsed: ${record.retriesUsed}`,
    `playback duration: ${schedule.durationSeconds.toFixed(2)}s (resolved at ${schedule.resolvedAtPlaybackSeconds.toFixed(2)}s, chase compression x${schedule.compressionMultiplier.toFixed(2)}, epilogue time-warp x${schedule.epilogueTimeWarp.toFixed(3)})`
  );
  return lines.join('\n');
}

function runWith(positions) {
  view.stop();
  const record = simulate(positions);
  const schedule = getPlaybackSchedule(record);
  animate(record, schedule);
  info.textContent = formatInfo(current, false) + '\n\nplaying...';
  hint.textContent = 'playing...';
}

/** Experimental: run a published free-fall periodic orbit through the same, unmodified engine.
 *  The only differences from a normal run are the preset's own masses, no nudge-and-retry (a
 *  nudged start would simply be a different, non-periodic configuration), and a longer
 *  playback cap so a long dance isn't sped up as much. The constructed hierarchical triple and
 *  the moving-start published orbits are run the same way, plus their starting velocities (the
 *  free-fall presets have none); the latter are then played as a natural-speed clip if they
 *  never leave the pattern (see stableOrbitClip). */
function runPreset(preset) {
  view.stop();
  placed = preset.positions.map((p) => [p[0], p[1]]);
  placedPreset = preset;
  const record = simulate(placed, { masses: preset.masses, maxRetries: 0, initialVelocities: preset.velocities });
  const played = preset.kind === 'moving-periodic' ? stableOrbitClip(preset, record) : record;
  const schedule = getPlaybackSchedule(played, { maxPlaybackSeconds: PRESET_PLAYBACK_MAX_SECONDS });
  animate(played, schedule, preset, record);
  info.textContent = formatInfo(current, false) + '\n\nplaying...';
  const ghostNote =
    preset.kind === 'hierarchical'
      ? "Faint ellipse = the outer star's ideal Kepler orbit."
      : preset.kind === 'moving-periodic'
        ? 'Faint lines = one full period of the published orbit.'
        : 'Faint lines = the published pattern.';
  hint.textContent = `experimental preset -- ${preset.label}: ${preset.blurb} ${ghostNote}`;
}

/** Moving-start periodic orbits are linearly stable, so the engine usually runs them until its
 *  own cutoff (~50-140 periods) without an outcome. Squeezing that whole run into the 45 s
 *  preset clip would strobe at ~0.3-1 s per period, so instead -- only when the run never left
 *  the pattern AND never resolved on its own -- play the first whole periods that fit in the
 *  clip at natural speed. This only trims what's *shown*: the physics run is untouched, and the
 *  info panel reports on the whole run (fullRecord). If the orbit ever does break or resolve,
 *  the whole run is played like every other preset. */
function stableOrbitClip(preset, record) {
  const T = preset.Tsim;
  const overlay = buildPresetOverlay(preset, record);
  const forcedFallback = record.outcome === 'BREAKAWAY' && record.epilogueEndSimTime === record.resolvedAtSimTime;
  if (Number.isFinite(overlay.brokenAtSimTime) || !forcedFallback) return record;
  const fit = Math.floor(PRESET_PLAYBACK_MAX_SECONDS / (T * BASE_SECONDS_PER_SIM_TIME));
  const clipPeriods = Math.max(1, Math.min(fit, Math.floor(record.resolvedAtSimTime / T)));
  const end = clipPeriods * T;
  const trajectory = record.trajectory.filter((s) => s.t < end);
  trajectory.push({ t: end, positions: trajectoryAt(record.trajectory, end) });
  return {
    ...record,
    outcome: null, // no outcome inside the clip -- the stars are still on the pattern
    pair: null,
    single: null,
    trajectory,
    resolvedAtSimTime: end,
    epilogueEndSimTime: end,
    clipPeriods,
  };
}

runBtn.addEventListener('click', () => {
  if (placedPreset) {
    runPreset(placedPreset);
    return;
  }
  if (placed.length !== 3 || !isValidPlacement(placed, MIN_SEPARATION)) return;
  runWith(placed);
});

randomRunBtn.addEventListener('click', () => {
  placed = randomValidPlacement();
  placedPreset = null;
  drawIdle();
  runWith(placed);
});

for (const preset of ALL_PRESETS) {
  const btn = document.createElement('button');
  btn.textContent = preset.label;
  btn.title = `${preset.citation} -- ${preset.blurb}`;
  btn.addEventListener('click', () => runPreset(preset));
  presetBox.appendChild(btn);
}
window.debugPreset = (id) => {
  const preset = ALL_PRESETS.find((p) => p.id === id);
  if (!preset) return ALL_PRESETS.map((p) => p.id);
  runPreset(preset);
  return window.debugSeek(0);
};

drawIdle();
