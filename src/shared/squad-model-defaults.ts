/** Product defaults for newly created or provider-switched squad agents. */
export const SQUAD_MODEL_DEFAULTS = {
  codex: 'gpt-5.6-terra',
  grok: 'grok-4.5',
  gemini: 'gemini-3.7-flash-high',
} as const;

export function defaultSquadModelForAdapter(adapterId: string): string | undefined {
  switch (adapterId.trim().toLowerCase()) {
    case 'codex':
      return SQUAD_MODEL_DEFAULTS.codex;
    case 'grok':
      return SQUAD_MODEL_DEFAULTS.grok;
    case 'agy':
    case 'gemini-cli':
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
