import {
  canMarkMilestoneDone,
  type Handoff,
  type MilestoneStatus,
  type Mission,
  type MissionMilestone,
  type MissionStatus,
} from '../../shared/orch-types';

/**
 * Mission Driver — pure decision rules (Fases B/C).
 *
 * Análogo a `shouldFire` (cron) e `shouldFlagStall` (watchdog): lê o estado da
 * missão + injeta `now`, decide UMA ação, sem side-effect. O caller aplica o
 * efeito via DriveDeps (shadow log ou active apply).
 *
 * Invariantes (docs/superpowers/specs/2026-07-13-mission-driver-design.md):
 *  - não-destrutivo: `signal-stall` só avisa, nunca mata o worker;
 *  - stop só por evidence-trusted + advance/complete gates;
 *  - orçamento finito (maxIterations / maxWallClockMs) → block-human;
 *  - puro em relação ao estado (sem IO, sem relógio global).
 */

export type DriveMode = 'shadow' | 'active';

export interface DriveConfig {
  /** Silêncio (ms) antes de uma missão running ser considerada stalled. */
  readonly stallMs: number;
  /** Intervalo mínimo (ms) entre dois signal-stall (debounce anti-spam). */
  readonly stallResignalMs: number;
  /** Máximo de iterações do drive antes de block-human. */
  readonly maxIterations: number;
  /** Máximo de respawns consecutivos de pane morto antes de block-human. */
  readonly maxRespawnAttempts: number;
  /** Wall-clock máximo (ms) desde startedAt antes de block-human. */
  readonly maxWallClockMs: number;
  /** Quantidade de signal-stall consecutivos que caracteriza stall crônico. */
  readonly chronicStallCount: number;
  /** Base do backoff exponencial entre iterações (ms); usado pelo runtime. */
  readonly baseBackoffMs: number;
  /** shadow = só observa; active = aplica efeitos via deps. */
  readonly mode: DriveMode;
}

/** Config padrão do drive. Canônica aqui (módulo puro) e congelada em runtime. */
export const defaultDriveConfig: DriveConfig = Object.freeze({
  stallMs: 10 * 60_000,
  stallResignalMs: 5 * 60_000,
  maxIterations: 50,
  // Pane que morre logo após CADA respawn não se cura respawnando de novo
  // (evidência de campo: 10 respawns "success" em 16min, missão eternamente
  // blocked). Após o teto, block-human com causa acionável.
  maxRespawnAttempts: 3,
  maxWallClockMs: 4 * 60 * 60_000, // 4h
  chronicStallCount: 5,
  baseBackoffMs: 1_000,
  // Default SHADOW: só observa/loga (zero efeito). Ativar efeitos autônomos
  // (Fase C) exige opt-in — settings missionDriverActiveMode ou config.mode
  // explícito. Nunca shipar active como default sem validação runtime.
  mode: 'shadow' as DriveMode,
});

export interface DriveStep {
  readonly id: string;
  readonly label: string;
  readonly status: MilestoneStatus;
  readonly evidenceIds: readonly string[];
  /** True when every evidenceId is in the trusted set (nexus-trusted). */
  readonly trustedEvidenceReady: boolean;
}

