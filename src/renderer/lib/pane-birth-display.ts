import type { PaneSessionState } from '../../shared/types';

/**
 * Quanto tempo um pane pode ficar "subindo" antes de dizermos, honestamente,
 * que está demorando. Cold start de CLI sob sandbox paga o handshake do helper
 * assinado antes do PTY reportar sessão — abaixo disso, silêncio é normal.
 */
export const PANE_BIRTH_SLOW_AFTER_MS = 12_000;

export interface PaneBirthDisplay {
  readonly headline: string;
  readonly detail: string;
  /** Passou do limiar sem sessão: a UI para de prometer que "já vai". */
  readonly slow: boolean;
}

export interface PaneBirthInput {
  readonly sessionState: PaneSessionState | undefined;
  readonly sessionId: string | null;
  readonly agentName?: string | undefined;
  readonly adapterId?: string | undefined;
  readonly model?: string | undefined;
  readonly elapsedMs: number;
}

function identity(input: PaneBirthInput): string {
  const who = input.agentName?.trim() || input.adapterId?.trim() || 'agente';
  const cli = input.adapterId?.trim();
  const model = input.model?.trim();
  const suffix = [cli?.toLowerCase() === who.toLowerCase() ? undefined : cli, model].filter(Boolean).join(' · ');
  return suffix ? `${who} — ${suffix}` : who;
}

/**
 * O que mostrar por cima de um pane de agente que ainda não tem sessão viva.
 *
 * Isto existe por um sintoma de campo: ao iniciar uma missão abria um "pane
 * morto tapando ela" — na verdade um terminal vazio esperando o PTY. Sem
 * explicação nenhuma, um cold start de 10s lê como bug. Assim que a sessão
 * materializa (ou o pane morre/hiberna), o terminal real volta a ser a única
 * fonte da verdade e este overlay sai da árvore.
 */
export function paneBirthDisplay(
  input: PaneBirthInput,
): PaneBirthDisplay | null {
  if (input.sessionId) return null;
  if (
    input.sessionState === 'exited' ||
    input.sessionState === 'hibernated' ||
    input.sessionState === 'idle' ||
    input.sessionState === 'busy'
  ) {
    return null;
  }
  const slow = input.elapsedMs >= PANE_BIRTH_SLOW_AFTER_MS;
  return {
    headline: slow ? 'A abertura está demorando' : 'Preparando agente…',
    detail: slow
      ? `${identity(input)} está demorando mais que o normal para responder.`
      : identity(input),
    slow,
  };
}
