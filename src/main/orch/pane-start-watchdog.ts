/**
 * F-723: o Nexus solta um pane e confere se ele começou o trabalho. Se não
 * começou, corrige ali (reenvia o briefing UMA vez, pela mesma entrega
 * comprovada do spawn) ou manda para outro (a mesma tarefa em outra CLI, pela
 * mesma rota do `nexus_pane_spawn`, no máximo uma vez por pedido) — e avisa
 * quem pediu em todos os desfechos.
 *
 * Este módulo guarda só a decisão pura e a ficha em memória de cada spawn
 * pendente que levou briefing. Os efeitos (revogar o grant, fechar, reenviar,
 * rotear, avisar) moram no delegation-supervisor, que roda a varredura; quem
 * conhece o briefing e a rota (tool-util / tools-panes) entra aqui como
 * closure. A ficha nunca vai para disco, log, trace ou handoff: lá só passam
 * ids, adapter e um motivo curto por categoria. No trace `pane-not-started`
 * de uma tentativa com sessão, o supervisor também guarda uma cauda limitada
 * e sanitizada do ring PTY (F-788/F-789).
 *
 * F-734: na família Claude (prova de turno), turno aberto ainda não é "começou".
 * O pane que recebeu o brief e teve o turno encerrado por StopFailure de
 * configuração (credencial, conta ou pedido recusados pelo provedor) sem fazer
 * nada não começou — e repetir não cura. A ficha espera o desfecho do turno:
 * ferramenta, handoff ou Stop normal provam o início.
 *
 * F-765: fora da família Claude o turno aberto continua bastando (F-723) — agy,
 * MiMo, Muse e afins mandam um ou dois eventos por sessão, e exigir mais deles
 * deixaria o worker que trabalha sem veredito. Só EVIDÊNCIA muda isso: o PTY
 * mostrando a recusa do modelo (sem trabalho no turno) segura a ficha para o
 * failover recuperar, e um turno fechado com erro não é início. Antes do
 * veredito o turno assenta START_SETTLE_MS, para a recusa ter tempo de chegar.
 */
import type { AgentStopFailureCategory } from '../../shared/agent-stop-failure';
import type { ProjectExecutionScope } from '../../shared/types';
import { sanitizeMissionOrchestratorExitOutput } from './mission-orchestrator-exit-policy';

/**
 * Prazo para o pane provar que começou: sessão viva com turno aberto. Vale do
 * nascimento da sessão (ou do pedido, sem sessão) e de novo depois do reenvio.
 */
export const START_GRACE_MS = 90_000;
/**
 * F-765: CLI sem prova de turno só é "começou" depois de o turno aberto
 * assentar — a recusa do modelo (400 do provedor) chega em segundos. É só
 * espera: enquanto assenta, a ficha não reenvia, não reroteia nem fecha nada.
 */
export const START_SETTLE_MS = 10_000;
/**
 * F-765: recusa de modelo segurada para o failover. Se ninguém assumiu o pane
 * neste prazo, a ficha vira falha de início (pedido recusado) e segue o F-723.
 */
export const MODEL_REJECTION_HANDOFF_MS = 60_000;
/**
 * Ficha sem veredito possível (CLI sem prova de turno, sessão viva) sai daqui:
 * a partir desse ponto quem cuida é o F-242 e a mortalidade de worker.
 */
export const START_WATCH_TTL_MS = 30 * 60_000;
const EARLY_MARK_TTL_MS = 2 * 60_000;
const MAX_EARLY_MARKS = 256;

/**
 * F-734: credencial recusada (auth/billing) sem conta gerenciada é a chave de
 * todos os panes da CLI — o disjuntor do adapter fica aberto por este tempo
 * (o mesmo da pausa de auth do failover, `limit-detector`).
 */
export const CREDENTIAL_REJECTED_OPEN_MS = 15 * 60_000;