export interface DriveState {
  readonly missionId: string;
  readonly missionStatus: MissionStatus;
  /** ms desde epoch do último progresso observado (handoff/output/evidence). */
  readonly lastProgressAt: number;
  /**
   * `true` quando houve progresso DEPOIS do último sinal de stall — o registro
   * não pode carregar um `stalled` obsoleto para sempre, nem política alguma
   * pode seguir agindo sobre ele.
   */
  readonly stallResolved?: boolean;
  /** ms desde epoch do último signal-stall emitido (debounce); indefinido se nunca. */
  readonly lastStallSignalAt?: number;
  /** Structured step checkpoints (Fase B). */
  readonly steps: readonly DriveStep[];
  /** First non-done step id, if any. */
  readonly currentStepId?: string;
  /** Current step has nexus-trusted evidence ready to advance. */
  readonly trustedEvidenceReadyForCurrent: boolean;
  /** All steps present and status=done (PREVC path complete). */
  readonly allStepsDone: boolean;
  /** Todo dispatch concluído E com recibo: conclusão provada pelo trabalho. */
  readonly workProven: boolean;
  /** Todo dispatch concluído, mas faltando recibo: parada visível, não silêncio. */
  readonly workDoneUnproven: boolean;
  /** A persisted PREVC contract/workflow still owns terminal completion. */
  readonly prevcCompletionRequired: boolean;
  /** Complete workflow plus an immutable, ordered receipt for every step. */
  readonly completionVerified: boolean;
  /** Context-rot signal (fresh-context recovery). */
  readonly contextRot: boolean;
  /** Dead pane signal. */
  readonly paneDead: boolean;
  /** Account/adapter failure signal (failover re-route). */
  readonly accountFailed: boolean;
  /** Drive iteration counter (budget). */
  readonly iteration: number;
  /** When this drive attempt started (wall-clock budget). */
  readonly startedAt: number;
  /** How many stall signals have been emitted for this mission (chronic). */
  readonly stallSignalCount: number;
  /**
   * ms since epoch of the last non-wait action applied (or decided+applied).
   * Used with `driveBackoffMs(iteration, baseBackoffMs)` to enforce exponential
   * backoff between recovery attempts — not just a fixed tick interval.
   */
  readonly lastActionAt?: number;
  /** Kind da última ação aplicada (runtime durável) — detecta loop de respawn. */
  readonly lastActionKind?: string;
}

export type DriveAction =
  | { readonly kind: 'wait'; readonly reason: string }
  | {
      readonly kind: 'signal-stall';
      readonly reason: string;
      readonly silentForMs: number;
    }
  | { readonly kind: 'respawn-fresh-context'; readonly reason: string }
  | { readonly kind: 're-route'; readonly reason: string }
  | {
      readonly kind: 'advance';
      readonly reason: string;
      readonly stepId: string;
    }
  | { readonly kind: 'block-human'; readonly reason: string }
  | { readonly kind: 'complete'; readonly reason: string };

/**
 * Decide a próxima ação do drive para uma missão. Pura: sem IO, sem relógio
 * global (recebe `now`), sem mutação.
 *
 * Prioridade (alto → baixo):
 * 1. não-running → wait
 * 2. budget esgotado → block-human
 * 3. all steps done → complete
 * 4. account fail → re-route
 * 5. pane dead / context rot → respawn-fresh-context
 * 6. trusted evidence no step atual → advance
 * 7. stall crônico → block-human
 * 8. silêncio ≥ stallMs → signal-stall (com debounce)
 * 9. senão → wait
 */
