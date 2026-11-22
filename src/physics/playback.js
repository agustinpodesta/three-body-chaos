// src/physics/playback.js
// Maps a completed simulation record to a real-time playback schedule.
//
// Product/design principle (see constants.js BASE_SECONDS_PER_SIM_TIME comment for the
// numeric reasoning): the CHASE phase (up to the resolution moment) stays honest/causal,
// never artificially padded -- a fast collision plays back fast, and the only compression
// applied is capping the rare long tail (a uniform speed-up, never a slow-down/stretch); any
// padding to reach the overall legibility floor holds the final frame rather than slowing
// motion. The BREAKAWAY EPILOGUE is a deliberate, scoped exception: it's a short showcase of
// the surviving pair settling into orbit, explicitly requested as a cinematic beat, and a
// tightly-bound pair's true orbital period can be too fast to read at honest speed (sometimes
// a small fraction of a second) -- so the epilogue is time-warped (sped up OR slowed down) to
// fill its own reserved window, so real orbital motion is visible throughout it rather than
// holding on a frozen frame.

import {
  BASE_SECONDS_PER_SIM_TIME,
  MAX_PLAYBACK_SECONDS,
  MIN_PLAYBACK_SECONDS,
  EPILOGUE_MIN_SECONDS,
  EPILOGUE_MAX_SECONDS,
  MIN_CHASE_SECONDS,
} from './constants.js';

/** Linear interpolation of body positions at `simTime` within a trajectory whose samples are
 *  naturally, non-uniformly spaced in time (dense during fast/close-encounter motion, sparse
 *  when calm -- see simulate.js). Binary search locates the bracketing pair; no assumption of
 *  fixed spacing. */
function interpolateTrajectory(trajectory, simTime) {
  const n = trajectory.length;
  if (n === 1) return trajectory[0].positions;

  const first = trajectory[0];
  const last = trajectory[n - 1];
  if (simTime <= first.t) return first.positions;
  if (simTime >= last.t) return last.positions;

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trajectory[mid].t <= simTime) lo = mid;
    else hi = mid;
  }
  const a = trajectory[lo];
  const b = trajectory[hi];
  const span = b.t - a.t;
  const frac = span > 0 ? (simTime - a.t) / span : 0;

  return a.positions.map((p, k) => [
    p[0] + (b.positions[k][0] - p[0]) * frac,
    p[1] + (b.positions[k][1] - p[1]) * frac,
  ]);
}

/**
 * Maps a simulation record to a real-time playback schedule, in two independently-budgeted
 * phases: the "chase" (0 .. resolvedAtSimTime) and, for BREAKAWAY, an "epilogue" (resolvedAt..
 * epilogueEndSimTime) covering the remaining pair settling into orbit. The epilogue gets a
 * reserved slice of screen time (EPILOGUE_MIN_SECONDS..EPILOGUE_MAX_SECONDS) independent of
 * how long/compressed the chase was -- otherwise a long chaotic chase could eat the whole
 * MAX_PLAYBACK_SECONDS budget and leave a camera move into the epilogue almost no time to
 * read. Each phase keeps the "honest pacing" rule on its own terms: motion is only ever sped
 * up to fit its budget, never slowed down; any padding to reach a phase's minimum happens by
 * holding the final frame of that phase, not by slowing the motion within it.
 *
 * @param {object} record - a simulate() result (needs resolvedAtSimTime, epilogueEndSimTime,
 *   and trajectory). For COLLAPSE, epilogueEndSimTime equals resolvedAtSimTime (no epilogue).
 * @param {object} [options] - override the module-default pacing constants (mainly for
 *   testing; the real caller should just use the defaults from constants.js).
 * @returns {{ durationSeconds: number, compressionMultiplier: number, resolvedAtPlaybackSeconds: number, sampleAt: (t:number) => Array<[number,number]> }}
 */
export function getPlaybackSchedule(record, options = {}) {
  const baseScale = options.baseSecondsPerSimTime ?? BASE_SECONDS_PER_SIM_TIME;
  const maxSeconds = options.maxPlaybackSeconds ?? MAX_PLAYBACK_SECONDS;
  const minSeconds = options.minPlaybackSeconds ?? MIN_PLAYBACK_SECONDS;
  const epilogueMinSeconds = options.epilogueMinSeconds ?? EPILOGUE_MIN_SECONDS;
  const epilogueMaxSeconds = options.epilogueMaxSeconds ?? EPILOGUE_MAX_SECONDS;
  const minChaseSeconds = options.minChaseSeconds ?? MIN_CHASE_SECONDS;

  const epilogueSimSpan = Math.max(0, (record.epilogueEndSimTime ?? record.resolvedAtSimTime) - record.resolvedAtSimTime);
  const hasEpilogue = epilogueSimSpan > 0;

  // Reserve the epilogue's budget first (clamped to its own min/max), then give the chase
  // whatever's left of maxSeconds -- but never squeeze the chase below minChaseSeconds.
  const epilogueNaive = epilogueSimSpan * baseScale;
  const epilogueBudget = hasEpilogue ? Math.min(Math.max(epilogueNaive, epilogueMinSeconds), epilogueMaxSeconds) : 0;
  const chaseBudget = Math.max(maxSeconds - epilogueBudget, minChaseSeconds);

  const chaseNaive = record.resolvedAtSimTime * baseScale;
  let chaseCompressionMultiplier = 1;
  let chaseDuration = chaseNaive;
  if (chaseDuration > chaseBudget) {
    chaseCompressionMultiplier = chaseDuration / chaseBudget;
    chaseDuration = chaseBudget;
  }
  const chaseEffectiveScale = baseScale / chaseCompressionMultiplier;

  // The epilogue always fills exactly its reserved window: time-warped down (slow motion) if
  // its natural span is shorter than epilogueMinSeconds -- common for a tight, fast-orbiting
  // pair -- or sped up if longer than epilogueMaxSeconds. Either way real motion plays for the
  // whole window; nothing here is a frozen-frame hold.
  const epilogueDuration = hasEpilogue ? Math.min(Math.max(epilogueNaive, epilogueMinSeconds), epilogueMaxSeconds) : 0;
  const epilogueEffectiveScale = hasEpilogue ? epilogueDuration / epilogueSimSpan : baseScale;
  const epilogueTimeWarp = hasEpilogue ? epilogueEffectiveScale / baseScale : 1; // >1 = slow motion (more real seconds per sim-unit), <1 = sped up

  const resolvedAtPlaybackSeconds = chaseDuration;
  const durationSeconds = Math.max(chaseDuration + epilogueDuration, minSeconds);

  function sampleAt(tSeconds) {
    const clampedT = Math.max(0, Math.min(tSeconds, durationSeconds));
    if (!hasEpilogue || clampedT <= chaseDuration) {
      const simTime = Math.max(0, Math.min(clampedT / chaseEffectiveScale, record.resolvedAtSimTime));
      return interpolateTrajectory(record.trajectory, simTime);
    }
    const epilogueElapsed = clampedT - chaseDuration;
    const simTime = Math.min(
      record.resolvedAtSimTime + epilogueElapsed / epilogueEffectiveScale,
      record.epilogueEndSimTime
    );
    return interpolateTrajectory(record.trajectory, simTime);
  }

  return {
    durationSeconds,
    compressionMultiplier: chaseCompressionMultiplier,
    epilogueTimeWarp,
    resolvedAtPlaybackSeconds,
    sampleAt,
  };
}
