import { useEffect, useState } from 'react';
import type { PaneModel } from '../../shared/types';
import {
  PANE_BIRTH_FAILED_AFTER_MS,
  PANE_BIRTH_SLOW_AFTER_MS,
  paneBirthDisplay,
} from '../lib/pane-birth-display';
import { useSessionStateStore } from '../state/session-state-store';
import {
  peekPaneSpawnError,
  subscribePaneSpawnErrors,
} from '../terminal/pane-spawn-errors';
import { getPaneSessionId, onPaneSessionChange } from '../terminal/terminal-host';

/**
 * Estado "nascendo" de um pane de agente: enquanto o PTY não reporta sessão,
 * o terminal é um retângulo preto sem explicação — que foi lido em campo como
 * "pane morto tapando a missão". Aqui a espera fica nomeada (quem, qual CLI,
 * qual modelo) e some no instante em que a sessão real assume.
 *
 * Quando o Main RECUSA o spawn (ou o prazo estoura sem sessão), o card vira
 * falha com um motivo categórico. Antes ele prometia "Ainda subindo…" para
 * sempre: o RPC que nunca resolve e o `waitForSpawnAccess` falso não mudam o
 * estado do pane.
 */
export function PaneBirthOverlay({ pane }: { pane: PaneModel }) {
  const sessionState = useSessionStateStore((s) => s.paneStates.get(pane.id));
  const [sessionId, setSessionId] = useState<string | null>(() =>
    getPaneSessionId(pane.id),
  );
  const [elapsedMs, setElapsedMs] = useState(0);
  const [failureReason, setFailureReason] = useState<string | null>(() =>
    peekPaneSpawnError(pane.id),
  );

  useEffect(() => {
    setSessionId(getPaneSessionId(pane.id));
    return onPaneSessionChange((paneId, next) => {
      if (paneId === pane.id) setSessionId(next);
    });
  }, [pane.id]);

  useEffect(() => {
    const refresh = () => setFailureReason(peekPaneSpawnError(pane.id));
    refresh();
    return subscribePaneSpawnErrors(refresh);
  }, [pane.id]);

  useEffect(() => {
    if (sessionId) return undefined;
    setElapsedMs(0);
    const slow = setTimeout(
      () => setElapsedMs(PANE_BIRTH_SLOW_AFTER_MS),
      PANE_BIRTH_SLOW_AFTER_MS,
    );
    const failed = setTimeout(
      () => setElapsedMs(PANE_BIRTH_FAILED_AFTER_MS),
      PANE_BIRTH_FAILED_AFTER_MS,
    );
    return () => {
      clearTimeout(slow);
      clearTimeout(failed);
    };
  }, [pane.id, sessionId]);

  const display = paneBirthDisplay({
    sessionState,
    sessionId,
    agentName: pane.agentName,
    adapterId: pane.adapterId,
    model: pane.model,
    elapsedMs,
    failureReason,
  });
  if (!display) return null;

  const tone = display.failed
    ? 'pane-birth--failed'
    : display.slow
      ? 'pane-birth--slow'
      : '';

  return (
    <div
      className={`pane-birth ${tone}`}
      // Uma recusa é uma mudança de estado que pede ação, não um progresso:
      // assertive só nela, para não gritar em cada cold start normal.
      role={display.failed ? 'alert' : 'status'}
      aria-live={display.failed ? 'assertive' : 'polite'}
    >
      {/* Sem pulso em falha: não há nada "em andamento" para animar. */}
      {!display.failed && (
        <span className="pane-birth__pulse" aria-hidden="true" />
      )}
      <strong className="pane-birth__headline">{display.headline}</strong>
      <span className="pane-birth__detail">{display.detail}</span>
    </div>
  );
}
