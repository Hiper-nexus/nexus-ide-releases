import { beforeEach, describe, expect, it } from 'vitest';
import {
  MODEL_ACCESS_QUARANTINE_MS,
  modelAccessQuarantine,
  quarantineRejectedModel,
  resetModelAccessQuarantineForTests,
} from './model-access-quarantine';

beforeEach(() => resetModelAccessQuarantineForTests());

describe('quarentena de modelo recusado pelo provider (F-683)', () => {
  it('guarda o motivo pelo par CLI + modelo até vencer', () => {
    quarantineRejectedModel('opencode', 'opencode/deepseek-v4-flash', 'Model access is disabled', 1_000);
    expect(modelAccessQuarantine('opencode', 'OpenCode/DeepSeek-V4-Flash', 2_000)).toBe('Model access is disabled');
    expect(modelAccessQuarantine('opencode', 'opencode/outro', 2_000)).toBeNull();
    expect(modelAccessQuarantine('codex', 'opencode/deepseek-v4-flash', 2_000)).toBeNull();
    expect(modelAccessQuarantine('opencode', 'opencode/deepseek-v4-flash', 1_000 + MODEL_ACCESS_QUARANTINE_MS)).toBeNull();
  });

  it('pane sem modelo conhecido não entra em quarentena', () => {
    quarantineRejectedModel('opencode', undefined, 'x', 1_000);
    expect(modelAccessQuarantine('opencode', undefined, 1_000)).toBeNull();
  });
});
