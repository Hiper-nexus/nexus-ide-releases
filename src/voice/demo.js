import '../voice.css';
import { EXAMPLES, PHASES, barScale, buildTimeline, finalState, levelAt, listeningEnd } from './script.js';

/** DOM side of the voice demo. It replays a written example; it never asks for
 * the microphone. The page already shows the finished state, so the content is
 * readable without pressing anything. */
const stage = document.getElementById('vox-stage');
if (stage) {
  const byId = id => document.getElementById(id);
  const spoken = byId('vox-spoken'), prompt = byId('vox-prompt'), phase = byId('vox-phase'), chip = byId('vox-chip');
  const mode = byId('vox-mode'), play = byId('vox-play'), playLabel = byId('vox-play-label');
  const bars = [...stage.querySelectorAll('.vox-bars i')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let example = EXAMPLES[0], timers = [], frame = 0;

  const setBars = level => bars.forEach((bar, index) => { bar.style.transform = `scaleY(${barScale(level, index, bars.length)})`; });

  function setPhase(name) {
    stage.dataset.phase = name;
    phase.textContent = PHASES[name];
    const waiting = name === 'transcribing' || name === 'refining';
    chip.hidden = !waiting;
    if (waiting) chip.textContent = name === 'refining' ? 'Modo CODE: transcrição e refino do texto' : 'Transcrevendo áudio…';
    const order = example.mode === 'code' ? ['listening', 'transcribing', 'refining', 'delivered'] : ['listening', 'transcribing', 'delivered'];
    stage.querySelectorAll('[data-vox-step]').forEach((item) => {
      const index = order.indexOf(item.dataset.voxStep);
      item.hidden = index === -1;
      item.classList.toggle('done', index !== -1 && index < order.indexOf(name) || name === 'delivered' && index !== -1);
      item.classList.toggle('current', item.dataset.voxStep === name && name !== 'delivered');
    });
  }

  function renderSpoken(visible, struck) {
    spoken.replaceChildren(...example.spoken.flatMap((token, index) => {
      const word = document.createElement(token.drop ? 'del' : 'span');
      word.textContent = token.text;
      word.className = 'vox-word' + (visible.includes(index) ? ' heard' : '') + (token.drop && struck ? ' dropped' : '');
      return [word, ' '];
    }));
  }

  function addLine(text) {
    const line = document.createElement('p');
    line.className = 'vox-line';
    line.textContent = text;
    prompt.append(line);
  }

  function stop() {
    timers.forEach(clearTimeout);
    timers = [];
    cancelAnimationFrame(frame);
    frame = 0;
    setBars(0);
    stage.classList.remove('playing');
    play.setAttribute('aria-pressed', 'false');
    playLabel.textContent = 'Reproduzir exemplo';
  }

  /** The finished state: what a replay leaves on screen. */
  function showFinal() {
    stop();
    const state = finalState(example);
    mode.textContent = example.mode === 'code' ? 'CODE' : 'CHAT';
    stage.dataset.mode = example.mode;
    renderSpoken(state.words, state.struck);
    prompt.replaceChildren();
    state.lines.forEach(addLine);
    setPhase(state.phase);
  }

  function replay() {
    if (reduced.matches) { showFinal(); return; }
    stop();
    stage.classList.add('playing');
    play.setAttribute('aria-pressed', 'true');
    playLabel.textContent = 'Parar';
    prompt.replaceChildren();
    const heard = [];
    renderSpoken(heard, false);
    const until = listeningEnd(example), startedAt = performance.now();
    const tick = (now) => { const elapsed = now - startedAt; setBars(levelAt(elapsed, until)); if (elapsed < until) frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    for (const step of buildTimeline(example)) {
      timers.push(setTimeout(() => {
        if (step.type === 'phase') { setPhase(step.phase); if (step.phase === 'delivered') stop(); }
        else if (step.type === 'word') { heard.push(step.index); renderSpoken(heard, false); }
        else if (step.type === 'strike') renderSpoken(heard, true);
        else addLine(step.text);
      }, step.at));
    }
  }

  stage.querySelectorAll('[data-vox-example]').forEach(button => button.addEventListener('click', () => {
    example = EXAMPLES.find(item => item.id === button.dataset.voxExample) ?? EXAMPLES[0];
    stage.querySelectorAll('[data-vox-example]').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    showFinal();
    replay();
  }));
  play.addEventListener('click', () => { if (stage.classList.contains('playing')) showFinal(); else replay(); });
  window.addEventListener('pagehide', stop);
  showFinal();
}
