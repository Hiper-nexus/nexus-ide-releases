import {
  DELEGATION_SCAN_MS,
  prepareDelegationSupervisor,
  reconcileDelegationSupervisor,
  shutdownDelegationSupervisor,
} from './delegation-supervisor';
import {
  installLoginStuckWatchdog,
  LOGIN_STUCK_TICK_MS,
  reconcileLoginStuckWatchdog,
} from './login-stuck-watchdog';
import {
  BOOT_PROMPT_TICK_MS,
  installBootPromptWatchdog,
  reconcileBootPromptWatchdog,
} from './boot-prompt-watchdog';
import {
  createOrchestrationReconciler,
  type OrchestrationReconciler,
} from './orchestration-reconciler';
import {
  HANDOFF_DELIVERY_OUTBOX_RECONCILE_MS,
  reconcilePendingHandoffDeliveryOutbox,
} from './handoff-delivery-outbox';
import { drainEffectOutbox } from './effect-outbox-worker';
import { EffectOutboxStore, isUnreconciledEffectOutbox } from './effect-outbox';
import { reconcileProviderRuntimesAtBoot } from './provider-runtime-recovery';
import { configureHandoffDeliveryRuntimeRecovery } from './idle-delivery';
import { recoverHandoffDeliveryRuntime } from './handoff-delivery-runtime-recovery';
import { terminateUnauthorizedMissionRuntimes } from './mission-runtime-termination';
import { requireProjectDomainStoreRegistry } from './project-domain-store-registry';
import {
  GOAL_GOVERNOR_RECONCILE_CADENCE_MS,
  reconcileGoalGovernor,
  shutdownGoalGovernor,
} from './goal-governor';

/**
 * Production owner for orchestration supervision.
 *
 * PTY/store listeners stay event-driven, but every periodic decision now runs
 * through one adaptive clock and one single-flight pass. This removes the old
 * 5s/15s/30s split-brain without coupling the domain modules to each other.
 */

let coordinator: OrchestrationReconciler | null = null;
let disposeLoginWatchdog: (() => Promise<void>) | null = null;
let disposeBootPromptWatchdog: (() => void) | null = null;
let coordinatorStopFlight: Promise<void> | null = null;
const MISSION_RUNTIME_AUTHORITY_RECONCILE_MS = 1_000;
/** ORC-01: dreno do outbox de efeitos no mesmo relógio do coordinator. */
const EFFECT_OUTBOX_DRAIN_MS = 1_000;

/**
 * ORC-06: recupera efeitos órfãos ANTES de qualquer trabalho novo.
 * PROCESS_BOUND pending/running → cancelled; REPLAY_SAFE running → pending.
 */
function recoverEffectOutboxesAtBoot(): void {
  try {
    const registry = requireProjectDomainStoreRegistry();
    const runtimeManager = registry.runtimeManager();
    const scopes = registry.listSuites().map((suite) => suite.scope);
    const result = reconcileProviderRuntimesAtBoot(runtimeManager, scopes);
    if (result.cancelledEffects || result.requeuedEffects || result.unsettledReceipts) {
      console.info(
        `[effect-outbox] boot reconcile: cancelled=${result.cancelledEffects} ` +
          `requeued=${result.requeuedEffects} unsettledReceipts=${result.unsettledReceipts}`,
      );
    }
  } catch (error) {
    console.warn('[effect-outbox] boot reconcile failed (continuing):', error);
  }
}

