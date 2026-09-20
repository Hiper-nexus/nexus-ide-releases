/**
 * Failover de CONTA em panes de missão main-owned (2026-08-16).
 *
 * O pipeline de failover (detectLimit → performSwitch → emitFailover) já
 * escolhe a próxima conta e emite o evento — mas o ÚNICO consumidor era o
 * renderer (failover-controller), que só age em panes do layout dele.
 * Workers headless/main-owned de missão morriam no limite sem NUNCA trocar
 * de conta: o pane morria, a missão sentia como exit comum. Este módulo é o
 * consumidor do lado do Main: mata a sessão exausta e respawna o MESMO
 * agente da MESMA missão com a nova conta pinada e nota de continuidade.
 */

import type { PaneSpawnOptions } from './main-owned-pane-runtime';
import type { PaneOrchMeta } from './main-owned-pane-runtime';
import { getMainOwnedPane } from './main-owned-pane-runtime';
import { spawnMainOwnedMissionPaneAsync } from './pane-registry';
import { orchTerminateSession } from '../pty/pty-manager';

export interface MainOwnedFailoverPlanInput {
  readonly adapterId: string;
  readonly meta: PaneOrchMeta | null;
  readonly toAccountId: string;
  readonly fromAccountLabel: string;
  readonly reason: string;
  /**
   * F-520: failover de MODELO (mesma conta) — modelo alternativo escolhido
   * pelo main quando o provider rejeitou o id anterior. Ausente = failover
   * de conta (o respawn já nasce no default do adapter).
   */
  readonly toModel?: string;
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

/**
 * Planeamento puro do respawn: mesmo adapter, mesma missão, mesmo papel,
 * MESMO selo de autoridade (o contexto da missão não mudou — só a conta
 * física), conta NOVA pinada e encarnação NOVA (o processo antigo morreu no
 * limite; herdar o incarnationId mentiria a prova de dedup do handoff).
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
    : `A conta "${input.fromAccountLabel}" bateu o limite (${input.reason}). ` +
      `Você foi religado automaticamente na conta reserva — continuar a tarefa ` +
      `de onde parou, sem repetir trabalho já entregue.`;
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
  readonly toAccountId: string;
  readonly fromAccountLabel: string;
  readonly reason: string;
  /** F-520: failover de modelo — mesma conta, modelo alternativo. */
  readonly toModel?: string;
}): Promise<boolean> {
  const entry = getMainOwnedPane(input.paneId);
  const plan = planMainOwnedFailoverRespawn({
    adapterId: input.adapterId,
    meta: entry?.meta ?? null,
    toAccountId: input.toAccountId,
    fromAccountLabel: input.fromAccountLabel,
    reason: input.reason,
    toModel: input.toModel,
  });
  if (plan.action === 'skip') {
    console.info(
      `[failover-mission-respawn] pulou ${input.paneId}: ${plan.reason}`,
    );
    return false;
  }
  if (input.sessionId) {
    try {
      await orchTerminateSession(input.sessionId);
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
    `[failover-mission-respawn] ${input.paneId} trocou para a conta ` +
    `${input.toAccountId} (novo pane ${spawned.paneId}, ` +
    `session ${spawned.sessionId})`,
  );
  return true;
}
