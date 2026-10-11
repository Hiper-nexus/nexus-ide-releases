/**
 * Failover de CONTA em panes de missão main-owned (2026-08-16).
 *
 * O pipeline de failover (detectLimit → performSwitch → emitFailover) já
 * escolhe a próxima conta e emite o evento — mas o ÚNICO consumidor era o
 * renderer (failover-controller), que só age em panes do layout dele.
 * Workers headless/main-owned de missão morriam no limite sem NUNCA trocar
 * de conta: o pane morria, a missão sentia como exit comum. Este módulo é o
 * consumidor do lado do Main: mata a sessão exausta e respawna o MESMO
 * agente da MESMA missão com a nova conta pinada e o pacote de continuidade
 * estruturado (F-775) como initialPrompt.
 */

import { recoveryTriggerClass, scheduleRecoveryAdvice } from './jev-mission-advisor';
import fs from 'node:fs';
import path from 'node:path';
import type { PaneSpawnOptions } from './main-owned-pane-runtime';
import type { PaneOrchMeta } from './main-owned-pane-runtime';
import { getMainOwnedPane } from './main-owned-pane-runtime';
import { spawnMainOwnedMissionPaneAsync } from './pane-registry';
import { orchTerminateSession } from '../pty/pty-manager';
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
import { getPaneTaskReroute } from './pane-task-reroute';
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
      model: input.toModel,
      missionId: meta.missionId,
      role: meta.role,
      agentName: meta.agentName,
      cwd: undefined,
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
 * Executor: mata a sessão exausta (se ainda viva) e respawna o agente
 * main-owned com a nova conta. Devolve false quando não é pane de missão
 * main-owned ou quando o spawn recusa (autoridade stale etc.) — nesses casos
 * o evento de failover segue para o renderer como sempre.
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
  const plan = planMainOwnedFailoverRespawn({
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
  if (input.sessionId) {
    try {
      const terminated = await orchTerminateSession(input.sessionId, {
        origin: 'failover-respawn',
      });
      if (terminated !== true) return false;
    } catch {
      // An absent session already returns true. A rejection is not proof
      // that its processes exited and must never start a replacement.
      return false;
    }
  }
  if (!isCurrent()) return false;
  const spawned = await spawnMainOwnedMissionPaneAsync({
    ...plan.options,
    assertOriginCurrent: () => {
      if (!isCurrent()) throw new Error('failover origin pane is stale');
    },
  });
  if (!spawned.ok) {
    console.warn(
      `[failover-mission-respawn] respawn recusado para ${input.paneId}: ` +
        `${spawned.error}`,
    );
    return false;
  }
  console.info(
    `[failover-mission-respawn] ${input.paneId} religou na conta ` +
      `${input.toAccountId ?? 'nativa'} (novo pane ${spawned.paneId}, ` +
      `session ${spawned.sessionId})`,
  );
  return true;
}