export type PaneStartRole = 'worker' | 'helper' | 'orchestrator' | 'operator';
export type StartAction = 'none' | 'redeliver' | 'reroute' | 'notify-only';
/**
 * F-734: o provedor recusou o turno do brief antes de qualquer trabalho
 * (StopFailure de configuração): credencial, conta ou pedido.
 */
export type ProviderRejectedCause =
  | 'provider-auth'
  | 'provider-billing'
  | 'provider-request';
/** Falha física provada por quem a viu (Main), antes de qualquer prazo. */
export type PaneStartFailureCause =
  | 'spawn-refused'
  | 'boot-exit'
  | 'brief-rejected'
  /** F-984: sessão viva sem NENHUM byte no terminal depois da graça. */
  | 'boot-silent'
  /** F-984: a CLI instalada recusou o modelo roteado ao nascer. */
  | 'model-rejected'
  | ProviderRejectedCause;
export type PaneNotStartedCause =
  | PaneStartFailureCause
  | 'no-session'
  | 'never-started';

export interface StartCheckInput {
  readonly role: PaneStartRole;
  /** F-231: pane aberto pela mão do operador — a máquina nunca o fecha. */
  readonly operatorOpened: boolean;
  /** Evidência de início: ferramenta, handoff ou fim de turno confiável. */
  readonly started: boolean;
  /** Falha física já provada (spawn recusado, saída no boot, brief recusado). */
  readonly failed: boolean;
  /** 'none' = nenhuma sessão nasceu para esta tentativa. */
  readonly session: 'none' | 'idle' | 'busy';
  /**
   * Só uma CLI com prova de turno confiável (UserPromptSubmit) deixa julgar
   * uma sessão viva como "não começou"; nas outras, viva = sem veredito.
   */
  readonly canJudgeLiveSession: boolean;
  readonly spawnedAt: number;
  readonly redeliveredAt: number | null;
  /** Esta tentativa já é o reenvio automático de outra (teto: um por pedido). */
  readonly rerouted: boolean;
  /** CLI nomeada pelo operador ou retomada de conversa: não troca sozinho. */
  readonly pinnedRuntime: boolean;
  readonly hasAlternative: boolean;
  readonly now: number;
  readonly graceMs?: number;
}

/**
 * Decisão pura. Passo 1 ("corrigir ali"): sessão viva, ociosa e sem turno
 * depois da graça → reenvia o briefing uma vez. Passo 2 ("mandar para
 * outro"): falha provada, nenhuma sessão na graça ou ainda sem turno uma graça
 * depois do reenvio → reroteia; sem como trocar (pane do operador, segunda
 * tentativa, CLI fixada, nenhuma alternativa) → só avisa.
 */
export function decideStartAction(input: StartCheckInput): StartAction {
  if (input.role === 'orchestrator' || input.role === 'operator') return 'none';
  if (input.started) return 'none';
  const graceMs = input.graceMs ?? START_GRACE_MS;
  let notStarted: boolean;
  if (input.failed) {
    notStarted = true;
  } else if (input.session === 'none') {
    notStarted = input.now - input.spawnedAt >= graceMs;
  } else if (input.session === 'busy' || !input.canJudgeLiveSession) {
    // PTY ocupado pode ser boot ou turno sem hook; sem prova não há veredito.
    return 'none';
  } else if (input.redeliveredAt === null) {
    if (input.now - input.spawnedAt < graceMs) return 'none';
    if (!input.operatorOpened) return 'redeliver';
    notStarted = true;
  } else {
    notStarted = input.now - input.redeliveredAt >= graceMs;
  }
  if (!notStarted) return 'none';
  if (
    input.operatorOpened ||
    input.rerouted ||
    input.pinnedRuntime ||
    !input.hasAlternative
  ) {
    return 'notify-only';
  }
  return 'reroute';
}

