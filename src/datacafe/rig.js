/** Câmera elevada atrás do dev, estilo diorama. Pura: o loop passa objetos de saída. */
export const RIG = {
  distance: 7.6,
  height: 8.4,
  lookHeight: 0.6,
  follow: 5,
  yawMin: -0.7,
  yawMax: 0.7,
  /** Folga da borda do salão, para a câmera não mostrar o vazio. */
  margin: 4,
};

export function clampYaw(yaw) {
  return Math.max(RIG.yawMin, Math.min(RIG.yawMax, yaw));
}

/** Mantém o ponto observado dentro do salão, com margem. */
export function clampTarget(x, z, layout, out = { x: 0, z: 0 }) {
  const w = layout.width * layout.cellSize, h = layout.height * layout.cellSize;
  const mx = Math.min(RIG.margin, w / 2), mz = Math.min(RIG.margin * 0.6, h / 2);
  out.x = Math.max(mx, Math.min(w - mx, x));
  out.z = Math.max(mz, Math.min(h - mz * 0.4, z));
  return out;
}

export function rigGoal(target, yaw, out = {}, zoom = 1) {
  out.x = target.x + Math.sin(yaw) * RIG.distance * zoom;
  out.y = RIG.height * zoom;
  out.z = target.z + Math.cos(yaw) * RIG.distance * zoom;
  out.tx = target.x;
  out.ty = RIG.lookHeight;
  out.tz = target.z;
  return out;
}

/** Aproxima a câmera do objetivo de forma independente da taxa de quadros. */
export function rigStep(camera, goal, dt, rate = RIG.follow) {
  const blend = 1 - Math.exp(-rate * Math.max(0, Math.min(dt, 0.1)));
  for (const key of ['x', 'y', 'z', 'tx', 'ty', 'tz']) camera[key] += (goal[key] - camera[key]) * blend;
  return camera;
}
