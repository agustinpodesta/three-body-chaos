// src/periodicOrbits.js
// EXPERIMENTAL curated presets for the debug harness -- not part of the click-to-place product
// flow. Each is a *published*, collisionless, periodic FREE-FALL three-body orbit: all three
// bodies start at rest (zero velocity, same as the rest of the product), fall together, weave
// a pattern, come to rest again at T/2 in a new triangle, then retrace the same path back to
// the start at T -- forever, in exact arithmetic.
//
// In practice every one of these orbits is unstable: any tiny error (the published digits, the
// engine's RK4 step) is amplified by a large factor every period, so the real simulation holds
// the pattern for a few periods and then breaks into ordinary chaos and resolves to COLLAPSE or
// BREAKAWAY. That's what these presets are for: watching "equilibrium until disorder" happen
// honestly in the unmodified engine.
//
// Coordinate convention in both source papers (Agekyan-Anosova domain): two bodies at
// (-0.5, 0) and (0.5, 0), the third at (x, y); zero initial velocities; G = 1. That's the same
// G = 1 unit system this engine uses, so the published numbers are used as-is -- only
// translated (centre of mass moved to (0.5, 0.5), the centre of the default view) and flipped
// vertically, never rescaled, so each orbit's published period T applies directly in sim-time
// units. At this scale the closest approaches (~1e-4..5e-3) stay well clear of the engine's
// COLLISION_RADIUS (1e-5) while the orbit is on-pattern.
//
// Sources:
//  [LL] X. Li & S. Liao, "Collisionless periodic orbits in the free-fall three-body problem",
//       New Astronomy 70, 22-26 (2019), arXiv:1805.07980 -- Tables A2 and A5 (10 significant
//       digits).
//  [H]  I. Hristov, R. Hristova, V. Dmitrasinovic, K. Tanikawa, "Three-body periodic
//       collisionless equal-mass free-fall orbits revisited", Celest. Mech. Dyn. Astron. 136, 7
//       (2024), arXiv:2308.16159 -- full 80-digit data set (sol_80.txt) and per-orbit
//       stability eigenvalues (res_exponents.txt) at http://db2.fmi.uni-sofia.bg/3bodyfree/
//       (companion paper: J. Phys.: Conf. Ser. 2910, 012030 (2024)).
//
// How this one was chosen (see the debug-harness report for the full numbers): all 234
// Li-Liao orbits and the 60 least-unstable of the 24,582 Hristov initial conditions were run
// through this engine's own integrator, measuring how far the system is from its starting
// triangle after each period. Three held the pattern longest; the two Li-Liao picks (the
// Standish orbit and F44) were later dropped from the harness, leaving Hristov #516. ([LL] is
// still cited because the selection scan covered it, and src/physics/selftest.js keeps the
// Standish initial condition as a standalone engine-accuracy fixture.)

/** Raw published data. `bodies` = [[x, y], ...] in the papers' frame, `masses` in the same
 *  order, `T` = published period (G = 1). */
const RAW = [
  {
    // #516 and #517 are the two "dual" starting triangles of one and the same orbit (the two
    // moments per period when all three stars are at rest). #516 held the pattern a little
    // longer in this engine (2.4 vs 2.2 periods) and then has a real chaotic phase before
    // resolving, so it's the one used here.
    id: 'hristov-516',
    label: 'Hristov #516',
    citation: 'Hristov et al. 2024, i.c. #516 of 24,582 (80-digit data, truncated to double)',
    blurb:
      'equal masses, like the main toy. The least unstable equal-mass orbit in their whole 12,409-orbit catalog -- and even so, any error grows ~216x per period.',
    masses: [1, 1, 1],
    bodies: [
      [0.2984772743727133422458, 0.4618937517422074030435],
      [-0.5, 0],
      [0.5, 0],
    ],
    T: 5.216439331327259829916,
  },
];

// Star colours in the harness are index-based: 0 = yellow, 1 = blue, 2 = red. For unequal
// masses, give the heaviest body the (hot, massive) blue star, the lightest the (cool, small)
// red one, the middle one yellow -- purely cosmetic, the physics doesn't care about order.
const COLOUR_SLOT_FOR_MASS_RANK = [1, 0, 2]; // rank 0 = heaviest -> blue, etc.

function normalize(raw) {
  const { masses, bodies } = raw;
  const M = masses.reduce((a, b) => a + b, 0);
  const com = [0, 1].map((k) => bodies.reduce((s, b, i) => s + b[k] * masses[i], 0) / M);
  // y is flipped because canvas y points down; this way the orbit appears the same way up as
  // in the papers' figures (a mirror image is an equally exact solution either way).
  const shifted = bodies.map((b) => [b[0] - com[0] + 0.5, -(b[1] - com[1]) + 0.5]);

  let order = [0, 1, 2];
  const equal = masses.every((m) => m === masses[0]);
  if (!equal) {
    const byMass = [0, 1, 2].sort((a, b) => masses[b] - masses[a]); // heaviest first
    order = new Array(3);
    byMass.forEach((body, rank) => (order[COLOUR_SLOT_FOR_MASS_RANK[rank]] = body));
  }
  return {
    ...raw,
    positions: order.map((i) => shifted[i]),
    masses: order.map((i) => masses[i]),
  };
}

/** Presets ready for simulate(positions, { masses, maxRetries: 0 }). */
export const PERIODIC_ORBITS = RAW.map(normalize);
