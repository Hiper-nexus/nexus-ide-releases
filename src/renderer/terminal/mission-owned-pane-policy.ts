/**
 * Posse de missão ≠ mudez. Decisões puras do restore/teclado para o
 * renderer não entrar no beco sync → block → retire → pane oco.
 */

import type { PaneSessionState } from '../../shared/surface-payload-types';

export type StaleAuthorityAction = 'sync-once' | 'unlock-keyboard';

export function decideStaleAuthorityRecovery(input: {
  readonly restorePersistedAuthority: boolean;
  readonly autoResumeAlreadySpent: boolean;
}): StaleAuthorityAction {
  if (input.restorePersistedAuthority || input.autoResumeAlreadySpent) {
    return 'unlock-keyboard';
  }
  return 'sync-once';
}

export type ExitedPaneKeyAction =
  | 'resume-keyboard'
  | 'reclaim-shell'
  | 'ignore';

export type DeadPaneReviveRespawnAction = 'same-pane-resume' | 'main-only';

/**
 * Tecla em pane morto: quem renasce a CLI do próprio pane?
 * Coordenador: no mesmo xterm (revisão humana pós-done, F-108).
 * Worker de missão / grant orchRequestId: main-only — o token morre com a
 * sessão do app; respawn local produz "unknown or expired orchestration
 * spawn grant".
 */
export type OrchestratorProcessExitAction =
  | 'relive-cli-quietly'
  | 'print-notice';

/**
 * Fim do turno do Maestro: a CLI sai sozinha (turn-end). O pane tem que
 * continuar vivo — religar a mesma conversa, sem banner no PTY e sem
 * mandar o motor reabrir a missão. O quadro/rail avisa o humano.
 */
export function decideOrchestratorProcessExit(input: {
  readonly isOrchestrator: boolean;
  readonly exitCode: number;
}): OrchestratorProcessExitAction {
  if (input.isOrchestrator && input.exitCode === 0) {
    return 'relive-cli-quietly';
  }
  return 'print-notice';
}

/** Tecla no Maestro morto religa a CLI. Nunca dispara resume/retry-kickoff. */
export function shouldKickMissionEngineOnDeadPaneKey(input: {
  readonly isOrchestrator: boolean;
}): boolean {
  return input.isOrchestrator !== true;
}

/**
 * Exceção à regra acima: Maestro de missão CONCLUÍDA. O main só religa a CLI
 * de missão running (a cerca de autoridade recusa o spawn e o reconciliador
 * mata em 1s), então religar no pane era beco sem saída. A tecla faz o mesmo
 * que "Pedir um ajuste" no Quadro: o main reabre e religa o Maestro (F-167).
 */
export function deadMaestroKeyRequestsAdjustment(input: {
  readonly isOrchestrator: boolean;
  readonly missionDone: boolean;
}): boolean {
  return input.isOrchestrator && input.missionDone;
}

export const DONE_MAESTRO_ADJUSTMENT_NOTICE =
  '[nexus] missão reaberta para o seu ajuste. O Maestro volta em instantes; escreva o ajuste nele.';

/** Exit 0 de missão: o quadro/rail avisa. O PTY não vira mural. */
export function shouldPrintMissionPaneExitNotice(exitCode: number): boolean {
  return exitCode !== 0;
}

/**
 * Ctrl+C no worker só quando já existe entrega e nada está na fila.
 * O CLI do Maestro sai em TODO turn-end: interrupt no kickoff (spawning,
 * sem handoff) mata o worker antes do trabalho. Pronto espera writer-busy,
 * então esperar `done` nunca dispara — o sinal é o handoff, não o status.
 */
export function shouldInterruptBusyWorkerAfterMaestroTurnEnd(input: {
  readonly workerIsOrchestrator: boolean;
  readonly paneState: string | undefined;
  readonly hasSuccessHandoff: boolean;
  readonly hasQueuedHandoffs: boolean;
}): boolean {
  if (input.workerIsOrchestrator) return false;
  if (input.paneState !== 'busy') return false;
  if (!input.hasSuccessHandoff || input.hasQueuedHandoffs) return false;
  return true;
}

/** Relive silencioso: prompt vivo, sem “Continue the current mission…”. */
export function shouldInjectResumeContinuation(input: {
  readonly quietSpawn: boolean;
  readonly hasContinuityPack: boolean;
  readonly resume: boolean;
  readonly adopted: boolean;
  readonly resumeMode: string | undefined;
  /** Auth same-account recovery: never type into /login. */
  readonly skipContinuation?: boolean;
}): boolean {
  if (input.quietSpawn) return false;
  if (input.skipContinuation) return false;
  if (input.hasContinuityPack) return true;
  return (
    input.resume &&
    !input.adopted &&
    input.resumeMode !== 'unsupported'
  );
}

