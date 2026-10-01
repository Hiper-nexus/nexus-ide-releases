import '@fontsource-variable/geist';
import './community.css';

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

boot();
