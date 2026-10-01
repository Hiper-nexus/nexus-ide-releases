/** Monta o Nexus Data Café dentro de um palco: cria o HUD, o som, carrega o
 * progresso e liga os eventos da cena. Serve à comunidade e à página principal. */
import './datacafe.css';
import { createWorld } from './scene.js';
import { createAudio } from './audio.js';
import { loadProgress, clearProgress } from './progress.js';
import { titleFor, levelProgress, BADGES } from './tickets.js';

export const GROUP_URL = 'https://chat.whatsapp.com/CB1tWTp9SVkFeJeZ33N9qK';
export const LIVE_URL = 'https://www.youtube.com/@Vibecoding-ao-vivo';
const WA = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.47-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2-1.42.25-.69.25-1.29.18-1.41-.08-.13-.27-.2-.57-.35M12.05 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.22-3.74.99 1-3.65-.24-.38a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.83 9.83 0 0 1 2.89 7c0 5.45-4.44 9.88-9.88 9.88m8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.69 1.45c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.17-3.48-8.42"/></svg>';
const CUP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 8h11v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8Z"/><path d="M16 10h2a2.5 2.5 0 0 1 0 5h-2"/><path d="M8 4c0 1 .8 1.2.8 2M12 3.5c0 1.2.8 1.4.8 2.5"/></svg>';
const RACK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h8"/></svg>';

const STATIONS = {
  group: {
    kicker: 'SORTEIO NO GRUPO',
    title: 'Entrar no grupo é a inscrição',
    copy: 'Aos 200 membros sorteamos uma conta Claude 20x por 1 mês; aos 500, uma conta Codex 20x por 1 mês. O sorteio é ao vivo, numa live, entre quem está no grupo. Jogar não muda as chances.',
    url: GROUP_URL, label: 'Entrar no grupo', whatsapp: true,
  },
  live: {
    kicker: 'DO PROMPT AO DEPLOY',
    title: 'Vibe coding ao vivo',
    copy: 'Código, ideias e os bugs no meio do caminho. É lá que os sorteios acontecem.',
    url: LIVE_URL, label: 'Abrir o canal no YouTube', whatsapp: false,
  },
};

let counter = 0;

function hudMarkup(id) {
  return `
<div class="dc-status">
  <div class="dc-meter dc-energy" role="status" aria-label="Energia do café">${CUP}<span class="dc-track"><span class="dc-fill"></span></span><span class="dc-label mono">CAFÉ</span></div>
  <div class="dc-meter dc-racks mono">${RACK}<span class="dc-racks-count">0/18</span><span>NO AR</span></div>
</div>
<button class="dc-level" type="button" aria-expanded="false" aria-controls="${id}-panel"><span class="pixel">LVL <b class="dc-lvl">1</b></span><span class="dc-xpbar" aria-hidden="true"><span></span></span><span class="mono dc-title">Estagiário</span></button>
<aside class="dc-panel" id="${id}-panel" hidden aria-label="Tickets e ajustes">
  <div class="dc-panel-head"><strong>Tickets do NOC</strong><span class="mono"><span class="dc-xp">0</span> XP · M</span></div>
  <ol class="dc-ticket-list"></ol>
  <div class="dc-badges" aria-label="Selos"></div>
  <div class="dc-panel-actions"><button type="button" data-act="mute">Som ligado</button><button type="button" data-act="pause">Pausar</button><button type="button" data-act="reset">Recomeçar</button></div>
  <small class="dc-footnote">XP e progresso ficam só neste navegador e não contam para o sorteio.</small>
</aside>
<div class="dc-ticket-now mono" aria-live="polite"></div>
<button class="dc-prompt" type="button" hidden><kbd class="dc-key">E</kbd><span class="dc-prompt-text"></span><span class="dc-hold" aria-hidden="true"><span></span></span></button>
<div class="dc-joystick" aria-hidden="true"><span class="dc-ring"></span><span class="dc-knob"></span></div>
<div class="dc-hints"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> anda</span><span>segure <kbd>E</kbd> para interagir</span><span><kbd>M</kbd> tickets</span><span>arraste para girar</span></div>
<div class="dc-toast" role="status" aria-live="polite"></div>
<aside class="dc-station" hidden aria-labelledby="${id}-station-title"><button type="button" class="dc-close" aria-label="Fechar">✕</button><span class="mono dc-station-kicker"></span><h3 id="${id}-station-title" class="dc-station-title"></h3><p class="dc-station-copy"></p><a class="button dc-station-link" target="_blank" rel="noopener noreferrer"></a></aside>`;
}

/**
 * @param {HTMLElement} stage   contêiner posicionado que recebe o HUD
 * @param {object} options
 * @param {HTMLElement} options.host     onde o canvas é inserido (focável)
 * @param {'full'|'embed'} [options.variant]
 * @param {HTMLElement[]} [options.startButtons]
 * @param {boolean} [options.autostart]
 */