export function decideDeadPaneReviveRespawn(input: {
  readonly missionOwnsPane: boolean;
  readonly hasOrchRequestId: boolean;
  /** Pane do coordenador: o ajuste pós-done acontece AQUI, não noutro leaf. */
  readonly isOrchestrator?: boolean;
}): DeadPaneReviveRespawnAction {
  // F-108: tecla no Maestro morto abria um pane novo e este virava
  // histórico — a varredura done em seguida apagava a conversa. O
  // coordenador revive no mesmo xterm. Grant órfão em worker segue
  // main-only (token morre com a sessão do app).
  if (input.isOrchestrator) return 'same-pane-resume';
  if (input.missionOwnsPane || input.hasOrchRequestId) return 'main-only';
  return 'same-pane-resume';
}

export type UnlockRetiredPaneDisposition =
  | 'keep-paused'
  | 'reclaim-shell'
  /** Preserva o pane como histórico: não revive a missão nem vira shell. */
  | 'keep-history';

/**
 * Missão viva (pending/running/blocked) NÃO vira shell. Falha ao consultar
 * o status também preserva o pane — fail-closed, nunca destrói o histórico
 * do agente porque o IPC piscou.
 */
/**
 * Restore/montagem do pane NÃO dispara retry-kickoff. Só tecla do operador
 * ou Retomar no rail. Sem isto, leftover/Encerrar reimprimia
 * "revival da missão falhou" em vermelho no histórico.
 */
export function shouldReviveDeadMissionFromPane(input: {
  readonly operatorInitiated?: boolean;
}): boolean {
  return input.operatorInitiated === true;
}

export function decideUnlockRetiredMissionPane(input: {
  readonly missionStatus?: 'pending' | 'running' | 'blocked' | 'done' | 'failed';
  readonly lookupFailed?: boolean;
  readonly isOrchestrator?: boolean;
  /** True somente quando o operador agiu (tecla no pane), nunca em montagem. */
  readonly operatorInitiated?: boolean;
}): UnlockRetiredPaneDisposition {
  if (input.lookupFailed) return 'keep-paused';
  if (
    input.missionStatus === 'pending' ||
    input.missionStatus === 'running' ||
    input.missionStatus === 'blocked'
  ) {
    return 'keep-paused';
  }
  // Missão concluída NÃO encerra a conversa: a entrega ainda espera revisão
  // humana e o operador pode não aprovar. O pane do coordenador é onde ele
  // pede o ajuste, então virar shell comum apagaria o histórico da
  // coordenação justamente no momento da revisão. Workers, que já cumpriram
  // o papel, seguem podendo virar shell.
  //
  // MAS reviver é decisão HUMANA: esta função também roda no restore/montagem
  // do pane, e sem esta cerca abrir "Terminais" numa missão pronta relançava
  // a missão sozinho (bug de campo 23/08) — a mesma "revival surpresa" que a
  // casa tirou fora. Sem gesto do operador, o pane fica como histórico.
  if (input.missionStatus === 'done' && input.isOrchestrator) {
    return input.operatorInitiated ? 'keep-paused' : 'keep-history';
  }
  return 'reclaim-shell';
}

export function decideExitedPaneKey(input: {
  readonly hasSession: boolean;
  readonly spawnStarted: boolean;
  readonly paneState: string | undefined;
  readonly missionOwns: boolean;
  readonly spawnHeld?: boolean;
  /** Pane do coordenador de uma missão já concluída. */
  readonly doneOrchestrator?: boolean;
}): ExitedPaneKeyAction {
  if (input.hasSession || input.spawnStarted) return 'ignore';
  if (input.spawnHeld && input.missionOwns) return 'resume-keyboard';
  if (input.paneState === 'hibernated' && input.missionOwns) {
    return 'resume-keyboard';
  }
  if (input.paneState !== 'exited') return 'ignore';
  if (input.missionOwns) return 'resume-keyboard';
  // `missionOwns` é falso em missão terminal, mas o coordenador de uma
  // missão concluída ainda é o canal da revisão humana — a tecla tenta
  // religá-lo, nunca troca por um shell vazio.
  return input.doneOrchestrator ? 'resume-keyboard' : 'reclaim-shell';
}

/**
 * Vínculo da missão para a tecla em pane sem sessão. `'none'` = pane livre;
 * `'done'`/`'failed'` = os espelhos locais concordam que terminou; qualquer
 * outro caso é tratado como missão viva ou desconhecida, com as proteções
 * intactas.
 *
 * `'done'` **não distingue aprovado de aguardando revisão** — quem precisa
 * dessa distinção consulta `missionOwns`, não este tipo.
 */
export type TerminalMissionLink = 'none' | 'done' | 'failed' | 'live-or-unknown';

