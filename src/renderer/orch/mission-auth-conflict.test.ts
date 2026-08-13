import { describe, expect, it } from 'vitest';
import {
  hardReopenWouldKillAgents,
  isExclusiveOrchestratorAdapter,
  sharedAuthFamily,
} from './mission-auth-conflict';

describe('sharedAuthFamily', () => {
  it('marks Claude adapters as a shared login family without requiring a kill', () => {
    expect(sharedAuthFamily('claude')).toBe('claude-shared-login');
    expect(sharedAuthFamily('claude-code')).toBe('claude-shared-login');
    expect(isExclusiveOrchestratorAdapter('claude')).toBe(true);
    expect(hardReopenWouldKillAgents('claude')).toBe(false);
  });

  it('allows parallel non-Claude orchestrators', () => {
    expect(sharedAuthFamily('codex')).toBeNull();
    expect(sharedAuthFamily('gemini')).toBeNull();
    expect(sharedAuthFamily('grok')).toBeNull();
    expect(isExclusiveOrchestratorAdapter('codex')).toBe(false);
  });
});
