import '@fontsource-variable/geist';
import './style.css';

const GROUP_URL = 'https://chat.whatsapp.com/CB1tWTp9SVkFeJeZ33N9qK';
const YOUTUBE_URL = 'https://www.youtube.com/@Vibecoding-ao-vivo';
const stations = {
  claude: { kicker: 'DROP / 001', title: 'Claude 20x', description: 'Uma conta Claude 20x por um mês. Para participar, esteja dentro do grupo e acompanhe o anúncio do sorteio.', label: 'Entrar no grupo', url: GROUP_URL },
  codex: { kicker: 'DROP / 002', title: 'Codex 20x', description: 'Uma conta Codex 20x. A data e os detalhes do prêmio serão anunciados no grupo, conforme a comunidade crescer.', label: 'Entrar no grupo', url: GROUP_URL },
  live: { kicker: 'DO PROMPT AO DEPLOY', title: 'Vibe coding ao vivo', description: 'Ideias, código e os bugs no meio do caminho. Acompanhe as lives e os projetos da nossa comunidade.', label: 'Abrir canal no YouTube', url: YOUTUBE_URL },
};
const dialog = document.querySelector('#station-dialog');
const toast = document.querySelector('#toast');
let toastTimer;

function openStation(key) {
  const station = stations[key];
  if (!station) return;
  document.querySelector('#station-kicker').textContent = station.kicker;
  document.querySelector('#station-title').textContent = station.title;
  document.querySelector('#station-description').textContent = station.description;
  const link = document.querySelector('#station-link');
  link.href = station.url;
  link.textContent = station.label + ' ↗';
  dialog.showModal();
}

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
dialog.addEventListener('click', event => {
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
if (!reducedMotion.matches && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('js-reveal');
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(element => observer.observe(element));
  const tagline = document.querySelector('.word-reveal');
  tagline.replaceChildren(...tagline.textContent.split(' ').map((word,index) => {
    const span = document.createElement('span');
    span.textContent = word + ' ';
    span.style.transitionDelay = `${index * 140}ms`;
    return span;
  }));
  const words = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) {
      entry.target.classList.add('word-visible');
      words.unobserve(entry.target);
    }
  },{threshold:1});
  tagline.querySelectorAll('span').forEach(word => words.observe(word));
}

async function startWorld() {
  const host = document.querySelector('#world');
  try {
    const { createWorld } = await import('./world/scene.js');
    const world = createWorld(host, {
      reducedMotion: reducedMotion.matches,
      onStation: openStation,
      onCoffee: count => {
        document.querySelector('#coffee-score').textContent = count;
        notify(count === 5 ? 'Café completo. Agora bora construir. O sorteio acontece no grupo.' : `Café encontrado. ${count}/5 na sua mesa.`);
      },
    });
    document.querySelector('#world-toggle').ariaPressed = String(reducedMotion.matches);
    document.querySelector('#world-toggle').textContent = reducedMotion.matches ? 'Ativar movimento' : 'Pausar movimento';
    document.querySelector('#world-toggle').addEventListener('click', event => {
      const paused = world.togglePause();
      event.currentTarget.ariaPressed = String(paused);
      event.currentTarget.textContent = paused ? 'Ativar movimento' : 'Pausar movimento';
    });
    document.querySelector('#world-reset').addEventListener('click', world.reset);
    window.addEventListener('pagehide', world.dispose, {once:true});
  } catch (error) {
    console.warn('Nexus playground unavailable:', error.message);
    document.querySelector('#world-loading').hidden = true;
    document.querySelector('#world-toggle').hidden = true;
    document.querySelector('#world-reset').hidden = true;
    document.querySelector('.touch-controls').hidden = true;
    document.querySelector('.world-help').textContent = 'O conteúdo e os links continuam disponíveis sem o modo 3D.';
    document.querySelector('.world-hud').hidden = true;
    document.querySelector('.game-note').hidden = true;
  }
}

startWorld();
