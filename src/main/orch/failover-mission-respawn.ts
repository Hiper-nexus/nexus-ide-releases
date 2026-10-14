/**
 * Failover de CONTA em panes de missão main-owned (2026-08-16).
 *
 * O pipeline de failover (detectLimit → performSwitch → emitFailover) já
 * escolhe a próxima conta e emite o evento — mas o ÚNICO consumidor era o
 * renderer (failover-controller), que só age em panes do layout dele.
 * Workers headless/main-owned de missão morriam no limite sem NUNCA trocar
 * de conta: o pane morria, a missão sentia como exit comum. Este módulo é o
 * consumidor do lado do Main: respawna o MESMO agente da MESMA missão com a
 * nova conta pinada e o pacote de continuidade estruturado (F-775) como
 * initialPrompt, e aposenta a sessão exausta — sem contar morte nem falha
 * de handoff (F-1480).
 */

import { recoveryTriggerClass, scheduleRecoveryAdvice } from './jev-mission-advisor';
import fs from 'node:fs';
import path from 'node:path';
import type { PaneSpawnOptions } from './main-owned-pane-runtime';
import type { PaneOrchMeta } from './main-owned-pane-runtime';
import { deleteMainOwnedPane, getMainOwnedPane } from './main-owned-pane-runtime';
import { spawnMainOwnedMissionPaneAsync } from './pane-registry';
import {
  getAgentSessionInfo,
  getRequestedTerminationOrigin,
  getSessionCwd,
  getSessionProviderConversation,
  getSessionSpawnedAtMs,
  getSessionState,
  listAgentSessionsForPane,
  orchTerminateSession,
  tapSessionTermination,
} from '../pty/pty-manager';
import { EXACT_RESUME_FAST_EXIT_MS } from '../pty/exact-resume-health';
import { rebindProviderPaneSessionAccount } from '../persistence/provider-session-store';
import { modelAccessQuarantine } from './model-access-quarantine';
import { trace } from '../observability/main-trace';
import { markPaneDeliberatelyClosed } from './pane-session-output';
import { getProjectDomainStores } from './project-domain-store-registry';
import { requireWorktreeRuntimeRegistry } from '../runtime/worktree-runtime-registry';
import {
  FAILOVER_RESPAWN_TERMINATION_ORIGIN,
  settleFailoverRetirement,
} from './failover-retirement';
import { parsePaneAdmissionRefusal } from './pane-admission';
import { licenseErrorFrom } from '../../shared/license-errors';
import { makeId } from './store-util';
import type { OrchPaneSpawnResult } from '../../shared/orch-types';
import {
  FAILOVER_HANDOFF_FOOTER,
  buildContinuityPack,
  buildCrossAccountResumeNote,
  type ContinuityPackInput,
} from '../../shared/failover-handoff';
import {
  prepareContextHandoff,
  terminalHistoryItems,
  type HandoffHistoricalMessage,
} from './context-handoff-budget';
import {
  forgetPaneTaskReroute,
  getPaneTaskReroute,
  registerPaneTaskReroute,
} from './pane-task-reroute';
import { carryInFlightRequests, inFlightRequestOf, inFlightRequestsOf } from './in-flight-request';
import type { TaskDispatchRecord } from './task-dispatch-store';
import { getAdapter } from '../adapters/adapter-registry';
import { getAcpDriverSession } from '../acp/acp-harness-driver';
import {
  initialPromptChannel,
  nativeInitialPromptForRole,
} from '../../shared/cli-initial-prompt';
import { parseGitPorcelain } from './worker-files-modified';
import {
  AsyncProcessGitRunner,
  assertSafeLocalGitConfigAsync,
  type AsyncGitRunner,
  type GitRunOptions,
} from '../runtime/git-command';

export interface MainOwnedFailoverPlanInput {
  readonly adapterId: string;
  readonly meta: PaneOrchMeta | null;
  /** Conta pinada no pane novo; ausente = login nativo (rotação de modelo). */
  readonly toAccountId?: string;
  readonly fromAccountLabel: string;
  readonly reason: string;
  /**
   * F-520: failover de MODELO (mesma conta) — modelo alternativo escolhido
   * pelo main quando o provider rejeitou o id anterior. Ausente = failover
   * de conta (o respawn já nasce no default do adapter).
   */
  readonly toModel?: string;
  /** F-775: janela/reset medidos + estado da tarefa para o pack. */
  readonly limitKind?: string;
  readonly limitWindow?: string | null;
  readonly limitResetsAt?: number | null;
  readonly limitCooldownMs?: number | null;
  readonly taskBrief?: string;
  readonly nextStep?: string;
  readonly scrollbackExcerpt?: string;
  /** Estado da tarefa já coletado (`collectGitTaskState`, worktree do pane). */
  readonly touchedFiles?: readonly string[];
  readonly diffStat?: string;
  readonly toAccountLabel?: string;
  /**
   * F-775: pacote pronto (troca de CLI) — vale sobre o de conta e o de modelo.
   * `adapterId` é então a CLI NOVA, escolhida pela rota.
   */
  readonly continuityPack?: string;
  /** ORC-05: pane de origem — ponteiro auditável do recorte de contexto. */
  readonly paneId?: string;
  /** ORC-05: pedido original da tarefa (memória do Main), item do recorte. */
  readonly originalRequest?: string;
  /**
   * F-1480: pasta real da sessão exausta. Sem ela o pane novo nascia na raiz
   * da worktree: perdia a subpasta e, no Claude, a pasta `projects/<cwd>`.
   */
  readonly cwd?: string;
  /**
   * F-1480: modelo e esforço do pane exausto (sessão física / linha da
   * composição). A troca de CONTA renasce neles, não no padrão do adapter; a
   * rotação de modelo (F-520) troca só o modelo; a troca de CLI não herda.
   */
  readonly previousModel?: string;
  readonly previousEffort?: string;
  /**
   * F-1473: o histórico do adapter atravessa contas (`nativeResumeAcrossAccounts`)
   * e a conversa de `paneId` já é da conta nova — o pane novo retoma a MESMA
   * conversa (`--resume`, no `cwd` real da sessão exausta) e recebe só a nota
   * curta, não o pack.
   */
  readonly nativeResume?: boolean;
  /** F-1482: último(s) pedido(s) entregue(s) ao pane (memória do Main). */
  readonly inFlightRequest?: string;
}