export function decideDriveAction(
  state: DriveState,
  now: number,
  config: DriveConfig,
): DriveAction {
  if (state.missionStatus !== 'running') {
    return { kind: 'wait', reason: `mission is ${state.missionStatus}` };
  }

  // A fully receipted PREVC outcome is terminal and cannot consume another
  // recovery attempt. In particular, the last allowed advance may finish all
  // steps exactly at the iteration or wall-clock boundary.
  if (state.completionVerified) {
    return { kind: 'complete', reason: 'all steps done via PREVC' };
  }

  // O TRABALHO manda. Todo dispatch concluído e com recibo é conclusão provada,
  // independente de milestone carimbado — a cerimônia é opcional, o trabalho não.
  if (state.workProven && !state.prevcCompletionRequired) {
    return {
      kind: 'complete',
      reason: 'todos os dispatches concluídos com recibo de integração',
    };
  }

  // Trabalho todo feito e sem prova NÃO pode virar espera silenciosa: foi
  // exatamente isso que deixou o dono olhando uma tela parada, com o driver
  // decidindo `wait` em todo tick e attempt_count zerado.
  if (state.workDoneUnproven) {
    return {
      kind: 'block-human',
      reason:
        'todos os dispatches concluíram, mas falta recibo de integração em ' +
        'pelo menos um — trabalho sem prova não é conclusão',
    };
  }

  if (state.allStepsDone) {
    return {
      kind: 'block-human',
      reason: 'all steps are marked done but PREVC receipts are incomplete',
    };
  }

  if (state.iteration >= config.maxIterations) {
    return {
      kind: 'block-human',
      reason: `maxIterations (${config.maxIterations}) exhausted`,
    };
  }
  const wallElapsed = now - state.startedAt;
  if (Number.isFinite(wallElapsed) && wallElapsed >= config.maxWallClockMs) {
    return {
      kind: 'block-human',
      reason: `maxWallClockMs (${config.maxWallClockMs}) exhausted`,
    };
  }

  const silentForMs = now - state.lastProgressAt;
  const silentOk =
    Number.isFinite(silentForMs) && silentForMs >= 0;
  if (
    silentOk &&
    silentForMs >= config.stallMs &&
    state.stallSignalCount >= config.chronicStallCount
  ) {
    return {
      kind: 'block-human',
      reason: `chronic stall (${state.stallSignalCount} signals)`,
    };
  }

  // A trusted PREVC receipt is deterministic forward progress, not a recovery
  // retry. Advancing it immediately prevents a long plan from accumulating an
  // exponential delay after every already-proven milestone. The evidence gate
  // in advanceStep remains the authority boundary, and the finite iteration
  // budget above still applies.
  if (state.currentStepId && state.trustedEvidenceReadyForCurrent) {
    return {
      kind: 'advance',
      reason: 'trusted evidence ready for current step',
      stepId: state.currentStepId,
    };
  }

  // Recovery actions sit behind exponential backoff so a fixed DRIVE_TICK_MS
  // poll cannot thrash respawn/stall/re-route.
  if (isWithinBackoff(state, now, config)) {
    return {
      kind: 'wait',
      reason: backoffReason(state, now, config),
    };
  }

  if (state.accountFailed) {
    return { kind: 're-route', reason: 'account or adapter failed' };
  }

  // Loop de respawn: pane que continua morto DEPOIS de respawns sucessivos
  // não se cura com mais um respawn (evidência de campo: 10 "success" em
  // 16min, missão eternamente presa). Estado terminal acionável em vez de
  // churn infinito — o Retomar do rail re-engaja depois que o usuário
  // resolver a causa (login/credencial do adapter é a mais comum).
  if (
    (state.paneDead || state.contextRot) &&
    state.lastActionKind === 'respawn-fresh-context' &&
    state.iteration >= config.maxRespawnAttempts
  ) {
    return {
      kind: 'block-human',
      reason:
        `pane morre repetidamente após ${state.iteration} respawns — ` +
        'verifique login/credencial do adapter e use Retomar no rail',
    };
  }

  if (state.paneDead) {
    return { kind: 'respawn-fresh-context', reason: 'pane dead' };
  }
  if (state.contextRot) {
    return { kind: 'respawn-fresh-context', reason: 'context rot' };
  }

  // Clock-skew / NaN defense: lastProgressAt no futuro ou NaN não mascara stall.
  if (!silentOk) {
    return {
      kind: 'wait',
      reason: `clock skew (silentForMs=${silentForMs})`,
    };
  }
  if (silentForMs >= config.stallMs) {
    const lastSignal = state.lastStallSignalAt;
    if (
      lastSignal !== undefined &&
      now - lastSignal < config.stallResignalMs
    ) {
      return {
        kind: 'wait',
        reason: 'stalled but re-signaled too recently',
      };
    }
    return {
      kind: 'signal-stall',
      reason: `no progress for ${Math.round(silentForMs / 60_000)}min`,
      silentForMs,
    };
  }

  return {
    kind: 'wait',
    reason: `progress ${Math.round(silentForMs / 1000)}s ago`,
  };
}

function isWithinBackoff(
  state: DriveState,
  now: number,
  config: DriveConfig,
): boolean {
  if (state.lastActionAt === undefined) return false;
  const backoff = driveBackoffMs(state.iteration, config.baseBackoffMs);
  const since = now - state.lastActionAt;
  return Number.isFinite(since) && since >= 0 && since < backoff;
}

function backoffReason(
  state: DriveState,
  now: number,
  config: DriveConfig,
): string {
  const backoff = driveBackoffMs(state.iteration, config.baseBackoffMs);
  const since = now - (state.lastActionAt ?? now);
  return `exponential backoff ${backoff}ms (iteration ${state.iteration}, ${Math.round(since)}ms elapsed)`;
}

/**
 * Entrada da derivação: campos mínimos de Mission/Handoff + sinais externos.
 * Mantém a função pura e testável sem DB.
 */
export interface DriveStateSignals {
  readonly contextRot?: boolean;
  readonly paneDead?: boolean;
  readonly accountFailed?: boolean;
  readonly iteration?: number;
  readonly startedAt?: number;
  readonly stallSignalCount?: number;
  readonly lastActionAt?: number;
  readonly lastActionKind?: string;
  readonly completionVerified?: boolean;
  readonly prevcCompletionRequired?: boolean;
}

