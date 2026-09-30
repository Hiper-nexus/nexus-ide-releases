import type { AgentGateContext } from './gate';
import type { Mission } from '../../shared/orch-types';
import { getProjectDomainStores } from './project-domain-store-registry';
import { maestroStandingDoctrine } from './orchestrator-doctrine';

type MaestroContext = Pick<AgentGateContext, 'role' | 'missionId' | 'providerId'> &
  Partial<Pick<AgentGateContext, 'scope'>>;

export type MissionLookup = (ctx: MaestroContext) => Mission | null;

const lookupMission: MissionLookup = (ctx) =>
  ctx.scope && ctx.missionId
    ? getProjectDomainStores(ctx.scope).missions.get(ctx.missionId) ?? null
    : null;

/**
 * Doutrina permanente (F-701) do orquestrador de uma missão que despacha
 * workers. Missão ilegível (store fechado, linha sumida) → nada.
 */
export function maestroStandingDoctrineFor(
  ctx: MaestroContext,
  lookup: MissionLookup = lookupMission,
): string | null {
  if (ctx.role !== 'orchestrator' || !ctx.missionId) return null;
  try {
    return maestroStandingDoctrine(lookup(ctx));
  } catch {
    return null;
  }
}

/**
 * Mesmo canal da doutrina do operador: `instructions` do MCP para toda CLI,
 * menos o Codex, que cola as instructions em cada tool e recebe a doutrina
 * pelo hook UserPromptSubmit (hook-delegate-endpoint).
 */
export function maestroStandingContext(
  ctx: MaestroContext,
  channel: 'mcp' | 'hook',
  lookup: MissionLookup = lookupMission,
): string | null {
  if ((ctx.providerId === 'codex') !== (channel === 'hook')) return null;
  return maestroStandingDoctrineFor(ctx, lookup);
}
