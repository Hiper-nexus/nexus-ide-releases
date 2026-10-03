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

import { execFileSync } from 'node:child_process';
import type { PaneSpawnOptions } from './main-owned-pane-runtime';
import type { PaneOrchMeta } from './main-owned-pane-runtime';
import { getMainOwnedPane } from './main-owned-pane-runtime';
import { spawnMainOwnedMissionPaneAsync } from './pane-registry';
import { orchTerminateSession } from '../pty/pty-manager';
import {
  buildContinuityPack,
  type ContinuityPackInput,
} from '../../shared/failover-handoff';
import { collectFilesModified } from './worker-files-modified';

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
  /** Pré-coletados (testes / chamador que já tem); senão coleta do cwd. */
  readonly touchedFiles?: readonly string[];
  readonly diffStat?: string;
  /** cwd do pane antigo para `git status`/`diff --stat`. */
  readonly cwd?: string;
  readonly toAccountLabel?: string;
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

function collectGitTaskState(cwd: string | undefined): {
  touchedFiles: string[];
  diffStat: string | undefined;
} {
  if (!cwd) return { touchedFiles: [], diffStat: undefined };
  let touchedFiles: string[] = [];
  try {
    touchedFiles = collectFilesModified(cwd);
  } catch {
    touchedFiles = [];
  }
  let diffStat: string | undefined;
  try {
    diffStat = execFileSync(
      'git',
      ['-C', cwd, 'diff', '--stat'],
      { encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    diffStat = undefined;
  }
  return {
    touchedFiles,
    diffStat: diffStat ? diffStat : undefined,
  };
}

function resolveGitState(input: MainOwnedFailoverPlanInput): {
  touchedFiles: readonly string[] | undefined;
  diffStat: string | undefined;
} {
  if (input.touchedFiles !== undefined || input.diffStat !== undefined) {
    return {
      touchedFiles: input.touchedFiles,
      diffStat: input.diffStat,
    };
  }
  const cwd =
    input.cwd ??
    input.meta?.executionScope?.rootRealPath ??
    input.meta?.scope?.rootRealPath;
  return collectGitTaskState(cwd);
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
  const initialPrompt = input.toModel
    ? `O modelo anterior foi rejeitado pelo provider. ` +
      `Você foi religado automaticamente no modelo "${input.toModel}" — ` +
      `continuar a tarefa de onde parou, sem repetir trabalho já entregue.`
    : buildCrossAccountPack(input, meta);
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
      initialPrompt,
    },
  };
}

function buildCrossAccountPack(
  input: MainOwnedFailoverPlanInput,
  meta: PaneOrchMeta,
): string {
  const git = resolveGitState(input);
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
    scrollbackExcerpt: input.scrollbackExcerpt,
    touchedFiles: git.touchedFiles,
    diffStat: git.diffStat,
  };
  return buildContinuityPack(packInput);
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
  readonly cwd?: string;
  readonly toAccountLabel?: string;
}): Promise<boolean> {
  const entry = getMainOwnedPane(input.paneId);
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
    touchedFiles: input.touchedFiles,
    diffStat: input.diffStat,
    cwd: input.cwd,
    toAccountLabel: input.toAccountLabel,
  });
  if (plan.action === 'skip') {
    console.info(
      `[failover-mission-respawn] pulou ${input.paneId}: ${plan.reason}`,
    );
    return false;
  }
  if (input.sessionId) {
    try {
      await orchTerminateSession(input.sessionId, {
        origin: 'failover-respawn',
      });
    } catch {
      // Sessão já morta: o alvo do respawn é o novo processo.
    }
  }
  const spawned = await spawnMainOwnedMissionPaneAsync(plan.options);
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