export interface DriveStateInputs {
  readonly mission: Pick<
    Mission,
    'id' | 'status' | 'updatedAt' | 'milestones' | 'createdAt'
  >;
  readonly handoffs: ReadonlyArray<
    Pick<Handoff, 'status' | 'createdAt' | 'evidenceTrust' | 'evidenceIds'>
  >;
  readonly signals?: DriveStateSignals;
  /**
   * Instante da última ATIVIDADE observável do worker (tool call, resultado,
   * início de turno). Vivacidade não pode ser medida só por `mission.updatedAt`
   * e cadência de handoff: uma unidade legítima de 26 minutos não produz
   * handoff nenhum e não toca a linha da missão, e o detector a declarava
   * parada com o processo trabalhando (falso positivo HiperGO 06/08).
   * Ausente = não instrumentado; nunca fabrica vivacidade.
   */
  readonly lastWorkerActivityAt?: number;
  /**
   * Estado da FILA DE DISPATCH — a verdade sobre o trabalho.
   *
   * A conclusão passa a ser derivada daqui, não de milestone carimbado. O
   * carimbo é artefato de CERIMÔNIA, e o caminho simples (`same_checkout`,
   * padrão desde 5c0208b9) legitimamente não o produz: quando a cerimônia saiu,
   * levou junto o batimento que este driver observava, e a missão do gate 0.28.0
   * ficou com 8/8 dispatches `completed` e `step-1` eternamente `pending`.
   *
   * `receipted` conta os concluídos que trouxeram recibo de integração. Concluir
   * sem recibo não é conclusão: é trabalho sem prova, e vira parada VISÍVEL.
   *
   * Ausente = sem instrumentação de fila; o comportamento antigo permanece e
   * nada é fabricado.
   */
  readonly dispatchWork?: {
    readonly total: number;
    readonly completed: number;
    readonly receipted: number;
  };
  /** Optional explicit trusted evidence ids (overrides derivation from handoffs). */
  readonly trustedEvidenceIds?: ReadonlySet<string>;
}

function deriveTrustedEvidenceIds(
  handoffs: DriveStateInputs['handoffs'],
  override?: ReadonlySet<string>,
): ReadonlySet<string> {
  if (override) return override;
  const ids = new Set<string>();
  for (const handoff of handoffs) {
    if (handoff.evidenceTrust !== 'nexus-trusted') continue;
    for (const evidenceId of handoff.evidenceIds) {
      ids.add(evidenceId);
    }
  }
  return ids;
}

/**
 * Trusted evidence ids that are not already claimed by done steps.
 * Prevents step N from advancing by reusing step N-1's nexus-trusted ids.
 */
export function unusedTrustedEvidenceIds(
  milestones: readonly MissionMilestone[],
  trusted: ReadonlySet<string>,
): string[] {
  const used = new Set<string>();
  for (const milestone of milestones) {
    if (milestone.status !== 'done') continue;
    for (const id of milestone.evidenceIds) used.add(id);
  }
  const available: string[] = [];
  for (const id of trusted) {
    if (!used.has(id)) available.push(id);
  }
  return available;
}

/**
 * Build a drive step. When the step has empty evidenceIds and is the current
 * (first non-done) step, bind *unused* mission-level nexus-trusted evidence
 * so advance is reachable without a separate "attach evidence" write first.
 */
export function toDriveStep(
  milestone: MissionMilestone,
  trusted: ReadonlySet<string>,
  options: {
    readonly isCurrent?: boolean;
    readonly unusedTrustedIds?: readonly string[];
  } = {},
): DriveStep {
  const storedIds = [...milestone.evidenceIds];
  const unused = options.unusedTrustedIds ?? [...trusted];
  const effectiveIds =
    storedIds.length > 0
      ? storedIds
      : options.isCurrent === true && unused.length > 0
        ? [...unused]
        : storedIds;
  // Trust set for readiness is the full trusted set (stored ids must still
  // resolve as trusted) — unused only affects inheritance for empty steps.
  return {
    id: milestone.id,
    label: milestone.label,
    status: milestone.status,
    evidenceIds: effectiveIds,
    trustedEvidenceReady: canMarkMilestoneDone(
      { evidenceIds: effectiveIds },
      trusted,
    ),
  };
}

