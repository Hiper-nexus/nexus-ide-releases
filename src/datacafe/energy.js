/** Energia do dev, que vem do café. Estado puro e imutável: cada função devolve
 * um novo objeto. Cansado, o dev anda devagar mas nunca trava. */
export const ENERGY = {
  max: 1,
  /** Um café bem tirado passa um pouco do máximo e esse excedente se dissipa. */
  overflow: 1.2,
  drink: 1.15,
  /** Queda por segundo parado, andando e carregando uma caixa. */
  idle: 0.004,
  walk: 0.011,
  carry: 0.018,
  overflowDecay: 0.08,
  /** Histerese: cansa em 0.2 e só desperta acima de 0.35. */
  tiredAt: 0.2,
  awakeAt: 0.35,
  tiredSpeed: 0.55,
  /** Abaixo disto a cafeteira vira ticket. */
  low: 0.3,
};

export function createEnergy() {
  return { value: ENERGY.max, tired: false };
}

export function energyStep(energy, dt, { moving = false, carrying = false } = {}) {
  const step = Math.max(0, Math.min(dt, 0.1));
  let value = energy.value;
  if (value > ENERGY.max) {
    value = Math.max(ENERGY.max, value - ENERGY.overflowDecay * step);
  } else {
    const drain = ENERGY.idle + (moving ? ENERGY.walk : 0) + (moving && carrying ? ENERGY.carry : 0);
    value = Math.max(0, value - drain * step);
  }
  const tired = energy.tired ? value < ENERGY.awakeAt : value <= ENERGY.tiredAt;
  if (value === energy.value && tired === energy.tired) return energy;
  return { value, tired };
}

export function drink(energy) {
  return { value: Math.min(ENERGY.overflow, Math.max(energy.value, ENERGY.drink)), tired: false };
}

export function isTired(energy) {
  return energy.tired;
}

/** Multiplicador de velocidade: cansado anda a pouco mais da metade. */
export function speedScale(energy) {
  return energy.tired ? ENERGY.tiredSpeed : 1;
}

export function energyLevel(energy) {
  return Math.min(1, energy.value / ENERGY.max);
}
