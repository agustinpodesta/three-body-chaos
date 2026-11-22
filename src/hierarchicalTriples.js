// src/hierarchicalTriples.js
// EXPERIMENTAL constructed preset for the debug harness -- a sibling of periodicOrbits.js, kept
// in its own file because it is NOT published data: the starting positions AND velocities are
// derived here from textbook Keplerian two-body orbits, then run through the same, unmodified
// engine. Not part of the click-to-place product flow (which is always free-fall from rest).
//
// A hierarchical triple: two stars in a tight mutual orbit (the "inner binary") while the third
// swings around the whole pair on a much wider "outer" orbit -- the shape of many real star
// systems (e.g. Alpha Centauri A/B with Proxima far outside). Unlike the free-fall presets it
// needs non-zero starting velocities (a system released from rest has no angular momentum, so
// it can't hold an orbit), which simulate() accepts via options.initialVelocities.
//
// Construction, in Jacobi coordinates (G = 1, every orbit started at periapsis):
//   inner:  r = x2 - x1,         mu_in  = G (m1 + m2),       |r| = a_in (1 - e_in),
//           |v| = sqrt(mu_in (1 + e_in) / (a_in (1 - e_in)))            (vis-viva at periapsis)
//   outer:  R = x3 - com(1,2),   mu_out = G (m1 + m2 + m3),  |R| = a_out (1 - e_out),
//           |V| = sqrt(mu_out (1 + e_out) / (a_out (1 - e_out)))
//   Treating the inner pair as one point mass m12 = m1 + m2, the outer two-body problem's
//   RELATIVE motion obeys R'' = -G (m12 + m3) R / |R|^3 -- so the outer speed uses the TOTAL
//   mass (for e_out = 0 this is the familiar v_out = sqrt(G M / r_out)). Each two-body problem
//   is then split about its own centre of mass so the whole system has zero net momentum:
//     com(1,2) = -(m3 / M) R,  x3 = (m12 / M) R      (same weights for the velocities)
//     x1 = com(1,2) - (m2 / m12) r,  x2 = com(1,2) + (m1 / m12) r
//   i.e. the inner pair's centre of mass is NOT at rest -- it orbits the barycentre opposite the
//   third star. With zero net momentum the barycentre stays put at (0.5, 0.5), which the
//   harness camera and the BREAKAWAY test assume. (Checked in the engine: with a very wide
//   triple the outer separation stays within 0.3% of circular, while using sqrt(G m12 / r)
//   instead would make it ~23% eccentric; net momentum ~1e-16.) Only +, -, *, / and sqrt are
//   used, so the numbers are bit-identical in every JS engine -- which matters, because once the
//   hierarchy breaks the rest is chaos and depends on every last bit.
//
// How the numbers were chosen: ~1,900 combinations (masses 1/1/1, 1/1/0.5, 1/0.8/0.6, 1/1/0.3;
// a_out / a_in = 2.6..4.5; e_out 0..0.3; e_in 0..0.2), plus a coarser pass out to a_out / a_in
// = 8 and e_out = 0.5, were run through this engine. Wide hierarchies are simply stable: from
// a_out / a_in ~ 4 up, 85-98% of combinations never left their Keplerian band, and everything
// tried at 5..8 (and so the "textbook" 6..25 range) orbits untouched until the engine's
// MAX_CROSSING_TIMES cutoff (~50-100 outer orbits) -- which in a 45 s clip means ~0.5 s per
// outer orbit and a strobing blur for the inner pair, so not worth a preset. Below ~3 most fall
// apart within the first outer orbit or two. In between there's a narrow band where the triple
// holds its shape for several outer orbits and THEN destabilises; how long the chaos after that
// lasts is itself chaotic (often a long bound excursion, or the run cutoff). The configuration
// below is the pick from that band. Its ordered phase is robust -- every nearby variant tried
// (a_in shifted by 1e-5..2e-3 either way) held for 7.6-28 outer orbits, most ~8-11 -- but the
// clean ejection soon after the break is specific to these exact digits.

const G = 1;
const CENTRE = [0.5, 0.5];