export type MainOwnedFailoverPlan =
  | {
      readonly action: 'respawn';
      readonly options: PaneSpawnOptions & {
        missionId: string;
        role: 'orchestrator' | 'worker';
      };
    }
  | {
      readonly action: 'skip';
      readonly reason: string;
    };

/** F-822: teto de CADA consulta ao git do pane — o failover não espera mais. */
export const GIT_STATE_TIMEOUT_MS = 1_000;

export interface GitTaskState {
  readonly touchedFiles: string[];
  readonly diffStat: string | undefined;
}

const NO_GIT_STATE: GitTaskState = Object.freeze({ touchedFiles: [], diffStat: undefined });

/**
 * F-822: arquivos tocados e `git diff --stat` para o pacote de continuidade —
 * SÓ na worktree do próprio pane. Em checkout compartilhado (a raiz da missão
 * ou do projeto) "Touched files" listaria o trabalho de outros workers, então
 * não coleta. Git assíncrono no envelope seguro do Nexus (AsyncProcessGitRunner:
 * hooks nulos, fsmonitor desligado, ambiente limpo), config local executável
 * recusada (`assertSafeLocalGitConfigAsync` — um `core.fsmonitor` ou
 * `diff.*.textconv` plantado não roda), diff sem driver externo e timeout de
 * 1 s por consulta. Antes eram três `execFileSync` com git cru (até 11 s por
 * pane) dentro do planejador "puro". Qualquer falha devolve estado vazio: a
 * seção some do pacote, o failover segue.
 */
export async function collectGitTaskState(
  worktreePath: string | undefined,
  options: { readonly sharedRootPath?: string; readonly git?: AsyncGitRunner } = {},
): Promise<GitTaskState> {
  if (!worktreePath) return NO_GIT_STATE;
  const runner = options.git ?? new AsyncProcessGitRunner();
  const git: AsyncGitRunner = {
    run: (cwd: string, args: readonly string[], runOptions: GitRunOptions = {}) =>
      runner.run(cwd, args, { ...runOptions, timeoutMs: GIT_STATE_TIMEOUT_MS }),
  };
  try {
    const real = await fs.promises.realpath(worktreePath);
    if (options.sharedRootPath) {
      const shared = await fs.promises.realpath(options.sharedRootPath).catch(() =>
        path.resolve(options.sharedRootPath!),
      );
      if (real === shared) return NO_GIT_STATE;
    }
    await assertSafeLocalGitConfigAsync(git, real);
    const [status, diff] = await Promise.all([
      git.run(real, ['status', '--porcelain'], { allowFailure: true }),
      git.run(real, ['diff', '--stat', '--no-ext-diff', '--no-textconv'], { allowFailure: true }),
    ]);
    return {
      touchedFiles: status.status === 0 ? parseGitPorcelain(status.stdout) : [],
      diffStat: diff.status === 0 && diff.stdout.trim() ? diff.stdout.trim() : undefined,
    };
  } catch {
    return NO_GIT_STATE;
  }
}

/**
 * Planeamento puro do respawn: mesmo adapter, mesma missão, mesmo papel,
 * MESMO selo de autoridade (o contexto da missão não mudou — só a conta
 * física), conta NOVA pinada e encarnação NOVA (o processo antigo morreu no
 * limite; herdar o incarnationId mentiria a prova de dedup do handoff).
 *
 * Cross-account vira o pacote de continuidade estruturado (F-775) — nunca o
 * motivo cru português de antes: o texto passa pelas máscaras anti-detector
 * e carrega arquivos/diff/próximo passo. F-520 (rotação de modelo, mesma
 * conta) mantém o prompt curto próprio — não é handoff entre credenciais.
 * ORC-05: quando a conversa nativa não pode ser retomada, o pack ganha um
 * recorte com orçamento (pedido original + terminal recente + ponteiros);
 * se nem isso cabe, o plano é `skip` com o erro — o pack nunca é encurtado.
 */
