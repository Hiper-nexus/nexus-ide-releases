/**
 * Worker TTL pós-handoff (paridade Bridge 1.2.4).
 *
 * O modelo fecha workers ~30s após um handoff limpo: o resultado já é
 * durável no SQLite, então manter o PTY vivo só consome pane, memória e
 * contexto visual. Aqui, um worker da missão que entregou TODOS os seus
 * handoffs (delivery_state='consumed') e ficou idle é encerrado após
 * WORKER_POST_HANDOFF_TTL_MS — a menos que volte a trabalhar (qualquer
 * transição busy cancela o timer) ou que a missão saia de 'running' (a
 * máquina de encerramento da missão passa a ser a dona).
 *
 * Fail-safe por construção:
 * - gate feature.mission.workerHandoffTtl, DEFAULT-ON desde 568c1324 (flag
 *   em shared/feature-flags.ts); o opt-out por override existe para o e2e
 *   real-mission, que ancora workers a PTYs físicos vivos, mesmo raciocínio do
 *   feature.mission.warmupAdvisories. Fechar é definitivo (sem hibernação):
 *   quem reaproveita o worker depois do TTL abre outro pane;
 * - nunca toca orchestrator/user panes;
 * - o fechamento usa requestMissionPaneClose com a identidade física exata
 *   (pane+session+incarnation), a mesma autoridade do teardown da missão;
 * - qualquer condição que mude entre armar e disparar re-avalia do zero.
 */

import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { tapSessionExit } from '../pty/pty-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getPaneRuntimeAuthorityBySession,
  requestMissionPaneClose,
  type PaneRuntimeAuthority,
} from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  isSessionInjectableIdle,
  tapAgentSemanticStatus,
  tapAgentTurnStart,
} from './agent-status';

/** 30 segundos — paridade Overclock 1.2.4: liberta pane sem matar reutilização. */
export const WORKER_POST_HANDOFF_TTL_MS = 30_000;

export interface WorkerHandoffTtlDeps {
  readonly isEnabled: () => boolean;
  readonly getAuthority: (sessionId: string) => PaneRuntimeAuthority | null;
  readonly listHandoffs: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => readonly Handoff[];
  readonly missionStatus: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => string | null;
  readonly isIdle: (sessionId: string) => boolean;
  readonly closePane: (
    authority: PaneRuntimeAuthority,
  ) => Promise<boolean> | boolean;
  readonly ttlMs: number;
  readonly log: (message: string) => void;
}

function productionDeps(): WorkerHandoffTtlDeps {
  return {
    isEnabled: () =>
      getFeatureFlagRegistry().isEnabled(
        FEATURE_FLAG_IDS.missionWorkerHandoffTtl,
      ),
    getAuthority: (sessionId) => getPaneRuntimeAuthorityBySession(sessionId),
    listHandoffs: (scope, missionId) =>
      getProjectDomainStores(scope).handoffs.list({
        missionId,
        includeDelivered: true,
      }),
    missionStatus: (scope, missionId) =>
      getProjectDomainStores(scope).missions.get(missionId)?.status ?? null,
    isIdle: (sessionId) => isSessionInjectableIdle(sessionId),
    closePane: (authority) =>
      requestMissionPaneClose({
        paneId: authority.paneId,
        missionId: authority.missionId!,
        scope: authority.scope!,
        ...(authority.sessionId ? { sessionId: authority.sessionId } : {}),
        role: 'worker',
        ...(authority.workerIncarnationId
          ? { workerIncarnationId: authority.workerIncarnationId }
          : {}),
      }),
    ttlMs: WORKER_POST_HANDOFF_TTL_MS,
    log: (message) => console.warn(`[worker-ttl] ${message}`),
  };
}

/** Handoffs do worker ainda não consumidos pelo orquestrador. */
function workerHandoffs(
  deps: WorkerHandoffTtlDeps,
  authority: PaneRuntimeAuthority,
): readonly Handoff[] {
  if (!authority.scope || !authority.missionId) return [];
  return deps
    .listHandoffs(authority.scope, authority.missionId)
    .filter((handoff) => handoff.sessionId === authority.sessionId);
}

/** Último início de trabalho observado por sessão (turno novo ou `working`). */
const lastWorkStartedAt = new Map<string, number>();

function noteWorkStarted(sessionId: string, at: number): void {
  const previous = lastWorkStartedAt.get(sessionId);
  if (previous === undefined || at > previous) lastWorkStartedAt.set(sessionId, at);
}

