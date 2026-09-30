/** Pure script of the voice demo. No DOM and no microphone: the page replays
 * a written example of what NexusIDE does with dictation. Phase names follow
 * the app's voice HUD (Ouvindo, Transcrevendo, Enviando ao pane). */

export const PHASES = {
  idle: 'Pronto para ouvir',
  listening: 'Ouvindo',
  transcribing: 'Transcrevendo',
  refining: 'Refinando o texto',
  delivered: 'No terminal',
};

/** `drop` marks what the CODE refinement removes: filler, false starts and
 * the first half of a self-correction. The prompt never adds what was not said. */
export const EXAMPLES = [
  {
    id: 'pedido',
    label: 'Pedir uma mudança',
    mode: 'code',
    spoken: [
      { text: 'ahn,', drop: true }, { text: 'então,', drop: true }, { text: 'cria' }, { text: 'uma' }, { text: 'tela' }, { text: 'de', drop: true },
      { text: 'agenda,', drop: true }, { text: 'não,', drop: true }, { text: 'pera,', drop: true }, { text: 'de' }, { text: 'horários,' },
      { text: 'comita' }, { text: 'numa' }, { text: 'branch' }, { text: 'nova' }, { text: 'e' }, { text: 'roda' }, { text: 'os' }, { text: 'testes' },
    ],
    prompt: ['1. Create a schedule screen.', '2. Commit it on a new branch.', '3. Run the tests.'],
  },
  {
    id: 'erro',
    label: 'Descrever um erro',
    mode: 'code',
    spoken: [
      { text: 'olha,', drop: true }, { text: 'o' }, { text: 'npm run build' }, { text: 'tá' }, { text: 'quebrando' }, { text: 'no' },
      { text: 'src/lib/agenda.ts,' }, { text: 'tipo,', drop: true }, { text: 'vê' }, { text: 'o' }, { text: 'erro' }, { text: 'e' },
      { text: 'corrige,' }, { text: 'mas' }, { text: 'sem' }, { text: 'mexer' }, { text: 'nos' }, { text: 'testes,' }, { text: 'tá?', drop: true },
    ],
    prompt: ['npm run build is failing in src/lib/agenda.ts.', 'Look at the error and fix it without changing the tests.'],
  },
  {
    id: 'conversa',
    label: 'Perguntar em português',
    mode: 'chat',
    spoken: [
      { text: 'explica' }, { text: 'pra' }, { text: 'mim' }, { text: 'o' }, { text: 'que' }, { text: 'esse' }, { text: 'diff' },
      { text: 'muda' }, { text: 'na' }, { text: 'agenda' },
    ],
    prompt: ['explica pra mim o que esse diff muda na agenda'],
  },
];

const WORD_MS = 190;
const LEAD_MS = 450;
const TRANSCRIBE_MS = 1300;
const REFINE_MS = 1500;
const LINE_MS = 520;

/** Steps of one replay, sorted by time. CHAT mode has no refinement phase. */
export function buildTimeline(example) {
  const steps = [{ at: 0, type: 'phase', phase: 'listening' }];
  let at = LEAD_MS;
  example.spoken.forEach((token, index) => { steps.push({ at, type: 'word', index }); at += WORD_MS; });
  const listenedUntil = at + 250;
  steps.push({ at: listenedUntil, type: 'phase', phase: 'transcribing' });
  at = listenedUntil + TRANSCRIBE_MS;
  if (example.mode === 'code') {
    steps.push({ at, type: 'phase', phase: 'refining' }, { at: at + 250, type: 'strike' });
    at += REFINE_MS;
  }
  for (const text of example.prompt) { at += LINE_MS; steps.push({ at, type: 'line', text }); }
  steps.push({ at: at + 400, type: 'phase', phase: 'delivered' });
  return steps;
}

/** When the speaker stops: bars go flat from here on. */
export function listeningEnd(example) {
  return buildTimeline(example).find(step => step.type === 'phase' && step.phase === 'transcribing').at;
}

/** What the page shows before any replay and under reduced motion. */
export function finalState(example) {
  return { phase: 'delivered', words: example.spoken.map((_, index) => index), struck: example.mode === 'code', lines: [...example.prompt] };
}

/** Deterministic speech-like envelope in 0..1, silent at and after `until`. */
export function levelAt(time, until) {
  if (!(time >= 0) || time >= until) return 0;
  const syllable = Math.abs(Math.sin(time / 95));
  const phrase = 0.55 + 0.45 * Math.sin(time / 610 + 1.3);
  const fade = Math.min(1, (until - time) / 220);
  return Math.max(0, Math.min(1, (0.18 + 0.82 * syllable * phrase) * fade));
}

const MIN_SCALE = 0.06;
/** Seven-bar VU reading, centre high and edges low, as in the app's level bars. */
export function barScale(level, index, count) {
  const safe = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
  const centre = (count - 1) / 2;
  const distance = centre === 0 ? 0 : Math.abs(index - centre) / centre;
  const height = Math.max(0, Math.min(1, safe * 1.7 - 0.55 * distance));
  return Math.round((MIN_SCALE + height * (1 - MIN_SCALE)) * 1000) / 1000;
}
