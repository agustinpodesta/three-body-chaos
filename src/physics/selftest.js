// src/physics/selftest.js
// Runnable self-test for the physics engine (plain Node ESM): `node src/physics/selftest.js`
// Exercises simulate(), isValidPlacement(), and getPlaybackSchedule(); prints pass/fail and
// summary stats. Exits with code 1 if any check fails.

import { simulate, isValidPlacement } from './simulate.js';
import { getPlaybackSchedule } from './playback.js';
import { ENERGY_ERROR_THRESHOLD, MAX_CROSSING_TIMES, COLLISION_RADIUS } from './constants.js';
import { computeEnergy } from './integrator.js';
import { HIERARCHICAL_TRIPLES, HIERARCHY_BAND, buildHierarchicalTriple } from '../hierarchicalTriples.js';
import { NON_FREE_FALL_ORBITS } from '../nonFreeFallOrbits.js';

function randomPlacement() {
  // Rejection-sample until we get a placement the future UI would actually allow.
  while (true) {
    const positions = [
      [Math.random(), Math.random()],
      [Math.random(), Math.random()],
      [Math.random(), Math.random()],
    ];
    if (isValidPlacement(positions)) return positions;
  }
}

function closeTriangle(side = 0.13, center = [0.5, 0.5]) {
  // Equilateral triangle with the given side length -> all three pairwise distances equal
  // `side`, which sits inside the "close-placed, ~0.15 apart" band while still clearing
  // MIN_SEPARATION (0.12).
  const r = side / Math.sqrt(3);
  return [90, 210, 330].map((deg) => {
    const a = (deg * Math.PI) / 180;
    return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
  });
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(n, digits = 4) {
  return Number(n).toFixed(digits);
}

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) failures++;
}

console.log('=== three-body-chaos physics self-test ===\n');

// --- 1 & 5: random batch ---
const BATCH_SIZE = 25;
console.log(`Running ${BATCH_SIZE} random valid placements...`);
const t0 = Date.now();
const results = [];
for (let i = 0; i < BATCH_SIZE; i++) {
  const placement = randomPlacement();
  results.push(simulate(placement));
}
const batchMs = Date.now() - t0;
console.log(`  done in ${batchMs}ms\n`);

check(
  'all random runs resolved to COLLAPSE or BREAKAWAY (no crash, no hang)',
  results.every((r) => r.outcome === 'COLLAPSE' || r.outcome === 'BREAKAWAY')
);
check(
  'all random runs report a 2-element pair of indices',
  results.every((r) => Array.isArray(r.pair) && r.pair.length === 2)
);
check(
  'COLLAPSE runs have single=null, BREAKAWAY runs have a numeric single',
  results.every((r) => (r.outcome === 'COLLAPSE' ? r.single === null : Number.isInteger(r.single)))
);

const collapseCount = results.filter((r) => r.outcome === 'COLLAPSE').length;
const breakawayCount = results.filter((r) => r.outcome === 'BREAKAWAY').length;

// --- 2: energy conservation ---
const energyErrors = results.map((r) => r.energyError);
const maxEnergyError = Math.max(...energyErrors);
// Allow some slack beyond the guard threshold itself, since the guard only halves eta
// *after* detecting drift on a step -- it doesn't retroactively fix that step.
const energyTolerance = ENERGY_ERROR_THRESHOLD * 50;
check(
  `energy error stays within a reasonable multiple of ENERGY_ERROR_THRESHOLD (max=${fmt(maxEnergyError, 6)} <= ${fmt(energyTolerance, 6)})`,
  maxEnergyError <= energyTolerance
);

// --- 3: close-placed config resolves quickly ---
const close = closeTriangle();
check('close triangle respects MIN_SEPARATION (isValidPlacement)', isValidPlacement(close));
const closeRecord = simulate(close);
const closeCrossingTimes = closeRecord.resolvedAtSimTime / closeRecord.crossingTime;
check(
  `close-placed config resolves within a handful of crossing times (${fmt(closeCrossingTimes, 2)} crossing times, outcome=${closeRecord.outcome}, retries=${closeRecord.retriesUsed})`,
  closeCrossingTimes < 50
);