export function planMainOwnedFailoverRespawn(
  input: MainOwnedFailoverPlanInput,
): MainOwnedFailoverPlan {
  const meta = input.meta;
  if (!meta) {
    return { action: 'skip', reason: 'pane main-owned não registrado' };
  }
  if (!meta.missionId || !meta.role) {
    return { action: 'skip', reason: 'pane main-owned sem missão/papel' };
  }
  // F-520: o prompt de modelo NUNCA ecoa o reason cru — o texto canónico
  // ("model requires a newer version", …) casaria de novo no detector ao ser
  // digitado no PTY novo e dispararia um failover fantasma na sessão sadia.
  let initialPrompt: string;
  const resumeFromPaneId = resumesNativeConversation(input) ? input.paneId : undefined;
  if (resumeFromPaneId) {
    initialPrompt = buildCrossAccountResumeNote({
      toAccountLabel: input.toAccountLabel ?? input.toAccountId ?? '',
      role: meta.role,
      inFlightRequest: input.inFlightRequest ?? input.originalRequest,
    });
  } else if (!nativeResumeImpossible(input)) {
    initialPrompt =
      `O modelo anterior foi rejeitado pelo provider. ` +
      `Você foi religado automaticamente no modelo "${input.toModel}" — ` +
      `continuar a tarefa de onde parou, sem repetir trabalho já entregue.`;
  } else {
    // ORC-05: a conversa nativa não atravessa a troca — o pedido corrente (o
    // pack) segue intacto e o histórico entra como recorte com orçamento. O
    // trecho do terminal vai no recorte (itens inteiros), não duplicado no pack.
    const currentRequest = input.continuityPack ?? buildCrossAccountPack(input, meta);
    const handoff = prepareContextHandoff({
      currentRequest,
      messages: handoffHistory(input),
      coverage: handoffCoverage(input, meta),
      compactCoverage:
        `Nexus context handoff (mission ${meta.missionId}). ` +
        `Recover omitted history with nexus_mission_get({missionId:"${meta.missionId}"}).`,
    });
    if (!handoff.ok) return { action: 'skip', reason: handoff.message };
    initialPrompt = withHandoffContext(currentRequest, handoff.context);
  }
  return {
    action: 'respawn',
    options: {
      adapterId: input.adapterId,
      accountId: input.toAccountId,
      model: input.toModel ?? (input.continuityPack ? undefined : input.previousModel),
      effort: input.continuityPack ? undefined : input.previousEffort,
      missionId: meta.missionId,
      role: meta.role,
      agentName: meta.agentName,
      cwd: input.cwd,
      title: meta.agentName,
      contextRevision: meta.contextRevision,
      allowedTools: meta.allowedTools ? [...meta.allowedTools] : null,
      allowedSkills: meta.allowedSkills ? [...meta.allowedSkills] : [],
      readOnly: meta.readOnly,
      nativeReadOnly: meta.nativeReadOnly,
      transient: meta.transient,
      scope: meta.scope as PaneSpawnOptions['scope'],
      executionScope: meta.executionScope as PaneSpawnOptions['executionScope'],
      isolatedWriter: meta.isolatedWriter,
      authoritySeal: meta.authoritySeal,
      visualTask: meta.visualTask,
      initialPrompt,
      ...(resumeFromPaneId ? { resume: true, resumeFromPaneId } : {}),
    },
  };
}

function buildCrossAccountPack(
  input: MainOwnedFailoverPlanInput,
  meta: PaneOrchMeta,
): string {
  const packInput: ContinuityPackInput = {
    fromAccountLabel: input.fromAccountLabel,
    toAccountLabel: input.toAccountLabel ?? input.toAccountId ?? '',
    reason: input.reason,
    role: meta.role,
    missionId: meta.missionId,
    taskBrief: input.taskBrief ?? meta.agentName,
    openWorkHint: meta.agentName,
    limitKind: input.limitKind,
    limitWindow: input.limitWindow,
    limitResetsAt: input.limitResetsAt,
    limitCooldownMs: input.limitCooldownMs,
    nextStep: input.nextStep,
    touchedFiles: input.touchedFiles,
    diffStat: input.diffStat,
    inFlightRequest: input.inFlightRequest,
  };
  return buildContinuityPack(packInput);
}

/**
 * ORC-05: sem resume nativo, o respawn main-owned é sessão nova. Troca de CLI
 * (pack pronto) nunca retoma; troca de conta só retoma quando o histórico do
 * adapter atravessa contas (F-1473, `resumesNativeConversation`); a rotação de
 * modelo F-520 (mesma conta, mesma CLI) fica de fora do recorte.
 */
export function nativeResumeImpossible(
  input: Pick<MainOwnedFailoverPlanInput, 'continuityPack' | 'toModel'>,
): boolean {
  return Boolean(input.continuityPack) || !input.toModel;
}

/** F-1473: troca de conta (não de CLI nem de modelo) com a conversa religada. */
function resumesNativeConversation(
  input: Pick<MainOwnedFailoverPlanInput, 'nativeResume' | 'continuityPack' | 'toModel' | 'toAccountId' | 'paneId'>,
): boolean {
  return Boolean(input.nativeResume && input.toAccountId && input.paneId &&
    !input.continuityPack && !input.toModel);
}

/** F-1473: prazo para a sessão do pane retomado nascer (o ACK do spawn pode vir antes do PTY). */
export const RESUME_BIND_TIMEOUT_MS = 75_000;
const RESUME_POLL_MS = 250;

/**
 * F-1473: `proved` = a retomada pegou; `failed` = sem prova (sessão não
 * nasceu, não retomou ou saiu antes da janela); `closed` = o próprio Nexus
 * encerrou a sessão na janela (missão cancelada, `nexus_pane_close`) — não é
 * queda e não pede fallback.
 */
export type ResumeBootVerdict = 'proved' | 'failed' | 'closed';

export interface ResumeBootObserver {
  /**
   * Prova de que a retomada pegou: sessão vinculada ao pane (ou a sessão
   * dada), nascida de `--resume` exato e viva por `windowMs` contados do
   * nascimento FÍSICO dela. Nenhuma sessão em `bindTimeoutMs` = `failed`.
   */
  confirm(target: { readonly paneId?: string; readonly sessionId?: string }): Promise<ResumeBootVerdict>;
  dispose(): void;
}

/**
 * F-1473: crie ANTES do spawn — a saída que acontece antes de o pane ser
 * conhecido (ou antes de `confirm`) fica registrada; a origem do encerramento
 * é lida na hora (pedido do Nexus = `closed`, não queda).
 */
