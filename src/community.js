import '@fontsource-variable/geist';
import './community.css';
import { DRAW, drawFrame } from './sorteio/draw.js';

const id = name => document.getElementById(name);

async function boot() {
  const stage = document.querySelector('.game-stage');
  const start = id('start-game');
  try {
    // VT323 pinta os letreiros e telões do data center: precisa estar pronta antes da cena.
    try { await document.fonts.load('80px VT323'); } catch { /* cai na monoespaçada do sistema */ }
    const { mountDataCafe } = await import('./datacafe/mount.js');
    const game = mountDataCafe(stage, {
      host: id('world'),
      variant: 'full',
      startButtons: [start],
      onError: () => { start.disabled = true; },
    });
    id('world-loading').hidden = true;
    id('clear-progress')?.addEventListener('click', () => { game.resetProgress(); id('clear-progress').textContent = 'Progresso recomeçado'; });
    // O bfcache mantém a página viva: só um descarregamento de verdade descarta o mundo.
    window.addEventListener('pagehide', event => { if (!event.persisted) game.dispose(); });
  } catch (error) {
    console.warn('Nexus Data Café:', error.message);
    id('world-loading').hidden = true;
    start.textContent = 'Jogo 3D indisponível neste navegador';
    start.disabled = true;
  }
}

/** O letreiro do ganhador gira só enquanto está na tela; com redução de movimento fica na frase. */
function startDrawSign(sign) {
  if (!sign || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const phrase = sign.textContent;
  let timer = 0;
  const spin = () => {
    const began = performance.now();
    const frame = () => {
      const progress = (performance.now() - began) / DRAW.spin;
      sign.textContent = drawFrame(phrase, progress);
      timer = setTimeout(progress < 1 ? frame : spin, progress < 1 ? DRAW.tick : DRAW.hold);
    };
    frame();
  };
  new IntersectionObserver(([entry]) => {
    clearTimeout(timer);
    if (entry.isIntersecting) spin(); else sign.textContent = phrase;
  }, { threshold: 0.6 }).observe(sign);
}

startDrawSign(id('draw-sign'));
boot();
