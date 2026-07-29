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
  DRIVE_TICK_MS,
  reconcileMissionDriver,
  setMissionDriverReconcileRequest,
} from './mission-driver-runtime';
import {
  MISSION_SCHEDULER_TICK_MS,
  reconcileMissionScheduler,
  setMissionSchedulerReconcileRequest,
} from './mission-scheduler-production';
import {
  MISSION_ORCHESTRATOR_BOOTSTRAP_RECONCILE_MS,
  prepareMissionOrchestratorBootstrapRecovery,
  reconcileMissionOrchestratorBootstrap,
  shutdownMissionOrchestratorBootstrapRecovery,
} from './mission-orchestrator-bootstrap';
import {
  MISSION_ORCHESTRATOR_EXIT_RECONCILE_MS,
  prepareMissionOrchestratorExitLifecycle,
  reconcileMissionOrchestratorExits,
  shutdownMissionOrchestratorExitLifecycle,
} from './mission-orchestrator-exit-lifecycle';
import {
  createOrchestrationReconciler,
  type OrchestrationReconciler,
} from './orchestration-reconciler';
import {
  HANDOFF_DELIVERY_OUTBOX_RECONCILE_MS,
  reconcilePendingHandoffDeliveryOutbox,
} from './handoff-delivery-outbox';
import { configureHandoffDeliveryRuntimeRecovery } from './idle-delivery';
import { recoverHandoffDeliveryRuntime } from './handoff-delivery-runtime-recovery';
import { terminateUnauthorizedMissionRuntimes } from './mission-runtime-termination';
import { requireProjectDomainStoreRegistry } from './project-domain-store-registry';
import {
  prepareStallWatchdog,
  reconcileStallWatchdog,
  shutdownStallWatchdog,
  STALL_SCAN_MS,
} from './stall-watchdog';
import {
  prepareTaskDispatchLifecycle,
  reconcileTaskDispatchLifecycle,
  shutdownTaskDispatchLifecycle,
  TASK_DISPATCH_RECONCILE_MS,
} from './task-dispatch-lifecycle';

/**
 * Production owner for orchestration supervision.
 *
 * PTY/store listeners stay event-driven, but every periodic decision now runs
 * through one adaptive clock and one single-flight pass. This removes the old
 * 5s/15s/30s split-brain without coupling the domain modules to each other.
 */

let coordinator: OrchestrationReconciler | null = null;
let disposeLoginWatchdog: (() => void) | null = null;
let coordinatorStopFlight: Promise<void> | null = null;
const MISSION_RUNTIME_AUTHORITY_RECONCILE_MS = 1_000;
/**
 * The merge council has its own 10-minute bound (20 minutes in the packaged
 * physical release gate). Keep the outer participant just beyond that bound:
 * otherwise a healthy reviewer is cancelled every 30 seconds and can never
 * submit its durable report. Abort still reaches the whole scheduler on a
 * genuine overrun or shutdown.
 */
export const MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS = 21 * 60_000;

export function runMissionSchedulerCoordinatorParticipant(
  _now: number,
  signal?: AbortSignal,
): Promise<void> {
  return reconcileMissionScheduler(signal);
}

export function startOrchestrationCoordinator(): void {
  if (coordinator) return;
  if (coordinatorStopFlight) {
    throw new Error('orchestration coordinator is still stopping');
  }

  prepareStallWatchdog();
  prepareDelegationSupervisor();
  prepareTaskDispatchLifecycle();
  prepareMissionOrchestratorExitLifecycle();
  prepareMissionOrchestratorBootstrapRecovery();
  configureHandoffDeliveryRuntimeRecovery(recoverHandoffDeliveryRuntime);
  disposeLoginWatchdog = installLoginStuckWatchdog({ autoTick: false });

  const instance = createOrchestrationReconciler([
    {
      id: 'login-stuck',
      cadenceMs: LOGIN_STUCK_TICK_MS,
      run: () => reconcileLoginStuckWatchdog(),
    },
    {
      id: 'stall-watchdog',
      cadenceMs: STALL_SCAN_MS,
      run: (now) => reconcileStallWatchdog(now),
    },
    {
      id: 'delegation-supervisor',
      cadenceMs: DELEGATION_SCAN_MS,
      run: (now) => reconcileDelegationSupervisor(now),
    },
    {
      id: 'task-dispatch-lifecycle',
      cadenceMs: TASK_DISPATCH_RECONCILE_MS,
      run: (now) => reconcileTaskDispatchLifecycle(now),
    },
    {
      id: 'mission-orchestrator-exit',
      cadenceMs: MISSION_ORCHESTRATOR_EXIT_RECONCILE_MS,
      run: () => reconcileMissionOrchestratorExits(),
    },
    {
      id: 'mission-orchestrator-bootstrap',
      cadenceMs: MISSION_ORCHESTRATOR_BOOTSTRAP_RECONCILE_MS,
      run: () => reconcileMissionOrchestratorBootstrap(),
    },
    {
      id: 'mission-runtime-authority',
      cadenceMs: MISSION_RUNTIME_AUTHORITY_RECONCILE_MS,
      run: async () => {
        const registry = requireProjectDomainStoreRegistry();
        for (const suite of registry.listSuites()) {
          const results = await terminateUnauthorizedMissionRuntimes(
            suite.scope,
            suite,
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
      run: () => reconcilePendingHandoffDeliveryOutbox(),
    },
    {
      id: 'mission-scheduler',
      cadenceMs: MISSION_SCHEDULER_TICK_MS,
      timeoutMs: MISSION_SCHEDULER_PARTICIPANT_TIMEOUT_MS,
      run: runMissionSchedulerCoordinatorParticipant,
    },
    {
      id: 'mission-driver',
      cadenceMs: DRIVE_TICK_MS,
      run: () => reconcileMissionDriver(),
    },
  ]);
  coordinator = instance;
  setMissionSchedulerReconcileRequest(
    () => coordinator?.request('mission-scheduler') ?? false,
  );
  setMissionDriverReconcileRequest(
    () => coordinator?.request('mission-driver') ?? false,
  );
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
    setMissionSchedulerReconcileRequest(null);
    setMissionDriverReconcileRequest(null);
    disposeLoginWatchdog?.();
    disposeLoginWatchdog = null;
    shutdownDelegationSupervisor();
    shutdownStallWatchdog();
    shutdownTaskDispatchLifecycle();
    shutdownMissionOrchestratorExitLifecycle();
    await shutdownMissionOrchestratorBootstrapRecovery();
    configureHandoffDeliveryRuntimeRecovery(null);
    coordinator = null;
  })();
  coordinatorStopFlight = stop;
  try {
    await stop;
  } finally {
    if (coordinatorStopFlight === stop) coordinatorStopFlight = null;
  }
}
