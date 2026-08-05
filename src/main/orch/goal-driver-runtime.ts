import type { ProjectExecutionScope } from '../../shared/types';
import {
  defaultGoalDriverConfig,
  shouldFireGoal,
  type GoalDriverConfig,
  type GoalFireDecision,
  type GoalLiveState,
  type GoalTrigger,
} from './goal-driver';

/**
 * Goal Driver runtime — o loop *goal-driven*, análogo ao `startCronLoop`
 * (`cron-runtime.ts:330`) *time-driven*. Coexiste com o cron: tick próprio,
 * timer próprio `.unref()`, sem estado mutável compartilhado. O cron dispara
 * missões por horário; o goal driver dispara missões por PREDICADO sobre estado
 * vivo (`goal-driver.ts shouldFireGoal`).
 *
 * A cada tick, para cada scope ativo: lê UMA vez o estado vivo, itera os
 * triggers, decide via `shouldFireGoal` e — quando dispara — chama `deps.fire`
 * (efeito injetável) e `deps.recordFire`. Falhas isoladas por scope e por
 * trigger; a concorrência é contabilizada DENTRO do tick para não estourar o
 * teto quando vários triggers querem disparar no mesmo scope.
 *
 * Invariantes: fail-closed, orçamento finito, `.unref()`, puro-no-estado na
 * camada de decisão (esta camada só faz IO + controle de loop).
 */

export const GOAL_DRIVER_TICK_MS = 30_000;

export type { GoalDriverConfig, GoalLiveState, GoalTrigger };
export { defaultGoalDriverConfig };

export interface GoalDriveSnapshot {
  readonly triggerId: string;
  readonly scope: ProjectExecutionScope;
  readonly state: GoalLiveState;
  readonly decision: GoalFireDecision;
}

export interface GoalDriverDeps {
  /** Scopes ativos a varrer (mesma fonte do cron: `knownCronScopes`). */
  listScopes(): readonly ProjectExecutionScope[];
  /** Gatilhos persistidos no scope. Vazio quando o store ainda não existe. */
  loadTriggers(scope: ProjectExecutionScope): readonly GoalTrigger[];
  /** Snapshot do estado vivo do scope (contagens de missão, fila, provider). */
  readLiveState(scope: ProjectExecutionScope): GoalLiveState;
  /**
   * Efeito de disparo — INJETÁVEL. Em produção default é shadow/observe (loga,
   * não cria missão autônoma sem consentimento). Testes injetam um fake que
   * prova o disparo por predicado.
   */
  fire(
    trigger: GoalTrigger,
    scope: ProjectExecutionScope,
    state: GoalLiveState,
  ): Promise<void>;
  /** Persiste o disparo (atualiza cooldown/budget do trigger). */
  recordFire(
    triggerId: string,
    scope: ProjectExecutionScope,
    at: number,
  ): void;
  now(): number;
  /** Hook de observabilidade — chamado após cada decisão (fire ou não). */
  onDecision?(snapshot: GoalDriveSnapshot): void;
}

export interface GoalDriverTickResult {
  /** Triggers avaliados em todos os scopes. */
  readonly scanned: number;
  /** Disparos efetivamente aplicados. */
  readonly fired: number;
  /** Erros isolados (readLiveState por scope + fire por trigger). */
  readonly errors: number;
}

/**
 * Processa um tick: scopes → estado vivo → triggers → decide → (dispara).
 * Falhas isoladas por scope e por trigger.
 */
export async function runGoalDriverTick(
  deps: GoalDriverDeps,
  config: GoalDriverConfig = defaultGoalDriverConfig,
): Promise<GoalDriverTickResult> {
  const now = deps.now();
  let scanned = 0;
  let fired = 0;
  let errors = 0;

  for (const scope of deps.listScopes()) {
    let triggers: readonly GoalTrigger[];
    let liveState: GoalLiveState;
    try {
      triggers = deps.loadTriggers(scope);
      liveState = deps.readLiveState(scope);
    } catch (error) {
      errors += 1;
      console.error(
        `[goal-driver] leitura de estado falhou para scope ` +
          `${scope.projectId}:${scope.checkoutId}:`,
        error,
      );
      continue;
    }

    // Contabiliza disparos DENTRO do tick: cada fire adiciona uma missão à
    // frota, então o próximo trigger enxerga a concorrência já ocupada. Sem
    // isso, N triggers com predicado true no mesmo scope estourariam o teto.
    let firedInScope = 0;
    for (const trigger of triggers) {
      scanned += 1;
      const effectiveState: GoalLiveState = {
        ...liveState,
        runningMissions: liveState.runningMissions + firedInScope,
      };
      const decision = shouldFireGoal(trigger, effectiveState, now, config);

      if (deps.onDecision) {
        try {
          deps.onDecision({
            triggerId: trigger.id,
            scope,
            state: effectiveState,
            decision,
          });
        } catch (error) {
          console.warn(
            `[goal-driver] onDecision falhou para ${trigger.id}:`,
            error,
          );
        }
      }

      if (!decision.fire) continue;

      try {
        await deps.fire(trigger, scope, effectiveState);
        firedInScope += 1;
        fired += 1;
        deps.recordFire(trigger.id, scope, now);
      } catch (error) {
        errors += 1;
        console.warn(
          `[goal-driver] fire falhou para ${trigger.id}:`,
          error,
        );
      }
    }
  }

  return { scanned, fired, errors };
}

/** Logger shadow: registra decisões de disparo (observe-only). */
export function logGoalDecisionShadow(snapshot: GoalDriveSnapshot): void {
  if (!snapshot.decision.fire) return;
  const { triggerId, scope, decision } = snapshot;
  console.info(
    `[goal-driver:shadow] fire trigger=${triggerId} ` +
      `project=${scope.projectId}:${scope.checkoutId} reason="${decision.reason}"`,
  );
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickFlight: Promise<GoalDriverTickResult> | null = null;

function requestGoalDriverTick(
  deps: GoalDriverDeps,
  config: GoalDriverConfig,
): Promise<GoalDriverTickResult> {
  if (tickFlight) return tickFlight;
  const flight = runGoalDriverTick(deps, config).finally(() => {
    if (tickFlight === flight) tickFlight = null;
  });
  tickFlight = flight;
  return flight;
}

/**
 * Inicia o loop de tick (idempotente). Timer `.unref()`'d — não mantém o
 * processo vivo, exatamente como `startCronLoop`. Coexiste com o cron: timers e
 * estado de módulo independentes.
 */
export function startGoalDriverLoop(
  deps: GoalDriverDeps,
  config: GoalDriverConfig = defaultGoalDriverConfig,
): void {
  if (timer) return; // idempotente
  timer = setInterval(() => {
    void requestGoalDriverTick(deps, config).catch((err) =>
      console.warn('[goal-driver] tick falhou:', err),
    );
  }, GOAL_DRIVER_TICK_MS);
  timer.unref?.();
}

export async function stopGoalDriverLoop(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const active = tickFlight;
  if (active) await active;
}
