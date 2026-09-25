/**
 * setInterval que dorme com a janela oculta. O main desliga o throttling de
 * timers de background do Chromium (main.ts), então um poll do renderer seguia
 * a todo vapor com o app minimizado ou coberto — e vários deles viram IPC,
 * SQLite ou `git` no processo principal. Oculto, o intervalo é desarmado (nem
 * acorda); ao voltar a ficar visível, roda uma vez na hora e rearma.
 */
export function setVisibleInterval(tick: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const arm = (): void => {
    if (timer === null) timer = setInterval(tick, ms);
  };
  const disarm = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  const onVisibility = (): void => {
    if (document.hidden) {
      disarm();
      return;
    }
    if (timer !== null) return;
    tick();
    arm();
  };
  document.addEventListener('visibilitychange', onVisibility);
  if (!document.hidden) arm();
  return () => {
    disarm();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
