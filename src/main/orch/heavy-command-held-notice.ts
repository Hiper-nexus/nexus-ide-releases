import type { ProjectExecutionScope } from '../../shared/types';
import type { HeavyExclusiveHeldReport } from './heavy-command-permit';

/**
 * Tells the Maestro of every mission involved (holder and waiters) that an
 * exclusive build/install keeps its root while heavy commands queue behind
 * it. Visibility only: the slot stays exclusive (F-983), nothing is killed.
 * Missions come from the Main-owned session info, never from the request.
 */
export interface HeavyHeldNoticePorts {
  session(sessionId: string): { readonly missionId?: string; readonly scope: ProjectExecutionScope;
    readonly coordinationScope?: ProjectExecutionScope } | null | undefined;
  missionRunning(scope: ProjectExecutionScope, missionId: string): boolean;
  submit(scope: ProjectExecutionScope, missionId: string, summary: string): void;
}

/** pt-BR, ids and counts only; the label already passed the heavy-command allowlist. */
export function exclusiveHeldNoticeText(report: HeavyExclusiveHeldReport): string {
  const minutes = Math.max(1, Math.round(report.heldMs / 60_000));
  const what = report.label ? `${report.kind} (${report.label})` : report.kind;
  const who = report.paneId ? ` do pane ${report.paneId}` : '';
  return `[fila-pesada] ${what}${who} segura a vaga exclusiva desta raiz há ${minutes} min, com ${report.waiting} comando(s) pesado(s) esperando atrás. ` +
    'A vaga continua exclusiva (build e install compartilham saídas): confira se ele ainda progride; se travou, interrompa-o. ' +
    'Enquanto isso, adiante o que não precisa de build.';
}

export function deliverExclusiveHeldNotice(report: HeavyExclusiveHeldReport, ports: HeavyHeldNoticePorts): number {
  const targets = new Map<string, { scope: ProjectExecutionScope; missionId: string }>();
  for (const sessionId of [report.sessionId, ...report.waitingSessionIds]) {
    if (!sessionId) continue;
    const info = ports.session(sessionId);
    if (!info?.missionId) continue;
    // F-1006: mission stores live in the coordination checkout, not the worktree.
    const scope = info.coordinationScope ?? info.scope;
    targets.set(JSON.stringify([scope.installationId, scope.projectId, scope.rootRealPath, info.missionId]),
      { scope, missionId: info.missionId });
  }
  const summary = exclusiveHeldNoticeText(report);
  let delivered = 0;
  for (const { scope, missionId } of targets.values()) {
    try {
      if (!ports.missionRunning(scope, missionId)) continue;
      ports.submit(scope, missionId, summary);
      delivered += 1;
    } catch { /* One mission's store must not silence the others. */ }
  }
  return delivered;
}

/** Production ports load lazily: the permit pool sits below idle delivery in the import graph. */
export async function deliverExclusiveHeldNoticeInMain(report: HeavyExclusiveHeldReport): Promise<void> {
  const [{ getAgentSessionInfo }, { getProjectDomainStores }, { onHandoffSubmitted }, { DELEGATION_SUPERVISOR_AGENT }] = await Promise.all([
    import('../pty/pty-manager'), import('./project-domain-store-registry'), import('./idle-delivery'), import('./delegation-supervisor'),
  ]);
  deliverExclusiveHeldNotice(report, {
    session: getAgentSessionInfo,
    missionRunning: (scope, missionId) => getProjectDomainStores(scope).missions.get(missionId)?.status === 'running',
    submit: (scope, missionId, summary) => {
      const handoff = getProjectDomainStores(scope).handoffs.submit({ missionId, status: 'progress', summary,
        fromAgent: DELEGATION_SUPERVISOR_AGENT });
      onHandoffSubmitted(handoff, scope);
    },
  });
}
