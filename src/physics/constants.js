// src/physics/constants.js
// Central tunable parameters for the three-body free-fall simulator.
//
// Coordinate convention: positions live in the normalized unit square [0,1] x [0,1].
// "Screen width" = 1.0 in these units.
// Physical units: gravitational constant G = 1. All masses default to 1 (equal masses,
// per current product spec), but the engine accepts an arbitrary masses array so unequal
// masses aren't hard-baked out of the math -- there's just no UI/logic for choosing them yet.

/** Gravitational constant, in the simulator's normalized units. */
export const G = 1;

/** Default mass for each of the three bodies. Current product spec is equal masses. */
export const DEFAULT_MASSES = [1, 1, 1];

/** Adaptive-step multiplier:
 *    dt = ETA_DEFAULT * min_{i != j} sqrt(r_ij^3 / (G * (m_i + m_j)))
 *  Smaller eta = smaller steps (more accurate, slower); larger = bigger steps (faster,
 *  less accurate). Recomputed every step from the current configuration ("global adaptive
 *  step": one shared dt for the whole system each step, sized off the closest pair). */
export const ETA_DEFAULT = 0.01;

/** If the relative energy error |E - E0| / |E0| exceeds this on a step, eta is halved
 *  (tightening the step) for the remainder of *that* run. The run is not restarted. */
export const ENERGY_ERROR_THRESHOLD = 1e-3;

/** Center-to-center distance (normalized [0,1] units) at which two bodies are considered
 *  to have collided -> immediate COLLAPSE. No softening is used anywhere in the integrator;
 *  this radius is what stops integration before a true singularity is reached. */
export const COLLISION_RADIUS = 1e-5;

/** Minimum number of integration steps before COLLAPSE/BREAKAWAY checks begin, so a
 *  pathological/edge starting placement can't false-trigger in the first instant. */
export const MIN_STEPS_BEFORE_CHECK = 10;

/** BREAKAWAY requires the escaping body's distance from the bound pair's center of mass to
 *  exceed this many multiples of the pair's characteristic orbital separation (semi-major
 *  axis, via vis-viva). */
export const BREAKAWAY_SEPARATION_MULTIPLE = 10;

/** BREAKAWAY also requires that distance to exceed this many multiples of the system's
 *  original starting size (max pairwise separation at t=0). */
export const BREAKAWAY_ORIGINAL_SIZE_MULTIPLE = 2;

/** Once BREAKAWAY is first detected, integration doesn't stop immediately -- it continues for
 *  a short "epilogue" so the remaining bound pair can be shown settling into its orbit (camera
 *  can zoom into them) rather than the clip just ending mid-chase. Expressed as a multiple of
 *  the bound pair's own orbital period (computed from its semi-major axis via Kepler's third
 *  law at the moment of detection). If the pair later collides during the epilogue, that
 *  collision becomes the real final outcome (COLLAPSE) -- the epilogue is honest simulation,
 *  not a scripted animation. */
export const EPILOGUE_ORBITS = 2.5;

/** Safety cap on the epilogue's length, expressed in multiples of the system's initial
 *  crossing time -- guards against a degenerate/huge computed orbital period (e.g. a very
 *  weakly-bound pair) making the epilogue run unreasonably long. */
export const MAX_EPILOGUE_CROSSING_TIMES = 60;

/** Hard cap on integration duration, expressed in multiples of the system's initial
 *  crossing time (a rough dynamical timescale computed from the starting configuration). */
export const MAX_CROSSING_TIMES = 1000;

/** Hard cap on integration duration, expressed in wall-clock milliseconds, per attempt. */
export const MAX_WALL_CLOCK_MS = 1000;

/** Magnitude (in normalized [0,1] screen-width units) of the random sub-pixel nudge applied
 *  to the *original* starting positions when a run fails to resolve before cutoff and must
 *  be retried -- small enough to read as an imprecise finger placement, large enough to
 *  actually change the chaotic outcome. */
export const RETRY_NUDGE_MAGNITUDE = 1e-4;

/** Maximum number of nudge-and-retry attempts before falling back to a forced BREAKAWAY
 *  classification using whatever the most-bound pair is at cutoff time. */
export const MAX_RETRIES = 5;

