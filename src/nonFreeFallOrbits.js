// src/nonFreeFallOrbits.js
// EXPERIMENTAL curated presets for the debug harness -- a sibling of periodicOrbits.js, kept in
// its own file because these are a different family: *published* periodic three-body orbits
// that start with NON-ZERO velocities (real orbital motion from the first frame, not a release
// from rest). Not part of the click-to-place product flow (which is always free-fall from rest).
//
// All three were matched against a reference image (a 5 x 4 grid of glowing-trail three-body
// orbits) by overlaying this module's own integrated trajectories onto the image, pixel for
// pixel: the matches below reproduce both inner-star positions AND every visible loop/petal of
// the reference trail at the same time, in the published orientation (see the debug-harness
// report for the overlays). The same grid also contains Broucke A7 (the "cross in a circle")
// and several Broucke R orbits, so it was evidently rendered from the Three-body Gallery below.
//
// Unlike the free-fall presets, these three are LINEARLY STABLE: in this unmodified engine
// none of them ever leaves its pattern -- each runs until the engine's MAX_CROSSING_TIMES
// cutoff (~105 / ~46 / ~140 periods) with the drift from the pattern growing only linearly
// (a slow phase slip from the ~10-digit data and the RK4 step, max 2.1% / 0.36% / 0.11%), and
// a 1e-6 nudge to one star also only grows linearly. simulate() never resolves such a run, so
// it hands back its forced "BREAKAWAY" fallback label at the cutoff -- the harness says so
// instead of presenting that as a real outcome, and plays a natural-speed clip of the first
// few periods (the full-run numbers are in the info panel).
//
// Coordinates: the published numbers are kept verbatim below (G = 1, unit masses, barycentre at
// the origin). Unlike periodicOrbits.js these orbits are too wide for the default view
// (up to ~1.43 from the centre), so each is shrunk by an exact Newtonian scaling before use:
//   r -> s r,   v -> v / sqrt(s),   t -> s^(3/2) t     (same s for all three bodies)
// which maps an exact solution onto an exact solution (energy -> E / s, angular momentum ->
// sqrt(s) L). T below is the published period; `Tsim` = s^(3/2) T is the period in the
// engine's sim-time units. Then, like periodicOrbits.js, the barycentre is moved to (0.5, 0.5)
// and y is flipped (canvas y points down) so the orbit appears the same way up as in the
// gallery / the reference image. Only +, -, *, / and sqrt are used, so the numbers are
// bit-identical in every JS engine.
//
// Sources:
//  [G]  M. Suvakov & V. Dmitrasinovic, Three-body Gallery, http://three-body.ipb.ac.rs/ (the
//       Broucke pages bsol.php?id=N are live; the main index is intermittently down and is
//       archived on the Wayback Machine). Companion paper: M. Suvakov & V. Dmitrasinovic,
//       "Three Classes of Newtonian Three-Body Planar Periodic Orbits", Phys. Rev. Lett. 110,
//       114301 (2013), arXiv:1303.0181.
//  [B]  R. Broucke, "On relative periodic solutions of the planar general three-body problem",
//       Celest. Mech. 12, 439 (1975) -- the gallery's source for its "Broucke A n" orbits.
//  [CM] A. Chenciner & R. Montgomery, "A remarkable periodic solution of the three-body problem
//       in the case of equal masses", Ann. Math. 152, 881 (2000); numerical initial condition
//       (C. Simo) as quoted by them -- the same fixture src/physics/selftest.js already
//       validates in this engine. (Found numerically first by C. Moore, PRL 70, 3675 (1993).)

/** Raw published data. `bodies` / `velocities` in the source's frame (G = 1), `T` = published
 *  period, `E` / `L` = published energy / angular momentum where the source lists them,
 *  `scale` = display scaling s (see above), `colourOrder[slot]` = which body gets harness colour
 *  slot 0 (yellow) / 1 (blue) / 2 (red) -- cosmetic only; the wide outer star gets blue, which
 *  is roughly how the reference image colours it. */
