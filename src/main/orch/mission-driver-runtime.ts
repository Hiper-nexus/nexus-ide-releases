import type { ProjectExecutionScope } from '../../shared/types';
import {
  decideDriveAction,
  defaultDriveConfig,
  type DriveAction,
  type DriveConfig,
  type DriveState,
} from './mission-drive';
import {
  applyDriveAction,
  type ApplyActionPorts,
} from './mission-driver-apply';

/**
 * Mission Driver runtime — Fases B/C (shadow observe + active apply).
 *
 * Tick de 30s: para cada scope ativo, para cada missão `running`, deriva o
 * DriveState, decide a ação e:
 *  - shadow: só loga via onDecision
 *  - active: aplica via applyPorts (injectable), com budget counters
 *
 * Este módulo é PURAMENTE LÓGICA + controle de loop — não importa o registry de
 * stores. A camada IO vive em `./mission-driver-io.ts`.
 *
 * Invariantes: não-destrutivo em stall, fail-closed, budget finito, .unref().
 */

export const DRIVE_TICK_MS = 30_000;
/** A cada N ticks (~10min em 30s) emite um heartbeat de saúde do loop. */
const HEARTBEAT_EVERY_N_TICKS = 20;

export type { DriveAction, DriveConfig, DriveState };
export { defaultDriveConfig };

export interface DriveSnapshot {
  readonly missionId: string;
  readonly scope: ProjectExecutionScope;
  readonly state: DriveState;
  readonly action: DriveAction;
}

export interface DriveDeps {
  listScopes(): readonly ProjectExecutionScope[];
  listRunningMissions(scope: ProjectExecutionScope): readonly { id: string }[];
  /** Retorna null se a missão não existe (removida entre list e load). */
  loadDriveState(
    missionId: string,
    scope: ProjectExecutionScope,
  ): DriveState | null;
  now(): number;
  /**
   * Observability hook — always called after decision (shadow and active).
   * Shadow production wiring only logs; active also applies via applyPorts.
   */
  onDecision(snapshot: DriveSnapshot): void | Promise<void>;
  /** ms da última emissão de signal-stall pelo drive (debounce próprio). */
  getDriveSignalAt(
    missionId: string,
    scope: ProjectExecutionScope,
  ): number | undefined;
  /** Registra emissão de signal-stall (atualiza debounce próprio do drive). */
  recordDriveSignal(
    missionId: string,
    scope: ProjectExecutionScope,
    at: number,
  ): void;
  /** Budget: current iteration count for mission. */
  getIteration(missionId: string, scope: ProjectExecutionScope): number;
  /**
   * Durably reserve one active attempt before any side effect. Failed applies
   * consume budget too, so a crashing action cannot retry forever.
   */
  reserveAttempt(
    missionId: string,
    scope: ProjectExecutionScope,
    actionKind: DriveAction['kind'],
    at: number,
  ): void;
  /** ms of last non-wait apply (exponential backoff input). */
  getLastActionAt(
    missionId: string,
    scope: ProjectExecutionScope,
  ): number | undefined;
  /** Finish the previously reserved attempt. */
  finishAttempt(
    missionId: string,
    scope: ProjectExecutionScope,
    outcome: 'success' | 'failed',
    at: number,
    error?: string,
  ): void;
  /**
   * Active-mode apply ports. Required when config.mode === 'active' for
   * non-wait actions. Shadow mode ignores this.
   */
  applyPorts?: ApplyActionPorts;
}

export interface DriveTickResult {
  /** Missões listadas (running) em todos os scopes. */
  readonly scanned: number;
  /** loadDriveState retornou null (missão removida OU mis-scope sistêmico). */
  readonly loadNull: number;
  /** loadDriveState lançou (corrupção/bug — logado em error, não warn). */
  readonly loadErrors: number;
  /** Decisões não-wait — decisão tomada, independente de apply. */
  readonly decidedNonWait: number;
  /** Ações realmente aplicadas (active mode only). */
  readonly applied: number;
  /** Apply falhou (isolado por missão). */
  readonly applyErrors: number;
}

