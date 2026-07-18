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
  const used =
    input.missionAdapterIds && input.missionAdapterIds.length > 0
      ? new Set(input.missionAdapterIds)
      : undefined;
  return {
    ompParticipation: input.ompParticipation,
    missionUsedAdapters: used,
    preferAdapters: input.preferAdapters,
  };
}
