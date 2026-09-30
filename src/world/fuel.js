/** Coffee is fuel. Pure state machine: the scene owns the meshes and the HUD,
 * this module owns the numbers. A sleepy rover still steers and still finishes,
 * it just runs out of steam. */
export const FUEL = {
  max: 1,
  /** per second while the engine is running */
  drainIdle: 0.012,
  /** extra per second while the rover is actually moving */
  drainDrive: 0.022,
  /** extra per second while the boost is on */
  drainBoost: 0.07,
  /** a cup/bean on the map */
  pickup: 0.2,
  /** per second while parked at the cafe station */
  stationRate: 0.55,
  /** below this the HUD warns */
  low: 0.25,
  /** acceleration multiplier at empty */
  emptyAccel: 0.42,
  /** top-speed multiplier at empty */
  emptyMax: 0.55,
  /** how long the rover stays "sleepy" after the last drop, in seconds */
  sleepyFade: 1.2,
};

export function initialFuel() {
  return { level: FUEL.max, refueling: false, sleepy: 0 };
}

/** One step of the coffee tank. `input` is {driving, boosting, nearStation}; returns a new state. */
export function fuelStep(fuel, input, delta) {
  const dt = Math.max(0, Math.min(delta, 0.1));
  const { driving = false, boosting = false, nearStation = false } = input ?? {};
  if (nearStation) {
    const level = Math.min(FUEL.max, fuel.level + FUEL.stationRate * dt);
    return { level, refueling: level < FUEL.max, sleepy: Math.max(0, fuel.sleepy - dt * 2) };
  }
  if (fuel.level <= 0) {
    // Empty tank: keep the sleepy flag warm so the shake and the weak headlight fade out gently.
    return { level: 0, refueling: false, sleepy: FUEL.sleepyFade };
  }
  let drain = FUEL.drainIdle;
  if (driving) drain += FUEL.drainDrive;
  if (boosting) drain += FUEL.drainBoost;
  const level = Math.max(0, fuel.level - drain * dt);
  const sleepy = level <= 0 ? FUEL.sleepyFade : Math.max(0, fuel.sleepy - dt);
  return { level, refueling: false, sleepy };
}

/** How much the empty tank costs the rover. Direction and finishing never change. */
export function fuelPower(fuel) {
  const t = Math.min(1, Math.max(0, fuel.level / 0.35));
  // Smoothstep from empty to comfortable, so the fade-in of power feels like waking up.
  const wake = t * t * (3 - 2 * t);
  return {
    accelScale: FUEL.emptyAccel + (1 - FUEL.emptyAccel) * wake,
    maxScale: FUEL.emptyMax + (1 - FUEL.emptyMax) * wake,
    sleepy: fuel.sleepy > 0 || fuel.level <= 0,
    low: fuel.level <= FUEL.low,
    empty: fuel.level <= 0,
  };
}

/** Drink a cup or a bean. Caps at full so a big sip at 90% does not overflow. */
export function refuel(fuel, amount = FUEL.pickup) {
  return { ...fuel, level: Math.min(FUEL.max, fuel.level + amount), sleepy: Math.max(0, fuel.sleepy - 0.4) };
}