/**
 * Processa um tick: itera scopes → missões running → deriva estado → decide →
 * onDecision → (active) apply. Falhas isoladas por scope e por missão.
 */
export async function runDriveTick(
  deps: DriveDeps,
  config: DriveConfig = defaultDriveConfig,
): Promise<DriveTickResult> {
  const now = deps.now();
  let scanned = 0;
  let loadNull = 0;
  let loadErrors = 0;
  let decidedNonWait = 0;
  let applied = 0;
  let applyErrors = 0;
  for (const scope of deps.listScopes()) {
    let running: readonly { id: string }[];
    try {
      running = deps.listRunningMissions(scope);
    } catch (error) {
      console.error(
        `[mission-driver] listRunningMissions falhou para scope ` +
          `${scope.projectId}:${scope.checkoutId}:`,
        error,
      );
      continue;
    }
    for (const mission of running) {
      scanned += 1;
      let state: DriveState | null;
      try {
        state = deps.loadDriveState(mission.id, scope);
      } catch (error) {
        loadErrors += 1;
        console.error(
          `[mission-driver] loadDriveState falhou para ${mission.id}:`,
          error,
        );
        continue;
      }
      if (!state) {
        loadNull += 1;
        continue;
      }
      // Overlay budget + debounce + lastActionAt from runtime memory.
      const driveSignalAt = deps.getDriveSignalAt(mission.id, scope);
      const iteration = deps.getIteration(mission.id, scope);
      const lastActionAt = deps.getLastActionAt(mission.id, scope);
      let effectiveState: DriveState = {
        ...state,
        iteration: Math.max(state.iteration, iteration),
        ...(lastActionAt !== undefined || state.lastActionAt !== undefined
          ? {
              lastActionAt: Math.max(
                lastActionAt ?? 0,
                state.lastActionAt ?? 0,
              ),
            }
          : {}),
      };
      if (
        driveSignalAt !== undefined &&
        (effectiveState.lastStallSignalAt === undefined ||
          driveSignalAt > effectiveState.lastStallSignalAt)
      ) {
        effectiveState = {
          ...effectiveState,
          lastStallSignalAt: driveSignalAt,
        };
      }
      const action = decideDriveAction(effectiveState, now, config);
      if (action.kind !== 'wait') decidedNonWait += 1;
      const snapshot: DriveSnapshot = {
        missionId: mission.id,
        scope,
        state: effectiveState,
        action,
      };
      try {
        await deps.onDecision(snapshot);
      } catch (error) {
        console.warn(
          `[mission-driver] onDecision falhou para ${mission.id}:`,
          error,
        );
      }
      // Active apply: non-wait only, with finite budget + backoff accounting.
      if (config.mode === 'active' && action.kind !== 'wait') {
        const ports = deps.applyPorts;
        if (!ports) {
          applyErrors += 1;
          console.error(
            `[mission-driver] active mode sem applyPorts para ${mission.id}`,
          );
          continue;
        }
        try {
          deps.reserveAttempt(mission.id, scope, action.kind, now);
        } catch (error) {
          applyErrors += 1;
          console.error(
            `[mission-driver] não reservou tentativa para ${mission.id}:`,
            error,
          );
          continue;
        }
        try {
          const result = await applyDriveAction(snapshot, ports);
          if (result.applied) {
            applied += 1;
            deps.finishAttempt(mission.id, scope, 'success', now);
            if (action.kind === 'signal-stall') {
              deps.recordDriveSignal(mission.id, scope, now);
            }
          } else {
            deps.finishAttempt(
              mission.id,
              scope,
              'failed',
              now,
              `action ${action.kind} returned not-applied`,
            );
          }
        } catch (error) {
          applyErrors += 1;
          const message = error instanceof Error ? error.message : String(error);
          try {
            deps.finishAttempt(mission.id, scope, 'failed', now, message);
          } catch (finishError) {
            console.error(
              `[mission-driver] não finalizou tentativa de ${mission.id}:`,
              finishError,
            );
          }
          console.warn(
            `[mission-driver] applyAction falhou para ${mission.id}:`,
            error,
          );
        }
      } else if (config.mode === 'shadow' && action.kind === 'signal-stall') {
        // Shadow observes only: still debounce decisions so logs don't spam.
        deps.recordDriveSignal(mission.id, scope, now);
      }
    }
  }
  return {
    scanned,
    loadNull,
    loadErrors,
    decidedNonWait,
    applied,
    applyErrors,
  };
}

