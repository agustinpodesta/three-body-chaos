// src/presetRunner.js
// The experimental orbit presets, packaged for the product page (src/main.js), where they are
// hidden behind D-pad codes. The preset DATA is not duplicated: it is imported from the same
// three modules the debug harness uses (periodicOrbits.js, hierarchicalTriples.js,
// nonFreeFallOrbits.js). The run MECHANISM below -- simulate() with the preset's own masses /
// starting velocities and maxRetries: 0, the natural-speed clip for linearly stable moving-start
// orbits, the 45 s preset playback cap, the "ghost" of the published pattern, and the
// holding / broken test -- is a line-for-line copy of src/debug.js's runPreset() path
// (runPreset, animate, stableOrbitClip, buildPresetOverlay, buildHierarchyOverlay, drawGhost,
// drawHierarchyGhost, chaseSimTime). It is copied rather than shared because debug.js is
// deliberately left untouched; if the two ever need to change together, the next step is to
// have debug.js import these functions from here.
//
// What differs is only the presentation: the harness draws a small monospace HUD onto the
// canvas and fills an info panel, while the product page shows the same facts (period count,
// holding / broken, the outcome) in its own pixel-font screen text -- see presetProgress() and
// presetSummary().

import { simulate, getPlaybackSchedule, constants } from './physics/index.js';
import { STAR_DEFS, prepareRun, centreOfMass } from './simCore.js';
import { PERIODIC_ORBITS } from './periodicOrbits.js';
import { HIERARCHICAL_TRIPLES, HIERARCHY_BAND } from './hierarchicalTriples.js';
import { NON_FREE_FALL_ORBITS } from './nonFreeFallOrbits.js';

const { BASE_SECONDS_PER_SIM_TIME } = constants;

export const ALL_PRESETS = [...PERIODIC_ORBITS, ...HIERARCHICAL_TRIPLES, ...NON_FREE_FALL_ORBITS];

// Same values as src/debug.js.
const PRESET_PLAYBACK_MAX_SECONDS = 45;
const PATTERN_BROKEN_DRIFT = 0.05;
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

/** A published orbit's period in the engine's sim-time units. */
function presetPeriod(preset) {
  return preset.kind === 'moving-periodic' ? preset.Tsim : preset.T;
}

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
  const moving = preset.kind === 'moving-periodic';
  const ghostSpan = moving ? T : T / 2;
  const ghostSamples = moving ? GHOST_SAMPLES * 4 : GHOST_SAMPLES;
  const ghost = [[], [], []];
  for (let s = 0; s <= ghostSamples; s++) {
    const p = trajectoryAt(traj, ghostSpan * (s / ghostSamples));
    for (let b = 0; b < 3; b++) ghost[b].push(p);
  }
  for (let b = 0; b < 3; b++) ghost[b] = ghost[b].map((p) => p[b]);
  const periodDrifts = [];
  for (let k = 1; k * T <= record.resolvedAtSimTime; k++) periodDrifts.push(drift(k * T));
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

/** Sim time shown at a playback moment, chase phase only (the chase is uniformly paced). */
function chaseSimTime(run, tSeconds) {
  const chaseEnd = run.schedule.resolvedAtPlaybackSeconds;
  return chaseEnd > 0 ? (Math.min(tSeconds, chaseEnd) / chaseEnd) * run.record.resolvedAtSimTime : 0;
}

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
    outcome: null,
    pair: null,
    single: null,
    trajectory,
    resolvedAtSimTime: end,
    epilogueEndSimTime: end,
    clipPeriods,
  };
}

/** Run a preset exactly as debug.js's runPreset() + animate() do, and return the prepared run
 *  (ready for view.play). Synchronous; takes up to ~1 s for the orbits that run to the engine's
 *  cutoff. */
export function preparePresetRun(preset) {
  const positions = preset.positions.map((p) => [p[0], p[1]]);
  const record = simulate(positions, { masses: preset.masses, maxRetries: 0, initialVelocities: preset.velocities });
  const played = preset.kind === 'moving-periodic' ? stableOrbitClip(preset, record) : record;
  const schedule = getPlaybackSchedule(played, { maxPlaybackSeconds: PRESET_PLAYBACK_MAX_SECONDS });
  return {
    ...prepareRun(played, schedule),
    preset,
    fullRecord: record,
    overlay:
      preset.kind === 'hierarchical' ? buildHierarchyOverlay(preset, played) : buildPresetOverlay(preset, record),
  };
}

/** The faint published-pattern ghost (or, for the hierarchical triple, the outer star's ideal
 *  Kepler ellipse), for createSimView's `underlay` hook. Same drawing as the harness. */
export function drawPresetGhost(view, run, camera, tSeconds) {
  const { ctx, toCanvas } = view;
  const { ghost, brokenAtSimTime } = run.overlay;
  const alpha = chaseSimTime(run, tSeconds) >= brokenAtSimTime ? GHOST_ALPHA * 0.5 : GHOST_ALPHA;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  const paths =
    run.preset.kind === 'hierarchical'
      ? [{ points: ghost, rgb: STAR_DEFS[run.preset.outer].trail }]
      : ghost.map((points, b) => ({ points, rgb: STAR_DEFS[b].trail }));
  for (const { points, rgb } of paths) {
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    ctx.beginPath();
    points.forEach((p, k) => {
      const c = toCanvas(p, camera);
      if (k === 0) ctx.moveTo(c[0], c[1]);
      else ctx.lineTo(c[0], c[1]);
    });
    ctx.stroke();
  }
}

/** One-line description of the preset, for the screen banner under its name. */
export function presetKindText(preset) {
  if (preset.kind === 'hierarchical') return 'CONSTRUCTED KEPLER ORBITS';
  if (preset.kind === 'moving-periodic') return 'PERIODIC ORBIT - IN MOTION';
  return 'PERIODIC ORBIT - FREE FALL';
}

/** Live status at a playback moment -- the facts the harness HUD shows (period / orbit count,
 *  holding or broken). */
export function presetProgress(run, tSeconds) {
  const { preset, overlay } = run;
  const simTime = chaseSimTime(run, tSeconds);
  const broken = simTime >= overlay.brokenAtSimTime;
  if (preset.kind === 'hierarchical') {
    return {
      count: `OUTER ORBIT ${(simTime / preset.Pout).toFixed(1)}`,
      state: broken ? 'HIERARCHY BROKEN' : 'HIERARCHY HOLDING',
      broken,
    };
  }
  return {
    count: `PERIOD ${(simTime / presetPeriod(preset)).toFixed(1)}`,
    state: broken ? 'PATTERN BROKEN' : 'HOLDING THE PATTERN',
    broken,
  };
}

/** How the run ended, in the harness's terms: `clipPeriods` when a stable orbit's clip ended
 *  with no outcome, otherwise how long it held its pattern before the outcome. */
export function presetSummary(run) {
  const { preset, overlay, record } = run;
  if (record.clipPeriods) return { clipPeriods: record.clipPeriods };
  const held = overlay.brokenAtSimTime;
  if (preset.kind === 'hierarchical') {
    return {
      held: Number.isFinite(held) ? `HELD ${(held / preset.Pout).toFixed(1)} OUTER ORBITS` : 'NEVER LEFT ITS ORBITS',
    };
  }
  return {
    held: Number.isFinite(held) ? `HELD ${(held / presetPeriod(preset)).toFixed(1)} PERIODS` : 'NEVER LEFT THE PATTERN',
  };
}
