/**
 * Teardown híbrido no done da missão (F-106, decisão de produto 23/08).
 *
 * Quando a missão vira 'done' o resultado já é durável no SQLite — manter o
 * runtime vivo só consome pane, memória e sessão de CLI (e pintava sinais
 * "vivos" numa missão "Pronto"). Regra híbrida (paridade Overclock 1.2.4):
 * - o ORQUESTRADOR morre no done: o resumo pós-completion é ruído e o pane
 *   não tem mais função;
 * - WORKERS ficam vivos por WORKER_POST_DONE_TTL_MS: qualquer trabalho novo
 *   (o operador mandou algo no pane → transição busy) cancela o timer; se
 *   voltar a ficar idle, o timer rearma. Sem interação, encerra sozinho.
 *
 * Fail-safe por construção:
 * - opt-out via feature.mission.doneTeardown (default ON; E2E real-mission
 *   que ancora workers a PTYs físicos vivos desliga por override de flag,
 *   mesmo raciocínio do feature.mission.workerHandoffTtl);
 * - só age em transições OBSERVADAS neste processo (diff do broadcast de
 *   missões): seed/replay de missão antiga já done nunca é tocado;
 * - nunca toca panes sem role de missão (shells do usuário);
 * - o fechamento usa requestMissionPaneClose com a identidade física exata
 *   (pane+session+incarnation), a mesma autoridade do teardown da missão;
 * - qualquer condição que mude entre armar e disparar re-avalia do zero.
 */

import type { Mission, PaneSnapshot } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import { tapSessionExit } from '../pty/pty-manager';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  getPaneRuntimeAuthorityBySession,
  listPaneSnapshots,
  requestMissionPaneClose,
  type MissionPaneCloseRequest,
  type PaneRuntimeAuthority,
} from './pane-registry';
import { getProjectDomainStores } from './project-domain-store-registry';
import { sameProjectScope } from './project-scoped-broadcast';
import { isSessionInjectableIdle, tapAgentSemanticStatus } from './agent-status';

/** 30 segundos — paridade Overclock 1.2.4: janela de reutilização pós-done. */
export const WORKER_POST_DONE_TTL_MS = 30_000;

export type MissionBroadcastTap = (
  scopeKey: string,
  missions: readonly Mission[],
) => void;

export interface MissionDoneTeardownDeps {
  readonly isEnabled: () => boolean;
  /** Tap do broadcast de missões (vive no orch-ipc; injetado no init). */
  readonly tapMissions: (cb: MissionBroadcastTap) => () => void;
  readonly parseScope: (scopeKey: string) => ProjectExecutionScope | null;
  readonly listMissionPanes: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => readonly PaneSnapshot[];
  readonly getAuthority: (sessionId: string) => PaneRuntimeAuthority | null;
  readonly missionStatus: (
    scope: ProjectExecutionScope,
    missionId: string,
  ) => string | null;
  readonly isIdle: (sessionId: string) => boolean;
  readonly closePane: (
    request: MissionPaneCloseRequest,
  ) => Promise<boolean> | boolean;
  readonly ttlMs: number;
  readonly log: (message: string) => void;
}

/** Deps de produção, exceto o tap de broadcast (composição no orch-ipc). */
export function productionMissionDoneTeardownDeps(): Omit<
  MissionDoneTeardownDeps,
  'tapMissions'
> {
  return {
    isEnabled: () =>
      getFeatureFlagRegistry().isEnabled(
        FEATURE_FLAG_IDS.missionDoneTeardown,
      ),
    parseScope: (scopeKey) => {
      try {
        return JSON.parse(scopeKey) as ProjectExecutionScope;
      } catch {
        return null;
      }
    },
    listMissionPanes: (scope, missionId) =>
      listPaneSnapshots().filter(
        (pane) =>
          pane.missionId === missionId &&
          Boolean(pane.scope && sameProjectScope(pane.scope, scope)),
      ),
    getAuthority: (sessionId) => getPaneRuntimeAuthorityBySession(sessionId),
    missionStatus: (scope, missionId) =>
      getProjectDomainStores(scope).missions.get(missionId)?.status ?? null,
    isIdle: (sessionId) => isSessionInjectableIdle(sessionId),
    closePane: (request) => requestMissionPaneClose(request),
    ttlMs: WORKER_POST_DONE_TTL_MS,
    log: (message) => console.warn(`[mission-done-teardown] ${message}`),
  };


}

const armed = new Map<string, ReturnType<typeof setTimeout>>();
/** Último status visto por missão (escopo|missão) — diff do broadcast. */
const lastStatusByMission = new Map<string, string>();
let untapMissions: (() => void) | null = null;
let untapStatus: (() => void) | null = null;
let untapExit: (() => void) | null = null;