export function notStartedCause(input: {
  readonly failure: PaneStartFailureCause | null;
  readonly hasSession: boolean;
}): PaneNotStartedCause {
  if (input.failure) return input.failure;
  return input.hasSession ? 'never-started' : 'no-session';
}

/**
 * F-734: só o StopFailure que repetir não cura vira falha de início —
 * credencial, conta e pedido recusados pelo provedor. Limite de uso é do
 * failover de conta (F-249/F-718); erro transitório a CLI já tentou de novo.
 */
export function providerRejectedCause(
  category: AgentStopFailureCategory | undefined,
): ProviderRejectedCause | null {
  switch (category) {
    case 'auth':
      return 'provider-auth';
    case 'billing':
      return 'provider-billing';
    case 'invalid_request':
      return 'provider-request';
    default:
      return null;
  }
}

/**
 * F-734: onde o pane está no caminho até "começou". `turn-open`: o turno
 * abriu, mas ainda não fez trabalho nem terminou — o veredito é do desfecho
 * dele (família Claude), da recusa do modelo que o failover recupera ou do
 * assentamento (F-765). `not-ours`: o turno acabou em limite de uso, erro
 * transitório ou erro sem trabalho, que são do failover (F-249/F-718).
 */
export type PaneStartProgress =
  | { readonly kind: 'none' | 'turn-open' | 'started' | 'not-ours' }
  | { readonly kind: 'rejected'; readonly cause: ProviderRejectedCause };

export function paneStartProgress(input: {
  readonly turnProof: boolean;
  /** Turno aberto: UserPromptSubmit, entrega aceita ou status semântico. */
  readonly turnOpened: boolean;
  /** Trabalho provado: ferramenta na sessão ou handoff da sessão. */
  readonly worked: boolean;
  /**
   * F-765: o PTY mostra a recusa do modelo pelo provedor e o turno não fez
   * trabalho. Em qualquer CLI isso não é início; a recuperação é do failover.
   */
  readonly modelRejected?: boolean;
  /**
   * F-765: CLI sem prova de turno com o turno aberto há menos de
   * START_SETTLE_MS — a primeira resposta do provedor ainda pode ser recusa.
   */
  readonly settling?: boolean;
  /** Último turno fechado da sessão (sem conteúdo). */
  readonly lastTurnEnd: {
    readonly outcome: 'completed' | 'error';
    readonly stopFailure?: AgentStopFailureCategory;
  } | null;
}): PaneStartProgress {
  if (input.worked) return { kind: 'started' };
  if (input.modelRejected) return { kind: 'turn-open' };
  const end = input.lastTurnEnd;
  if (!input.turnProof) {
    // Sem prova de turno não há StopFailure: um turno fechado sem trabalho é
    // do failover se acabou em erro; aberto e assentado basta (F-723).
    if (end) return { kind: end.outcome === 'completed' ? 'started' : 'not-ours' };
    if (!input.turnOpened) return { kind: 'none' };
    return { kind: input.settling ? 'turn-open' : 'started' };
  }
  if (end) {
    if (end.outcome === 'completed') return { kind: 'started' };
    const cause = providerRejectedCause(end.stopFailure);
    return cause ? { kind: 'rejected', cause } : { kind: 'not-ours' };
  }
  return { kind: input.turnOpened ? 'turn-open' : 'none' };
}

/**
 * F-734: o que a falha de início faz no disjuntor do adapter. A credencial é
 * o escopo: recusa de credencial ou conta (auth/billing) SEM conta gerenciada
 * é a chave que todo pane da CLI usa → abre o disjuntor por
 * `CREDENTIAL_REJECTED_OPEN_MS`. Com conta gerenciada a chave é da conta — a
 * pausa POR CONTA é do failover (F-676) e o adapter só conta a falha, como
 * qualquer outra falha de início. Pedido recusado é do modelo/pedido: conta.
 */
