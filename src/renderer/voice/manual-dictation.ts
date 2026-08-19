/**
 * Gatilho manual do DITADO (botão de microfone em UI, ex.: wizard de missão).
 *
 * Mesmo idioma do manual-wake: CustomEvent na janela, o voice-controller
 * assina e chama o MESMO onDictationStart/onDictationStop do Space hold-to-
 * talk — nenhum caminho novo de captura, nenhuma sessão Jarvis/Live.
 */

const DICTATION_START_EVENT = 'nexus:dictation-start-request';
const DICTATION_STOP_EVENT = 'nexus:dictation-stop-request';

export function requestDictationStart(): void {
  window.dispatchEvent(new CustomEvent(DICTATION_START_EVENT));
}

export function requestDictationStop(): void {
  window.dispatchEvent(new CustomEvent(DICTATION_STOP_EVENT));
}

export function onDictationRequest(callbacks: {
  start: () => void;
  stop: () => void;
}): () => void {
  const onStart = () => callbacks.start();
  const onStop = () => callbacks.stop();
  window.addEventListener(DICTATION_START_EVENT, onStart);
  window.addEventListener(DICTATION_STOP_EVENT, onStop);
  return () => {
    window.removeEventListener(DICTATION_START_EVENT, onStart);
    window.removeEventListener(DICTATION_STOP_EVENT, onStop);
  };
}
