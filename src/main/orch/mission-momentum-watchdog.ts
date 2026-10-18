import { createHash } from 'node:crypto';

/**
 * Vigia de esteira: uma vaga com backlog registrado/pronto não espera 20 min
 * só porque um helper idle ainda existe. Main faz somente a aritmética da
 * fila e entrega uma diretiva ao Maestro; não inventa trabalho nem despacha
 * fora da autoridade vigente. A decisão sem prova de backlog conserva o
 * formato legado para leitores antigos, sem transformar dúvida em tarefa.
 */

export const MOMENTUM_SOLO_MS = 20 * 60_000;
export const MOMENTUM_REPEAT_MS = 60 * 60_000;
export const MOMENTUM_READY_MS = 30_000;
/** A new registered queue milestone may refresh a receipt, never every scan. */
export const MOMENTUM_PROGRESS_REPEAT_MS = 60_000;

export type MomentumDecision =
  | { readonly action: 'none' }
  | {
      readonly action: 'nudge';
      readonly soloForMs: number;
      readonly readyTaskIds?: readonly string[];
      readonly availableSlots?: number;
      readonly usefulWorkingWorkers?: number;
      readonly backlogKey?: string;
    };

export function decideMomentumNudge(input: {
  readonly missionStatus: string;
  readonly lane?: string | null;
  /** Orçamento de workers da missão; 0 = execução direta. */
  readonly maxWorkers?: number | null;
  readonly workerPanes: number;
  /** Pane do orquestrador existe e não saiu/estacionou. */
  readonly orchestratorAlive: boolean;
  /** Desde quando a missão está sem worker (null = tem worker agora). */
  readonly soloSinceMs: number | null;
  readonly lastNudgeAtMs: number | null;
  readonly now: number;
  /** Present only after Main has read the actual current task/dispatch rows. */
  readonly readyTaskIds?: readonly string[];
  readonly availableSlots?: number;
  readonly usefulWorkingWorkers?: number;
  readonly readySinceMs?: number | null;
  readonly dispatchAuthorized?: boolean;
  readonly readOnly?: boolean;
  readonly backlogKey?: string;
  readonly lastBacklogKey?: string | null;
  /**
   * Bug7: missão livre/adotada (freeAgentChoice) sem plano selado — os
   * pedidos vivem no chat e nunca viram `suite.tasks`, então o backlog
   * confirmado é sempre vazio. Só com esta flag o vazio confirmado cai no
   * empurrão solo de 20 min; sem ela, vazio continua silêncio (nada de
   * inventar trabalho para missão selada/plano).
   */
  readonly soloNudgeWhenNoBacklog?: boolean;
  /**
   * O líder atual pediu done e a verificação ainda não respondeu. Abrir
   * workers agora não tem trabalho para eles e só gasta tokens; se a
   * verificação recusar (clearCompletionRequest), o nudge volta a valer.
   */
  readonly completionRequested?: boolean;
}): MomentumDecision {
  if (input.missionStatus !== 'running') return { action: 'none' };
  if (input.completionRequested === true) return { action: 'none' };
  if (input.lane === 'plan' || input.lane === 'consult')
    return { action: 'none' };
  if (input.maxWorkers === 0) return { action: 'none' };
  if (
    !input.orchestratorAlive ||
    input.dispatchAuthorized === false ||
    input.readOnly === true
  )
    return { action: 'none' };
  const legacySoloNudge = (): MomentumDecision => {
    if (input.workerPanes > 0) return { action: 'none' };
    if (input.soloSinceMs === null) return { action: 'none' };
    const soloForMs = input.now - input.soloSinceMs;
    if (soloForMs < MOMENTUM_SOLO_MS) return { action: 'none' };
    if (
      input.lastNudgeAtMs !== null &&
      input.now - input.lastNudgeAtMs < MOMENTUM_REPEAT_MS
    ) {
      return { action: 'none' };
    }
    return { action: 'nudge', soloForMs };
  };
  if (input.readyTaskIds !== undefined) {
    const max = input.maxWorkers;
    if (
      input.dispatchAuthorized !== true ||
      typeof max !== 'number' ||
      !Number.isSafeInteger(max) ||
      max <= 0
    )
      return { action: 'none' };
    const availableSlots = Math.min(
      input.availableSlots ?? 0,
      max - input.workerPanes,
    );
    if (!Number.isSafeInteger(availableSlots) || availableSlots <= 0)
      return { action: 'none' };
    // Bug7: vazio confirmado só vira empurrão solo para a missão livre/
    // adotada (flag do supervisor), herdando as cercas acima e as do ramo
    // legado (zero workers, 20 min, repetição de 1 h).
    if (input.readyTaskIds.length === 0) {
      return input.soloNudgeWhenNoBacklog === true
        ? legacySoloNudge()
        : { action: 'none' };
    }
    if (input.readySinceMs == null) return { action: 'none' };
    const readyForMs = input.now - input.readySinceMs;
    if (readyForMs < MOMENTUM_READY_MS) return { action: 'none' };
    const changed = Boolean(
      input.backlogKey &&
      input.lastBacklogKey &&
      input.backlogKey !== input.lastBacklogKey,
    );
    const cooldown = changed ? MOMENTUM_PROGRESS_REPEAT_MS : MOMENTUM_REPEAT_MS;
    if (
      input.lastNudgeAtMs !== null &&
      input.now - input.lastNudgeAtMs < cooldown
    )
      return { action: 'none' };
    return {
      action: 'nudge',
      soloForMs: readyForMs,
      readyTaskIds: input.readyTaskIds,
      availableSlots,
      usefulWorkingWorkers: input.usefulWorkingWorkers ?? 0,
      backlogKey: input.backlogKey,
    };
  }
  return legacySoloNudge();
}