export function startFailureBreakerAction(input: {
  readonly cause: PaneNotStartedCause;
  readonly accountBound: boolean;
}): 'trip' | 'count' {
  const credential =
    input.cause === 'provider-auth' || input.cause === 'provider-billing';
  return credential && !input.accountBound ? 'trip' : 'count';
}

const PROVIDER_REJECTED_TAIL = 'o turno do brief acabou antes de qualquer trabalho';

const CAUSE_TEXT: Readonly<Record<PaneNotStartedCause, string>> = {
  'spawn-refused': 'o CLI não subiu (o spawn foi recusado)',
  'boot-exit': 'o processo saiu antes de abrir o primeiro turno',
  'brief-rejected': 'o briefing não foi aceito pelo pane',
  'boot-silent': `a CLI não escreveu nada no terminal em ${Math.round(START_GRACE_MS / 1000)} s`,
  'model-rejected':
    'a CLI instalada recusou o modelo roteado — o modelo saiu das rotas desta CLI até a instalação mudar',
  'no-session': `nenhuma sessão nasceu em ${Math.round(START_GRACE_MS / 1000)} s`,
  'never-started':
    'a sessão ficou parada sem abrir turno, mesmo com o briefing reenviado',
  'provider-auth': `credencial recusada pelo provedor (${PROVIDER_REJECTED_TAIL})`,
  'provider-billing':
    `conta recusada pelo provedor — cobrança, crédito ou bloqueio (${PROVIDER_REJECTED_TAIL})`,
  'provider-request':
    `pedido recusado pelo provedor — modelo ou parâmetro inválido (${PROVIDER_REJECTED_TAIL})`,
};

export type PaneStartOutcome =
  | {
      readonly kind: 'rerouted';
      readonly paneId: string;
      readonly adapterId: string;
    }
  | { readonly kind: 'reroute-failed'; readonly error: string }
  | {
      readonly kind: 'not-rerouted';
      readonly why: 'operator' | 'second-attempt' | 'pinned' | 'no-alternative';
    };

/** Motivo curto de erro para o aviso: 1ª linha, sem segredo, até 160 chars. */
export function shortStartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = sanitizeMissionOrchestratorExitOutput(raw.split(/\r?\n/u)[0] ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
}

/** Texto do aviso a quem pediu (pt-BR): só ids, adapter e motivo por categoria. */
export function paneStartNoticeSummary(input: {
  readonly paneId: string;
  readonly adapterId: string;
  readonly cause: PaneNotStartedCause;
  readonly outcome: PaneStartOutcome;
  /**
   * F-984: motivo legível já categorizado pelo Main (frase fixa, id do modelo,
   * código de saída) — nunca a saída crua do terminal.
   */
  readonly detail?: string | null;
}): string {
  const detail = input.detail?.trim();
  const head =
    `[nao-iniciou:${input.paneId}] O pane ${input.paneId} (${input.adapterId}) ` +
    `não começou a tarefa: ${CAUSE_TEXT[input.cause]}.` +
    (detail ? ` Motivo: ${detail}.` : '');
  const outcome = input.outcome;
  if (outcome.kind === 'rerouted') {
    return `${head} Reenviada para ${outcome.adapterId} (pane ${outcome.paneId}).`;
  }
  if (outcome.kind === 'reroute-failed') {
    return (
      `${head} O reenvio automático falhou (${outcome.error}) — decida: abra ` +
      'de novo com outra CLI (nexus_pane_spawn) ou siga sem esse pane.'
    );
  }
  const why = {
    operator: 'O pane é do operador e continua aberto — decida.',
    'second-attempt':
      'Esta já era a tentativa reenviada; não reenvio de novo — decida.',
    pinned:
      'A CLI foi pedida pelo operador (ou é retomada de conversa); não troquei ' +
      'sozinho — decida.',
    'no-alternative': 'Nenhuma outra CLI está disponível — decida.',
  }[outcome.why];
  return `${head} ${why}`;
}

export interface PaneStartRerouteResult {
  readonly paneId: string;
  readonly adapterId: string;
}

