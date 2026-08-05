import type { ProjectExecutionScope } from '../../shared/types';
import {
  defaultGoalDriverConfig,
  type GoalDriverConfig,
  type GoalLiveState,
  type GoalTrigger,
} from './goal-driver';
import { getProjectDomainStores } from './project-domain-store-registry';
import {
  logGoalDecisionShadow,
  startGoalDriverLoop,
  stopGoalDriverLoop,
  type GoalDriverDeps,
} from './goal-driver-runtime';

/**
 * Goal Driver IO/wiring — monta os deps de produção e liga o loop no launch do
 * orquestrador, COEXISTINDO com o cron (`startCronLoop`). A camada de decisão
 * (`goal-driver.ts`) e o loop (`goal-driver-runtime.ts`) são puros/injetáveis;
 * aqui vive o IO real (leitura de estado vivo dos stores) e o default seguro.
 *
 * DEFAULT = SHADOW/observe: `fire` só loga a decisão. Materializar o disparo
 * autônomo de uma missão exige o mesmo consentimento exato que o cron aplica
 * (`cron-exact-consent`) — essa autoridade + o store persistente de triggers +
 * a UI são a fatia seguinte (partial). Sem triggers persistidos, o loop é um
 * observador inerte que apenas comprova coexistência e leitura de estado vivo.
 */

/** Probe injetável de disponibilidade de provider. Fail-closed = false. */
export type ProviderAvailabilityProbe = (
  scope: ProjectExecutionScope,
) => boolean;

/**
 * Lê o estado vivo real de um scope a partir dos stores de missão. Defensivo:
 * qualquer falha de leitura degrada para zeros/false (fail-closed), nunca
 * derruba o tick.
 */
export function readLiveStateForScope(
  scope: ProjectExecutionScope,
  providerAvailable: ProviderAvailabilityProbe,
): GoalLiveState {
  let runningMissions = 0;
  let pendingMissions = 0;
  let blockedMissions = 0;
  try {
    const { missions } = getProjectDomainStores(scope);
    runningMissions = missions.list('running').length;
    pendingMissions = missions.list('pending').length;
    blockedMissions = missions.list('blocked').length;
  } catch (error) {
    console.warn(
      `[goal-driver] leitura de contagem de missões falhou para ` +
        `${scope.projectId}:${scope.checkoutId}:`,
      error,
    );
  }
  let available = false;
  try {
    available = providerAvailable(scope);
  } catch {
    available = false; // fail-closed
  }
  return {
    runningMissions,
    pendingMissions,
    blockedMissions,
    // Proxy: profundidade de fila = missões pending aguardando dispatch. O
    // acoplamento fino ao task_dispatch_queue entra com a fatia do store.
    queueDepth: pendingMissions,
    providerAvailable: available,
  };
}

/**
 * Monta os deps default do goal driver. `loadTriggers` retorna vazio até o
 * store persistente existir (partial); `fire` é shadow/observe por padrão.
 */
export function createDefaultGoalDriverDeps(options: {
  listScopes: () => readonly ProjectExecutionScope[];
  loadTriggers?: (scope: ProjectExecutionScope) => readonly GoalTrigger[];
  providerAvailable?: ProviderAvailabilityProbe;
  fire?: GoalDriverDeps['fire'];
  recordFire?: GoalDriverDeps['recordFire'];
}): GoalDriverDeps {
  const providerAvailable = options.providerAvailable ?? (() => false);
  return {
    listScopes: options.listScopes,
    loadTriggers: options.loadTriggers ?? (() => []),
    readLiveState: (scope) => readLiveStateForScope(scope, providerAvailable),
    fire:
      options.fire ??
      (async () => {
        // Shadow default: efeito autônomo desligado. Nunca cria missão sem
        // consentimento — só a decisão é observável via onDecision.
      }),
    recordFire: options.recordFire ?? (() => {}),
    now: Date.now,
    onDecision: logGoalDecisionShadow,
  };
}

/**
 * Conveniência de wiring: monta deps default e inicia o loop (idempotente).
 * Chamado no launch do orquestrador, junto de `startCronLoop`.
 */
export function configureGoalDriver(options: {
  listScopes: () => readonly ProjectExecutionScope[];
  config?: GoalDriverConfig;
  loadTriggers?: (scope: ProjectExecutionScope) => readonly GoalTrigger[];
  providerAvailable?: ProviderAvailabilityProbe;
  fire?: GoalDriverDeps['fire'];
  recordFire?: GoalDriverDeps['recordFire'];
}): void {
  const config = options.config ?? defaultGoalDriverConfig;
  startGoalDriverLoop(
    createDefaultGoalDriverDeps({
      listScopes: options.listScopes,
      ...(options.loadTriggers ? { loadTriggers: options.loadTriggers } : {}),
      ...(options.providerAvailable
        ? { providerAvailable: options.providerAvailable }
        : {}),
      ...(options.fire ? { fire: options.fire } : {}),
      ...(options.recordFire ? { recordFire: options.recordFire } : {}),
    }),
    config,
  );
}

export { defaultGoalDriverConfig, stopGoalDriverLoop };
