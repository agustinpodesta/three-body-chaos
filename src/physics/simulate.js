// src/physics/simulate.js
// Runs a full free-fall three-body simulation from initial positions (zero velocity, unless a
// caller explicitly passes options.initialVelocities) to a resolved outcome -- COLLAPSE or
// BREAKAWAY -- including nudge-and-retry logic for the rare unresolved long tail.

import {
  G,
  DEFAULT_MASSES,
  ETA_DEFAULT,
  ENERGY_ERROR_THRESHOLD,
  COLLISION_RADIUS,
  MIN_STEPS_BEFORE_CHECK,
  BREAKAWAY_SEPARATION_MULTIPLE,
  BREAKAWAY_ORIGINAL_SIZE_MULTIPLE,
  MAX_CROSSING_TIMES,
  MAX_WALL_CLOCK_MS,
  RETRY_NUDGE_MAGNITUDE,
  MAX_RETRIES,
  MIN_SEPARATION,
  MAX_RAW_SAMPLES,
  EPILOGUE_ORBITS,
  MAX_EPILOGUE_CROSSING_TIMES,
} from './constants.js';
import {
  makeState,
  statePositions,
  stateVelocities,
  rk4Step,
  computeAdaptiveDt,
  computeEnergy,
} from './integrator.js';

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function clonePositions(positions) {
  return positions.map((p) => [p[0], p[1]]);
}

/** Pure validator: does this placement respect the minimum starting separation?
 *  This is a placement-time constraint -- the future UI calls it before allowing "play".
 *  The simulator itself doesn't enforce it; it just does its best with whatever it's given
 *  (physics does what physics does with a too-close start). */
export function isValidPlacement(positions, minSeparation = MIN_SEPARATION) {
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      if (dist(positions[i], positions[j]) < minSeparation) return false;
    }
  }
  return true;
}

function maxPairwiseDistance(positions) {
  let max = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      max = Math.max(max, dist(positions[i], positions[j]));
    }
  }
  return max;
}