const RAW = [
  {
    id: 'broucke-a2',
    label: 'Broucke A2',
    refCell: '#5 (row 1, col 5)',
    citation: 'Broucke (1975), Celest. Mech. 12, 439; i.c. from the Suvakov-Dmitrasinovic Three-body Gallery, "Broucke A 2"',
    blurb:
      'a tight pair loops its way round a ring of rosette loops while the third star circles them all. Equal masses. Linearly stable: it just keeps going.',
    masses: [1, 1, 1],
    bodies: [
      [0.336130095, 0],
      [0.7699893804, 0],
      [-1.1061194753, 0],
    ],
    velocities: [
      [0, 1.532431537],
      [0, -0.6287350978],
      [0, -0.9036964391],
    ],
    T: 7.702408,
    E: -1.751113,
    L: 1.030573,
    scale: 0.55,
    colourOrder: [0, 2, 1],
  },
  {
    id: 'figure-eight',
    label: 'Figure-eight',
    refCell: '#10 (row 2, col 5)',
    citation:
      'Chenciner & Montgomery (2000), Ann. Math. 152, 881 (first found by Moore 1993); i.c. by C. Simo as quoted there -- the selftest.js fixture',
    blurb:
      'all three stars chase each other round one figure-eight (lemniscate). Equal masses, zero angular momentum. Famously linearly stable.',
    masses: [1, 1, 1],
    bodies: [
      [-0.97000436, 0.24308753],
      [0.97000436, -0.24308753],
      [0, 0],
    ],
    velocities: [
      [0.466203685, 0.43236573],
      [0.466203685, 0.43236573],
      [-0.93240737, -0.86473146],
    ],
    T: 6.32591398,
    E: null, // not listed by the source (computes to -1.2871)
    L: 0,
    scale: 0.55,
    colourOrder: [0, 1, 2],
  },
  {
    id: 'broucke-a11',
    label: 'Broucke A11',
    refCell: '#16 (row 4, col 1)',
    citation: 'Broucke (1975), Celest. Mech. 12, 439; i.c. from the Suvakov-Dmitrasinovic Three-body Gallery, "Broucke A 11"',
    blurb:
      'two stars swing straight through the centre in long narrow petals -- a daisy -- while the third circles the rim 3 times per period. Equal masses. Linearly stable.',
    masses: [1, 1, 1],
    bodies: [
      [0.0132604844, 0],
      [1.4157286016, 0],
      [-1.4289890859, 0],
    ],
    velocities: [
      [0, 1.054151921],
      [0, -0.2101466639],
      [0, -0.8440052572],
    ],
    T: 32.584945,
    E: -0.824047,
    L: 0.922542,
    scale: 0.42,
    colourOrder: [0, 2, 1],
  },
];

const CENTRE = [0.5, 0.5];

function normalize(raw) {
  const { masses, bodies, velocities, scale: s, colourOrder } = raw;
  const M = masses.reduce((a, b) => a + b, 0);
  const com = [0, 1].map((k) => bodies.reduce((sum, b, i) => sum + b[k] * masses[i], 0) / M);
  const vScale = 1 / Math.sqrt(s);
  const positions = bodies.map((b) => [s * (b[0] - com[0]) + CENTRE[0], -s * (b[1] - com[1]) + CENTRE[1]]);
  const vels = velocities.map((v) => [v[0] * vScale, -v[1] * vScale]);
  return {
    ...raw,
    publishedVelocities: velocities, // `velocities` below is overwritten with the engine-ready ones
    kind: 'moving-periodic',
    Tsim: raw.T * s * Math.sqrt(s),
    positions: colourOrder.map((i) => positions[i]),
    velocities: colourOrder.map((i) => vels[i]),
    masses: colourOrder.map((i) => masses[i]),
  };
}

/** Presets ready for simulate(positions, { masses, initialVelocities: velocities, maxRetries: 0 }).
 *  Their period in sim-time units is `Tsim` (not the published `T`). */
export const NON_FREE_FALL_ORBITS = RAW.map(normalize);