export function observeResumeBoot(
  options: { readonly windowMs?: number; readonly bindTimeoutMs?: number } = {},
): ResumeBootObserver {
  const windowMs = options.windowMs ?? EXACT_RESUME_FAST_EXIT_MS;
  const bindTimeoutMs = options.bindTimeoutMs ?? RESUME_BIND_TIMEOUT_MS;
  /** Sessões que terminaram desde a criação do observador. */
  const ended = new Map<string, { readonly paneId?: string; readonly deliberate: boolean }>();
  const wakers = new Set<() => void>();
  const untap = tapSessionTermination((sessionId, agent) => {
    ended.set(sessionId, {
      paneId: agent?.paneId,
      deliberate: getRequestedTerminationOrigin(sessionId) !== null,
    });
    for (const wake of [...wakers]) wake();
  });
  let disposed = false;
  const nap = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      wakers.add(done);
    });
  const endOf = (target: { readonly paneId?: string; readonly sessionId?: string }) =>
    target.sessionId
      ? ended.get(target.sessionId)
      : [...ended.values()].find((end) => end.paneId === target.paneId);
  const verdictOfEnd = (end: { readonly deliberate: boolean }): ResumeBootVerdict =>
    end.deliberate ? 'closed' : 'failed';
  const liveSessionOf = (target: { readonly paneId?: string; readonly sessionId?: string }): string | undefined => {
    if (target.sessionId) return getSessionState(target.sessionId) !== null ? target.sessionId : undefined;
    return target.paneId
      ? listAgentSessionsForPane(target.paneId).find((session) => getSessionState(session.sessionId) !== null)?.sessionId
      : undefined;
  };
  return {
    async confirm(target) {
      const bindDeadline = Date.now() + bindTimeoutMs;
      for (;;) {
        if (disposed) return 'failed';
        const early = endOf(target);
        if (early) return verdictOfEnd(early);
        const sessionId = liveSessionOf(target);
        if (sessionId) {
          if (getSessionProviderConversation(sessionId)?.resumed !== true) return 'failed';
          const provenAt = (getSessionSpawnedAtMs(sessionId) ?? Date.now()) + windowMs;
          while (Date.now() < provenAt) {
            await nap(provenAt - Date.now());
            if (disposed) return 'failed';
            const end = ended.get(sessionId);
            if (end) return verdictOfEnd(end);
          }
          return getSessionState(sessionId) !== null ? 'proved' : 'failed';
        }
        if (Date.now() >= bindDeadline) return 'failed';
        await nap(Math.min(RESUME_POLL_MS, bindDeadline - Date.now()));
      }
    },
    dispose() {
      disposed = true;
      untap();
      for (const wake of [...wakers]) wake();
    },
  };
}

/**
 * F-1473: o substituto sem prova sai antes do pacote — cada sessão viva dele
 * encerrada com prova física (fora do disjuntor e sem cobrança: a tarefa
 * segue no pane de antes ou no do pacote) e o pane removido, sem sobrar morto.
 */
async function retireUnprovedReplacement(paneId: string): Promise<boolean> {
  markPaneDeliberatelyClosed(paneId);
  for (const session of listAgentSessionsForPane(paneId)) {
    if (getSessionState(session.sessionId) === null) continue;
    try {
      const exited = await orchTerminateSession(session.sessionId, {
        origin: FAILOVER_RESPAWN_TERMINATION_ORIGIN,
      });
      if (exited !== true) return false;
    } catch {
      return false;
    } finally {
      settleFailoverRetirement(session.sessionId, true);
    }
  }
  deleteMainOwnedPane(paneId);
  return true;
}

/**
 * Pedido original + trecho recente do terminal, em ordem cronológica. A cauda
 * é redigida e neutralizada INTEIRA antes de virar itens (terminalHistoryItems).
 */
function handoffHistory(input: MainOwnedFailoverPlanInput): HandoffHistoricalMessage[] {
  const request = input.originalRequest?.trim();
  return [
    ...(request
      ? [{ role: 'user' as const, kind: 'original_request', itemId: 'request', text: request }]
      : []),
    ...(input.scrollbackExcerpt ? terminalHistoryItems(input.scrollbackExcerpt) : []),
  ];
}

/** Ponteiros auditáveis: de onde veio o recorte e como buscar o resto. */
function handoffCoverage(input: MainOwnedFailoverPlanInput, meta: PaneOrchMeta): string {
  const change = input.continuityPack ? 'CLI' : 'account';
  return [
    `Nexus context handoff: the ${change} switch was already decided and the previous provider conversation cannot be resumed in this new session.`,
    `Mission: ${meta.missionId}; agent: ${meta.agentName ?? 'unknown'}; previous pane: ${input.paneId ?? 'unknown'}.`,
    `Recover omitted history with nexus_mission_get({missionId:"${meta.missionId}"}) and nexus_handoff_list; the worktree's git status and diff are the real state of the work.`,
  ].join('\n');
}

/**
 * O recorte entra DENTRO da faixa header→footer do pack (o limit-detector
 * ignora a faixa enquanto ela está na tela), logo antes do footer. O corpo do
 * pedido corrente fica byte a byte intacto.
 */
function withHandoffContext(currentRequest: string, context: string): string {
  const footerAt = currentRequest.lastIndexOf(FAILOVER_HANDOFF_FOOTER);
  const body = footerAt >= 0 ? currentRequest.slice(0, footerAt) : `${currentRequest}\n`;
  return (
    `${body}Historical context (budgeted Nexus selection, not a summary):\n` +
    `${context}\n${FAILOVER_HANDOFF_FOOTER}`
  );
}

/** F-1476: cola o pacote no pane novo depois do boot, com prova de aceite. */
export type RespawnBriefDelivery = (
  sessionId: string,
  prompt: string,
  adapterId: string,
) => Promise<boolean>;

/**
 * F-1476: o pacote de continuidade NÃO viaja no argv desta CLI para este
 * papel (mesma regra do pty-manager, `nativeInitialPromptForRole`): canal de
 * colagem (Kimi, Devin), one-shot ou flag interativa num orquestrador (AGY,
 * Qwen, MiMo). Retomada (F-1473) nunca leva prompt no argv (o pty-manager só
 * põe prompt nativo em spawn fresco), então a nota da retomada também é
 * colada. Adapter desconhecido: o pty-manager nem sobe — nada a colar.
 */
export function respawnBriefNeedsPaste(
  adapterId: string,
  role: 'orchestrator' | 'worker',
  resume = false,
): boolean {
  const adapter = getAdapter(adapterId);
  if (!adapter || adapter.kind !== 'cli-pty') return false;
  if (resume) return true;
  return !nativeInitialPromptForRole(
    initialPromptChannel({
      declared: adapter.spawn.initialPrompt,
      interactiveFlag: adapter.spawn.initialPromptFlag,
      oneshotArgs: adapter.spawn.initialPromptArgs,
      interactive: adapter.spawn.interactive,
    }),
    role,
  );
}