// --- 4: widely-spread config terminates cleanly ---
const wide = [
  [0.05, 0.05],
  [0.95, 0.05],
  [0.5, 0.95],
];
check('wide config respects MIN_SEPARATION (isValidPlacement)', isValidPlacement(wide));
const wideRecord = simulate(wide);
check(
  `wide config terminates cleanly within retry/cutoff bounds (outcome=${wideRecord.outcome}, retries=${wideRecord.retriesUsed}/5)`,
  (wideRecord.outcome === 'COLLAPSE' || wideRecord.outcome === 'BREAKAWAY') && wideRecord.retriesUsed <= 5
);

// --- published periodic orbits: integrator accuracy + the options used by curated presets ---
function positionAt(record, simTime) {
  const tr = record.trajectory;
  let k = 1;
  while (k < tr.length - 1 && tr[k].t < simTime) k++;
  const a = tr[k - 1];
  const b = tr[k];
  const f = (simTime - a.t) / (b.t - a.t || 1);
  return a.positions.map((p, i) => [p[0] + (b.positions[i][0] - p[0]) * f, p[1] + (b.positions[i][1] - p[1]) * f]);
}
function maxDisplacement(p, q) {
  return Math.max(...p.map((pi, i) => Math.hypot(pi[0] - q[i][0], pi[1] - q[i][1])));
}

// Standish's collisionless free-fall periodic orbit (masses 0.6/0.8/1, zero velocity; initial
// condition from Li & Liao 2019, arXiv:1805.07980, Table A5 F1(0.6,0.8,1), period T). It's
// unstable, so it must eventually break, but an accurate integrator keeps it on-pattern for
// the first few periods. (A self-contained fixture: its numbers are inlined here on purpose. It
// was once also a debug-harness preset, since removed; this check doesn't depend on that list.)
const STANDISH_T = 2.6925803371;
const standish = [[-0.5, 0], [0.5, 0], [0.2061730906, 0.4463433325]];
const standishRecord = simulate(standish, { masses: [0.6, 0.8, 1], maxRetries: 0 });
const standishDrift3 = maxDisplacement(positionAt(standishRecord, 3 * STANDISH_T), standish);
check(
  `published free-fall periodic orbit (Standish) returns to its start after 3 periods (drift=${standishDrift3.toExponential(1)} < 1e-2, outcome=${standishRecord.outcome} at ${fmt(standishRecord.resolvedAtSimTime / STANDISH_T, 2)} periods)`,
  standishRecord.resolvedAtSimTime > 3 * STANDISH_T && standishDrift3 < 1e-2
);
check('simulate() records the masses it ran with', standishRecord.masses.join(',') === '0.6,0.8,1');
check('maxRetries: 0 is honoured (no nudged retry)', standishRecord.retriesUsed === 0);

// options.initialVelocities: the Chenciner-Montgomery figure-eight (equal masses, non-zero
// start velocities, period T ~= 6.3259), shifted into the unit square. Never resolves on its
// own, so it runs to the per-attempt cutoff -- maxRetries: 0 keeps that to a single attempt.
const EIGHT_T = 6.32591398;
const eight = [[-0.97000436 + 0.5, 0.24308753 + 0.5], [0.97000436 + 0.5, -0.24308753 + 0.5], [0.5, 0.5]];
const eightV = [[0.466203685, 0.43236573], [0.466203685, 0.43236573], [-0.93240737, -0.86473146]];
const eightRecord = simulate(eight, { initialVelocities: eightV, maxRetries: 0 });
const eightDrift = maxDisplacement(positionAt(eightRecord, EIGHT_T), eight);
check(
  `options.initialVelocities is used (figure-eight returns to its start after one period, drift=${eightDrift.toExponential(1)} < 5e-3)`,
  eightRecord.trajectory[eightRecord.trajectory.length - 1].t > EIGHT_T && eightDrift < 5e-3
);