export function momentumNudgeSummary(
  missionId: string,
  soloForMs: number,
  ready?: Extract<MomentumDecision, { readonly action: 'nudge' }>,
): string {
  if (ready?.readyTaskIds?.length) {
    const count = Math.min(
      ready.availableSlots ?? 0,
      ready.readyTaskIds.length,
    );
    return (
      `[momentum:${missionId}] [momentum-ready:${ready.backlogKey}] Há ${ready.readyTaskIds.length} tarefas registradas prontas e ${ready.availableSlots} vagas do orçamento da missão; ${ready.usefulWorkingWorkers} workers trabalhando agora. ` +
      `Preencha até ${count} vagas visíveis com as tarefas existentes (${ready.readyTaskIds.slice(0, count).join(', ')}), sem esperar o próximo handoff ou o gate longo. ` +
      'Se o PREVC estiver congelado, continue somente pelo dispatcher Main e pelo plano vigente, sem spawn manual nem remover o selo. ' +
      'Na Via Rápida/execução livre, use UMA chamada nexus_pane_spawn com task/prompt por worker; os gates de dependências, ownership/roster e orçamento continuam valendo. Use a pasta de execução que o Main autorizar, sem trocar de checkout para contornar uma restrição. ' +
      'Respeite readOnly, allowlists e a política nativa de subagentes existente; mantenha a escolha livre somente quando freeAgentChoice estiver aprovado. ' +
      'Não invente tarefas. Comando pesado local (validador, make verify, suíte) continua um por vez; outros workers podem avançar trabalho independente sem rodar a mesma suíte pesada.'
    );
  }
  const minutes = Math.max(1, Math.round(soloForMs / 60_000));
  return (
    `[momentum:${missionId}] Esteira parada: a missão está sem nenhum worker há ${minutes} min. ` +
    'Gate longo (validador, make verify, suíte) não para a missão: enquanto ele roda, abra ' +
    'workers para as próximas unidades independentes do objetivo — planejar, implementar em ' +
    'worktree isolada (isolatedWriter: true), revisar. Só comando pesado local vai um por vez, ' +
    'e os workers não rodam suíte pesada enquanto o gate roda. Se nada pode avançar antes do ' +
    'gate, diga o porquê numa linha e siga.'
  );
}

/** Read only the structured footer written by nexus_task plan. Prose is not a graph. */
function declaredDependencies(detail: string): readonly string[] | null {
  const marker = detail.lastIndexOf('[plan-meta]');
  if (marker < 0) return [];
  try {
    const metadata: unknown = JSON.parse(
      detail.slice(marker + '[plan-meta]'.length),
    );
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      return null;
    const deps = (metadata as { dependsOn?: unknown }).dependsOn;
    if (deps === undefined) return [];
    if (
      !Array.isArray(deps) ||
      deps.some((id) => typeof id !== 'string' || !id.trim())
    )
      return null;
    return deps as string[];
  } catch {
    return null;
  }
}

/** Arithmetic projection of actual registered rows; never grants spawn authority. */
export function momentumReadyBacklog(input: {
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly status: string;
    readonly detail: string;
    readonly providerWaiverReason?: string;
  }>;
  readonly intentVersion?: number;
  readonly sealedTasks?: ReadonlyArray<{
    readonly taskId: string;
    readonly plannerId: string;
    readonly detail: string;
  }>;
  readonly dispatches: ReadonlyArray<{
    readonly taskId: string;
    readonly state: string;
    readonly revision?: number;
    readonly attempt?: number;
  }>;
}): { readonly readyTaskIds: readonly string[]; readonly backlogKey: string } {
  const sealed = input.sealedTasks
    ? new Map(input.sealedTasks.map((row) => [row.taskId, row]))
    : null;
  const selected = input.tasks.filter((row) => !sealed || sealed.has(row.id));
  const known = new Set(selected.map((row) => row.id));
  const plannerIds = new Map(
    input.sealedTasks?.map((row) => [row.plannerId, row.taskId]) ?? [],
  );
  const dispatches = new Map(input.dispatches.map((row) => [row.taskId, row]));
  const done = new Set(
    selected
      .filter(
        (row) =>
          row.status === 'done' &&
          !row.providerWaiverReason &&
          (!dispatches.has(row.id) ||
            dispatches.get(row.id)!.state === 'completed'),
      )
      .map((row) => row.id),
  );
  const readyTaskIds = selected
    .filter((row) => {
      if (row.status !== 'pending') return false;
      const dispatch = dispatches.get(row.id);
      // Active, blocked/suspended and contradictory terminal dispatches are not vacancies.
      if (dispatch && dispatch.state !== 'failed') return false;
      const deps = declaredDependencies(
        sealed?.get(row.id)?.detail ?? row.detail,
      );
      return (
        deps !== null &&
        deps.every((dependency) => {
          const id = plannerIds.get(dependency) ?? dependency;
          return known.has(id) && done.has(id);
        })
      );
    })
    .map((row) => row.id)
    .sort();
  const key = [
    input.intentVersion ?? 0,
    readyTaskIds.map((id) => [
      id,
      dispatches.get(id)?.state ?? null,
      dispatches.get(id)?.attempt ?? null,
      dispatches.get(id)?.revision ?? null,
    ]),
    [...done].sort(),
  ];
  return {
    readyTaskIds,
    backlogKey: createHash('sha256').update(JSON.stringify(key)).digest('hex'),
  };
}
