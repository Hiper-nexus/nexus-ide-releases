import { hasFlag } from './agent-cli-flag-detection';
import type { AgentSessionOptionCatalog } from './agent-session-option-catalog-types';
import { MIMO_MODELS } from './mimo-models';

export const MIMO_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  models: MIMO_MODELS.map((model, index) => ({ id: `xiaomi/${model.id}`, label: model.name, isDefault: index === 0, options: [] })),
  supportsWorkerLaunchPreferences: true,
  modelApply: {
    launchArgs: value => ['--model', String(value)],
    agentArgsOverride: tokens => hasFlag(tokens, ['--model', '-m']),
    midSession: { kind: 'agent-picker', command: '/models', delivery: 'type' },
  },
};