/** Minimum pairwise starting separation the future placement UI should enforce before
 *  allowing "play". This is a pure placement-time validation constant here -- the simulator
 *  itself doesn't enforce it, it just does its best with whatever it's given. */
export const MIN_SEPARATION = 0.12;

/** Safety cap on raw (adaptively-spaced) samples retained in memory *during* integration
 *  before the collector decimates (halves resolution, keeps every other sample, doubles the
 *  store interval). The trajectory is used at this natural adaptive density -- dense during
 *  fast/close-encounter motion, sparse when calm -- rather than resampled onto a small fixed
 *  uniform grid, since that resampling was starving fast segments of samples and causing
 *  visibly jumpy/vibrating playback. This cap is just a memory safeguard against pathological
 *  long/fine-stepped runs, not a target resolution. */
export const MAX_RAW_SAMPLES = 20000;

// --- Playback (playback.js) ---

/** Base real-time seconds per one simulation time unit (G=m=1 units), before any
 *  compression. Derived from the research numbers cited in the product spec: crossing time
 *  ~= 0.37 sim-time-units, median resolution ~= 10 crossing times (~3.7 sim-time-units),
 *  90th percentile ~= 62 crossing times (~22.9 sim-time-units), for a 1e-5 collision
 *  threshold. Originally 0.65 s per sim-time-unit (median ~2.4s of chase), which played back
 *  as rushed -- runs were over in ~3s -- so it was doubled to 1.3:
 *    median real chase duration ~= 3.7 * 1.3 ~= 4.8s
 *    90th-pct                  ~= 22.9 * 1.3 ~= 30s -> capped by MAX_PLAYBACK_SECONDS below
 *  (Measured over random debug-harness placements, which skew more compact than the spec's
 *  research numbers, the median chase is ~2.4s and ~10% of runs hit the cap.) */
export const BASE_SECONDS_PER_SIM_TIME = 1.3;

/** Hard cap on playback duration in real seconds (chase + any BREAKAWAY epilogue). Naive
 *  durations beyond this get a uniform speed-up so the clip still fits -- pacing stays honest,
 *  only the long tail is capped. Raised from 15 alongside the BASE_SECONDS_PER_SIM_TIME doubling
 *  (and the longer epilogue window) so long chases aren't compressed straight back to feeling
 *  fast; the cap still keeps any single run from running away. */
export const MAX_PLAYBACK_SECONDS = 22;

/** BREAKAWAY's epilogue (the remaining pair settling into orbit, see EPILOGUE_ORBITS) gets
 *  its own reserved slice of playback time, independent of how long/compressed the chaotic
 *  chase before it was -- otherwise a long chase could eat the whole MAX_PLAYBACK_SECONDS
 *  budget and squeeze the epilogue (and any camera move into it) down to almost nothing. The
 *  epilogue is allowed to run short-to-long between these bounds; below the min it's time-warped
 *  into slow motion to fill the window (real motion the whole time, not a frozen-frame hold --
 *  see playback.js's epilogueEffectiveScale), above the max it gets uniformly sped up.
 *  The min was raised from 2.5 so that, after the renderer's ~1.8s camera zoom into the pair,
 *  there are still ~4.5s of settled, already-zoomed-in orbiting to watch. In practice the
 *  pair's natural epilogue span is tiny (a tight pair's 2.5 orbits), so nearly every epilogue
 *  lands exactly on the min, slow-motioned to fill it. */
export const EPILOGUE_MIN_SECONDS = 6.5;
export const EPILOGUE_MAX_SECONDS = 9;

/** The chase phase (everything up to the resolution moment) is never squeezed below this many
 *  seconds even if a generous epilogue budget would otherwise eat further into
 *  MAX_PLAYBACK_SECONDS -- an edge-case guard, not something typical runs should hit. */
export const MIN_CHASE_SECONDS = 3;

/** Small floor on playback duration, purely so an extremely fast collision is still
 *  perceivable as a clip rather than a single flash frame. This is a legibility nicety only:
 *  it pads the clip by holding the final resolved frame, it does NOT slow down the physics/
 *  motion itself -- pacing stays honest/causal per the explicit product decision. */
export const MIN_PLAYBACK_SECONDS = 0.75;