function meanPairwiseDistance(positions) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      sum += dist(positions[i], positions[j]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Initial dynamical/crossing timescale of the system, computed from the starting
 *  configuration: t_cross ~= sqrt(R^3 / (G * M_total)), with R the mean pairwise starting
 *  separation (a characteristic system size) and M_total the total mass. Used both as the
 *  MAX_CROSSING_TIMES cutoff basis and (elsewhere) as the playback-pacing reference. */
function computeCrossingTime(positions, masses) {
  const R = meanPairwiseDistance(positions);
  const totalMass = masses.reduce((a, b) => a + b, 0);
  return Math.sqrt((R * R * R) / (G * totalMass));
}

/** Fresh, independent small random nudge applied to the *original* starting positions each
 *  retry (not compounded onto the previous failed attempt's nudge) -- reads as a legitimate
 *  re-reading of imprecise finger placement each time. */
function nudgePositions(originalPositions) {
  return originalPositions.map(([x, y]) => [
    x + (Math.random() * 2 - 1) * RETRY_NUDGE_MAGNITUDE,
    y + (Math.random() * 2 - 1) * RETRY_NUDGE_MAGNITUDE,
  ]);
}

/** Boekholt et al. (2020)-style BREAKAWAY test: identify the most tightly-bound pair (most
 *  negative pairwise specific orbital energy), then check whether the third body is unbound
 *  from that pair, moving away from it, and far enough away in both pair-relative and
 *  absolute (original-system-size-relative) terms. Also used, unconditionally, to produce
 *  the forced-BREAKAWAY fallback classification when a run never resolves. */
function evaluateBreakaway(positions, velocities, masses, originalSize) {
  const pairs = [[0, 1], [1, 2], [0, 2]];
  let best = null;
  for (const [i, j] of pairs) {
    const rij = dist(positions[i], positions[j]);
    const dvx = velocities[i][0] - velocities[j][0];
    const dvy = velocities[i][1] - velocities[j][1];
    const vij2 = dvx * dvx + dvy * dvy;
    const muPair = G * (masses[i] + masses[j]);
    // Specific orbital energy of the pair (vis-viva form): independent of how the pair's
    // mass is split between i and j, only their sum matters.
    const eps = rij > 0 ? 0.5 * vij2 - muPair / rij : -Infinity;
    if (!best || eps < best.eps) best = { pair: [i, j], eps, muPair };
  }

  const [i, j] = best.pair;
  const k = 3 - i - j; // the remaining index, since {0,1,2} sums to 3 (n=3 fixed here)
  const mi = masses[i];
  const mj = masses[j];
  const mk = masses[k];
  const mPair = mi + mj;

  const comPos = [
    (positions[i][0] * mi + positions[j][0] * mj) / mPair,
    (positions[i][1] * mi + positions[j][1] * mj) / mPair,
  ];
  const comVel = [
    (velocities[i][0] * mi + velocities[j][0] * mj) / mPair,
    (velocities[i][1] * mi + velocities[j][1] * mj) / mPair,
  ];

  const rRel = [positions[k][0] - comPos[0], positions[k][1] - comPos[1]];
  const vRel = [velocities[k][0] - comVel[0], velocities[k][1] - comVel[1]];
  const rRelMag = Math.hypot(rRel[0], rRel[1]);
  const vRelMag = Math.hypot(vRel[0], vRel[1]);
  const muThird = G * (mPair + mk);
  const epsThird = rRelMag > 0 ? 0.5 * vRelMag * vRelMag - muThird / rRelMag : -Infinity;
  const radialVelocity = rRelMag > 0 ? (rRel[0] * vRel[0] + rRel[1] * vRel[1]) / rRelMag : 0;

  const pairBound = best.eps < 0;
  // Characteristic orbital separation of the bound pair == semi-major axis, via vis-viva.
  const semiMajorAxis = pairBound ? -best.muPair / (2 * best.eps) : Infinity;

  const resolved =
    pairBound &&
    epsThird > 0 &&
    radialVelocity > 0 &&
    rRelMag > BREAKAWAY_SEPARATION_MULTIPLE * semiMajorAxis &&
    rRelMag > BREAKAWAY_ORIGINAL_SIZE_MULTIPLE * originalSize;

  return { resolved, pair: [i, j], single: k, semiMajorAxis, rRelMag, epsThird };
}

// NOTE: trajectories are kept at their natural adaptively-spaced density (see rawSamples in
// runSingleAttempt) rather than resampled onto a small fixed-count uniform-time grid. The
// integrator already takes tiny steps exactly when the system is moving fast (close
// encounters, periastron passes) and big steps when it's calm -- collapsing that down to a
// fixed number of uniform-time points would starve the fast, visually-important parts of
// samples and make played-back motion look jumpy/vibrating right where it matters most.
// playback.js's interpolateTrajectory is written to handle this non-uniform spacing directly
// (binary search over each sample's `t`, not an assumed fixed spacing).

/** Integrates a single attempt from `startPositions` (zero velocity unless `startVelocities` is
 *  given) until it resolves or hits the per-attempt cutoff (MAX_CROSSING_TIMES or
 *  MAX_WALL_CLOCK_MS, whichever first). */
function runSingleAttempt(startPositions, masses, startVelocities = null) {
  const n = masses.length;
  const velocities = startVelocities ? startVelocities.map((v) => [v[0], v[1]]) : startPositions.map(() => [0, 0]);
  let state = makeState(startPositions, velocities);
  let eta = ETA_DEFAULT; // reset fresh each attempt
  let t = 0;
  let step = 0;

  const originalSize = maxPairwiseDistance(startPositions);
  const crossingTime = computeCrossingTime(startPositions, masses);
  const maxSimTime = crossingTime * MAX_CROSSING_TIMES;
  const initialEnergy = computeEnergy(startPositions, velocities, masses);

  const rawSamples = [{ t: 0, positions: clonePositions(startPositions) }];
  let storeInterval = 1;
  let sinceStore = 0;

  const wallStart = Date.now();
  let outcome = null; // 'COLLAPSE' | 'BREAKAWAY' | null (unresolved at cutoff)
  let pair = null;
  let single = null;
  let resolvedAtSimTime = null;
  let epilogueEndSimTime = null;

  // Set once BREAKAWAY is first detected. Integration keeps going past this point (see
  // EPILOGUE_ORBITS) so the remaining pair can be shown settling into orbit; a later collision
  // during that epilogue still overrides the outcome to COLLAPSE (this is honest continued
  // simulation, not scripted footage).
  let breakawayCandidate = null;

  while (true) {
    const positions = statePositions(state, n);
    const dt = computeAdaptiveDt(positions, masses, eta);
    if (dt <= 0 || !Number.isFinite(dt)) break; // degenerate configuration -- bail safely

    const nextState = rk4Step(state, masses, dt);
    const nextPositions = statePositions(nextState, n);
    const nextVelocities = stateVelocities(nextState, n);
    const nextEnergy = computeEnergy(nextPositions, nextVelocities, masses);

    const relEnergyError =
      Math.abs(initialEnergy) > 0
        ? Math.abs(nextEnergy - initialEnergy) / Math.abs(initialEnergy)
        : Math.abs(nextEnergy - initialEnergy);
    if (relEnergyError > ENERGY_ERROR_THRESHOLD) {
      eta = eta / 2; // tighten the step from here on -- don't restart the run
    }

    state = nextState;
    t += dt;
    step += 1;

    sinceStore += 1;
    if (sinceStore >= storeInterval) {
      rawSamples.push({ t, positions: clonePositions(nextPositions) });
      sinceStore = 0;
      if (rawSamples.length >= MAX_RAW_SAMPLES) {
        // Memory safeguard: halve resolution, double the store interval, keep going.
        const decimated = rawSamples.filter((_, idx) => idx % 2 === 0);
        rawSamples.length = 0;
        rawSamples.push(...decimated);
        storeInterval *= 2;
      }
    }

    if (step >= MIN_STEPS_BEFORE_CHECK) {
      let collided = null;
      for (let i = 0; i < n && !collided; i++) {
        for (let j = i + 1; j < n; j++) {
          if (dist(nextPositions[i], nextPositions[j]) < COLLISION_RADIUS) {
            collided = [i, j];
            break;
          }
        }
      }
      if (collided) {
        // Terminal, no matter whether this happens before any breakaway candidate or during
        // one's epilogue -- a real collision always wins.
        outcome = 'COLLAPSE';
        pair = collided;
        single = null;
        resolvedAtSimTime = t;
        epilogueEndSimTime = t;
        break;
      }

      if (!breakawayCandidate) {
        const breakaway = evaluateBreakaway(nextPositions, nextVelocities, masses, originalSize);
        if (breakaway.resolved) {
          const [i, j] = breakaway.pair;
          const mPair = masses[i] + masses[j];
          // Kepler's third law from the semi-major axis already computed for the resolved
          // check. A degenerate axis (shouldn't normally happen once `resolved` is true, since
          // that requires a bound pair) falls back to one crossing time.
          const period =
            Number.isFinite(breakaway.semiMajorAxis) && breakaway.semiMajorAxis > 0
              ? 2 * Math.PI * Math.sqrt(breakaway.semiMajorAxis ** 3 / (G * mPair))
              : crossingTime;
          const epilogueSpan = Math.min(EPILOGUE_ORBITS * period, MAX_EPILOGUE_CROSSING_TIMES * crossingTime);
          breakawayCandidate = {
            pair: breakaway.pair,
            single: breakaway.single,
            atT: t,
            epilogueEndTarget: t + epilogueSpan,
          };
        }
      }
    }

    if (breakawayCandidate && t >= breakawayCandidate.epilogueEndTarget) {
      outcome = 'BREAKAWAY';
      pair = breakawayCandidate.pair;
      single = breakawayCandidate.single;
      resolvedAtSimTime = breakawayCandidate.atT;
      epilogueEndSimTime = t;
      break;
    }

    if (t >= maxSimTime || Date.now() - wallStart >= MAX_WALL_CLOCK_MS) {
      if (breakawayCandidate) {
        // Already have a confirmed breakaway -- just cut the epilogue short gracefully rather
        // than treating this as unresolved.
        outcome = 'BREAKAWAY';
        pair = breakawayCandidate.pair;
        single = breakawayCandidate.single;
        resolvedAtSimTime = breakawayCandidate.atT;
        epilogueEndSimTime = t;
      }
      break; // unresolved (no candidate) -- caller (simulate()) decides retry vs. forced fallback
    }
  }

  const finalPositions = statePositions(state, n);
  const finalVelocities = stateVelocities(state, n);

  if (rawSamples[rawSamples.length - 1].t !== t) {
    rawSamples.push({ t, positions: clonePositions(finalPositions) });
  }

  const finalEnergy = computeEnergy(finalPositions, finalVelocities, masses);
  const energyError =
    Math.abs(initialEnergy) > 0
      ? Math.abs(finalEnergy - initialEnergy) / Math.abs(initialEnergy)
      : Math.abs(finalEnergy - initialEnergy);

  if (resolvedAtSimTime === null) resolvedAtSimTime = t;
  if (epilogueEndSimTime === null) epilogueEndSimTime = t;

  if (!outcome) {
    // Unresolved by cutoff, no breakaway candidate ever formed: pre-compute the fallback
    // classification (most-bound pair right now) so simulate() can use it immediately if this
    // was the last allowed retry.
    const fallback = evaluateBreakaway(finalPositions, finalVelocities, masses, originalSize);
    pair = fallback.pair;
    single = fallback.single;
  }

  return {
    resolved: outcome !== null,
    outcome,
    pair,
    single,
    resolvedAtSimTime,
    epilogueEndSimTime,
    trajectory: rawSamples,
    crossingTime,
    initialEnergy,
    finalEnergy,
    energyError,
    stepsTaken: step,
  };
}

/**
 * Runs a full simulation from initial positions (zero velocity by default) to a resolved
 * COLLAPSE or BREAKAWAY outcome.
 *
 * @param {Array<[number, number]>} initialPositions - three [x, y] positions (normally in
 *   [0,1]^2, but any coordinates work -- G = 1 units, no boundary).
 * @param {object} [options]
 * @param {number[]} [options.masses] - defaults to DEFAULT_MASSES ([1, 1, 1]).
 * @param {Array<[number, number]>} [options.initialVelocities] - defaults to zero for all
 *   three bodies (free-fall, the product's normal mode). Not used by the click-to-place UI.
 * @param {number} [options.maxRetries] - defaults to MAX_RETRIES. A curated preset whose exact
 *   starting numbers matter (e.g. a published periodic orbit) passes 0, so an unresolved run is
 *   never silently replaced by a nudged -- i.e. different -- starting configuration.
 * @returns {object} simulation record (see file header / spec for shape), plus the `masses`
 *   it was run with.
 */
export function simulate(initialPositions, options = {}) {
  const masses = options.masses || DEFAULT_MASSES;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const startVelocities = options.initialVelocities || null;
  let retriesUsed = 0;

  while (true) {
    // Every attempt (including the first) starts from a freshly-nudged copy of the
    // *original* positions once retriesUsed > 0, so nudges never compound.
    const startPositions =
      retriesUsed === 0 ? clonePositions(initialPositions) : nudgePositions(initialPositions);

    const attempt = runSingleAttempt(startPositions, masses, startVelocities);

    if (attempt.resolved) {
      const { resolved, ...record } = attempt;
      return { ...record, masses: [...masses], retriesUsed };
    }

    if (retriesUsed >= maxRetries) {
      // Exhausted retries: fall back to BREAKAWAY using the most-bound pair at cutoff time,
      // per the product spec ("do not introduce a third outcome label").
      const { resolved, outcome, ...record } = attempt;
      return { ...record, masses: [...masses], outcome: 'BREAKAWAY', retriesUsed };
    }

    retriesUsed += 1;
  }
}