/**
 * Se a tecla passa pela rota rápida de missão terminal ou cai na rota antiga
 * (`decideExitedPaneKey`), que é a que tem as proteções completas.
 *
 * A rota rápida existe para um caso só: **estado preso**. Pane cuja missão
 * terminou mas cujo estado não é `'exited'`, onde `decideExitedPaneKey`
 * devolveria `'ignore'` e o teclado ficaria mudo para sempre. Ela não existe
 * para atropelar posse de missão nem hibernação, e F-347 é o que acontece quando
 * atropela:
 *
 *   1. `missionOwns` — done SEM carimbo do humano ainda é revisão, então o
 *      coordenador continua dono do pane (F-108). `link === 'done'` vale para
 *      aprovado e para aguardando revisão, então os dois predicados discordam
 *      exatamente onde importa. Sem esta guarda, uma tecla num pane de worker de
 *      missão concluída-não-aprovada apagava `paneMissions[pane.id]` de forma
 *      irreversível pela UI, antes de o humano revisar.
 *   2. `paneState === 'hibernated'` — pane hibernado tem botão de acordar e não
 *      é estado preso; virar shell nu na primeira tecla descarta o snapshot sem
 *      necessidade.
 */
export function terminalDeadPaneFastPathApplies(input: {
  readonly link: TerminalMissionLink;
  /** `paneState(paneId)`; `undefined` quando o pane não tem entrada de estado. */
  readonly paneState: PaneSessionState | undefined;
  /** `missionStillOwnsPane(pane.id, pane)`. */
  readonly missionOwns: boolean;
}): boolean {
  if (input.link === 'live-or-unknown') return false;
  if (input.paneState === 'hibernated') return false;
  return !input.missionOwns;
}

/**
 * Tecla em pane SEM sessão de missão TERMINAL (done/failed) ou vínculo
 * órfão. O chamador já provou que não há sessão viva nem spawn em curso
 * (para spawn em curso, devolve 'ignore' — transiente).
 *
 * Pós-missão nunca é mudez: estado preso (busy/spawning travado, exit
 * perdido) não pode silenciar o teclado. O coordenador de missão concluída
 * mantém o canal de revisão (F-108); todo o resto vira shell digitável.
 * Missão VIVA nunca passa por aqui — as proteções acima continuam valendo.
 */
export function decideTerminalMissionDeadPaneKey(input: {
  readonly spawnStarted: boolean;
  /** Coordenador de missão concluída: a tecla tenta religar o Maestro. */
  readonly keepReviewChannel: boolean;
}): ExitedPaneKeyAction {
  if (input.spawnStarted) return 'ignore';
  return input.keepReviewChannel ? 'resume-keyboard' : 'reclaim-shell';
}

function isTypableOperatorLeaf(pane: {
  readonly kind?: string;
  readonly isStructuralPlaceholder?: boolean;
}): boolean {
  if (pane.isStructuralPlaceholder === true) return false;
  return pane.kind === 'shell' || pane.kind === 'cli-agent';
}

/** True when pruning this pane would leave the operator with no typable leaf. */
export function pruneWouldLeaveOperatorMute(
  livePanes: readonly { readonly id: string; readonly kind?: string; readonly isStructuralPlaceholder?: boolean }[],
  paneId: string,
): boolean {
  return !livePanes.some(
    (pane) => pane.id !== paneId && isTypableOperatorLeaf(pane),
  );
}

export const MISSION_OWNED_EXIT_NOTICE =
  '[nexus] agente entregou. Digite no Maestro para pedir um ajuste — a missão não encerrou.';

/**
 * Pós-done/morto, nenhuma tecla cai no silêncio: a tentativa anuncia na
 * hora (o aceite/erro vem depois pelas linhas existentes) e a repetição
 * dentro do cooldown de 15s ganha dica em vez de no-op mudo — era assim
 * que "terminou a missão e não deixa eu intervir" se apresentava.
 */
export const DEAD_PANE_REVIVE_ATTEMPT_NOTICE =
  '[nexus] tecla recebida — tentando religar o Maestro neste pane…';
/**
 * Pane de worker/helper morto: a tecla não promete religar NADA neste
 * pane — o renderer só verifica a missão. A versão do Maestro ("tentando
 * religar o Maestro neste pane") num helper lia como promessa quebrada:
 * o pane nunca volta (F-368).
 */
export const DEAD_PANE_REVIVE_CHECK_NOTICE =
  '[nexus] tecla recebida — verificando a missão deste pane…';
export const DEAD_PANE_REVIVE_COOLDOWN_NOTICE =
  '[nexus] tentativa recente em curso — aguarde concluir ou use Reiniciar na toolbar.';

/**
 * Worker morto com Maestro VIVO: religar a missão respawnaria coordenação
 * em cima de coordenação. O pane fica como histórico e a mensagem aponta o
 * pane onde a missão continua (F-368).
 */
