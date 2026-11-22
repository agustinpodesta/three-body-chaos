// src/physics/integrator.js
// RK4 integrator with a global adaptive time step for the free-fall gravity problem.
//
// State layout: a flat array [x0,y0,x1,y1,...,xN-1,yN-1, vx0,vy0,vx1,vy1,...,vxN-1,vyN-1].
// The math here is written generically over masses.length (not hard-baked to 3 bodies),
// even though the product using this module is specifically a three-body toy.

import { G } from './constants.js';

const N_DIM = 2;

/** Packs position/velocity pairs into the flat state vector used by rk4Step/derivatives. */
export function makeState(positions, velocities) {
  const n = positions.length;
  const state = new Array(n * N_DIM * 2);
  for (let i = 0; i < n; i++) {
    state[i * 2] = positions[i][0];
    state[i * 2 + 1] = positions[i][1];
  }
  const velOffset = n * N_DIM;
  for (let i = 0; i < n; i++) {
    state[velOffset + i * 2] = velocities[i][0];
    state[velOffset + i * 2 + 1] = velocities[i][1];
  }
  return state;
}

/** Extracts positions ([[x,y], ...]) from a flat state vector. */
export function statePositions(state, n) {
  const positions = [];
  for (let i = 0; i < n; i++) positions.push([state[i * 2], state[i * 2 + 1]]);
  return positions;
}

/** Extracts velocities ([[vx,vy], ...]) from a flat state vector. */
export function stateVelocities(state, n) {
  const velOffset = n * N_DIM;
  const velocities = [];
  for (let i = 0; i < n; i++) {
    velocities.push([state[velOffset + i * 2], state[velOffset + i * 2 + 1]]);
  }
  return velocities;
}

/** d(state)/dt: velocities become position derivatives, gravitational accelerations become
 *  velocity derivatives. No softening (see constants.js COLLISION_RADIUS -- the collision
 *  check in simulate.js is what stops integration before this blows up). */
export function derivatives(state, masses) {
  const n = masses.length;
  const positions = statePositions(state, n);
  const velocities = stateVelocities(state, n);
  const deriv = new Array(state.length).fill(0);

  for (let i = 0; i < n; i++) {
    deriv[i * 2] = velocities[i][0];
    deriv[i * 2 + 1] = velocities[i][1];
  }

  const velOffset = n * N_DIM;
  for (let i = 0; i < n; i++) {
    let ax = 0;
    let ay = 0;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const dx = positions[j][0] - positions[i][0];
      const dy = positions[j][1] - positions[i][1];
      const r2 = dx * dx + dy * dy;
      const r = Math.sqrt(r2);
      const r3 = r2 * r;
      const invR3 = r3 > 0 ? 1 / r3 : 0; // guard against coincident points
      const f = G * masses[j] * invR3;
      ax += f * dx;
      ay += f * dy;
    }
    deriv[velOffset + i * 2] = ax;
    deriv[velOffset + i * 2 + 1] = ay;
  }

  return deriv;
}

function addScaled(a, b, scale) {
  const out = new Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] + b[k] * scale;
  return out;
}

/** One RK4 step of size dt. */
export function rk4Step(state, masses, dt) {
  const k1 = derivatives(state, masses);
  const k2 = derivatives(addScaled(state, k1, dt / 2), masses);
  const k3 = derivatives(addScaled(state, k2, dt / 2), masses);
  const k4 = derivatives(addScaled(state, k3, dt), masses);
  const out = new Array(state.length);
  for (let k = 0; k < state.length; k++) {
    out[k] = state[k] + (dt / 6) * (k1[k] + 2 * k2[k] + 2 * k3[k] + k4[k]);
  }
  return out;
}

/** Global adaptive time step, sized off the currently-closest pair:
 *    dt = eta * min_{i != j} sqrt(r_ij^3 / (G * (m_i + m_j)))
 *  Returns 0 for a degenerate single-body (or empty) configuration. */
export function computeAdaptiveDt(positions, masses, eta) {
  const n = masses.length;
  let minT = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = positions[j][0] - positions[i][0];
      const dy = positions[j][1] - positions[i][1];
      const r = Math.hypot(dx, dy);
      const t = Math.sqrt((r * r * r) / (G * (masses[i] + masses[j])));
      if (t < minT) minT = t;
    }
  }
  if (!Number.isFinite(minT)) return 0;
  return eta * minT;
}

/** Total mechanical energy (kinetic + gravitational potential) of the system. */
export function computeEnergy(positions, velocities, masses) {
  const n = masses.length;
  let ke = 0;
  for (let i = 0; i < n; i++) {
    const v2 = velocities[i][0] * velocities[i][0] + velocities[i][1] * velocities[i][1];
    ke += 0.5 * masses[i] * v2;
  }
  let pe = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = positions[j][0] - positions[i][0];
      const dy = positions[j][1] - positions[i][1];
      const r = Math.hypot(dx, dy);
      if (r > 0) pe -= (G * masses[i] * masses[j]) / r;
    }
  }
  return ke + pe;
}