// --- constructed hierarchical triple (src/hierarchicalTriples.js) ---
// (a) The Keplerian construction itself: a very wide triple (a_out / a_in = 11) must start with
// zero net momentum, keep its barycentre fixed, and hold both orbits circular -- which is only
// true if the outer speed uses the total mass and the inner pair's centre of mass is given its
// own orbital velocity.
const hwMasses = [1, 1, 0.3];
const hwTriple = buildHierarchicalTriple({ masses: hwMasses, aIn: 0.05, aOut: 0.55 });
const hwMomentum = hwTriple.velocities.reduce(
  (s, v, i) => [s[0] + hwMasses[i] * v[0], s[1] + hwMasses[i] * v[1]],
  [0, 0]
);
const hwRecord = simulate(hwTriple.positions, { masses: hwMasses, initialVelocities: hwTriple.velocities, maxRetries: 0 });
let hwInnerDev = 0;
let hwOuterDev = 0;
let hwBaryDrift = 0;
for (const { t, positions: p } of hwRecord.trajectory) {
  if (t > 3 * hwTriple.Pout) break;
  const com = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
  hwInnerDev = Math.max(hwInnerDev, Math.abs(Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) / 0.05 - 1));
  hwOuterDev = Math.max(hwOuterDev, Math.abs(Math.hypot(p[2][0] - com[0], p[2][1] - com[1]) / 0.55 - 1));
  const bary = [0, 1].map((k) => (p[0][k] + p[1][k] + 0.3 * p[2][k]) / 2.3);
  hwBaryDrift = Math.max(hwBaryDrift, Math.hypot(bary[0] - 0.5, bary[1] - 0.5));
}
check(
  `hierarchical-triple construction: zero net momentum (|p|=${Math.hypot(...hwMomentum).toExponential(1)}), fixed barycentre (drift=${hwBaryDrift.toExponential(1)}), ` +
    `inner/outer separations stay circular over 3 outer periods (max deviation ${(hwInnerDev * 100).toFixed(2)}% / ${(hwOuterDev * 100).toFixed(2)}% < 1%)`,
  Math.hypot(...hwMomentum) < 1e-12 && hwBaryDrift < 1e-9 && hwInnerDev < 0.01 && hwOuterDev < 0.01
);

// (b) The actual preset: the inner pair's separation (and the outer star's distance from the
// pair) stay inside their Keplerian ranges -- the same band the harness HUD uses -- for many
// inner periods before the hierarchy breaks, and the run then resolves on its own (it doesn't
// just sit there until the engine's cutoff).
for (const preset of HIERARCHICAL_TRIPLES) {
  const rec = simulate(preset.positions, { masses: preset.masses, initialVelocities: preset.velocities, maxRetries: 0 });
  const [a, b] = preset.innerPair;
  const o = preset.outer;
  const m = preset.masses;
  const m12 = m[a] + m[b];
  let brokenAt = Infinity;
  for (const { t, positions: p } of rec.trajectory) {
    const d = Math.hypot(p[a][0] - p[b][0], p[a][1] - p[b][1]);
    const com = [0, 1].map((k) => (p[a][k] * m[a] + p[b][k] * m[b]) / m12);
    const R = Math.hypot(p[o][0] - com[0], p[o][1] - com[1]);
    const inBand =
      d >= preset.aIn * (1 - preset.eIn) * HIERARCHY_BAND.innerLow &&
      d <= preset.aIn * (1 + preset.eIn) * HIERARCHY_BAND.innerHigh &&
      R >= preset.aOut * (1 - preset.eOut) * HIERARCHY_BAND.outerLow &&
      R <= preset.aOut * (1 + preset.eOut) * HIERARCHY_BAND.outerHigh;
    if (!inBand) {
      brokenAt = t;
      break;
    }
  }
  const cutoff = rec.crossingTime * MAX_CROSSING_TIMES;
  check(
    `hierarchical preset "${preset.id}" holds its inner/outer orbits for >= 8 outer periods ` +
      `(held ${(brokenAt / preset.Pout).toFixed(2)} outer = ${Math.floor(brokenAt / preset.Pin)} inner periods, dE=${rec.energyError.toExponential(1)})`,
    brokenAt >= 8 * preset.Pout && rec.energyError < ENERGY_ERROR_THRESHOLD
  );
  check(
    `hierarchical preset "${preset.id}" then destabilizes and resolves before the engine cutoff ` +
      `(${rec.outcome} at outer period ${(rec.resolvedAtSimTime / preset.Pout).toFixed(2)}, cutoff at ${(cutoff / preset.Pout).toFixed(0)})`,
    Number.isFinite(brokenAt) && rec.resolvedAtSimTime < 0.98 * cutoff
  );
}

