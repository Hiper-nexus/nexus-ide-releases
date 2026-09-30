/** Chase camera math. Pure: the scene copies the result into a PerspectiveCamera.
 * Heading 0 drives toward -z, so "behind" is +z; every follow is an exponential
 * step, which keeps the same lag at 30 or 120 frames per second. */
export const CAMERA = { distance: 11, height: 6.4, lookAhead: 2.6, rate: 4.2, targetRate: 6, fov: 50, boostFov: 60, attractRadius: 38, attractHeight: 17 };
export const ORBIT = { rate: 2.8, pitchMin: -0.35, pitchMax: 0.7 };

export function initialCamera(vehicle) {
  return { x: vehicle.x, y: CAMERA.height, z: vehicle.z + CAMERA.distance, tx: vehicle.x, ty: 0.8, tz: vehicle.z, fov: CAMERA.fov, attract: 0 };
}

const ease = (delta, rate) => 1 - Math.exp(-Math.max(0, delta) * rate);
const step = (current, goal, k) => current + (goal - current) * k;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Eases the drag angles toward their target. Pitch is clamped so the camera never dives
 * underground or flips over the rover; yaw wraps free like the old scalar orbit. */
export function orbitStep(orbit, target, delta) {
  const k = ease(delta, ORBIT.rate);
  return {
    yaw: step(orbit.yaw ?? 0, target.yaw ?? 0, k),
    pitch: clamp(step(orbit.pitch ?? 0, target.pitch ?? 0, k), ORBIT.pitchMin, ORBIT.pitchMax),
  };
}

export const STATION_FOCUS_MS = 2400;

/** Cinematic pose while a station is being read: the camera parks on the rover's approach side
 * of the beacon and frames it. Pure so scene.js only owns the timing; heading 0 faces -z. */
export function stationFocusGoal(focus, heading) {
  return { x: focus.x + Math.sin(heading) * 10, y: 6, z: focus.z + Math.cos(heading) * 10, tx: focus.x, ty: 2.2, tz: focus.z };
}

export function chaseStep(camera, vehicle, delta, options = {}) {
  const speed = Math.abs(vehicle.speed ?? Math.hypot(vehicle.vx ?? 0, vehicle.vz ?? 0));
  const k = ease(delta, CAMERA.rate), kt = ease(delta, CAMERA.targetRate);
  if (options.attract) {
    // Intro flight: a slow orbit around the centre of the world, wide and high.
    const angle = camera.attract + delta * 0.12;
    const goal = { x: Math.sin(angle) * CAMERA.attractRadius, y: CAMERA.attractHeight, z: Math.cos(angle) * CAMERA.attractRadius };
    return { ...camera, attract: angle, x: step(camera.x, goal.x, k), y: step(camera.y, goal.y, k), z: step(camera.z, goal.z, k), tx: step(camera.tx, 0, kt), ty: step(camera.ty, 1.5, kt), tz: step(camera.tz, 0, kt), fov: step(camera.fov, CAMERA.fov, k) };
  }
  const forward = { x: -Math.sin(vehicle.heading), z: -Math.cos(vehicle.heading) };
  const orbit = options.orbit ?? {};
  const angle = vehicle.heading + (orbit.yaw ?? 0);
  const pace = Math.min(1, speed / 10);
  const reach = CAMERA.distance + pace * 1.5;
  const pitch = orbit.pitch ?? 0;
  const goal = {
    x: vehicle.x + Math.sin(angle) * Math.cos(pitch) * reach,
    y: CAMERA.height + pace * 0.8 + (vehicle.y ?? 0) * 0.6 + Math.sin(pitch) * reach * 0.55,
    z: vehicle.z + Math.cos(angle) * Math.cos(pitch) * reach,
    tx: vehicle.x + forward.x * CAMERA.lookAhead * (0.4 + pace), ty: 0.8 + (vehicle.y ?? 0), tz: vehicle.z + forward.z * CAMERA.lookAhead * (0.4 + pace),
  };
  if (options.focus) Object.assign(goal, stationFocusGoal(options.focus, vehicle.heading));
  const fov = options.boost && speed > 6 ? CAMERA.boostFov : CAMERA.fov + pace * 4;
  return { ...camera, attract: 0, x: step(camera.x, goal.x, k), y: step(camera.y, goal.y, k), z: step(camera.z, goal.z, k), tx: step(camera.tx, goal.tx, kt), ty: step(camera.ty, goal.ty, kt), tz: step(camera.tz, goal.tz, kt), fov: step(camera.fov, fov, ease(delta, 3)) };
}