/** Logger shadow: só registra decisões não-wait, em nível info. */
export function logDecisionShadow(snapshot: DriveSnapshot): void {
  const { action, missionId, scope } = snapshot;
  if (action.kind === 'wait') return;
  console.info(
    `[mission-driver:shadow] ${action.kind} mission=${missionId} ` +
      `project=${scope.projectId}:${scope.checkoutId} reason="${action.reason}"`,
  );
}

/** Logger active: decisions that were (or will be) applied. */
export function logDecisionActive(snapshot: DriveSnapshot): void {
  const { action, missionId, scope } = snapshot;
  if (action.kind === 'wait') return;
  console.info(
    `[mission-driver:active] ${action.kind} mission=${missionId} ` +
      `project=${scope.projectId}:${scope.checkoutId} reason="${action.reason}"`,
  );
}

let configuredDeps: DriveDeps | null = null;
let configuredConfig: DriveConfig = defaultDriveConfig;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let heartbeatCounter = 0;

export function configureMissionDriverRuntime(options: {
  deps: DriveDeps;
  config?: DriveConfig;
}): void {
  if (timer) {
    console.warn(
      '[mission-driver] configure chamado com o loop rodando; os novos deps ' +
        'só passam a valer após stop()+start()',
    );
  }
  configuredDeps = options.deps;
  if (options.config) configuredConfig = options.config;
}

/** Inicia o loop (idempotente). Requer configure prévio. Timer .unref(). */
export function startMissionDriverLoop(
  deps: DriveDeps | null = configuredDeps,
  config: DriveConfig = configuredConfig,
): void {
  if (timer) return; // idempotente
  if (!deps) {
    console.warn(
      '[mission-driver] start chamado antes de configure; loop não iniciado',
    );
    return;
  }
  const activeDeps = deps;
  const activeConfig = config;
  const modeTag = activeConfig.mode === 'active' ? 'active' : 'shadow';
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void runDriveTick(activeDeps, activeConfig)
      .then((result) => {
        heartbeatCounter += 1;
        if (heartbeatCounter % HEARTBEAT_EVERY_N_TICKS !== 0) return;
        const allNull =
          result.scanned > 0 && result.loadNull === result.scanned;
        const line =
          `[mission-driver:${modeTag}] tick scanned=${result.scanned} ` +
          `loadNull=${result.loadNull} loadErrors=${result.loadErrors} ` +
          `decidedNonWait=${result.decidedNonWait} applied=${result.applied} ` +
          `applyErrors=${result.applyErrors}` +
          (allNull ? ' (ALL NULL — possível mis-scope)' : '');
        if (allNull || result.loadErrors > 0 || result.applyErrors > 0) {
          console.warn(line);
        } else {
          console.info(line);
        }
      })
      .catch((err) => console.warn('[mission-driver] tick falhou:', err))
      .finally(() => {
        ticking = false;
      });
  }, DRIVE_TICK_MS);
  timer.unref?.();
}

export function stopMissionDriverLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
}

export function disposeMissionDriverRuntime(): void {
  stopMissionDriverLoop();
  configuredDeps = null;
  configuredConfig = defaultDriveConfig;
  heartbeatCounter = 0;
}
