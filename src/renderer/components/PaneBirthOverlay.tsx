import { useEffect, useState } from 'react';
import type { PaneModel } from '../../shared/types';
import {
  PANE_BIRTH_FAILED_AFTER_MS,
  PANE_BIRTH_SLOW_AFTER_MS,
  clearPaneBirthElapsed,
  paneBirthClockKey,
  paneBirthDisplay,
  paneBirthElapsedMs,
  peekPaneBirthElapsedMs,
} from '../lib/pane-birth-display';
import { useSessionStateStore } from '../state/session-state-store';
import {
  peekPaneSpawnError,
  subscribePaneSpawnErrors,
} from '../terminal/pane-spawn-errors';
import { getPaneSessionId, onPaneSessionChange } from '../terminal/terminal-host';
import { ProviderLogo } from './ProviderLogo';

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
  const birthKey = paneBirthClockKey(pane.id, pane.adapterId);
  const [sessionId, setSessionId] = useState<string | null>(() =>
    getPaneSessionId(pane.id),
  );
  // Um remount parte do relógio da geração: uma tentativa que já passou dos
  // 90 s volta vencida, sem um quadro de "Preparando agente…" no meio.
  const [elapsedMs, setElapsedMs] = useState(() =>
    sessionId ? 0 : peekPaneBirthElapsedMs(birthKey),
  );
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

  const display = paneBirthDisplay({
    sessionState,
    sessionId,
    agentName: pane.agentName,
    adapterId: pane.adapterId,
    model: pane.model,
    elapsedMs,
    failureReason,
  });

  // O relógio vive fora do mount: remount por troca de aba/layout continua o
  // elapsed da geração. Concluir o nascimento (sessão vinculada, pane escondido
  // ou recusa do Main) limpa a entrada e zera o estado, para um respawn
  // começar do zero. Estourar os 90 s NÃO conclui nada: a tentativa segue
  // vencida se remontar, até uma dessas saídas.
  const hidden = display === null;
  const refused = Boolean(failureReason?.trim());
  useEffect(() => {
    if (sessionId || hidden || refused) {
      clearPaneBirthElapsed(birthKey);
      setElapsedMs(0);
      return undefined;
    }
    const elapsed = paneBirthElapsedMs(birthKey);
    setElapsedMs(elapsed);
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (elapsed < PANE_BIRTH_SLOW_AFTER_MS) {
      timers.push(
        setTimeout(
          () => setElapsedMs(PANE_BIRTH_SLOW_AFTER_MS),
          PANE_BIRTH_SLOW_AFTER_MS - elapsed,
        ),
      );
    } else {
      setElapsedMs(PANE_BIRTH_SLOW_AFTER_MS);
    }
    if (elapsed < PANE_BIRTH_FAILED_AFTER_MS) {
      timers.push(
        setTimeout(
          () => setElapsedMs(PANE_BIRTH_FAILED_AFTER_MS),
          PANE_BIRTH_FAILED_AFTER_MS - elapsed,
        ),
      );
    } else {
      setElapsedMs(PANE_BIRTH_FAILED_AFTER_MS);
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [birthKey, sessionId, hidden, refused]);

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
      {/* Sem pulso em falha: não há nada "em andamento" para animar; o logo
          fica, porque identifica QUAL agente não subiu. */}
      <span className="pane-birth__identity" aria-hidden="true">
        <ProviderLogo adapterId={pane.adapterId ?? ''} label={pane.agentName ?? pane.adapterId ?? 'Agente'} />
        {!display.failed && <span className="pane-birth__pulse" />}
      </span>
      <strong className="pane-birth__headline">{display.headline}</strong>
      <span className="pane-birth__detail">{display.detail}</span>
    </div>
  );
}
