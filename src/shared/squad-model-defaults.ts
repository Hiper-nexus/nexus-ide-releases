import { CODEX_FRONTIER_MODEL } from './model-defaults';

/** Product defaults for newly created or provider-switched squad agents. */
export const SQUAD_MODEL_DEFAULTS = {
  codex: CODEX_FRONTIER_MODEL,
  grok: 'grok-4.6',
  gemini: 'gemini-3.8-pro-high',
} as const;

export function defaultSquadModelForAdapter(adapterId: string): string | undefined {
  switch (adapterId.trim().toLowerCase()) {
    case 'codex':
      return SQUAD_MODEL_DEFAULTS.codex;
    case 'grok':
      return SQUAD_MODEL_DEFAULTS.grok;
    case 'agy':
    case 'antigravity-cli':
      return SQUAD_MODEL_DEFAULTS.gemini;
    default:
      return undefined;
  }
}

export function applySquadModelDefault<T extends { cli: string; model?: string }>(
  agent: T,
): T & { model?: string } {
  if (agent.model?.trim()) return { ...agent };
  const model = defaultSquadModelForAdapter(agent.cli);
  return model ? { ...agent, model } : { ...agent };
}
