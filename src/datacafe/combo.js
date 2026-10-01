/** Combo de entregas: instalar ou reiniciar um rack logo depois do outro soma
 * uma sequência que multiplica o XP. Puro e imutável. */
export const COMBO = {
  /** Segundos para emendar a próxima entrega (doca até o rack leva uns 10 s). */
  window: 18,
  /** Cada entrega da sequência depois da primeira soma isto ao multiplicador. */
  step: 0.25,
  max: 2,
};

const IDLE = Object.freeze({ streak: 0, left: 0 });

export function createCombo() {
  return IDLE;
}

export function comboHit(combo) {
  return { streak: combo.left > 0 ? combo.streak + 1 : 1, left: COMBO.window };
}

export function comboStep(combo, dt) {
  if (combo.left <= 0) return combo;
  const left = combo.left - dt;
  return left > 0 ? { streak: combo.streak, left } : IDLE;
}

export function comboMultiplier(combo) {
  return Math.min(COMBO.max, 1 + COMBO.step * Math.max(0, combo.streak - 1));
}

/** Tempo restante de 1 a 0, para o medidor do HUD. */
export function comboLevel(combo) {
  return Math.max(0, combo.left) / COMBO.window;
}
