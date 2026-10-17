/** Monta o Nexus Data Café dentro de um palco: cria o HUD, o som, carrega o
 * progresso e liga os eventos da cena. Serve à comunidade e à página principal. */
import './datacafe.css';
import { createWorld } from './scene.js';
import { createAudio } from './audio.js';
import { loadProgress, clearProgress } from './progress.js';
import { titleFor, levelProgress, BADGES } from './tickets.js';
import { formatClock } from './shift.js';
import { chipParts, groupStation } from './prize-ui.js';
import { nextPrize } from '../sorteio/prizes.js';

export const GROUP_URL = 'https://chat.whatsapp.com/CB1tWTp9SVkFeJeZ33N9qK';
export const LIVE_URL = 'https://www.youtube.com/@Vibecoding-ao-vivo';
const WA = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.08-.3-.15-1.26-.47-2.4-1.48-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.7.63.71.22 1.36.19 1.87.12.57-.09 1.76-.72 2-1.42.25-.69.25-1.29.18-1.41-.08-.13-.27-.2-.57-.35M12.05 21.79h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.22-3.74.99 1-3.65-.24-.38a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.83 9.83 0 0 1 2.89 7c0 5.45-4.44 9.88-9.88 9.88m8.41-18.3A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.69 1.45c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.17-3.48-8.42"/></svg>';
const CUP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 8h11v7a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8Z"/><path d="M16 10h2a2.5 2.5 0 0 1 0 5h-2"/><path d="M8 4c0 1 .8 1.2.8 2M12 3.5c0 1.2.8 1.4.8 2.5"/></svg>';
const RACK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h8"/></svg>';
const CLOCK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 3h6"/></svg>';
const SPEAKER = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10v4h3l5 4V6L7 10H4Z"/><path class="dc-sound-on" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/><path class="dc-sound-off" d="m16 9.5 5 5m0-5-5 5"/></svg>';