export function mountDataCafe(stage, { host, variant = 'full', startButtons = [], autostart = false, onError } = {}) {
  const id = `dc${++counter}`;
  const hud = document.createElement('div');
  hud.className = 'dc-hud';
  hud.dataset.variant = variant;
  hud.innerHTML = hudMarkup(id);
  stage.append(hud);
  stage.classList.add('dc-stage');
  const $ = selector => hud.querySelector(selector);
  const prompt = $('.dc-prompt');
  const panel = $('.dc-panel');
  const level = $('.dc-level');
  let toastTimer;

  const audio = createAudio();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function toast(text) {
    clearTimeout(toastTimer);
    const box = $('.dc-toast');
    box.textContent = text;
    box.classList.add('visible');
    toastTimer = setTimeout(() => box.classList.remove('visible'), 3200);
  }

  function togglePanel(force) {
    const open = force ?? panel.hidden;
    panel.hidden = !open;
    level.setAttribute('aria-expanded', String(open));
  }

  function openStation(key) {
    const item = STATIONS[key];
    if (!item) return;
    const box = $('.dc-station');
    $('.dc-station-kicker').textContent = item.kicker;
    $('.dc-station-title').textContent = item.title;
    $('.dc-station-copy').textContent = item.copy;
    const link = $('.dc-station-link');
    link.href = item.url;
    link.className = `button dc-station-link ${item.whatsapp ? 'button-whatsapp' : 'button-white'}`;
    link.innerHTML = `${item.whatsapp ? WA : ''} ${item.label} ↗`;
    box.hidden = false;
  }

  const world = createWorld(host, {
    reducedMotion,
    audio,
    progress: loadProgress(),
    joystick: $('.dc-joystick'),
    on: {
      energy(level, tired) {
        $('.dc-fill').style.transform = `scaleX(${level.toFixed(3)})`;
        const meter = $('.dc-energy');
        meter.classList.toggle('low', level < 0.3 && !tired);
        meter.classList.toggle('empty', tired);
        $('.dc-label').textContent = tired ? 'SEM CAFÉ' : level < 0.3 ? 'CAFÉ BAIXO' : 'CAFÉ';
      },
      racks(powered, total) {
        $('.dc-racks-count').textContent = `${powered}/${total}`;
        $('.dc-racks').classList.toggle('complete', powered === total);
      },
      objective(goal) {
        $('.dc-ticket-now').textContent = goal ? goal.text : 'NOC em ordem. Bora de café?';
        $('.dc-ticket-now').dataset.kind = goal?.kind ?? 'ok';
      },
      tickets(list) {
        $('.dc-ticket-list').replaceChildren(...list.slice(0, 6).map(ticket => {
          const item = document.createElement('li');
          item.dataset.kind = ticket.kind;
          item.innerHTML = `<span class="dc-dot"></span><span></span><small class="mono">+${ticket.xp} XP</small>`;
          item.children[1].textContent = ticket.title;
          return item;
        }));
      },
      prompt(label) {
        prompt.hidden = !label;
        if (!label) return;
        $('.dc-prompt-text').textContent = label.text;
        prompt.classList.toggle('blocked', label.blocked);
      },
      hold(progress) {
        $('.dc-hold>span').style.transform = `scaleX(${progress})`;
      },
      xp({ progress, gained, leveledUp }) {
        $('.dc-lvl').textContent = progress.level;
        $('.dc-title').textContent = titleFor(progress.level);
        $('.dc-xp').textContent = progress.xp;
        $('.dc-xpbar>span').style.transform = `scaleX(${levelProgress(progress.xp).toFixed(3)})`;
        $('.dc-badges').replaceChildren(...progress.badges.map(badge => {
          const chip = document.createElement('span');
          chip.className = 'dc-badge mono';
          chip.textContent = BADGES[badge];
          return chip;
        }));
        if (leveledUp && gained) toast(`Subiu de nível: ${titleFor(progress.level)}`);
      },
      badge(badge) { toast(`Selo: ${BADGES[badge]}`); },
      toast,
      station: openStation,
      menu: () => togglePanel(),
      requestStart: () => start(),
      error() {
        toast('O modo 3D foi interrompido. O grupo e as lives continuam abaixo.');
        onError?.();
      },
    },
  });

  function start() {
    if (world.playing) return;
    stage.classList.add('dc-playing');
    world.start();
    toast(matchMedia('(pointer: coarse)').matches
      ? 'Use o joystick para andar e segure o botão para interagir. Comece pela doca de GPUs.'
      : 'WASD anda, segure E para interagir. Comece pegando uma GPU na doca.');
  }

  // Botão de ação: segurar com mouse, toque ou teclado.
  const press = event => { event.preventDefault(); try { prompt.setPointerCapture(event.pointerId); } catch { /* sintético */ } world.holdStart(); };
  prompt.addEventListener('pointerdown', press);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) prompt.addEventListener(name, () => world.holdEnd());
  level.addEventListener('click', () => togglePanel());
  $('.dc-close').addEventListener('click', () => { $('.dc-station').hidden = true; host.focus({ preventScroll: true }); });
  const muteButton = hud.querySelector('[data-act=mute]');
  const paintMute = () => { muteButton.textContent = audio.isMuted() ? 'Som desligado' : 'Som ligado'; muteButton.setAttribute('aria-pressed', String(!audio.isMuted())); };
  paintMute();
  muteButton.addEventListener('click', () => { audio.unlock(); audio.setMuted(!audio.isMuted()); paintMute(); });
  hud.querySelector('[data-act=pause]').addEventListener('click', event => {
    const paused = world.togglePause();
    event.currentTarget.textContent = paused ? 'Retomar' : 'Pausar';
  });
  hud.querySelector('[data-act=reset]').addEventListener('click', () => { clearProgress(); world.resetProgress(); toast('Progresso recomeçado.'); });
  hud.addEventListener('keydown', event => { if (event.key === 'Escape') { togglePanel(false); $('.dc-station').hidden = true; } });
  for (const button of startButtons) button?.addEventListener('click', start);
  if (autostart) start();

  return {
    start,
    resetProgress: () => { clearProgress(); world.resetProgress(); },
    dispose() {
      world.dispose();
      audio.dispose();
      clearTimeout(toastTimer);
      hud.remove();
      stage.classList.remove('dc-stage', 'dc-playing');
    },
  };
}
