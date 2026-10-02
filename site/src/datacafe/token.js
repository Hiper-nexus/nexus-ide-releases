/** A ficha do prêmio e as faíscas em volta dela, como poses puras (local à âncora).
 * Frente (+z) é o Claude; as costas, o Codex. Nada aqui conhece o Three.js. */
export const TOKEN = Object.freeze({
  y: 0,
  bob: 0.09,
  /** Radianos por segundo: uma volta a cada ~7 s, devagar o bastante para ler a face. */
  spinRate: 0.9,
  sparkles: 14,
  sparkleRadius: 0.95,
});

const GOLDEN = 2.399963;
const CALM_SPIN = 0.35;

/** Altura e giro da ficha em `time`; `face` diz qual lado olha para a câmera. */
export function tokenPose(time, calm) {
  const spin = calm ? CALM_SPIN : time * TOKEN.spinRate;
  return {
    y: calm ? TOKEN.y : TOKEN.y + Math.sin(time * 1.7) * TOKEN.bob,
    spin,
    face: Math.cos(spin) > 0 ? 'front' : 'back',
  };
}

const frac = value => value - Math.floor(value);

/** Posição e escala (0 a 1) da faísca `index`; escreve em `out` para não alocar a cada quadro. */
export function sparkleAt(index, time, calm, out) {
  const phase = index * GOLDEN;
  const orbit = phase + (calm ? 0 : time * (0.35 + (index % 3) * 0.12));
  const lift = Math.sin(phase * 3.1 + (calm ? 0 : time * 0.8)) * 0.8;
  const radius = TOKEN.sparkleRadius * (0.55 + 0.45 * frac(index * 0.618));
  const flat = Math.sqrt(Math.max(0, 1 - lift * lift));
  out.x = Math.cos(orbit) * radius * flat;
  out.z = Math.sin(orbit) * radius * flat * 0.5;
  out.y = lift * radius * 0.8;
  out.scale = calm ? 0.2 + 0.4 * frac(index * 0.37) : Math.pow(0.5 + 0.5 * Math.sin(time * 2.2 + phase * 5), 1.5);
  return out;
}
