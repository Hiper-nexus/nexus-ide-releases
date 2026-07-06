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
  it('strips the nexus_ namespace', () => {
    expect(canonicalToolName('nexus_pane_spawn')).toBe('pane_spawn');
    expect(canonicalToolName('pane_spawn')).toBe('pane_spawn');
  });

  it('lowercases mixed-case client tool names', () => {
    expect(canonicalToolName('ToolSearch')).toBe('toolsearch');
  });
});

describe('isToolAllowed', () => {
  it('treats a null allowlist as unrestricted', () => {
    expect(isToolAllowed(null, 'nexus_pane_spawn')).toBe(true);
    expect(isToolAllowed(null, 'Bash')).toBe(true);
  });

  it('blocks tools outside the allowlist', () => {
    expect(isToolAllowed(['Read', 'Grep'], 'Bash')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_spawn')).toBe(false);
  });

  it('matches across the nexus_ namespace and bare names', () => {
    expect(isToolAllowed(['nexus_pane_read'], 'pane_read')).toBe(true);
    expect(isToolAllowed(['pane_read'], 'nexus_pane_read')).toBe(true);
  });

  it('always allows handoff tools and ToolSearch, even with empty allowlist', () => {
    expect(isToolAllowed([], 'nexus_handoff_submit')).toBe(true);
    expect(isToolAllowed([], 'handoff_list')).toBe(true);
    expect(isToolAllowed([], 'ToolSearch')).toBe(true);
  });

  it('never grants high-impact tools implicitly (null allowlist)', () => {
    // These reach outside the sandbox — a prompt-injected agent with the
    // default (unrestricted) allowlist must NOT inherit them.
    expect(isToolAllowed(null, 'nexus_remote_spawn')).toBe(false);
    expect(isToolAllowed(null, 'nexus_agent_spec_write')).toBe(false);
    expect(isToolAllowed(null, 'nexus_remote_cli_detect')).toBe(false);
    expect(isToolAllowed(null, 'nexus_remote_bridge_status')).toBe(false);
  });

  it('grants high-impact tools only when named explicitly', () => {
    expect(isToolAllowed(['nexus_remote_spawn'], 'nexus_remote_spawn')).toBe(true);
    expect(isToolAllowed(['remote_spawn'], 'nexus_remote_spawn')).toBe(true);
    expect(isToolAllowed(['agent_spec_write'], 'nexus_agent_spec_write')).toBe(true);
    // A different explicit grant does not leak the dangerous one.
    expect(isToolAllowed(['nexus_pane_read'], 'nexus_remote_spawn')).toBe(false);
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
