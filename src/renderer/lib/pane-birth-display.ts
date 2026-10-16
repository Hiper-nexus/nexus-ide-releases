import type { PaneSessionState } from '../../shared/types';

/**
 * Quanto tempo um pane pode ficar "subindo" antes de dizermos, honestamente,
 * que está demorando. Cold start de CLI sob sandbox paga o handshake do helper
 * assinado antes do PTY reportar sessão — abaixo disso, silêncio é normal.
 */
export const PANE_BIRTH_SLOW_AFTER_MS = 12_000;

/**
 * Prazo em que a espera deixa de ser plausível e vira falha. Alinhado à graça
 * do vigia de início do Main (`START_GRACE_MS`, 90 s): depois disso o próprio
 * Main já declarou que o pane não começou. Existia um buraco real — o RPC do
 * spawn que nunca resolve e o `waitForSpawnAccess` falso não mudam o estado do
 * pane, então o card ficava em "Ainda subindo…" para sempre.
 */
export const PANE_BIRTH_FAILED_AFTER_MS = 90_000;

/**
 * Relógio de nascimento por geração do pane (paneId + adapterId), fora do
 * mount efêmero do React. Sem isto, cada remount (troca de aba, layout,
 * maximização) zerava o cronômetro de 12s/90s: um pane a 89s de cold start
 * voltava a prometer "Preparando agente…" como se tivesse acabado de nascer.
 * A entrada é limpa quando o nascimento conclui — sessão vinculada, pane
 * escondido ou recusa do Main — então uma retomada/respawn começa ciclo
 * novo em vez de herdar o elapsed da tentativa anterior. O prazo de 90 s
 * estourado NÃO conclui o nascimento: a tentativa segue vencida até uma
 * dessas saídas, inclusive se o componente remontar.
 */
const paneBirthStarts = new Map<string, number>();

export function paneBirthClockKey(
  paneId: string,
  adapterId?: string,
): string {
  const adapter = adapterId?.trim();
  return adapter ? `${paneId}:${adapter}` : paneId;
}

/**
 * Lê (e semeia, na primeira vez) o instante de início do nascimento desta
 * geração. Chamadas seguintes devolvem o elapsed desde o PRIMEIRO mount,
 * não desde este.
 */
export function paneBirthElapsedMs(key: string, now = Date.now()): number {
  const startedAt = paneBirthStarts.get(key);
  if (startedAt !== undefined) return Math.max(0, now - startedAt);
  paneBirthStarts.set(key, now);
  return 0;
}

/**
 * Lê o elapsed da geração SEM semear o relógio (seguro no render): 0 enquanto
 * nenhum nascimento começou. Um remount parte daqui, então uma tentativa que
 * já passou do prazo volta vencida, sem um quadro de "Preparando agente…".
 */
export function peekPaneBirthElapsedMs(key: string, now = Date.now()): number {
  const startedAt = paneBirthStarts.get(key);
  return startedAt === undefined ? 0 : Math.max(0, now - startedAt);
}

/** Esquece o relógio desta geração — o próximo nascimento começa do zero. */
export function clearPaneBirthElapsed(key: string): void {
  paneBirthStarts.delete(key);
}

/** Esquece todo relógio do pane (qualquer adapter), mesmo com o overlay desmontado. */
export function clearPaneBirthElapsedForPane(paneId: string): void {
  for (const key of [...paneBirthStarts.keys()]) {
    if (key === paneId || key.startsWith(`${paneId}:`)) paneBirthStarts.delete(key);
  }
}

export interface PaneBirthDisplay {
  readonly headline: string;
  readonly detail: string;
  /** Passou do limiar sem sessão: a UI para de prometer que "já vai". */
  readonly slow: boolean;
  /** Recusado pelo Main ou prazo estourado: não há mais o que esperar. */
  readonly failed: boolean;
}

export interface PaneBirthInput {
  readonly sessionState: PaneSessionState | undefined;
  readonly sessionId: string | null;
  readonly agentName?: string | undefined;
  readonly adapterId?: string | undefined;
  readonly model?: string | undefined;
  readonly elapsedMs: number;
  /**
   * Erro bruto gravado pelo terminal-host na recusa do spawn. Só a CATEGORIA
   * sai daqui (`paneBirthFailureReason`): o texto cru pode trazer argv, caminho
   * e credencial, e não é o que o operador precisa ler num card.
   */
  readonly failureReason?: string | null | undefined;
}

/**
 * Motivo categórico de uma recusa de spawn. É uma allowlist de causas que o
 * operador pode resolver; qualquer outra coisa vira uma frase genérica. O erro
 * bruto nunca é devolvido — ele pode conter argv, caminho absoluto ou um token
 * que a CLI ecoou.
 */
const FAILURE_CATEGORIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/sessão do grok expirou|grok login/i, 'Grok precisa de login'],
  [/não instalado|not installed|cli_missing|binary unavailable/i, 'A CLI não está instalada'],
  [/licen[çc]a|license/i, 'Licença recusada'],
  [/memória|memory|capacidade|capacity/i, 'A máquina está sem recursos para abrir o pane'],
];

export function paneBirthFailureReason(rawError: string): string {
  for (const [pattern, label] of FAILURE_CATEGORIES) {
    if (pattern.test(rawError)) return label;
  }
  return 'O agente não subiu';
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
  const refusal = input.failureReason?.trim();
  // Uma recusa registrada sobrevive ao `exited`: é exatamente o caso em que o
  // terminal ficou um retângulo preto sem explicação (o Main recusou e o
  // terminal-host marcou o pane como saído). `clearPaneSpawnError` roda em todo
  // spawn bem-sucedido, então um erro gravado aqui é sempre da última tentativa.
  // Hibernado/estacionado não: aquele pane tem uma sessão viva guardada.
  if (!refusal) {
    if (
      input.sessionState === 'exited' ||
      input.sessionState === 'hibernated' ||
      input.sessionState === 'idle' ||
      input.sessionState === 'busy'
    ) {
      return null;
    }
  } else if (input.sessionState === 'hibernated') {
    return null;
  }
  if (refusal) {
    return {
      headline: 'Não subiu',
      detail: paneBirthFailureReason(refusal),
      slow: false,
      failed: true,
    };
  }
  if (input.elapsedMs >= PANE_BIRTH_FAILED_AFTER_MS) {
    return {
      headline: 'Não subiu',
      detail: `${identity(input)} não respondeu no prazo.`,
      slow: false,
      failed: true,
    };
  }
  const slow = input.elapsedMs >= PANE_BIRTH_SLOW_AFTER_MS;
  return {
    headline: slow ? 'A abertura está demorando' : 'Preparando agente…',
    detail: slow
      ? `${identity(input)} está demorando mais que o normal para responder.`
      : identity(input),
    slow,
    failed: false,
  };
}
