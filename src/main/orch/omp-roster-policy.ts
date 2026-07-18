/**
 * Oh My Pi participation policy for squad roster spawns and routing context.
 * Pure logic — unit-tested; production wires orch settings + adapter install.
 */
import type { OmpParticipation } from '../../shared/settings-types';
import type { RouteContext } from './task-router';

export interface StickyOmpInput {
  rosterCli: string;
  requestedAdapterId: string | undefined;
  requestedModel: string | undefined;
  rosterModel: string | undefined;
  rosterEffort: string | undefined;
  requestedEffort: string | undefined;
  ompInstalled: boolean;
  ompParticipation: OmpParticipation;
  /** Adapter catalog default when roster has no model. */
  defaultOmpModel?: string;
}

export interface StickyOmpResult {
  adapterId: string;
  model: string | undefined;
  effort: string | undefined;
  /** True when roster cli=omp was forced despite a route_task override. */
  sticky: boolean;
}

/**
 * Roster-sticky omp: when the squad agent is declared as omp and participation
 * is not `off`, keep adapterId=omp even if the orchestrator passed a different
 * route_task adapter. Models from route_task only stick when the requested
 * adapter was already omp.
 */
export function resolveStickyOmpAdapter(input: StickyOmpInput): StickyOmpResult {
  const baseAdapter = input.requestedAdapterId ?? input.rosterCli;
  const baseModel = input.requestedModel ?? input.rosterModel;
  const baseEffort = input.requestedEffort ?? input.rosterEffort;

  if (input.rosterCli !== 'omp') {
    return {
      adapterId: baseAdapter,
      model: baseModel,
      effort: baseEffort,
      sticky: false,
    };
  }

  if (input.ompParticipation === 'off' || !input.ompInstalled) {
    return {
      adapterId: baseAdapter,
      model: baseModel,
      effort: baseEffort,
      sticky: false,
    };
  }

  const model =
    input.requestedAdapterId === 'omp'
      ? (input.requestedModel ?? input.rosterModel ?? input.defaultOmpModel)
      : (input.rosterModel ?? input.defaultOmpModel);

  return {
    adapterId: 'omp',
    model,
    effort: baseEffort,
    sticky: baseAdapter !== 'omp',
  };
}

/** Build RouteContext from orch settings + mission pane adapter history. */
export function buildOmpRouteContext(input: {
  ompParticipation: OmpParticipation;
  missionAdapterIds?: readonly string[];
  preferAdapters?: readonly string[];
}): RouteContext {
  const ids = input.missionAdapterIds ?? [];
  const used = ids.length > 0 ? new Set(ids) : undefined;
  const missionUseCounts =
    ids.length > 0
      ? ids.reduce((map, id) => {
          map.set(id, (map.get(id) ?? 0) + 1);
          return map;
        }, new Map<string, number>())
      : undefined;
  return {
    ompParticipation: input.ompParticipation,
    missionUsedAdapters: used,
    missionUseCounts,
    preferAdapters: input.preferAdapters,
  };
}

/**
 * Whether the system should auto-spawn one omp companion after a non-omp
 * mission worker starts — zero human / Maestro friction.
 */
export function shouldAutoSpawnOmpCompanion(input: {
  ompParticipation: OmpParticipation;
  ompAutoSpawn: boolean;
  ompInstalled: boolean;
  justSpawnedAdapterId: string;
  missionHasOmp: boolean;
  /** Orchestrator panes never trigger companion. */
  role?: 'orchestrator' | 'worker' | string;
}): boolean {
  if (!input.ompAutoSpawn) return false;
  if (input.role === 'orchestrator') return false;
  if (input.ompParticipation === 'off' || input.ompParticipation === 'fallback') {
    return false;
  }
  if (!input.ompInstalled) return false;
  if (input.missionHasOmp) return false;
  if (input.justSpawnedAdapterId === 'omp') return false;
  return true;
}

/** Compact unattended brief for the auto omp worker. */
export function buildOmpAutoSpawnPrompt(input: {
  missionId: string;
  goalHint?: string;
}): string {
  const goal = input.goalHint?.trim();
  return [
    'Você é o worker Oh My Pi desta missão Nexus. Rode em piloto automático.',
    `missionId=${input.missionId}`,
    goal ? `Contexto: ${goal.slice(0, 1_200)}` : null,
    'Execute: leia o workspace, avance o objetivo, use tools host quando útil.',
    'Não peça confirmação humana. Ao terminar, nexus_handoff_submit com resumo.',
    'Fale pouco em PT-BR só no handoff final.',
  ]
    .filter(Boolean)
    .join('\n');
}