/**
 * "Handoff limpo": o worker entregou ao menos um handoff, NENHUM segue
 * pendente de consumo e ele não começou trabalho depois do último consumo.
 * Um handoff ainda queued/submitted significa que o orquestrador ainda não
 * processou o resultado. F-690: o Maestro reaproveita o helper que entregou
 * (`nexus_pane_write` segundos depois do consumo); o handoff antigo continua
 * `consumed`, e na primeira pausa do trabalho novo o TTL o matava — "encerrou
 * sem entregar", três vezes em 29/09. Reaproveitado, ele só fecha depois de
 * entregar de novo.
 */
function hasCleanHandoff(
  deps: WorkerHandoffTtlDeps,
  authority: PaneRuntimeAuthority,
): boolean {
  const mine = workerHandoffs(deps, authority);
  if (mine.length === 0) return false;
  if (!mine.every((handoff) => handoff.deliveryState === 'consumed')) return false;
  const settledAt = Math.max(
    ...mine.map((handoff) => handoff.consumedAt ?? handoff.createdAt),
  );
  const workAt = authority.sessionId
    ? lastWorkStartedAt.get(authority.sessionId)
    : undefined;
  return workAt === undefined || workAt <= settledAt;
}

/** Re-avalia todas as condições do zero — usado ao armar E ao disparar. */
function workerIsClosable(
  deps: WorkerHandoffTtlDeps,
  sessionId: string,
): PaneRuntimeAuthority | null {
  if (!deps.isEnabled()) return null;
  if (!deps.isIdle(sessionId)) return null;
  const authority = deps.getAuthority(sessionId);
  if (!authority) return null;
  if (authority.role !== 'worker') return null;
  // F-231: pane aberto pelo operador nunca expira — a mão é dele.
  if (authority.operatorOpened === true) return null;
  if (!authority.missionId || !authority.scope) return null;
  if (authority.sessionId !== sessionId) return null;
  // Missão fora de 'running' pertence à máquina de encerramento da missão.
  if (deps.missionStatus(authority.scope, authority.missionId) !== 'running') {
    return null;
  }
  if (!hasCleanHandoff(deps, authority)) return null;
  return authority;
}

const armed = new Map<string, ReturnType<typeof setTimeout>>();
let untapStatus: (() => void) | null = null;
let untapTurnStart: (() => void) | null = null;
let untapExit: (() => void) | null = null;

function cancelTimer(sessionId: string): void {
  const timer = armed.get(sessionId);
  if (timer) clearTimeout(timer);
  armed.delete(sessionId);
}

function armTimer(deps: WorkerHandoffTtlDeps, sessionId: string): void {
  if (armed.has(sessionId)) return;
  const timer = setTimeout(() => {
    armed.delete(sessionId);
    const authority = workerIsClosable(deps, sessionId);
    if (!authority) return;
    deps.log(
      `encerrando worker idle com handoff limpo ` +
        `(pane=${authority.paneId}, session=${sessionId}, ` +
        `mission=${authority.missionId})`,
    );
    void Promise.resolve(deps.closePane(authority)).then(
      (closed) => {
        if (!closed) {
          deps.log(
            `fechamento recusado pela autoridade do pane ` +
              `(pane=${authority.paneId}, session=${sessionId})`,
          );
        }
      },
      (error) => {
        deps.log(
          `falha ao encerrar worker (session=${sessionId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  }, deps.ttlMs);
  if (typeof timer.unref === 'function') timer.unref();
  armed.set(sessionId, timer);
}

export function initWorkerHandoffTtl(
  deps: WorkerHandoffTtlDeps = productionDeps(),
): void {
  if (untapStatus) return;
  untapStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status === 'working') {
      noteWorkStarted(entry.sessionId, entry.updatedAt ?? Date.now());
    }
    if (entry.status === 'idle' || entry.status === 'completed') {
      if (workerIsClosable(deps, entry.sessionId)) {
        armTimer(deps, entry.sessionId);
      }
      return;
    }
    // Qualquer trabalho novo (working etc.) cancela o encerramento.
    cancelTimer(entry.sessionId);
  });
  // Cada submissão nativa conta, mesmo com o pane já em `working` (sem
  // transição de status para o tap acima ver).
  untapTurnStart = tapAgentTurnStart((entry) => {
    noteWorkStarted(entry.sessionId, entry.observedAt);
    cancelTimer(entry.sessionId);
  });
  untapExit = tapSessionExit((sessionId) => {
    cancelTimer(sessionId);
    lastWorkStartedAt.delete(sessionId);
  });
}

export function shutdownWorkerHandoffTtl(): void {
  untapStatus?.();
  untapStatus = null;
  untapTurnStart?.();
  untapTurnStart = null;
  untapExit?.();
  untapExit = null;
  lastWorkStartedAt.clear();
  for (const sessionId of [...armed.keys()]) cancelTimer(sessionId);
}