export interface PaneStartWatchInit {
  readonly paneId: string;
  /** Tentativa de spawn do Main (`orchspawn-*`): a sessão dela, nunca a do paneId. */
  readonly requestId: string;
  readonly adapterId: string;
  readonly scope: Readonly<ProjectExecutionScope>;
  readonly missionId?: string;
  readonly role: 'worker' | 'helper';
  /** Quem pediu: o Maestro (worker) ou o pane pai do operador (helper). */
  readonly callerSessionId: string;
  readonly operatorOpened?: boolean;
  readonly turnProof: boolean;
  readonly pinnedRuntime: boolean;
  readonly rerouted: boolean;
  readonly createdAt: number;
  /** Mesma entrega comprovada do spawn; true = turno aceito. */
  readonly redeliver?: () => Promise<boolean>;
  /** Reabre o pedido pela rota do spawn, sem as CLIs excluídas. */
  readonly reroute?: (
    excludeAdapterIds: readonly string[],
  ) => Promise<PaneStartRerouteResult>;
  readonly hasAlternative?: () => boolean;
}

export interface PaneStartWatch extends PaneStartWatchInit {
  sessionId: string | null;
  sessionSpawnedAt: number | null;
  accepted: boolean;
  failure: {
    readonly cause: PaneStartFailureCause;
    readonly at: number;
    /** F-984: código de saída da raiz quando o processo saiu sozinho. */
    readonly exitCode?: number;
  } | null;
  /** A sessão acabou sem falha provada (pedido de encerramento, one-shot, fora da janela). */
  sessionEnded: boolean;
  /**
   * F-734: desfecho do primeiro turno fechado (o do brief). Só ele é julgado —
   * um turno seguinte (o Maestro escrevendo no pane) nunca reverte o veredito.
   */
  turnOutcome: 'started' | 'not-ours' | null;
  /** F-765: quando o turno do brief foi visto aberto (assentamento). */
  turnOpenedAt: number | null;
  /** F-765: quando a recusa do modelo apareceu no PTY sem trabalho. */
  modelRejectedAt: number | null;
  redeliveredAt: number | null;
  /** Passo 1 em curso: a varredura espera, mas a saída da sessão ainda conta. */
  redelivering: boolean;
  /** 'acting' = passo 2 em curso (fechar, rerotear, avisar). */
  phase: 'watching' | 'acting' | 'done';
}

const watches = new Map<string, PaneStartWatch>();
interface EarlyMark {
  readonly at: number;
  readonly failure?: PaneStartFailureCause;
  readonly accepted?: true;
}
/** Sinal que chegou antes de a ficha existir (corrida com a resposta da tool). */
const earlyMarks = new Map<string, EarlyMark>();
let kick: (() => void) | null = null;

function pruneEarlyMarks(now: number): void {
  for (const [paneId, mark] of earlyMarks) {
    if (now - mark.at >= EARLY_MARK_TTL_MS) earlyMarks.delete(paneId);
  }
  while (earlyMarks.size > MAX_EARLY_MARKS) {
    const oldest = earlyMarks.keys().next().value;
    if (oldest === undefined) break;
    earlyMarks.delete(oldest);
  }
}

function scheduleKick(): void {
  if (!kick) return;
  const run = kick;
  const timer = setTimeout(() => {
    try {
      run();
    } catch (error) {
      console.warn('[pane-start] verificação imediata falhou:', error);
    }
  }, 0);
  timer.unref?.();
}

/** O supervisor registra aqui a varredura imediata (falha provada não espera 15 s). */
export function setPaneStartKick(next: (() => void) | null): void {
  kick = next;
}

