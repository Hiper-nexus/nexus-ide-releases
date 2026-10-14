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
import { getMainOwnedPane } from './main-owned-pane-runtime';
import { spawnMainOwnedMissionPaneAsync } from './pane-registry';
import { getAgentSessionInfo, getSessionCwd, orchTerminateSession } from '../pty/pty-manager';
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
  if (!nativeResumeImpossible(input)) {
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
  };
  return buildContinuityPack(packInput);
}

/**
 * ORC-05: o respawn main-owned é SEMPRE sessão nova. Troca de CLI (pack
 * pronto) e troca de conta (ids de sessão do provider são da conta) não têm
 * como retomar a conversa nativa; só a rotação de modelo F-520 (mesma conta,
 * mesma CLI) fica de fora do recorte.
 */
export function nativeResumeImpossible(
  input: Pick<MainOwnedFailoverPlanInput, 'continuityPack' | 'toModel'>,
): boolean {
  return Boolean(input.continuityPack) || !input.toModel;
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
}, deps: { readonly git?: AsyncGitRunner } = {}): Promise<boolean> {
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
  const plan = planMainOwnedFailoverRespawn({
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
  });
  if (plan.action === 'skip') {
    console.info(
      `[failover-mission-respawn] pulou ${input.paneId}: ${plan.reason}`,
    );
    return false;
  }
  // Worker governado ganha geração física NOVA, nunca a do processo exausto.
  const replacementIncarnationId = entry.meta.workerIncarnationId ? makeId('workerinc') : undefined;
  const spawnReplacement = () => spawnMainOwnedMissionPaneAsync({
    ...plan.options,
    ...(replacementIncarnationId ? { workerIncarnationId: replacementIncarnationId } : {}),
    assertOriginCurrent: () => {
      if (!isCurrent()) throw new Error('failover origin pane is stale');
    },
  });
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
      plan.options.role === 'worker' ? await spawnReplacement() : null;
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
    replaced = true;
    const replacement = spawned.paneId && spawned.sessionId
      ? { paneId: spawned.paneId, sessionId: spawned.sessionId }
      : null;
    if (replacement) {
      adoptReplacementLineage(input.paneId, entry.meta, plan.options, replacement);
    }
    if (!retireRequested && !(await retireExhausted())) {
      // O pane novo já trabalha; a sessão exausta fica inerte e registrada
      // até a prova física (o reconciliador tenta de novo).
      console.warn(
        `[failover-mission-respawn] sessão exausta ${input.sessionId} sem prova ` +
          `de saída; o pane novo ${spawned.paneId} segue`,
      );
    }
    // A tarefa despachada segue o pane novo depois que a sessão exausta saiu
    // (ou ficou inerte): lease e heartbeat passam à sessão/encarnação novas.
    if (replacement && expectedSessionId && entry.meta.workerIncarnationId && replacementIncarnationId) {
      transferTaskDispatch(entry.meta, {
        paneId: input.paneId,
        sessionId: expectedSessionId,
        workerIncarnationId: entry.meta.workerIncarnationId,
      }, { ...replacement, workerIncarnationId: replacementIncarnationId });
    }
    console.info(
      `[failover-mission-respawn] ${input.paneId} religou na conta ` +
        `${input.toAccountId ?? 'nativa'} (novo pane ${spawned.paneId}, ` +
        `session ${spawned.sessionId})`,
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
 * F-1480: a tarefa despachada (lease + heartbeat) passa da sessão exausta
 * para a nova pelo mesmo rebind exato do worker reiniciado (CAS por tarefa e
 * revisão, sem receipt). Worker sem tarefa despachada não tem o que mover.
 */
function transferTaskDispatch(
  meta: PaneOrchMeta,
  from: { readonly paneId: string; readonly sessionId: string; readonly workerIncarnationId: string },
  to: { readonly paneId: string; readonly sessionId: string; readonly workerIncarnationId: string },
): void {
  if (!meta.scope || !meta.missionId) return;
  try {
    const dispatches = getProjectDomainStores(meta.scope).taskDispatches;
    const dispatch = dispatches.list(meta.missionId).find((row) =>
      row.paneId === from.paneId && row.sessionId === from.sessionId &&
      row.workerIncarnationId === from.workerIncarnationId &&
      (row.state === 'running' || row.state === 'superseded'));
    if (!dispatch) return;
    dispatches.rebindRestartedWorker({
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
    console.warn('[failover-mission-respawn] tarefa despachada não transferida ao pane novo', error);
  }
}

/** Lease inicial da tarefa no pane novo: o heartbeat dele renova (≤ 4 min). */
const TRANSFERRED_DISPATCH_LEASE_MS = 10 * 60_000;