/** Raw constructed parameters. Masses are [inner A, inner B, outer]. */
const RAW = [
  {
    id: 'hier-triple',
    label: 'Hierarchical triple',
    citation: 'constructed (not from a paper): Keplerian inner + outer orbits in Jacobi coordinates',
    blurb:
      'a tight binary orbits itself while a lighter third star circles the pair -- like Alpha Centauri A/B + Proxima, only far closer. Holds for ~10 outer orbits, then the pull of the third star breaks it.',
    masses: [1, 1, 0.3],
    aIn: 0.1833,
    eIn: 0.1,
    aOut: 0.55,
    eOut: 0.2,
  },
];

// "Hierarchy holding" test used by the harness HUD: the inner separation and the outer star's
// distance from the inner pair's centre of mass must stay inside their Keplerian ranges
// ([periapsis, apoapsis]) widened by these factors. Loose enough to ignore the normal
// perturbation wobble (the outer star's pull squeezes/stretches the inner orbit a little every
// pass), tight enough to flag the first real energy exchange.
export const HIERARCHY_BAND = { innerLow: 0.8, innerHigh: 1.2, outerLow: 0.85, outerHigh: 1.25 };

/** Positions/velocities (zero net momentum, barycentre at CENTRE) for masses [m1, m2, m3]. */
export function buildHierarchicalTriple({ masses, aIn, eIn = 0, aOut, eOut = 0 }) {
  const [m1, m2, m3] = masses;
  const m12 = m1 + m2;
  const M = m12 + m3;
  // Inner relative orbit at periapsis along +x, moving along +y.
  const rIn = aIn * (1 - eIn);
  const vIn = Math.sqrt((G * m12 * (1 + eIn)) / rIn);
  // Outer relative orbit at periapsis along +x too (the three start in a line), same sense.
  const rOut = aOut * (1 - eOut);
  const vOut = Math.sqrt((G * M * (1 + eOut)) / rOut);

  const comX = -(m3 / M) * rOut; // inner pair's centre of mass (x); its velocity is along y
  const comVy = -(m3 / M) * vOut;
  const positions = [
    [comX - (m2 / m12) * rIn, 0],
    [comX + (m1 / m12) * rIn, 0],
    [(m12 / M) * rOut, 0],
  ].map(([x, y]) => [x + CENTRE[0], y + CENTRE[1]]);
  const velocities = [
    [0, comVy - (m2 / m12) * vIn],
    [0, comVy + (m1 / m12) * vIn],
    [0, (m12 / M) * vOut],
  ];
  return {
    positions,
    velocities,
    Pin: 2 * Math.PI * Math.sqrt(aIn ** 3 / (G * m12)),
    Pout: 2 * Math.PI * Math.sqrt(aOut ** 3 / (G * M)),
  };
}

// Same star-colour convention as periodicOrbits.js: heaviest -> blue, lightest -> red, middle ->
// yellow (index-based in the harness: 0 = yellow, 1 = blue, 2 = red). Cosmetic only.
const COLOUR_SLOT_FOR_MASS_RANK = [1, 0, 2];

function normalize(raw) {
  const { positions, velocities, Pin, Pout } = buildHierarchicalTriple(raw);
  const byMass = [0, 1, 2].sort((a, b) => raw.masses[b] - raw.masses[a]); // heaviest first (stable)
  const order = new Array(3);
  byMass.forEach((body, rank) => (order[COLOUR_SLOT_FOR_MASS_RANK[rank]] = body));
  const slotOf = (body) => order.indexOf(body);
  return {
    ...raw,
    kind: 'hierarchical',
    positions: order.map((i) => positions[i]),
    velocities: order.map((i) => velocities[i]),
    masses: order.map((i) => raw.masses[i]),
    innerPair: [slotOf(0), slotOf(1)],
    outer: slotOf(2),
    Pin,
    Pout,
  };
}

/** Presets ready for simulate(positions, { masses, initialVelocities: velocities, maxRetries: 0 }). */
export const HIERARCHICAL_TRIPLES = RAW.map(normalize);
