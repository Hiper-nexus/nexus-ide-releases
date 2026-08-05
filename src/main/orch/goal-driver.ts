/**
 * Goal Driver — pure predicate rules (goal-driven mission trigger).
 *
 * Este é o análogo *goal-driven* do cron *time-driven*. O cron decide disparar
 * uma missão quando o RELÓGIO bate (`shouldFire(job, now, staleMs)`,
 * `cron-loop.ts:163`). O Goal Driver decide disparar uma missão quando um
 * PREDICADO sobre o ESTADO VIVO da missão é satisfeito
 * (`shouldFireGoal(trigger, liveState, now, config)`). É o único gap real vs
 * Ralph que o cron não fecha: cron cria uma missão por horário; o goal driver
 * cria uma missão por condição de estado (profundidade de fila, disponibilidade
 * de provider, etc.).
 *
 * Design: docs/superpowers/specs/2026-07-13-mission-driver-design.md.
 *
 * Invariantes herdados do cron/watchdog (não negociáveis):
 *  - PURO em relação ao estado: sem IO, sem relógio global (recebe `now`), sem
 *    mutação. Testável sem DB nem processos — igual a `shouldFire`.
 *  - FAIL-CLOSED: predicado indeciso, trigger pausado, budget esgotado, ou frota
 *    no teto de concorrência → NÃO dispara. Silêncio = não-disparo.
 *  - ORÇAMENTO FINITO: `maxFires` por trigger + `cooldownMs` entre disparos +
 *    `maxConcurrentMissions` global. Nunca dispara indefinidamente.
 *  - O predicado é uma CONDIÇÃO DECLARATIVA (métrica/comparador/valor), nunca
 *    código arbitrário — serializável, auditável, e imune a injeção.
 *
 * CAVEAT DE SEGURANÇA: este módulo apenas DECIDE. Materializar o disparo
 * autônomo de uma missão (criar+bootstrap) sem consentimento exato seria a
 * mesma regressão que o cron recusa (`cron-exact-consent`). O efeito é aplicado
 * pelo caller via deps injetáveis (ver `goal-driver-runtime.ts`), em modo
 * shadow/observe por padrão.
 */

/** Métrica de estado vivo referenciável por um predicado de goal. */
export type GoalMetric =
  | 'runningMissions'
  | 'pendingMissions'
  | 'blockedMissions'
  | 'queueDepth'
  | 'providerAvailable';

/** Comparadores suportados no predicado declarativo. */
export type GoalComparator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

/**
 * Predicado declarativo sobre o estado vivo. `providerAvailable` é lido como
 * métrica booleana coagida a 0/1 (use `eq 1` para "disponível", `eq 0` para
 * "indisponível").
 */
export interface GoalPredicate {
  readonly metric: GoalMetric;
  readonly comparator: GoalComparator;
  readonly value: number;
}

/**
 * Definição de um gatilho goal-driven — análogo ao `CronJob` (`cron-loop.ts`),
 * mas com `predicate` no lugar de `schedule`. `lastFiredAt`/`fireCount` são as
 * entradas de cooldown/budget (o runtime as persiste, como o cron persiste
 * `nextFireAt`/`lastFiredAt`).
 */
export interface GoalTrigger {
  readonly id: string;
  readonly name: string;
  readonly status: 'active' | 'paused';
  /** Predicado sobre o estado vivo da missão. */
  readonly predicate: GoalPredicate;
  /** Brief da missão a disparar quando o predicado vale. */
  readonly brief: string;
  /** Um dos dois: agente do squad OU squad inteiro (igual ao cron). */
  readonly squadId?: string;
  readonly agentName?: string;
  /** ms do último disparo (entrada de cooldown). */
  readonly lastFiredAt?: number;
  /** Total de disparos (entrada de budget). */
  readonly fireCount?: number;
}

/** Snapshot do estado vivo da missão/frota lido a cada tick (IO no runtime). */
export interface GoalLiveState {
  /** Missões `running` no scope. */
  readonly runningMissions: number;
  /** Missões `pending` (aguardando) no scope. */
  readonly pendingMissions: number;
  /** Missões `blocked` no scope. */
  readonly blockedMissions: number;
  /** Profundidade de fila de dispatch de tasks. */
  readonly queueDepth: number;
  /** Se há provider com credencial/rota disponível. Fail-closed = false. */
  readonly providerAvailable: boolean;
}