export function startOrchestrationCoordinator(): void {
  if (coordinator) return;
  if (coordinatorStopFlight) {
    throw new Error('orchestration coordinator is still stopping');
  }

  prepareDelegationSupervisor();
  configureHandoffDeliveryRuntimeRecovery(recoverHandoffDeliveryRuntime);
  disposeLoginWatchdog = installLoginStuckWatchdog({ autoTick: false });
  disposeBootPromptWatchdog = installBootPromptWatchdog();
  // ORC-06: reconcilia efeitos órfãos do processo anterior antes do primeiro
  // passe de trabalho (delegation, handoff, goal).
  recoverEffectOutboxesAtBoot();

  const instance = createOrchestrationReconciler([
    {
      id: 'login-stuck',
      cadenceMs: LOGIN_STUCK_TICK_MS,
      run: (_now, _signal, context) => reconcileLoginStuckWatchdog(context),
    },
    {
      id: 'boot-prompt',
      cadenceMs: BOOT_PROMPT_TICK_MS,
      run: (_now, _signal, context) => reconcileBootPromptWatchdog(context),
    },
    {
      id: 'delegation-supervisor',
      cadenceMs: DELEGATION_SCAN_MS,
      run: (now, _signal, context) => reconcileDelegationSupervisor(now, context),
    },
    {
      id: 'mission-runtime-authority',
      cadenceMs: MISSION_RUNTIME_AUTHORITY_RECONCILE_MS,
      run: async (_now, _signal, context) => {
        const registry = requireProjectDomainStoreRegistry();
        for (const suite of registry.listSuites()) {
          await context?.checkpoint();
          const results = await terminateUnauthorizedMissionRuntimes(
            suite.scope,
            suite,
            context,
          );
          const failure = results.find((result) => !result.ok);
          if (failure) {
            throw new Error(
              failure.error ??
                'unauthorized mission runtime termination was not proven',
            );
          }
        }
      },
    },
    {
      id: 'handoff-delivery-outbox',
      cadenceMs: HANDOFF_DELIVERY_OUTBOX_RECONCILE_MS,
      run: async (_now, _signal, context) => { await reconcilePendingHandoffDeliveryOutbox({}, context); },
    },
    {
      // ORC-01: drena o outbox transacional de efeitos (handlers por tipo via
      // registerEffectOutboxHandler). Sem handler registrado, o efeito assenta
      // pela classe — nunca fica preso em silêncio.
      id: 'effect-outbox',
      cadenceMs: EFFECT_OUTBOX_DRAIN_MS,
      run: async (_now, _signal, context) => {
        const registry = requireProjectDomainStoreRegistry();
        const runtimeManager = registry.runtimeManager();
        for (const suite of registry.listSuites()) {
          await context?.checkpoint();
          if (isUnreconciledEffectOutbox(suite.scope)) continue;
          const store = new EffectOutboxStore(runtimeManager, suite.scope);
          await drainEffectOutbox(
            {
              store,
              scope: suite.scope,
              workerId: 'orchestration-coordinator',
            },
            context,
          );
        }
      },
    },
    {
      id: 'goal-governor',
      cadenceMs: GOAL_GOVERNOR_RECONCILE_CADENCE_MS,
      run: (now, _signal, context) => reconcileGoalGovernor(now, context),
    },
  ]);
  coordinator = instance;
  instance.start();
}

export function requestOrchestrationReconciliation(
  participantId?: string,
): boolean {
  return coordinator?.request(participantId) ?? false;
}

export function requestMissionRuntimeAuthorityReconciliation(): boolean {
  return coordinator?.request('mission-runtime-authority') ?? false;
}

/**
 * Stop every periodic/spawning participant while retaining physical-exit taps
 * and project stores. App shutdown uses this phase before terminating PTYs, so
 * exact exit observations can still be committed synchronously.
 */
export async function quiesceOrchestrationCoordinator(): Promise<void> {
  if (coordinatorStopFlight) return coordinatorStopFlight;
  const current = coordinator;
  if (!current) return;
  await current.stop();
  if (coordinator !== current) {
    throw new Error('orchestration coordinator identity changed during quiesce');
  }
}

export async function stopOrchestrationCoordinator(): Promise<void> {
  if (coordinatorStopFlight) return coordinatorStopFlight;
  const current = coordinator;
  if (!current) return;
  const stop = (async () => {
    // Keep the coordinator identity and every store-backed subsystem installed
    // until all participant promises have physically settled. If stop rejects,
    // callers must not tear down stores or start a replacement epoch.
    await current.stop();
    if (coordinator !== current) {
      throw new Error('orchestration coordinator identity changed during stop');
    }
    await disposeLoginWatchdog?.();
    disposeLoginWatchdog = null;
    disposeBootPromptWatchdog?.();
    disposeBootPromptWatchdog = null;
    await shutdownDelegationSupervisor();
    configureHandoffDeliveryRuntimeRecovery(null);
    await shutdownGoalGovernor();
    coordinator = null;
  })();
  coordinatorStopFlight = stop;
  try {
    await stop;
  } finally {
    if (coordinatorStopFlight === stop) coordinatorStopFlight = null;
  }
}
