import { useEffect, useState } from 'react';
import { useVoiceStore } from '../voice/voice-store';
import { hasDictationTargetClaim } from '../voice/dictation-target';

/** Segundos de espera a partir dos quais o chip mostra o tempo decorrido. */
const DICTATION_ELAPSED_VISIBLE_AFTER_SEC = 2;

/**
 * F-371 — feedback in-pane do ditado. Entre soltar o Space e o texto cair no
 * PTY passam ~6 s (STT ~1,5 s + refino CODE ~4 s + injeção); sem este chip o
 * pane parecia morto. Só aparece no pane FOCADO — é ele que recebe o texto —
 * e some se uma superfície de UI (wizard de missão) reivindicou o ditado:
 * nesse caso o texto não vai para terminal nenhum.
 */
export function PaneDictationOverlay({ isFocused }: { isFocused: boolean }) {
  const pending = useVoiceStore((s) => s.dictationPending);
  const failed = useVoiceStore((s) => s.dictationFailed);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!pending) {
      setElapsedSec(0);
      return undefined;
    }
    const tick = () =>
      setElapsedSec(
        Math.max(0, Math.floor((Date.now() - pending.startedAt) / 1_000)),
      );
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [pending]);

  if (!isFocused || hasDictationTargetClaim()) return null;

  if (failed) {
    return (
      <div
        className="pane-dictation pane-dictation--failed"
        role="status"
        aria-live="polite"
      >
        <span className="pane-dictation__pulse" aria-hidden="true" />
        <strong className="pane-dictation__headline">
          Transcrição falhou — veja Voz
        </strong>
      </div>
    );
  }

  if (!pending) return null;

  const elapsed =
    elapsedSec >= DICTATION_ELAPSED_VISIBLE_AFTER_SEC ? ` · ${elapsedSec}s` : '';
  return (
    <div className="pane-dictation" role="status" aria-live="polite">
      <span className="pane-dictation__pulse" aria-hidden="true" />
      <strong className="pane-dictation__headline">
        Transcrevendo áudio…{elapsed}
      </strong>
      {pending.mode !== 'portuguese' && (
        <span className="pane-dictation__detail">
          Modo CODE: transcrição e refino do texto
        </span>
      )}
    </div>
  );
}