export interface GoalDriverConfig {
  /** Intervalo mínimo (ms) entre dois disparos do MESMO trigger (anti-thrash). */
  readonly cooldownMs: number;
  /** Máximo de disparos por trigger antes de exigir re-arme humano (budget). */
  readonly maxFires: number;
  /** Teto global de missões running; o predicado nunca dispara acima dele. */
  readonly maxConcurrentMissions: number;
}

/** Config padrão do goal driver. Canônica aqui (módulo puro) e congelada. */
export const defaultGoalDriverConfig: GoalDriverConfig = Object.freeze({
  cooldownMs: 5 * 60_000,
  maxFires: 100,
  maxConcurrentMissions: 8,
});

export interface GoalFireDecision {
  readonly fire: boolean;
  readonly reason: string;
}

/** Lê uma métrica do estado vivo (booleano coagido a 0/1). Pura, exaustiva. */
export function readMetric(state: GoalLiveState, metric: GoalMetric): number {
  switch (metric) {
    case 'runningMissions':
      return state.runningMissions;
    case 'pendingMissions':
      return state.pendingMissions;
    case 'blockedMissions':
      return state.blockedMissions;
    case 'queueDepth':
      return state.queueDepth;
    case 'providerAvailable':
      return state.providerAvailable ? 1 : 0;
    default: {
      const exhaustive: never = metric;
      return exhaustive;
    }
  }
}

/** Avalia o predicado declarativo contra o estado vivo. Pura, exaustiva. */
export function evaluatePredicate(
  predicate: GoalPredicate,
  state: GoalLiveState,
): boolean {
  const actual = readMetric(state, predicate.metric);
  switch (predicate.comparator) {
    case 'lt':
      return actual < predicate.value;
    case 'lte':
      return actual <= predicate.value;
    case 'eq':
      return actual === predicate.value;
    case 'gte':
      return actual >= predicate.value;
    case 'gt':
      return actual > predicate.value;
    default: {
      const exhaustive: never = predicate.comparator;
      return exhaustive;
    }
  }
}

/**
 * Decide se o gatilho dispara AGORA. Pura: sem IO, sem relógio global (recebe
 * `now`), sem mutação — o análogo goal-driven de `shouldFire` (cron).
 *
 * Prioridade (alto → baixo, tudo fail-closed):
 * 1. trigger pausado → não dispara
 * 2. budget de disparos esgotado → não dispara (re-arme humano)
 * 3. frota no teto de concorrência → não dispara
 * 4. dentro do cooldown do próprio trigger → não dispara (debounce)
 * 5. predicado sobre estado vivo NÃO satisfeito → não dispara
 * 6. senão → dispara
 */
export function shouldFireGoal(
  trigger: GoalTrigger,
  state: GoalLiveState,
  now: number,
  config: GoalDriverConfig,
): GoalFireDecision {
  if (trigger.status !== 'active') {
    return { fire: false, reason: `trigger is ${trigger.status}` };
  }

  const fireCount = trigger.fireCount ?? 0;
  if (fireCount >= config.maxFires) {
    return {
      fire: false,
      reason: `maxFires (${config.maxFires}) exhausted — re-arm required`,
    };
  }

  if (state.runningMissions >= config.maxConcurrentMissions) {
    return {
      fire: false,
      reason:
        `at concurrency cap ` +
        `(${state.runningMissions}/${config.maxConcurrentMissions} running)`,
    };
  }

  if (trigger.lastFiredAt !== undefined) {
    const since = now - trigger.lastFiredAt;
    // Clock-skew defense: elapsed negativo/NaN não é "cooldown expirado". Trata
    // como ainda-em-cooldown (fail-closed) — nunca dispara com relógio inválido.
    if (!Number.isFinite(since) || since < 0 || since < config.cooldownMs) {
      return {
        fire: false,
        reason: `cooldown ${config.cooldownMs}ms (${Math.round(since)}ms elapsed)`,
      };
    }
  }

  if (!evaluatePredicate(trigger.predicate, state)) {
    const { metric, comparator, value } = trigger.predicate;
    return {
      fire: false,
      reason: `predicate not satisfied (${metric} ${comparator} ${value})`,
    };
  }

  const { metric, comparator, value } = trigger.predicate;
  return {
    fire: true,
    reason: `goal predicate satisfied: ${metric} ${comparator} ${value}`,
  };
}
