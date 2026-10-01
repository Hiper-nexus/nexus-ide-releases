import { tickerPhrases } from './prizes.js';

/** Letreiro corrido do prêmio: duas cópias do mesmo grupo, para o laço fechar sem salto. */
export function buildMarquee(marquee, phrases = tickerPhrases()) {
  if (!marquee) return;
  const track = document.createElement('div');
  track.className = 'prize-marquee-track';
  for (let copy = 0; copy < 2; copy++) {
    const group = document.createElement('div');
    group.className = 'prize-marquee-group';
    for (const phrase of phrases) {
      const item = document.createElement('span');
      item.className = 'prize-marquee-item';
      item.textContent = phrase;
      group.append(item);
    }
    track.append(group);
  }
  marquee.append(track);
}