export function deadHelperPaneHistoryNotice(
  maestroTitle?: string,
): string {
  const destino =
    maestroTitle && maestroTitle.trim().length > 0 ? maestroTitle : 'Maestro';
  return (
    '[nexus] este pane é histórico: o agente dele encerrou. ' +
    `A missão segue com o Maestro em «${destino}» — escreva lá.`
  );
}

/**
 * Worker morto SEM Maestro vivo: o retry-kickoff reabre a coordenação
 * noutro pane e este fica como histórico. Só se imprime depois do comando
 * aceito — antes, "o Maestro abre em outro pane" saía mesmo quando o main
 * não fazia nada visível (F-368).
 */
export const DEAD_PANE_MISSION_RELIVED_NOTICE =
  '[nexus] missão religada — o Maestro reabre em outro pane; este fica como histórico.';

/**
 * Aviso de cooldown do revive: UMA vez por janela por pane. A chave é o
 * carimbo de início da janela (`deadPaneReviveAt`) — uma janela nova tem
 * outro carimbo e volta a poder avisar. Sem esta cerca, cada tecla dentro
 * dos 15s repetia a linha (uma por tecla no voo real de 28/09).
 */
export function deadPaneReviveCooldownNoticeDue(input: {
  readonly windowStart: number | undefined;
  readonly lastNotifiedWindowStart: number | undefined;
}): boolean {
  return input.windowStart !== input.lastNotifiedWindowStart;
}

function clampDeliverySummary(raw: string): string | null {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (line.length === 0 || line.startsWith('{')) return null;
  return line.length > 280 ? `${line.slice(0, 277)}…` : line;
}

export function latestCivilianDeliverySummary(input: {
  readonly missionId: string;
  readonly resultSummary?: string | null;
  readonly handoffs: readonly {
    readonly missionId?: string;
    readonly status?: string;
    readonly summary?: string;
    readonly createdAt?: number;
  }[];
}): string | null {
  const fromResult = clampDeliverySummary(input.resultSummary ?? '');
  if (fromResult) return fromResult;
  const successes = input.handoffs.filter(
    (handoff) =>
      handoff.missionId === input.missionId &&
      handoff.status === 'success' &&
      typeof handoff.summary === 'string',
  );
  if (successes.length === 0) return null;
  const latest = successes.reduce((winner, candidate) =>
    (candidate.createdAt ?? 0) >= (winner.createdAt ?? 0) ? candidate : winner,
  );
  return clampDeliverySummary(latest.summary ?? '');
}

/**
 * Exit de worker: o turno do AGENTE acabou, a missão não. "turno encerrado"
 * em 4 panes lia como missão fechada (print 24/08: resultado 2+2=4 no JSON
 * e Maestro morto). Instrução de tecla só quando o processo CAIU.
 */
export function missionOwnedExitNotice(exitCode: number): string {
  if (exitCode === 0) {
    return `[nexus] agente entregou — a missão segue no Maestro.`;
  }
  return (
    `[nexus] processo caiu (code ${exitCode}). ` +
    'Digite para religar — a missão continua no rail.'
  );
}

/**
 * O coordenador NUNCA anuncia que a missão encerrou. Só o humano fecha.
 * Se houver entrega, ela aparece aqui — o operador não precisa caçar JSON
 * noutro pane.
 */
export function orchestratorOwnedExitLines(input: {
  readonly exitCode: number;
  readonly deliverySummary?: string | null;
}): readonly string[] {
  if (input.exitCode !== 0) {
    return [missionOwnedExitNotice(input.exitCode)];
  }
  const summary = clampDeliverySummary(input.deliverySummary ?? '');
  return [
    ...(summary ? [`[nexus] resultado: ${summary}`] : []),
    '[nexus] a missão NÃO encerrou. Digite aqui para pedir um ajuste.',
  ];
}

export const STALE_AUTHORITY_SYNC_NOTICE =
  '[nexus] contexto antigo detectado — sincronizando a missão uma vez pela autoridade principal…';

export const STALE_AUTHORITY_UNLOCK_NOTICE =
  '[nexus] este pane não tem mais sessão. Digite para um shell aqui — a missão continua no rail.';

export const BLOCKED_RESUME_NOTICE =
  '[nexus] missão bloqueada — retomando pela autoridade principal…';

export const MISSION_HOLD_NOTICE =
  '[Nexus] Agente em pausa — a sessão anterior NÃO foi reiniciada automaticamente.\r\n' +
  '  Clique a missão no rail e use Retomar.\r\n';

export const STANDALONE_HOLD_NOTICE =
  '[Nexus] Agente em pausa — a sessão anterior NÃO foi reiniciada automaticamente.\r\n' +
  '  Confirme o diálogo ou retome a missão no rail quando quiser.\r\n';
