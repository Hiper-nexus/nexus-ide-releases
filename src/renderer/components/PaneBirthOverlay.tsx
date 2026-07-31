import { useEffect, useState } from 'react';
import type { PaneModel } from '../../shared/types';
import {
  PANE_BIRTH_SLOW_AFTER_MS,
  paneBirthDisplay,
} from '../lib/pane-birth-display';
import { useSessionStateStore } from '../state/session-state-store';
import { getPaneSessionId, onPaneSessionChange } from '../terminal/terminal-host';

/**
 * Estado "nascendo" de um pane de agente: enquanto o PTY não reporta sessão,
 * o terminal é um retângulo preto sem explicação — que foi lido em campo como
 * "pane morto tapando a missão". Aqui a espera fica nomeada (quem, qual CLI,
 * qual modelo) e some no instante em que a sessão real assume.
 */
export function PaneBirthOverlay({ pane }: { pane: PaneModel }) {
  const sessionState = useSessionStateStore((s) => s.paneStates.get(pane.id));
  const [sessionId, setSessionId] = useState<string | null>(() =>
    getPaneSessionId(pane.id),
  );
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    setSessionId(getPaneSessionId(pane.id));
    return onPaneSessionChange((paneId, next) => {
      if (paneId === pane.id) setSessionId(next);
    });
  }, [pane.id]);

  useEffect(() => {
    if (sessionId) return undefined;
    setElapsedMs(0);
    const timer = setTimeout(
      () => setElapsedMs(PANE_BIRTH_SLOW_AFTER_MS),
      PANE_BIRTH_SLOW_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [pane.id, sessionId]);

  const display = paneBirthDisplay({
    sessionState,
    sessionId,
    agentName: pane.agentName,
    adapterId: pane.adapterId,
    model: pane.model,
    elapsedMs,
  });
  if (!display) return null;

  return (
    <div
      className={`pane-birth ${display.slow ? 'pane-birth--slow' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="pane-birth__pulse" aria-hidden="true" />
      <strong className="pane-birth__headline">{display.headline}</strong>
      <span className="pane-birth__detail">{display.detail}</span>
    </div>
  );
}