// --- published moving-start periodic orbits (src/nonFreeFallOrbits.js) ---
// (a) Transcription + display scaling: undoing the scale (E * s, L / sqrt(s)) must give back the
// published energy / angular momentum, with zero net momentum. (b) The figure-eight preset is
// the exact fixture validated above. (c) In the unmodified engine each one is linearly stable:
// it stays on its pattern (< 1% drift at each of the first 10 periods, < 5% over the whole run
// -- the harness's "pattern broken" threshold), never comes anywhere near COLLISION_RADIUS
// (no false COLLAPSE from a close-but-correct pass), and runs at least 10 periods without
// resolving (simulate() then returns its forced fallback label at the cutoff).
function trajAt(tr, t) {
  let lo = 0;
  let hi = tr.length - 1;
  if (t >= tr[hi].t) return tr[hi].positions;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (tr[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = tr[lo];
  const b = tr[hi];
  const f = (t - a.t) / (b.t - a.t || 1);
  return a.positions.map((p, i) => [p[0] + (b.positions[i][0] - p[0]) * f, p[1] + (b.positions[i][1] - p[1]) * f]);
}
for (const preset of NON_FREE_FALL_ORBITS) {
  const { positions: p, velocities: v, masses: m, scale: s, Tsim: T } = preset;
  const E = computeEnergy(p, v, m) * s;
  const L = p.reduce((sum, q, i) => sum + m[i] * ((q[0] - 0.5) * -v[i][1] - -(q[1] - 0.5) * v[i][0]), 0) / Math.sqrt(s);
  const P = Math.hypot(...[0, 1].map((k) => v.reduce((sum, w, i) => sum + m[i] * w[k], 0)));
  check(
    `moving-start preset "${preset.id}": i.c. reproduce the published E/L after undoing the x${s} display scale ` +
      `(E=${E.toFixed(6)} vs ${preset.E ?? 'n/a'}, L=${L.toFixed(6)} vs ${preset.L}, |p|=${P.toExponential(1)})`,
    (preset.E === null || Math.abs(E - preset.E) < 2e-6) && Math.abs(L - preset.L) < 2e-6 && P < 1e-9
  );

  const rec = simulate(p, { masses: m, initialVelocities: v, maxRetries: 0 });
  const tr = rec.trajectory;
  const tEnd = tr[tr.length - 1].t;
  const size = Math.max(...[[0, 1], [1, 2], [0, 2]].map(([i, j]) => Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1])));
  const drift = (t) => {
    const now = trajAt(tr, t);
    const ref = trajAt(tr, t % T);
    return Math.max(...now.map((q, i) => Math.hypot(q[0] - ref[i][0], q[1] - ref[i][1]))) / size;
  };
  const firstTen = Array.from({ length: 10 }, (_, k) => drift((k + 1) * T));
  let maxDrift = 0;
  for (let t = 0; t <= tEnd; t += T / 50) maxDrift = Math.max(maxDrift, drift(t));
  let minSep = Infinity;
  for (const { positions: q } of tr) {
    for (const [i, j] of [[0, 1], [1, 2], [0, 2]]) minSep = Math.min(minSep, Math.hypot(q[i][0] - q[j][0], q[i][1] - q[j][1]));
  }
  const forcedFallback = rec.outcome === 'BREAKAWAY' && rec.epilogueEndSimTime === rec.resolvedAtSimTime;
  check(
    `moving-start preset "${preset.id}" stays on its pattern for the whole engine run: ${(tEnd / T).toFixed(1)} periods, ` +
      `drift ${(Math.max(...firstTen) * 100).toFixed(2)}% max over periods 1-10 (< 1%), ${(maxDrift * 100).toFixed(2)}% over the run (< 5%), ` +
      `min separation ${minSep.toExponential(1)} (>> COLLISION_RADIUS ${COLLISION_RADIUS}), unresolved -> forced ${rec.outcome}, dE=${rec.energyError.toExponential(1)}`,
    tEnd >= 10 * T && Math.max(...firstTen) < 0.01 && maxDrift < 0.05 && minSep > 1e3 * COLLISION_RADIUS && forcedFallback && rec.energyError < ENERGY_ERROR_THRESHOLD
  );
}
const eightPreset = NON_FREE_FALL_ORBITS.find((o) => o.id === 'figure-eight');
check(
  'figure-eight preset uses exactly the fixture numbers validated above',
  eightPreset.bodies.every((b, i) => Math.abs(b[0] + 0.5 - eight[i][0]) < 1e-15 && Math.abs(b[1] + 0.5 - eight[i][1]) < 1e-15) &&
    JSON.stringify(eightPreset.publishedVelocities) === JSON.stringify(eightV) &&
    eightPreset.T === EIGHT_T
);