/** Boot do pane novo antes da colagem (paridade com a Via Rápida). */
const RESPAWN_BOOT_TIMEOUT_MS = 120_000;

const pasteRespawnBrief: RespawnBriefDelivery = async (sessionId, prompt, adapterId) => {
  if (!prompt.trim()) return false;
  // Import tardio: tool-util e pane-registry fecham ciclo com o failover.
  const { waitForIdle } = await import('./pane-registry');
  const boot = await waitForIdle(sessionId, RESPAWN_BOOT_TIMEOUT_MS);
  if (boot === 'exited') return false;
  const { deliverAgentPrompt } = await import('./tool-util');
  return deliverAgentPrompt(sessionId, prompt, undefined, { adapterId });
};

/**
 * Executor: respawna o agente main-owned com a nova conta e aposenta a sessão
 * exausta. Worker nasce ANTES de a velha sair (F-1480); orquestrador e worker
 * no teto de panes trocam na ordem inversa, com prova física de saída. Devolve
 * false quando não é pane de missão main-owned ou quando o spawn recusa
 * (autoridade stale etc.) — nesses casos o evento de failover segue para o
 * renderer como sempre.
 */
export async function respawnMainOwnedPaneWithAccount(input: {
  readonly paneId: string;
  readonly sessionId?: string;
  readonly adapterId: string;
  readonly toAccountId?: string;
  readonly fromAccountLabel: string;
  readonly reason: string;
  /** F-520: failover de modelo — mesma conta, modelo alternativo. */
  readonly toModel?: string;
  /** F-775: contexto estruturado do pack de continuidade. */
  readonly limitKind?: string;
  readonly limitWindow?: string | null;
  readonly limitResetsAt?: number | null;
  readonly limitCooldownMs?: number | null;
  readonly taskBrief?: string;
  readonly nextStep?: string;
  readonly scrollbackExcerpt?: string;
  readonly touchedFiles?: readonly string[];
  readonly diffStat?: string;
  readonly toAccountLabel?: string;
  /** F-775: pacote pronto da troca de CLI (`adapterId` é a CLI nova). */
  readonly continuityPack?: string;
  /** F-1473: conta esgotada (CAS do religamento da conversa). */
  readonly fromAccountId?: string;
  /** F-1473: o histórico do adapter atravessa as duas contas — tenta o resume nativo. */
  readonly nativeResume?: boolean;
}, deps: {
  readonly git?: AsyncGitRunner;
  readonly rebindSession?: typeof rebindProviderPaneSessionAccount;
  readonly observeResumeBoot?: () => ResumeBootObserver;
  /** F-1476: colagem do pacote com prova de aceite (dublê nos testes). */
  readonly deliverBrief?: RespawnBriefDelivery;
} = {}): Promise<boolean> {
  const entry = getMainOwnedPane(input.paneId);
  if (!entry || input.sessionId && entry.entry.sessionId !== input.sessionId) return false;
  // F-1166: dica consultiva de recuperação (repetir, trocar de CLI ou escalar).
  // Só registra; a lógica de failover abaixo segue exatamente a mesma.
  const failoverMissionId = entry.meta?.missionId;
  if (failoverMissionId) {
    // Só a classe da queda: o `reason` é texto do detector e não pode ser ecoado (F-520).
    scheduleRecoveryAdvice({
      missionId: failoverMissionId, paneId: input.paneId, adapterId: input.adapterId,
      triggerClass: recoveryTriggerClass({ limitKind: input.limitKind, toModel: input.toModel }),
      switchingTo: input.continuityPack ? 'cli' : input.toModel ? 'model' : input.toAccountId ? 'account' : undefined,
    });
  }
  const expectedSessionId = entry.entry.sessionId;
  const isCurrent = () => getMainOwnedPane(input.paneId) === entry &&
    entry.entry.sessionId === expectedSessionId;
  // Troca de conta leva o estado da tarefa — coletado AQUI, assíncrono e só
  // na worktree do próprio pane (F-822); rotação de modelo (F-520) não.
  const worktree =
    !input.toModel &&
    !input.continuityPack &&
    input.touchedFiles === undefined &&
    input.diffStat === undefined
      ? entry?.meta?.executionScope?.rootRealPath
      : undefined;
  const git = worktree
    ? await collectGitTaskState(worktree, {
        sharedRootPath: entry?.meta?.scope?.rootRealPath,
        git: deps.git,
      })
    : { touchedFiles: input.touchedFiles, diffStat: input.diffStat };
  if (!isCurrent()) return false;
  const previous = previousRuntime(input, entry, expectedSessionId);
  // F-1512: o que o pacote leva; o aceito na origem depois disto é o delta.
  const capturedRequests = inFlightRequestsOf(input.paneId);
  const planInput: MainOwnedFailoverPlanInput = {
    // F-1480: a sessão exausta ainda vive aqui — a pasta dela é a real.
    cwd: (expectedSessionId ? getSessionCwd(expectedSessionId) : null) ?? undefined,
    previousModel: previous.model,
    previousEffort: previous.effort,
    adapterId: input.adapterId,
    meta: entry?.meta ?? null,
    toAccountId: input.toAccountId,
    fromAccountLabel: input.fromAccountLabel,
    reason: input.reason,
    toModel: input.toModel,
    limitKind: input.limitKind,
    limitWindow: input.limitWindow,
    limitResetsAt: input.limitResetsAt,
    limitCooldownMs: input.limitCooldownMs,
    taskBrief: input.taskBrief,
    nextStep: input.nextStep,
    scrollbackExcerpt: input.scrollbackExcerpt,
    touchedFiles: git.touchedFiles,
    diffStat: git.diffStat,
    toAccountLabel: input.toAccountLabel,
    continuityPack: input.continuityPack,
    paneId: input.paneId,
    // O pedido guardado do spawn (só memória do Main) é o pedido original.
    originalRequest: getPaneTaskReroute(input.paneId)?.routeTask ?? undefined,
    inFlightRequest: inFlightRequestOf(input.paneId),
  };
  const plan = planMainOwnedFailoverRespawn(planInput);
  // F-1473: com histórico compartilhado o pane novo retoma a MESMA conversa;
  // `plan` (sessão nova + pacote) fica de fallback se a retomada não provar.
  const resumePlan = input.nativeResume
    ? planMainOwnedFailoverRespawn({ ...planInput, nativeResume: true })
    : null;
  const resumeOptions =
    resumePlan?.action === 'respawn' && resumePlan.options.resumeFromPaneId
      ? resumePlan.options
      : null;
  if (plan.action === 'skip' && !resumeOptions) {
    console.info(
      `[failover-mission-respawn] pulou ${input.paneId}: ${plan.reason}`,
    );
    return false;
  }
  type RespawnOptions = Extract<MainOwnedFailoverPlan, { action: 'respawn' }>['options'];
  // Worker governado ganha geração física NOVA, nunca a do processo exausto
  // (nem a de um substituto que não provou a retomada).
  let replacementIncarnationId: string | undefined;
  let spawnedOptions: RespawnOptions | undefined;
  const spawnWith = (options: RespawnOptions) => {
    replacementIncarnationId = entry.meta.workerIncarnationId ? makeId('workerinc') : undefined;
    spawnedOptions = options;
    return spawnMainOwnedMissionPaneAsync({
      ...options,
      ...(replacementIncarnationId ? { workerIncarnationId: replacementIncarnationId } : {}),
      assertOriginCurrent: () => {
        if (!isCurrent()) throw new Error('failover origin pane is stale');
      },
    });
  };
  const scope = entry.meta?.scope;
  let nativeResumed = false;
  // F-1476: o Nexus encerrou a retomada na janela — nada a colar nela.
  let resumeClosed = false;
  /**
   * F-1473: a conversa vai junto para a conta nova e o pane retomado só vale
   * com prova de boot. Sem prova, o substituto sai e o pacote entra no lugar;
   * encerrado pelo próprio Nexus na janela, não há fallback.
   */
  const spawnReplacement = async (): Promise<OrchPaneSpawnResult> => {
    if (
      resumeOptions &&
      input.toAccountId &&
      scope &&
      (deps.rebindSession ?? rebindProviderPaneSessionAccount)(
        scope, input.paneId, input.adapterId, input.fromAccountId, input.toAccountId,
      )
    ) {
      // O observador nasce antes do spawn: a saída no boot nunca escapa dele.
      const boot = (deps.observeResumeBoot ?? observeResumeBoot)();
      try {
        const resumed = await spawnWith(resumeOptions);
        if (!resumed.ok) {
          if (isSeatRefusal(resumed) || plan.action === 'skip') return resumed;
        } else {
          const target = {
            ...(resumed.sessionId ? { sessionId: resumed.sessionId } : {}),
            ...(resumed.paneId ? { paneId: resumed.paneId } : {}),
          };
          const verdict: ResumeBootVerdict =
            target.sessionId || target.paneId ? await boot.confirm(target) : 'failed';
          if (verdict !== 'failed') {
            nativeResumed = verdict === 'proved';
            resumeClosed = verdict === 'closed';
            return resumed;
          }
          console.warn(
            `[failover-mission-respawn] resume nativo sem prova para ${input.paneId} ` +
              '(sessão não nasceu, não retomou ou caiu no boot); sessão nova com o pacote',
          );
          // Um worker por tarefa: o substituto sem prova sai antes do pacote.
          if (resumed.paneId && !(await retireUnprovedReplacement(resumed.paneId))) {
            console.warn(
              `[failover-mission-respawn] o pane ${resumed.paneId} sem prova de retomada não encerrou; ` +
                'ele segue com a tarefa',
            );
            return resumed;
          }
          if (plan.action === 'skip') {
            return { requestId: resumed.requestId, ok: false, error: 'a retomada não subiu e o pacote não cabe' };
          }
        }
      } finally {
        boot.dispose();
      }
    }
    if (plan.action === 'skip') return { requestId: 'failover-respawn', ok: false, error: plan.reason };
    return spawnWith(plan.options);
  };
  // Aposenta a sessão exausta; true = saída provada (ou sessão já ausente).
  let retireRequested = false;
  const retireExhausted = async (): Promise<boolean> => {
    if (!input.sessionId) return true;
    retireRequested = true;
    // F-918: troca de conta não é a CLI morrendo sozinha — fora do breaker.
    markPaneDeliberatelyClosed(input.paneId);
    try {
      return await orchTerminateSession(input.sessionId, {
        origin: FAILOVER_RESPAWN_TERMINATION_ORIGIN,
      }) === true;
    } catch {
      return false;
    }
  };
  let replaced = false;
  try {
    // F-1480: o worker ganha o pane novo ANTES de a sessão exausta sair — se o
    // spawn falhar, a tarefa segue no pane de antes (nada fica sem pane).
    let spawned: OrchPaneSpawnResult | null =
      (resumeOptions ?? (plan.action === 'respawn' ? plan.options : null))?.role === 'worker'
        ? await spawnReplacement()
        : null;
    if (!spawned || (!spawned.ok && isSeatRefusal(spawned))) {
      // Orquestrador (um Maestro por missão) ou teto de panes/licença: a vaga
      // é a da sessão exausta. Ela sai antes, e só com prova física — uma
      // rejeição não prova que os processos saíram (F-890).
      if (!(await retireExhausted())) return false;
      if (!isCurrent()) return false;
      spawned = await spawnReplacement();
    }
    if (!spawned.ok) {
      console.warn(
        `[failover-mission-respawn] respawn recusado para ${input.paneId}: ` +
          `${spawned.error}`,
      );
      return false;
    }
    const replacement = spawned.paneId && spawned.sessionId
      ? { paneId: spawned.paneId, sessionId: spawned.sessionId }
      : null;
    // F-1512: a tarefa despachada passa ao substituto ANTES de qualquer
    // trabalho dele (colagem do pacote, delta): heartbeat e handoff do pane
    // novo já acham o dispatch. Troca desfeita devolve o dispatch à origem.
    const origin = expectedSessionId && entry.meta.workerIncarnationId
      ? { paneId: input.paneId, sessionId: expectedSessionId, workerIncarnationId: entry.meta.workerIncarnationId }
      : null;
    const handedOver = replacement && origin && replacementIncarnationId
      ? transferTaskDispatch(entry.meta, origin, { ...replacement, workerIncarnationId: replacementIncarnationId })
      : null;
    // F-1476: o pty-manager só põe o pacote no argv numa sessão NOVA cujo canal
    // o leva para este papel (orquestrador: só posicional) — nunca numa
    // retomada. Sem argv, cola com prova de aceite DEPOIS da prova de boot do
    // F-1473 e ANTES de declarar a recuperação; sem aceite, o pane novo sai e
    // a tarefa segue onde estava. Sessão que o próprio Nexus fechou na janela
    // (`closed`) não recebe nada.
    if (
      spawned.sessionId &&
      spawnedOptions &&
      !resumeClosed &&
      (spawnedOptions.role === 'orchestrator' || spawnedOptions.role === 'worker') &&
      respawnBriefNeedsPaste(spawnedOptions.adapterId, spawnedOptions.role, Boolean(spawnedOptions.resume)) &&
      !getAcpDriverSession(spawned.sessionId)
    ) {
      const delivered = await (deps.deliverBrief ?? pasteRespawnBrief)(
        spawned.sessionId,
        spawnedOptions.initialPrompt ?? '',
        spawnedOptions.adapterId,
      ).catch(() => false);
      if (!delivered) {
        console.warn(
          `[failover-mission-respawn] pacote não aceito pelo pane novo de ${input.paneId}; ` +
            'recuperação não confirmada',
        );
        if (handedOver && origin && replacement && replacementIncarnationId) {
          transferTaskDispatch(entry.meta, { ...replacement, workerIncarnationId: replacementIncarnationId },
            origin, handedOver);
        }
        if (spawned.paneId) await retireUnprovedReplacement(spawned.paneId);
        return false;
      }
    }
    replaced = true;
    // F-1512: pedido aceito na origem viva durante o boot/colagem (depois da
    // captura do pacote) vai ao substituto pronto, uma vez, antes de a origem sair.
    const delta = inFlightRequestsOf(input.paneId).filter((request) => !capturedRequests.includes(request));
    if (delta.length && spawned.sessionId && spawnedOptions && !resumeClosed && !getAcpDriverSession(spawned.sessionId)) {
      const forwarded = await (deps.deliverBrief ?? pasteRespawnBrief)(
        spawned.sessionId,
        `${RESPAWN_DELTA_PREAMBLE}\n${delta.join('\n---\n')}`,
        spawnedOptions.adapterId,
      ).catch(() => false);
      if (!forwarded) {
        console.warn(
          `[failover-mission-respawn] pedido aceito por ${input.paneId} durante a troca não chegou ao pane novo; ` +
            'ele segue na memória do pane novo para a próxima troca',
        );
      }
    }
    // F-1482: o pane novo herda os pedidos em voo (troca em cadeia A → B → C).
    carryInFlightRequests(input.paneId, spawned.paneId);
    if (replacement && spawnedOptions) {
      adoptReplacementLineage(input.paneId, entry.meta, spawnedOptions, replacement);
    }
    if (!retireRequested && !(await retireExhausted())) {
      // O pane novo já trabalha; a sessão exausta fica inerte e registrada
      // até a prova física (o reconciliador tenta de novo).
      console.warn(
        `[failover-mission-respawn] sessão exausta ${input.sessionId} sem prova ` +
          `de saída; o pane novo ${spawned.paneId} segue`,
      );
    }
    console.info(
      `[failover-mission-respawn] ${input.paneId} religou na conta ` +
        `${input.toAccountId ?? 'nativa'} (novo pane ${spawned.paneId}, ` +
        `session ${spawned.sessionId})${nativeResumed ? ' retomando a mesma conversa' : ''}`,
    );
    return true;
  } finally {
    // Veredito para a cobrança de handoff: sem pane novo, a saída é cobrada.
    if (retireRequested && input.sessionId) {
      settleFailoverRetirement(input.sessionId, replaced);
    }
  }
}