/**
 * Deriva DriveState a partir da missão + handoffs + sinais (pura, sem IO).
 *
 * - `lastProgressAt` = máximo entre `mission.updatedAt` e o `createdAt` dos
 *   handoffs NÃO-stalled. `blocked`/`failed` CONTAM como progresso.
 * - `lastStallSignalAt` = `createdAt` do handoff stalled mais recente.
 * - steps + trustedEvidenceReady: current step inherits mission trusted
 *   evidence when its own evidenceIds is empty (makes advance reachable).
 */
export function deriveDriveState(input: DriveStateInputs): DriveState {
  const { mission, handoffs, signals } = input;
  const trusted = deriveTrustedEvidenceIds(handoffs, input.trustedEvidenceIds);

  let lastProgressAt = mission.updatedAt;
  let lastStallSignalAt: number | undefined;
  let stallFromHandoffs = 0;
  for (const handoff of handoffs) {
    if (handoff.status === 'stalled') {
      stallFromHandoffs += 1;
      if (
        lastStallSignalAt === undefined ||
        handoff.createdAt > lastStallSignalAt
      ) {
        lastStallSignalAt = handoff.createdAt;
      }
      continue;
    }
    if (handoff.createdAt > lastProgressAt) {
      lastProgressAt = handoff.createdAt;
    }
  }

  // Atividade real do worker é progresso, tanto quanto um handoff.
  const activityAt = input.lastWorkerActivityAt;
  if (
    typeof activityAt === 'number' &&
    Number.isFinite(activityAt) &&
    activityAt > lastProgressAt
  ) {
    lastProgressAt = activityAt;
  }

  const unusedTrusted = unusedTrustedEvidenceIds(mission.milestones, trusted);
  const currentIndex = mission.milestones.findIndex(
    (milestone) => milestone.status !== 'done',
  );
  const steps = mission.milestones.map((milestone, index) =>
    toDriveStep(milestone, trusted, {
      isCurrent: index === currentIndex,
      unusedTrustedIds: unusedTrusted,
    }),
  );
  const current = steps.find((step) => step.status !== 'done');
  const allStepsDone =
    steps.length > 0 && steps.every((step) => step.status === 'done');

  // Conclusão derivada do TRABALHO. `total > 0` é deliberado: missão que nunca
  // despachou nada não tem trabalho feito — zero não é "tudo pronto".
  const work = input.dispatchWork;
  const allDispatchesDone =
    work !== undefined && work.total > 0 && work.completed === work.total;
  const workProven = allDispatchesDone && work.receipted === work.total;
  const workDoneUnproven = allDispatchesDone && !workProven;

  return {
    missionId: mission.id,
    missionStatus: mission.status,
    lastProgressAt,
    stallResolved:
      lastStallSignalAt !== undefined && lastProgressAt > lastStallSignalAt,
    ...(lastStallSignalAt !== undefined ? { lastStallSignalAt } : {}),
    steps,
    ...(current ? { currentStepId: current.id } : {}),
    trustedEvidenceReadyForCurrent: current?.trustedEvidenceReady === true,
    allStepsDone,
    workProven,
    workDoneUnproven,
    prevcCompletionRequired: signals?.prevcCompletionRequired === true,
    completionVerified: signals?.completionVerified === true,
    contextRot: signals?.contextRot === true,
    paneDead: signals?.paneDead === true,
    accountFailed: signals?.accountFailed === true,
    iteration: signals?.iteration ?? 0,
    startedAt: signals?.startedAt ?? mission.createdAt,
    stallSignalCount: signals?.stallSignalCount ?? stallFromHandoffs,
    ...(signals?.lastActionKind !== undefined
      ? { lastActionKind: signals.lastActionKind }
      : {}),
    ...(signals?.lastActionAt !== undefined
      ? { lastActionAt: signals.lastActionAt }
      : {}),
  };
}

/** Exponential backoff delay for iteration N (0-based). Capped at 5 min. */
export function driveBackoffMs(iteration: number, baseMs: number): number {
  const safeIteration = Math.max(0, Math.min(iteration, 12));
  const delay = baseMs * 2 ** safeIteration;
  return Math.min(delay, 5 * 60_000);
}
