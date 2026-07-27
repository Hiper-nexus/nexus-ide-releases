import { hasCurrentDispatchAuthority } from '../../shared/mission-intent';
import type { Mission } from '../../shared/orch-types';
import {
  getAgentSessionInfo,
  tapSessionExit,
  type OwnedAgentSessionInfo,
  type SessionExitTap,
} from '../pty/pty-manager';
import { hashMissionIntentContract } from './mission-pane-authority';
import { sanitizeMissionOrchestratorExitOutput } from './mission-orchestrator-exit-policy';
import { readSessionOutput } from './pane-session-output';
import {
  getProjectDomainStores,
  requireProjectDomainStoreRegistry,
} from './project-domain-store-registry';
import { sameProjectScope } from './project-scoped-broadcast';
import type {
  OrchestratorPreDispatchExitInput,
  ScopedMissionStore,
} from './mission-store';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OUTPUT_UNAVAILABLE =
  '[saída indisponível; a ausência física da sessão foi comprovada pelo Nexus]';

export const MISSION_ORCHESTRATOR_EXIT_RECONCILE_MS = 1_000;

interface MissionOrchestratorExitStores {
  readonly scope: OwnedAgentSessionInfo['scope'];
  readonly missions: Pick<
    ScopedMissionStore,
    'list' | 'blockOrchestratorPreDispatchExit'
  >;
  readonly taskDispatches?: {
    list(missionId?: string): Array<{ readonly intentVersion: number }>;
  };
}

interface PendingOrchestratorExit {
  readonly scope: OwnedAgentSessionInfo['scope'];
  readonly input: OrchestratorPreDispatchExitInput;
}

export interface MissionOrchestratorExitLifecycleDeps {
  readonly tapExit: (tap: SessionExitTap) => () => void;
  readonly getStores: (
    scope: OwnedAgentSessionInfo['scope'],
  ) => MissionOrchestratorExitStores;
  readonly listStores: () => readonly MissionOrchestratorExitStores[];
  readonly getAgentSessionInfo: (
    sessionId: string,
  ) => OwnedAgentSessionInfo | null;
  readonly readOutput: (sessionId: string, lines?: number) => string;
  readonly warn: (message: string, error: unknown) => void;
}

const productionDeps: MissionOrchestratorExitLifecycleDeps = {
  tapExit: tapSessionExit,
  getStores: getProjectDomainStores,
  listStores: () => requireProjectDomainStoreRegistry().listSuites(),
  getAgentSessionInfo,
  readOutput: readSessionOutput,
  warn: (message, error) => console.warn(message, error),
};

let disposeExitTap: (() => void) | null = null;
const pendingExitTombstones = new Map<string, PendingOrchestratorExit>();

function exitKey(
  scope: Readonly<OwnedAgentSessionInfo['scope']>,
  input: Pick<
    OrchestratorPreDispatchExitInput,
    'missionId' | 'orchestratorSessionId' | 'intentVersion'
  >,
): string {
  return [
    scope.installationId,
    scope.projectId,
    scope.checkoutId,
    scope.rootRealPath,
    input.missionId,
    input.intentVersion,
    input.orchestratorSessionId,
  ].join('\0');
}

function rememberExit(pending: PendingOrchestratorExit): string {
  const key = exitKey(pending.scope, pending.input);
  const existing = pendingExitTombstones.get(key);
  if (
    existing &&
    existing.input.observation === 'physical_exit' &&
    pending.input.observation === 'missing_session_reconcile'
  ) {
    return key;
  }
  pendingExitTombstones.set(key, Object.freeze({
    scope: Object.freeze({ ...pending.scope }),
    input: Object.freeze({ ...pending.input }),
  }));
  return key;
}

type ExitPersistenceOutcome = 'blocked' | 'resolved' | 'retry';

function persistPendingExit(
  key: string,
  pending: PendingOrchestratorExit,
  deps: MissionOrchestratorExitLifecycleDeps,
  knownStores?: MissionOrchestratorExitStores,
): ExitPersistenceOutcome {
  try {
    const stores = knownStores ?? deps.getStores(pending.scope);
    if (!sameProjectScope(stores.scope, pending.scope)) {
      throw new Error('orchestrator exit store scope identity changed');
    }
    const blocked = stores.missions.blockOrchestratorPreDispatchExit(
      pending.input,
    );
    pendingExitTombstones.delete(key);
    return blocked ? 'blocked' : 'resolved';
  } catch (error) {
    deps.warn(
      '[mission-orchestrator-exit] durable block pending retry:',
      error,
    );
    return 'retry';
  }
}

function pendingFromMission(
  scope: OwnedAgentSessionInfo['scope'],
  mission: Mission,
): PendingOrchestratorExit | null {
  const contract = mission.intentContract;
  const sessionId = mission.orchestratorSessionId;
  const intentVersion = mission.intentVersion ?? 0;
  const squadRevisionHash = contract?.squadRevisionHash;
  if (
    mission.status !== 'running' ||
    !['dispatched', 'executing'].includes(mission.intentState ?? '') ||
    !sessionId ||
    intentVersion <= 0 ||
    !contract ||
    !hasCurrentDispatchAuthority(mission) ||
    !squadRevisionHash ||
    !HASH_PATTERN.test(squadRevisionHash)
  ) {
    return null;
  }
  return Object.freeze({
    scope: Object.freeze({ ...scope }),
    input: Object.freeze({
      missionId: mission.id,
      orchestratorSessionId: sessionId,
      intentVersion,
      intentContractHash: hashMissionIntentContract(contract),
      squadRevisionHash,
      observation: 'missing_session_reconcile',
      outputTail: OUTPUT_UNAVAILABLE,
    }),
  });
}