/** Recusa de vaga (teto de panes, memória, agentes da licença), não da CLI. */
function isSeatRefusal(result: OrchPaneSpawnResult): boolean {
  return result.code === 'license_agent_limit' ||
    licenseErrorFrom(result.error)?.code === 'license_agent_limit' ||
    parsePaneAdmissionRefusal(result.error) !== null;
}

/**
 * F-1480: o pane novo assume o lugar do exausto — o pedido guardado para
 * reabrir a tarefa (mesma linhagem e geração: troca de conta não é
 * reabertura), o vínculo durável com a worktree do writer isolado (o `resume`
 * acha o pane novo) e a linha da composição (`mission_panes`). Best-effort: o
 * pane novo já está vivo; uma falha aqui só fica no log.
 */
function adoptReplacementLineage(
  fromPaneId: string,
  meta: PaneOrchMeta,
  options: Pick<PaneSpawnOptions, 'adapterId' | 'model' | 'effort'>,
  replacement: { readonly paneId: string; readonly sessionId: string },
): void {
  const handle = getPaneTaskReroute(fromPaneId);
  if (handle) {
    registerPaneTaskReroute({ ...handle, paneId: replacement.paneId, adapterId: options.adapterId });
    forgetPaneTaskReroute(fromPaneId);
  }
  const scope = meta.scope;
  if (!scope) return;
  try {
    const registry = requireWorktreeRuntimeRegistry();
    const writer = registry.findPaneWriter(scope, { paneId: fromPaneId });
    if (writer) registry.bindPaneWriter(scope, writer.missionId, writer.taskId, replacement);
  } catch (error) {
    console.warn('[failover-mission-respawn] vínculo pane→worktree não transferido', error);
  }
  // Orquestrador tem linha própria (moveOrchestratorPane); aqui só worker.
  if (meta.role !== 'worker') return;
  try {
    const panes = getProjectDomainStores(scope).missionPanes;
    const previous = panes.findByPaneId(fromPaneId);
    const physical = getMainOwnedPane(replacement.paneId);
    if (!previous || !physical) return;
    panes.record({
      missionId: previous.missionId,
      paneId: replacement.paneId,
      // Seleção física do Main, nunca a da linha antiga.
      adapterId: physical.entry.adapterId ?? options.adapterId,
      model: physical.entry.model ?? options.model,
      effort: options.effort,
      accountId: physical.entry.accountId,
      workerIncarnationId: physical.meta.workerIncarnationId,
      authoritySeal: physical.meta.authoritySeal,
      cwd: previous.cwd,
      title: previous.title,
      agentName: previous.agentName,
      role: 'worker',
      allowedTools: previous.allowedTools,
      allowedSkills: previous.allowedSkills,
      readOnly: previous.readOnly,
      executionScope: previous.executionScope,
      visualTask: previous.visualTask,
      operatorOpened: previous.operatorOpened,
    });
  } catch (error) {
    console.warn('[failover-mission-respawn] pane novo não gravado na composição', error);
  }
}