const STATIONS = {
  group: groupStation(GROUP_URL),
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
  <div class="dc-row">
    <div class="dc-meter dc-energy" role="status" aria-label="Energia do café">${CUP}<span class="dc-track"><span class="dc-fill"></span></span><span class="dc-label mono">CAFÉ</span></div>
    <button class="dc-sound" type="button" aria-pressed="true" aria-label="Som do jogo">${SPEAKER}</button>
  </div>
  <div class="dc-row dc-chips">
    <div class="dc-meter dc-boost mono" role="timer" aria-label="Turbo do Nexus+" hidden><span class="dc-boost-name pixel">NEXUS+</span><span class="dc-track"><span class="dc-boost-fill"></span></span><span class="dc-boost-label">TURBO</span><span class="dc-boost-time">0:20</span></div>
    <div class="dc-meter dc-racks mono">${RACK}<span class="dc-racks-count">0/18</span><span class="dc-racks-label">NO AR</span></div>
    <div class="dc-meter dc-shift mono" role="timer" aria-label="Tempo e pontos do turno">${CLOCK}<span class="dc-shift-clock">3:00</span><span class="dc-shift-score">0 PTS</span></div>
    <div class="dc-meter dc-combo mono" hidden><span class="dc-combo-x pixel">×1</span><span class="dc-track"><span class="dc-combo-fill"></span></span><span class="dc-combo-label">COMBO</span></div>
  </div>
</div>
<button class="dc-prize" type="button" aria-controls="${id}-station"><i class="dc-prize-dot" aria-hidden="true"></i><span class="dc-prize-tag mono"></span><span class="dc-prize-name pixel"></span><span class="dc-prize-goal mono"></span></button>
<button class="dc-level" type="button" aria-expanded="false" aria-controls="${id}-panel"><span class="pixel">LVL <b class="dc-lvl">1</b></span><span class="dc-xpbar" aria-hidden="true"><span></span></span><span class="mono dc-title">Estagiário</span></button>
<aside class="dc-panel" id="${id}-panel" hidden aria-label="Missões, tickets e ajustes">
  <div class="dc-panel-head"><strong>Missões do turno</strong><span class="mono">RECORDE <span class="dc-best">0</span> PTS</span></div>
  <ol class="dc-mission-list"></ol>
  <div class="dc-panel-head"><strong>Tickets do NOC</strong><span class="mono"><span class="dc-xp">0</span> XP · M</span></div>
  <div class="dc-tickets"><ol class="dc-ticket-list" hidden></ol><div class="dc-empty">${CUP}<div><strong>Nenhum ticket pendente</strong><p>Tudo em ordem por aqui. Explore o café e acompanhe as próximas missões.</p></div></div></div>
  <div class="dc-badges" aria-label="Selos"><div class="dc-badge-list" hidden></div><div class="dc-empty">${RACK}<div><strong>Seu primeiro selo começa na doca</strong><p>Pegue uma GPU e instale em um rack para conquistar o primeiro selo.</p></div></div></div>
  <label class="dc-volume"><span class="mono">VOLUME</span><input type="range" min="0" max="100" step="5" aria-label="Volume do jogo"></label>
  <div class="dc-panel-actions"><button type="button" data-act="mute">Som ligado</button><button type="button" data-act="pause">Pausar</button><button type="button" data-act="reset">Recomeçar</button></div>
  <small class="dc-footnote">XP, recorde e progresso ficam só neste navegador e não contam para o sorteio.</small>
</aside>
<div class="dc-ticket-now mono" aria-live="polite"></div>
<div class="dc-mission mono" hidden><span class="dc-mission-text"></span><span class="dc-mission-count"></span><span class="dc-mission-bar" aria-hidden="true"><span></span></span></div>
<button class="dc-prompt" type="button" hidden><kbd class="dc-key">E</kbd><span class="dc-prompt-text"></span><span class="dc-hold" aria-hidden="true"><span></span></span></button>
<div class="dc-joystick" aria-hidden="true"><span class="dc-ring"></span><span class="dc-knob"></span></div>
<div class="dc-hints"><span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> anda</span><span>segure <kbd>E</kbd> para interagir</span><span><kbd>M</kbd> tickets</span><span>arraste gira, a roda aproxima</span></div>
<div class="dc-toast" role="status" aria-live="polite" tabindex="-1"></div>
<aside class="dc-station" id="${id}-station" hidden aria-labelledby="${id}-station-title"><button type="button" class="dc-close" aria-label="Fechar"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button><span class="mono dc-station-kicker"></span><h3 id="${id}-station-title" class="dc-station-title"></h3><ol class="dc-station-prizes" hidden></ol><p class="dc-station-copy"></p><a class="button dc-station-link" target="_blank" rel="noopener noreferrer"></a><p class="dc-station-note" hidden></p></aside>`;
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
  const chip = chipParts(nextPrize());
  const prizeChip = $('.dc-prize');
  prizeChip.setAttribute('aria-label', `${chip.label}. Abrir o painel do sorteio.`);
  [$('.dc-prize-tag'), $('.dc-prize-name'), $('.dc-prize-goal')].forEach((node, index) => { node.textContent = chip.parts[index]; });
  let toastTimer = null;
  let toastRemaining = 0;
  let toastStarted = 0;
  let disposed = false;
  const aborter = new AbortController();
  const listen = { signal: aborter.signal };

  const audio = createAudio();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** O relógio do turno chega várias vezes por segundo: só escreve no DOM o que mudou. */
  const shown = { clock: '', score: -1, best: -1, boost: -1 };

  const toastBox = $('.dc-toast');
  function resumeToast() {
    if (disposed || toastTimer !== null || !toastBox.classList.contains('visible') || toastBox.matches(':hover, :focus-within')) return;
    toastStarted = performance.now();
    toastTimer = setTimeout(() => {
      toastTimer = null;
      toastBox.classList.remove('visible');
      toastBox.tabIndex = -1;
    }, toastRemaining);
  }
  function pauseToast() {
    if (toastTimer === null) return;
    clearTimeout(toastTimer);
    toastTimer = null;
    toastRemaining = Math.max(0, toastRemaining - (performance.now() - toastStarted));
  }
  for (const event of ['pointerenter', 'focusin']) toastBox.addEventListener(event, pauseToast, listen);
  toastBox.addEventListener('pointerleave', resumeToast, listen);
  // focusout precede a troca de activeElement: confira o foco depois dela.
  toastBox.addEventListener('focusout', () => queueMicrotask(resumeToast), listen);

  function toast(text) {
    if (disposed) return;
    clearTimeout(toastTimer);
    toastTimer = null;
    toastRemaining = 3200;
    toastBox.textContent = text;
    toastBox.classList.add('visible');
    toastBox.tabIndex = 0;
    resumeToast();
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
    const rows = $('.dc-station-prizes');
    rows.hidden = !item.prizes;
    rows.replaceChildren(...(item.prizes ?? []).map(prize => {
      const row = document.createElement('li');
      row.className = 'dc-prize-row';
      row.dataset.next = String(prize.next);
      row.innerHTML = '<span class="dc-prize-row-name"></span><span class="dc-prize-row-badge mono"></span><span class="dc-prize-row-goal"></span><span class="dc-prize-row-meta mono"></span>';
      row.children[0].textContent = prize.name;
      row.children[1].textContent = prize.badge;
      row.children[2].textContent = prize.goal;
      row.children[3].textContent = prize.meta;
      return row;
    }));
    const note = $('.dc-station-note');
    note.hidden = !item.note;
    note.textContent = item.note ?? '';
    const link = $('.dc-station-link');
    link.href = item.url;
    link.className = `button dc-station-link ${item.whatsapp ? 'button-whatsapp' : 'button-white'}`;
    link.innerHTML = `${item.whatsapp ? WA : ''} ${item.label} ↗`;
    box.hidden = false;
  }

  const worldOptions = {
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
      racks(operational, total, installed = operational) {
        $('.dc-racks-count').textContent = `${operational}/${total}`;
        const down = installed - operational;
        $('.dc-racks-label').textContent = down > 0 ? `NO AR · ${down} ${down === 1 ? 'CAÍDO' : 'CAÍDOS'}` : 'NO AR';
        $('.dc-racks').classList.toggle('complete', operational === total);
        $('.dc-racks').classList.toggle('down', down > 0);
      },
      objective(goal) {
        $('.dc-ticket-now').textContent = goal ? goal.text : 'NOC em ordem. Bora de café?';
        $('.dc-ticket-now').dataset.kind = goal?.kind ?? 'ok';
      },
      tickets(list) {
        $('.dc-tickets .dc-empty').hidden = list.length > 0;
        $('.dc-ticket-list').hidden = list.length === 0;
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
        $('.dc-badges .dc-empty').hidden = progress.badges.length > 0;
        $('.dc-badge-list').hidden = progress.badges.length === 0;
        $('.dc-badge-list').replaceChildren(...progress.badges.map(badge => {
          const chip = document.createElement('span');
          chip.className = 'dc-badge mono';
          chip.textContent = BADGES[badge];
          return chip;
        }));
      },
      missions(list) {
        const first = list[0];
        $('.dc-mission').hidden = !first;
        if (first) {
          $('.dc-mission-text').textContent = `Missão: ${first.text}`;
          $('.dc-mission-count').textContent = `${first.done}/${first.goal} · +${first.xp} XP`;
          $('.dc-mission-bar>span').style.transform = `scaleX(${(first.done / first.goal).toFixed(3)})`;
        }
        $('.dc-mission-list').replaceChildren(...list.map(mission => {
          const item = document.createElement('li');
          item.innerHTML = '<span></span><small class="mono"></small>';
          item.children[0].textContent = mission.text;
          item.children[1].textContent = `${mission.done}/${mission.goal} · +${mission.xp} XP`;
          return item;
        }));
      },
      combo(streak, multiplier, level) {
        const chip = $('.dc-combo');
        chip.hidden = streak < 2;
        if (streak < 2) return;
        $('.dc-combo-x').textContent = `×${multiplier}`;
        $('.dc-combo-label').textContent = `${streak} EM SEQUÊNCIA`;
        $('.dc-combo-fill').style.transform = `scaleX(${level.toFixed(3)})`;
      },
      shift(left, score, best) {
        const clock = formatClock(left);
        if (clock !== shown.clock) { shown.clock = clock; $('.dc-shift-clock').textContent = clock; $('.dc-shift').classList.toggle('ending', left <= 20); }
        if (score !== shown.score) { shown.score = score; $('.dc-shift-score').textContent = `${score} PTS`; }
        if (best !== shown.best) { shown.best = best; $('.dc-best').textContent = best; }
      },
      /** Turbo do Nexus+ (marca fictícia): chip com a barra que esvazia. Só escreve no DOM o que mudou. */
      turbo(left, level) {
        const chip = $('.dc-boost');
        const seconds = Math.ceil(left);
        chip.hidden = seconds <= 0;
        if (seconds <= 0) { shown.boost = -1; return; }
        $('.dc-boost-fill').style.transform = `scaleX(${level.toFixed(3)})`;
        if (seconds === shown.boost) return;
        shown.boost = seconds;
        $('.dc-boost-time').textContent = formatClock(seconds);
        chip.setAttribute('aria-label', `Turbo do Nexus+: ${seconds} segundos`);
        chip.classList.toggle('ending', seconds <= 3);
      },
      turboFx(active) { stage.classList.toggle('dc-turbo', active); },
      toast,
      station: openStation,
      menu: () => togglePanel(),
      requestStart: () => start(),
      error() {
        toast('O modo 3D foi interrompido. O grupo e as lives continuam abaixo.');
        onError?.();
      },
    },
  };
  let world;
  try {
    world = createWorld(host, worldOptions);
  } catch (error) {
    aborter.abort();
    clearTimeout(toastTimer);
    audio.dispose();
    hud.remove();
    stage.classList.remove('dc-stage');
    throw error;
  }

  function start() {
    if (disposed || world.playing) return;
    stage.classList.add('dc-playing');
    world.start();
    toast(matchMedia('(pointer: coarse)').matches
      ? 'Use o joystick para andar e segure o botão para interagir. Comece pela doca de GPUs.'
      : 'WASD anda, segure E para interagir. Comece pegando uma GPU na doca.');
  }

  // Botão de ação: segurar com mouse, toque ou teclado.
  const press = event => { event.preventDefault(); try { prompt.setPointerCapture(event.pointerId); } catch { /* sintético */ } world.holdStart(); };
  prompt.addEventListener('pointerdown', press, listen);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) prompt.addEventListener(name, () => world.holdEnd(), listen);
  // Teclado no próprio botão: E, Enter ou Espaço seguram a ação como no jogo.
  prompt.addEventListener('keydown', event => {
    if (!['e', 'E', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) world.holdStart();
  }, listen);
  prompt.addEventListener('keyup', event => { if (['e', 'E', 'Enter', ' '].includes(event.key)) world.holdEnd(); }, listen);
  level.addEventListener('click', () => togglePanel(), listen);
  // Quem abriu o painel pelo chip recebe o foco de volta nele; os demais voltam ao jogo.
  let stationOpener = null;
  const closeStation = () => {
    $('.dc-station').hidden = true;
    const back = stationOpener ?? host;
    stationOpener = null;
    back.focus({ preventScroll: true });
  };
  prizeChip.addEventListener('click', () => { stationOpener = prizeChip; world.seePrize(); $('.dc-close').focus({ preventScroll: true }); }, listen);
  $('.dc-close').addEventListener('click', closeStation, listen);
  const muteButton = hud.querySelector('[data-act=mute]');
  const soundButton = $('.dc-sound');
  const volume = $('.dc-volume input');
  const paintMute = () => {
    const on = !audio.isMuted();
    muteButton.textContent = on ? 'Som ligado' : 'Som desligado';
    for (const button of [muteButton, soundButton]) button.setAttribute('aria-pressed', String(on));
    soundButton.title = on ? 'Desligar o som' : 'Ligar o som';
  };
  paintMute();
  const toggleMute = () => { audio.unlock(); audio.setMuted(!audio.isMuted()); paintMute(); };
  muteButton.addEventListener('click', toggleMute, listen);
  soundButton.addEventListener('click', () => { toggleMute(); host.focus({ preventScroll: true }); }, listen);
  volume.value = String(Math.round(audio.getVolume() * 100));
  volume.addEventListener('input', () => { audio.unlock(); audio.setVolume(Number(volume.value) / 100); if (audio.isMuted() && Number(volume.value) > 0) toggleMute(); }, listen);
  hud.querySelector('[data-act=pause]').addEventListener('click', event => {
    const paused = world.togglePause();
    event.currentTarget.textContent = paused ? 'Retomar' : 'Pausar';
  }, listen);
  hud.querySelector('[data-act=reset]').addEventListener('click', () => {
    clearProgress();
    world.resetProgress();
    hud.querySelector('[data-act=pause]').textContent = 'Pausar';
    toast('Progresso recomeçado.');
  }, listen);
  hud.addEventListener('keydown', event => { if (event.key === 'Escape') { togglePanel(false); closeStation(); } }, listen);
  // Os botões de início são da página: o AbortController os solta no dispose.
  for (const button of startButtons) button?.addEventListener('click', start, listen);
  if (autostart) start();

  return {
    start,
    resetProgress: () => { clearProgress(); world.resetProgress(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      aborter.abort();
      world.dispose();
      audio.dispose();
      clearTimeout(toastTimer);
      hud.remove();
      stage.classList.remove('dc-stage', 'dc-playing', 'dc-turbo');
    },
  };
}
