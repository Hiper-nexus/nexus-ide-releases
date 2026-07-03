import { beforeEach, describe, expect, it } from 'vitest';
import {
  bindTokenToSession,
  canonicalToolName,
  evaluateStop,
  getContext,
  getContextBySession,
  isSkillAllowed,
  isToolAllowed,
  markHandoffSubmitted,
  MAX_STOP_ATTEMPTS,
  mintToken,
  releaseSession,
  resetGateForTests,
} from './gate';

describe('canonicalToolName', () => {
  it('strips the nexus_ and overclock_ namespaces', () => {
    expect(canonicalToolName('nexus_pane_spawn')).toBe('pane_spawn');
    expect(canonicalToolName('overclock_pane_spawn')).toBe('pane_spawn');
    expect(canonicalToolName('pane_spawn')).toBe('pane_spawn');
  });

  it('lowercases mixed-case client tool names', () => {
    expect(canonicalToolName('ToolSearch')).toBe('toolsearch');
  });
});

describe('isToolAllowed', () => {
  it('treats a null allowlist as unrestricted (Overclock semantics)', () => {
    expect(isToolAllowed(null, 'nexus_pane_spawn')).toBe(true);
    expect(isToolAllowed(null, 'Bash')).toBe(true);
  });

  it('blocks tools outside the allowlist', () => {
    expect(isToolAllowed(['Read', 'Grep'], 'Bash')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_spawn')).toBe(false);
  });

  it('matches across namespaces', () => {
    expect(isToolAllowed(['nexus_pane_read'], 'overclock_pane_read')).toBe(true);
    expect(isToolAllowed(['pane_read'], 'nexus_pane_read')).toBe(true);
  });

  it('always allows handoff tools and ToolSearch, even with empty allowlist', () => {
    expect(isToolAllowed([], 'nexus_handoff_submit')).toBe(true);
    expect(isToolAllowed([], 'handoff_list')).toBe(true);
    expect(isToolAllowed([], 'ToolSearch')).toBe(true);
  });
});

describe('isSkillAllowed', () => {
  it('null allowlist is unrestricted', () => {
    expect(isSkillAllowed(null, 'anything')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isSkillAllowed(['code-review'], 'Code-Review')).toBe(true);
    expect(isSkillAllowed(['code-review'], 'deploy')).toBe(false);
  });
});

describe('token registry + stop gate', () => {
  beforeEach(() => resetGateForTests());

  it('mints unique tokens and binds them to sessions', () => {
    const a = mintToken({ label: 'worker-a', role: 'worker' });
    const b = mintToken({ label: 'worker-b', role: 'worker' });
    expect(a.token).not.toBe(b.token);

    bindTokenToSession(a.token, 'pty-1');
    expect(getContextBySession('pty-1')?.label).toBe('worker-a');

    releaseSession('pty-1');
    expect(getContextBySession('pty-1')).toBeNull();
    expect(getContext(a.token)).toBeNull();
    expect(getContext(b.token)).not.toBeNull();
  });

  it('blocks a worker stop until handoff, then allows', () => {
    const ctx = mintToken({ label: 'w', role: 'worker' });
    expect(evaluateStop(ctx).allow).toBe(false);
    markHandoffSubmitted(ctx);
    expect(evaluateStop(ctx).allow).toBe(true);
  });

  it('gives up blocking after MAX_STOP_ATTEMPTS (never traps an agent)', () => {
    const ctx = mintToken({ label: 'w', role: 'worker' });
    let allowed = false;
    for (let i = 0; i < MAX_STOP_ATTEMPTS; i++) {
      allowed = evaluateStop(ctx).allow;
    }
    expect(allowed).toBe(true);
  });

  it('never blocks orchestrators or user panes', () => {
    expect(evaluateStop(mintToken({ label: 'o', role: 'orchestrator' })).allow).toBe(true);
    expect(evaluateStop(mintToken({ label: 'u', role: 'user' })).allow).toBe(true);
  });
});