/**
 * F-1480: modelo e esforço com que o pane exausto rodava — a sessão física
 * primeiro (o pedido selado do Main), a linha da composição depois. Na troca
 * de CONTA, modelo que a conta nova já recusou (quarentena de acesso F-683/
 * F-765) cai no padrão do adapter, com trace — nunca um pane que nasce para
 * ser recusado de novo.
 */
function previousRuntime(
  input: { readonly paneId: string; readonly adapterId: string; readonly toAccountId?: string;
    readonly toModel?: string; readonly continuityPack?: string },
  entry: { readonly entry: { readonly model?: string }; readonly meta: PaneOrchMeta },
  sessionId: string | null,
): { readonly model?: string; readonly effort?: string } {
  if (input.continuityPack) return {};
  const physical = sessionId ? getAgentSessionInfo(sessionId) : null;
  let row: { readonly model?: string; readonly effort?: string } | null = null;
  try {
    row = entry.meta.scope
      ? getProjectDomainStores(entry.meta.scope).missionPanes.findByPaneId(input.paneId)
      : null;
  } catch {
    row = null;
  }
  const effort = physical?.effort ?? row?.effort;
  const model = physical?.requestedModel ?? entry.entry.model ?? row?.model;
  if (!model || input.toModel) return { effort };
  const refused = modelAccessQuarantine(input.adapterId, model, Date.now(),
    input.toAccountId ? { accountId: input.toAccountId } : {});
  if (!refused) return { model, effort };
  trace({
    kind: 'account-failover',
    outcome: 'model-unavailable-on-account',
    paneId: input.paneId,
    adapterId: input.adapterId,
    toAccountId: input.toAccountId ?? null,
    fromModel: model,
    toModel: null,
    reason: refused,
  });
  console.info(
    `[failover-mission-respawn] ${input.paneId}: a conta nova não oferece "${model}"; ` +
      'o pane novo nasce no modelo padrão do adapter',
  );
  return { effort };
}

