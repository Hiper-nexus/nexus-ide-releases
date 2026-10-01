/** Letreiro do sorteio: as letras giram e a frase se revela da esquerda para a direita,
 * como o nome saindo ao vivo. Puro: o acaso vem de fora, para o teste escolher. */
export const DRAW = {
  glyphs: 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789',
  /** Quanto tempo as letras giram até a frase fechar (ms). */
  spin: 1500,
  /** Quanto tempo a frase fica parada antes de girar de novo (ms). */
  hold: 5200,
  /** Intervalo entre um quadro e outro (ms). */
  tick: 60,
};

/** O que o letreiro mostra em `progress` (0 = tudo girando, 1 = frase inteira). */
export function drawFrame(text, progress, random = Math.random) {
  const shown = Math.floor(Math.max(0, Math.min(1, progress)) * text.length);
  let frame = '';
  for (let i = 0; i < text.length; i++) {
    const settled = i < shown || text[i] === ' ';
    frame += settled ? text[i] : DRAW.glyphs[Math.floor(random() * DRAW.glyphs.length)];
  }
  return frame;
}
