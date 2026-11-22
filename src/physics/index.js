// src/physics/index.js
// Barrel file: public API of the physics engine module.
// No rendering, no DOM -- pure simulation logic, consumed by a later UI/canvas layer.

export { simulate, isValidPlacement } from './simulate.js';
export { getPlaybackSchedule } from './playback.js';

// Lower-level pieces, exposed for advanced use / testing (not required by the basic
// "place three stars, press play" flow, but harmless to expose).
export { rk4Step, computeAdaptiveDt, computeEnergy } from './integrator.js';

export * as constants from './constants.js';
