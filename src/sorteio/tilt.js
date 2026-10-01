/** Inclinação do bilhete sob o ponteiro: a ponta que o ponteiro encosta cede um pouco e o
 * brilho segue o dedo. Puro: recebe o retângulo e a posição, devolve graus e porcentagens. */
export const TILT = Object.freeze({ max: 7 });

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function tiltFor(rect, x, y) {
  const width = rect.width > 0 ? rect.width : 1;
  const height = rect.height > 0 ? rect.height : 1;
  const px = clamp((x - rect.left) / width, 0, 1);
  const py = clamp((y - rect.top) / height, 0, 1);
  return {
    ry: (px - 0.5) * 2 * TILT.max,
    rx: (0.5 - py) * 2 * TILT.max,
    mx: px * 100,
    my: py * 100,
  };
}