// --- playback sanity ---
const durations = results.map((r) => getPlaybackSchedule(r).durationSeconds);
check('all playback durations are finite and > 0', durations.every((d) => Number.isFinite(d) && d > 0));

const closeSchedule = getPlaybackSchedule(closeRecord);
const midSample = closeSchedule.sampleAt(closeSchedule.durationSeconds / 2);
check(
  'sampleAt() returns three [x,y] positions at an arbitrary playback time',
  Array.isArray(midSample) && midSample.length === 3 && midSample.every((p) => p.length === 2)
);
const endSample = closeSchedule.sampleAt(closeSchedule.durationSeconds + 5); // beyond duration
check('sampleAt() clamps gracefully past the end of playback', Array.isArray(endSample) && endSample.length === 3);

// --- summary ---
const avgRetries = results.reduce((a, r) => a + r.retriesUsed, 0) / results.length;
const avgEnergyError = energyErrors.reduce((a, b) => a + b, 0) / energyErrors.length;

console.log('\n--- Summary ---');
console.log(
  `Outcomes: ${collapseCount} COLLAPSE / ${breakawayCount} BREAKAWAY out of ${BATCH_SIZE} ` +
    `(${fmt((collapseCount / BATCH_SIZE) * 100, 1)}% / ${fmt((breakawayCount / BATCH_SIZE) * 100, 1)}%)`
);
console.log(`Average retries used: ${fmt(avgRetries, 2)}`);
console.log(
  `Energy error (relative): min=${fmt(Math.min(...energyErrors), 6)} ` +
    `median=${fmt(median(energyErrors), 6)} mean=${fmt(avgEnergyError, 6)} max=${fmt(maxEnergyError, 6)}`
);
console.log(
  `Playback durations (s): min=${fmt(Math.min(...durations), 2)} ` +
    `median=${fmt(median(durations), 2)} max=${fmt(Math.max(...durations), 2)}`
);
console.log(
  `Close-placed config: outcome=${closeRecord.outcome}, resolvedAtSimTime=${fmt(closeRecord.resolvedAtSimTime, 4)}, ` +
    `crossingTimes=${fmt(closeCrossingTimes, 2)}, playbackSeconds=${fmt(closeSchedule.durationSeconds, 2)}`
);
console.log(
  `Wide config: outcome=${wideRecord.outcome}, resolvedAtSimTime=${fmt(wideRecord.resolvedAtSimTime, 4)}, ` +
    `retries=${wideRecord.retriesUsed}`
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