function cancelTimer(sessionId: string): void {
  const timer = armed.get(sessionId);
  if (timer) clearTimeout(timer);
  armed.delete(sessionId);
}

/** Worker idle de missão done: re-avalia tudo do zero (armar E disparar). */
function workerIsClosablePostDone(
  deps: MissionDoneTeardownDeps,
  sessionId: string,
): PaneRuntimeAuthority | null {
  if (!deps.isEnabled()) return null;
  if (!deps.isIdle(sessionId)) return null;
  const authority = deps.getAuthority(sessionId);
  if (!authority) return null;
  if (authority.role !== 'worker') return null;
  if (!authority.missionId || !authority.scope) return null;
  if (authority.sessionId !== sessionId) return null;
  if (deps.missionStatus(authority.scope, authority.missionId) !== 'done') {
    return null;
  }
  return authority;
}

function armTimer(deps: MissionDoneTeardownDeps, sessionId: string): void {
  if (armed.has(sessionId)) return;
  const timer = setTimeout(() => {
    armed.delete(sessionId);
    const authority = workerIsClosablePostDone(deps, sessionId);
    if (!authority) return;
    deps.log(
      `encerrando worker idle pós-done ` +
        `(pane=${authority.paneId}, session=${sessionId}, ` +
        `mission=${authority.missionId})`,
    );
    void Promise.resolve(
      deps.closePane({
        paneId: authority.paneId,
        missionId: authority.missionId!,
        scope: authority.scope!,
        ...(authority.sessionId ? { sessionId: authority.sessionId } : {}),
        role: 'worker',
        ...(authority.workerIncarnationId
          ? { workerIncarnationId: authority.workerIncarnationId }
          : {}),
      }),
    ).then(
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

/** Done observado: orquestrador morre já; workers idle armam o TTL. */
function handleMissionDone(
  deps: MissionDoneTeardownDeps,
  scope: ProjectExecutionScope,
  missionId: string,
): void {
  if (!deps.isEnabled()) return;
  for (const pane of deps.listMissionPanes(scope, missionId)) {
    if (pane.role === 'orchestrator') {
      deps.log(
        `encerrando orquestrador no done ` +
          `(pane=${pane.paneId}, mission=${missionId})`,
      );
      void Promise.resolve(
        deps.closePane({
          paneId: pane.paneId,
          missionId,
          scope: pane.scope ?? scope,
          ...(pane.sessionId ? { sessionId: pane.sessionId } : {}),
          role: 'orchestrator',
        }),
      ).then(
        (closed) => {
          if (!closed) {
            deps.log(
              `fechamento do orquestrador recusado pela autoridade ` +
                `(pane=${pane.paneId}, mission=${missionId})`,
            );
          }
        },
        (error) => {
          deps.log(
            `falha ao encerrar orquestrador (pane=${pane.paneId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        },
      );
      continue;
    }
    if (pane.role === 'worker' && pane.sessionId && deps.isIdle(pane.sessionId)) {
      if (workerIsClosablePostDone(deps, pane.sessionId)) {
        armTimer(deps, pane.sessionId);
      }
    }
  }
}

function handleMissionsBroadcast(
  deps: MissionDoneTeardownDeps,
  scopeKey: string,
  missions: readonly Mission[],
): void {
  for (const mission of missions) {
    const key = `${scopeKey}|${mission.id}`;
    const previous = lastStatusByMission.get(key);
    lastStatusByMission.set(key, mission.status);
    // Só transição observada neste processo: seed/replay (previous ===
    // undefined) nunca dispara teardown em missão antiga já done.
    if (previous === undefined || previous === 'done') continue;
    if (mission.status !== 'done') continue;
    const scope = deps.parseScope(scopeKey);
    if (!scope) continue;
    handleMissionDone(deps, scope, mission.id);
  }
}

export function initMissionDoneTeardown(
  deps: MissionDoneTeardownDeps,
): void {
  if (untapMissions) return;
  untapMissions = deps.tapMissions((scopeKey, missions) =>
    handleMissionsBroadcast(deps, scopeKey, missions),
  );
  untapStatus = tapAgentSemanticStatus((entry) => {
    if (entry.status === 'idle' || entry.status === 'completed') {
      if (workerIsClosablePostDone(deps, entry.sessionId)) {
        armTimer(deps, entry.sessionId);
      }
      return;
    }
    // Qualquer trabalho novo (o operador mandou algo no pane) cancela.
    cancelTimer(entry.sessionId);
  });
  untapExit = tapSessionExit((sessionId) => {
    cancelTimer(sessionId);
  });
}

export function shutdownMissionDoneTeardown(): void {
  untapMissions?.();
  untapMissions = null;
  untapStatus?.();
  untapStatus = null;
  untapExit?.();
  untapExit = null;
  for (const sessionId of [...armed.keys()]) cancelTimer(sessionId);
  lastStatusByMission.clear();
}