/**
 * F-1480: a tarefa despachada (lease + heartbeat) passa de uma sessão para a
 * outra pelo mesmo rebind exato do worker reiniciado (CAS por tarefa e
 * revisão, sem receipt). Worker sem tarefa despachada não tem o que mover.
 * F-1512: devolve a linha movida (`known` = devolução exata à origem).
 */
function transferTaskDispatch(
  meta: PaneOrchMeta,
  from: { readonly paneId: string; readonly sessionId: string; readonly workerIncarnationId: string },
  to: { readonly paneId: string; readonly sessionId: string; readonly workerIncarnationId: string },
  known?: TaskDispatchRecord,
): TaskDispatchRecord | null {
  if (!meta.scope || !meta.missionId) return null;
  try {
    const dispatches = getProjectDomainStores(meta.scope).taskDispatches;
    const dispatch = known ?? dispatches.list(meta.missionId).find((row) =>
      row.paneId === from.paneId && row.sessionId === from.sessionId &&
      row.workerIncarnationId === from.workerIncarnationId &&
      (row.state === 'running' || row.state === 'superseded'));
    if (!dispatch) return null;
    return dispatches.rebindRestartedWorker({
      missionId: meta.missionId,
      paneId: from.paneId,
      expectedSessionId: from.sessionId,
      workerIncarnationId: from.workerIncarnationId,
      expectedTaskId: dispatch.taskId,
      expectedRevision: dispatch.revision,
      replacementSessionId: to.sessionId,
      replacementPaneId: to.paneId,
      replacementWorkerIncarnationId: to.workerIncarnationId,
      leaseMs: TRANSFERRED_DISPATCH_LEASE_MS,
    });
  } catch (error) {
    console.warn('[failover-mission-respawn] tarefa despachada não transferida entre os panes', error);
    return null;
  }
}

/** F-1512: abre o pedido repassado ao substituto (texto do Nexus ao agente). */
const RESPAWN_DELTA_PREAMBLE =
  'Request accepted by your previous pane while Nexus was switching the account ' +
  '(forwarded once; follow it together with the current task):';

/** Lease inicial da tarefa no pane novo: o heartbeat dele renova (≤ 4 min). */
const TRANSFERRED_DISPATCH_LEASE_MS = 10 * 60_000;