export function trackPaneStart(init: PaneStartWatchInit): PaneStartWatch {
  const now = Date.now();
  pruneEarlyMarks(now);
  const early = earlyMarks.get(init.paneId);
  earlyMarks.delete(init.paneId);
  const watch: PaneStartWatch = {
    ...init,
    sessionId: null,
    sessionSpawnedAt: null,
    accepted: early?.accepted === true,
    failure: early?.failure ? { cause: early.failure, at: early.at } : null,
    sessionEnded: false,
    turnOutcome: null,
    turnOpenedAt: early?.accepted === true ? early.at : null,
    modelRejectedAt: null,
    redeliveredAt: null,
    redelivering: false,
    phase: 'watching',
  };
  watches.set(init.paneId, watch);
  if (watch.failure) scheduleKick();
  return watch;
}

export function untrackPaneStart(paneId: string): void {
  watches.delete(paneId);
}

export function getPaneStartWatch(paneId: string): PaneStartWatch | null {
  return watches.get(paneId) ?? null;
}

export function listPaneStartWatches(): PaneStartWatch[] {
  return [...watches.values()];
}

export function finishPaneStartWatch(watch: PaneStartWatch): void {
  watch.phase = 'done';
  if (watches.get(watch.paneId) === watch) watches.delete(watch.paneId);
}

/**
 * F-765: o failover assumiu o pane (religou com outro modelo ou reabriu a
 * tarefa pela rota do spawn). A ficha sai sem veredito: nem sucesso no
 * disjuntor, nem um segundo reenvio da mesma tarefa.
 */
export function releasePaneStartWatch(paneId: string): boolean {
  const watch = watches.get(paneId);
  if (!watch || watch.phase !== 'watching') return false;
  finishPaneStartWatch(watch);
  return true;
}

/** Ficha da sessão: pela sessão já vinculada ou, antes do vínculo, pelo pane. */
export function paneStartWatchForSession(
  sessionId: string,
  paneId: string | undefined,
): PaneStartWatch | null {
  for (const watch of watches.values()) {
    if (watch.sessionId === sessionId) return watch;
  }
  if (!paneId) return null;
  const byPane = watches.get(paneId);
  return byPane && byPane.sessionId === null ? byPane : null;
}

/** Falha física provada (pty-ipc, entrega do brief, saída no boot). */
export function notePaneStartFailure(
  paneId: string,
  cause: PaneStartFailureCause,
  now: number = Date.now(),
): void {
  const watch = watches.get(paneId);
  if (!watch) {
    pruneEarlyMarks(now);
    earlyMarks.set(paneId, { at: now, failure: cause });
    return;
  }
  if (watch.phase !== 'watching' || watch.accepted || watch.failure) return;
  watch.failure = { cause, at: now };
  scheduleKick();
}

/**
 * F-734: o primeiro turno fechado da sessão vigiada — o do brief — acabou
 * (Stop ou StopFailure). StopFailure de configuração SEM trabalho no turno
 * (nenhuma ferramenta, nenhum handoff) é falha provada: o pane recebeu o brief,
 * mas o provedor recusou a credencial, a conta ou o pedido. Vale mesmo com o
 * turno aceito — foi justamente o turno aceito que o provedor recusou. Trabalho
 * ou Stop normal provam o início; limite e transitório saem para o failover.
 * Turnos seguintes não são julgados. Devolve a causa anotada (null = sem falha).
 */
export function notePaneTurnEnded(
  watch: PaneStartWatch,
  input: {
    readonly sessionId: string;
    readonly outcome: 'completed' | 'error';
    readonly stopFailure?: AgentStopFailureCategory;
    readonly worked: boolean;
    readonly modelRejected?: boolean;
    readonly now: number;
  },
): ProviderRejectedCause | null {
  if (watch.phase !== 'watching' || watch.failure || watch.turnOutcome !== null) {
    return null;
  }
  if (watch.sessionId === null) watch.sessionId = input.sessionId;
  const progress = paneStartProgress({
    turnProof: watch.turnProof,
    turnOpened: true,
    worked: input.worked,
    modelRejected: input.modelRejected,
    lastTurnEnd: {
      outcome: input.outcome,
      ...(input.stopFailure ? { stopFailure: input.stopFailure } : {}),
    },
  });
  if (progress.kind === 'rejected') {
    watch.failure = { cause: progress.cause, at: input.now };
    scheduleKick();
    return progress.cause;
  }
  if (progress.kind === 'turn-open') {
    // F-765: recusa do modelo — a ficha espera o failover (ou o prazo dele).
    watch.modelRejectedAt ??= input.now;
    return null;
  }
  watch.turnOutcome = progress.kind === 'not-ours' ? 'not-ours' : 'started';
  return null;
}

