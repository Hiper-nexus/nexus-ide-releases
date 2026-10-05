import '@fontsource-variable/geist';
import './community.css';
import './prize.css';
import './calm.css';
import { applyCalmMotion } from './calm-motion.js';
import { buildMarquee } from './sorteio/marquee.js';
import { startDrawSign } from './sorteio/reel.js';
import { tiltFor } from './sorteio/tilt.js';

// No Linux desktop a página nasce no movimento calmo (ver calm-motion.js).
const calmMotion = applyCalmMotion();
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

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** O bilhete do próximo prêmio cede na ponta que o ponteiro encosta e o brilho segue o dedo. */
function tiltTicket(ticket) {
  if (!ticket || calmMotion || reducedMotion() || !matchMedia('(hover: hover)').matches) return;
  let frame = 0;
  const paint = event => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const { rx, ry, mx, my } = tiltFor(ticket.getBoundingClientRect(), event.clientX, event.clientY);
      ticket.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
      ticket.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
      ticket.style.setProperty('--mx', `${mx.toFixed(1)}%`);
      ticket.style.setProperty('--my', `${my.toFixed(1)}%`);
    });
  };
  ticket.addEventListener('pointerenter', () => ticket.classList.add('tilting'));
  ticket.addEventListener('pointermove', paint);
  ticket.addEventListener('pointerleave', () => {
    cancelAnimationFrame(frame);
    ticket.classList.remove('tilting');
    ticket.style.removeProperty('--rx');
    ticket.style.removeProperty('--ry');
  });
}

/** Os bilhetes saem da impressora uma vez, quando o quadro deles chega à tela. Quem observa é o quadro, nunca o
 * bilhete: o bilhete começa recortado e um alvo recortado pode nunca ser considerado visível. Sem observador ou
 * com redução de movimento, nada fica escondido. */
function printTickets(board) {
  const tickets = board ? [...board.querySelectorAll('.drop')] : [];
  if (!tickets.length || reducedMotion() || !('IntersectionObserver' in window)) return;
  document.body.classList.add('prize-ready');
  const observer = new IntersectionObserver(entries => {
    if (!entries.some(entry => entry.isIntersecting)) return;
    tickets.forEach(ticket => ticket.classList.add('printed'));
    observer.disconnect();
  }, { threshold: 0.15 });
  observer.observe(board);
}

buildMarquee(id('prize-marquee'));
tiltTicket(document.querySelector('.drop-next'));
printTickets(document.querySelector('.sorteio-board'));
startDrawSign(id('draw-sign'));
boot();