/**
 * Consume a proven physical exit carrying the exact main-owned mission seal.
 * The observation is retained before any diagnostic/store IO; a transient
 * SQLite failure therefore becomes retryable instead of losing the only exit
 * signal.
 */
export function handleMissionOrchestratorSessionExit(
  sessionId: string,
  authority: OwnedAgentSessionInfo | null,
  deps: MissionOrchestratorExitLifecycleDeps = productionDeps,
): boolean {
  if (
    !authority ||
    authority.role !== 'orchestrator' ||
    authority.sessionId !== sessionId ||
    !authority.missionId ||
    !authority.authoritySeal
  ) {
    return false;
  }

  const seal = authority.authoritySeal;
  const fallback: PendingOrchestratorExit = Object.freeze({
    scope: Object.freeze({ ...authority.scope }),
    input: Object.freeze({
      missionId: authority.missionId,
      orchestratorSessionId: sessionId,
      intentVersion: seal.intentVersion,
      intentContractHash: seal.intentContractHash,
      squadRevisionHash: seal.squadRevisionHash,
      observation: 'physical_exit',
      outputTail: OUTPUT_UNAVAILABLE,
    }),
  });
  const key = rememberExit(fallback);
  try {
    rememberExit(Object.freeze({
      ...fallback,
      input: Object.freeze({
        ...fallback.input,
        outputTail: sanitizeMissionOrchestratorExitOutput(
          deps.readOutput(sessionId, 64),
        ),
      }),
    }));
  } catch (error) {
    deps.warn(
      '[mission-orchestrator-exit] diagnostic output unavailable; blocking without it:',
      error,
    );
  }
  return persistPendingExit(key, pendingExitTombstones.get(key)!, deps) ===
    'blocked';
}

/**
 * Retry exact exit tombstones and recover a lost process-level event after an
 * app crash/restart. The durable mission/session binding supplies the identity;
 * the store transaction remains the final authority and proves zero dispatches
 * for the current revision before blocking.
 */
export function reconcileMissionOrchestratorExits(
  deps: MissionOrchestratorExitLifecycleDeps = productionDeps,
): boolean {
  let complete = true;
  const attempted = new Set<string>();
  for (const [key, pending] of [...pendingExitTombstones]) {
    attempted.add(key);
    if (persistPendingExit(key, pending, deps) === 'retry') {
      complete = false;
    }
  }

  let storesByScope: readonly MissionOrchestratorExitStores[];
  try {
    storesByScope = deps.listStores();
  } catch (error) {
    deps.warn(
      '[mission-orchestrator-exit] could not list startup reconciliation scopes:',
      error,
    );
    return false;
  }

  for (const stores of storesByScope) {
    let missions: Mission[];
    try {
      missions = stores.missions.list('running');
    } catch (error) {
      deps.warn(
        `[mission-orchestrator-exit] could not inspect scope ${stores.scope.projectId}:`,
        error,
      );
      complete = false;
      continue;
    }
    for (const mission of missions) {
      const pending = pendingFromMission(stores.scope, mission);
      if (!pending) continue;
      let live: OwnedAgentSessionInfo | null;
      try {
        live = deps.getAgentSessionInfo(
          pending.input.orchestratorSessionId,
        );
      } catch (error) {
        deps.warn(
          '[mission-orchestrator-exit] physical session inventory unavailable:',
          error,
        );
        complete = false;
        continue;
      }
      if (live) continue;

      try {
        const alreadyDispatched = stores.taskDispatches
          ?.list(mission.id)
          .some(
            (dispatch) =>
              dispatch.intentVersion === pending.input.intentVersion,
          );
        if (alreadyDispatched) continue;
      } catch (error) {
        deps.warn(
          '[mission-orchestrator-exit] dispatch inventory unavailable:',
          error,
        );
        complete = false;
        continue;
      }

      const key = rememberExit(pending);
      if (attempted.has(key)) continue;
      attempted.add(key);
      const retained = pendingExitTombstones.get(key);
      if (
        !retained ||
        persistPendingExit(key, retained, deps, stores) === 'retry'
      ) {
        complete = false;
      }
    }
  }
  return complete && pendingExitTombstones.size === 0;
}

export function prepareMissionOrchestratorExitLifecycle(
  deps: MissionOrchestratorExitLifecycleDeps = productionDeps,
): void {
  shutdownMissionOrchestratorExitLifecycle();
  disposeExitTap = deps.tapExit((sessionId, authority) => {
    handleMissionOrchestratorSessionExit(sessionId, authority, deps);
  });
}

export function shutdownMissionOrchestratorExitLifecycle(): void {
  disposeExitTap?.();
  disposeExitTap = null;
  // Pending observations intentionally survive a lifecycle stop. A shutdown
  // retry in the same process must not erase the only physical-exit evidence.
}

/** Test-only process reset; production shutdown deliberately retains tombstones. */
export function resetMissionOrchestratorExitLifecycleForTests(): void {
  shutdownMissionOrchestratorExitLifecycle();
  pendingExitTombstones.clear();
}