/** A entrega comprovada do spawn (colagem com ACK pendente) abriu o turno. */
export function notePaneStartAccepted(paneId: string, now: number = Date.now()): void {
  const watch = watches.get(paneId);
  if (!watch) {
    pruneEarlyMarks(now);
    earlyMarks.set(paneId, { at: now, accepted: true });
    return;
  }
  if (!watch.failure) {
    watch.accepted = true;
    watch.turnOpenedAt ??= now;
  }
}

/**
 * F-792: one-shot (AGY `--print`, OpenCode `run`) que sai com código 0 acabou
 * a tarefa; com código de erro ou sinal, morreu. Sem a saída da raiz (null)
 * não há prova de morte: vale o comportamento antigo (terminou).
 */
function oneShotFinished(
  exit: { readonly exitCode: number; readonly signal?: number } | null | undefined,
): boolean {
  return !exit || (exit.exitCode === 0 && (exit.signal ?? 0) === 0);
}

/**
 * Fim da sessão da tentativa. Saída SOZINHA (sem pedido de encerramento),
 * dentro da janela de início, sem turno → não começou. Vale também para o
 * one-shot que saiu com erro (F-792: o AGY recusou `--effort` e saiu com 1 em
 * 4 s, e ninguém soube). O resto (fechamento pedido, one-shot que terminou
 * com 0, morte tardia) não é veredito deste watchdog.
 */
export function notePaneSessionEnded(
  watch: PaneStartWatch,
  input: {
    readonly sessionId: string;
    readonly requested: boolean;
    readonly oneShot: boolean;
    /** Saída da raiz quando o processo saiu sozinho (tap de terminação). */
    readonly exit?: { readonly exitCode: number; readonly signal?: number } | null;
    readonly spawnedAt: number | null;
    readonly started: boolean;
    readonly now: number;
  },
): void {
  if (watch.phase !== 'watching' || watch.failure) return;
  if (watch.sessionId === null) {
    watch.sessionId = input.sessionId;
    watch.sessionSpawnedAt = input.spawnedAt;
  }
  if (input.started) watch.accepted = true;
  const windowStart =
    watch.redeliveredAt ?? input.spawnedAt ?? watch.sessionSpawnedAt ?? watch.createdAt;
  // F-984: saída com código de erro (ou sinal) sem nunca ter começado é
  // morte provada a QUALQUER momento da ficha — três writers Codex saíram com
  // 74 aos 303 s (fila de pesados) e ninguém foi avisado porque a janela de
  // 90 s já tinha passado. Saída limpa depois da graça continua sem veredito.
  const exit = input.exit ?? null;
  const errorExit = exit !== null && (exit.exitCode !== 0 || (exit.signal ?? 0) !== 0);
  if (
    !input.requested &&
    !(input.oneShot && oneShotFinished(input.exit)) &&
    !input.started &&
    (input.now - windowStart < START_GRACE_MS || errorExit)
  ) {
    watch.failure = {
      cause: 'boot-exit',
      at: input.now,
      ...(exit !== null ? { exitCode: exit.exitCode } : {}),
    };
    scheduleKick();
    return;
  }
  watch.sessionEnded = true;
}

export function resetPaneStartWatchdogForTests(): void {
  watches.clear();
  earlyMarks.clear();
  kick = null;
}
