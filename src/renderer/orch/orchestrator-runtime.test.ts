import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/account-types';
import type { AdapterInfo } from '../../shared/types';
import {
  isOrchestratorCapableAdapter,
  resolveOrchestratorRuntime,
} from './orchestrator-runtime';

function account(patch: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 'acct-work',
    adapterId: 'claude',
    label: 'Trabalho',
    mode: 'subscription',
    upstream: 'anthropic',
    createdAt: 1,
    active: false,
    hasCredential: true,
    onCooldown: false,
    ...patch,
  };
}

function adapter(patch: Partial<AdapterInfo> = {}): AdapterInfo {
  return {
    id: 'claude',
    kind: 'cli-pty',
    label: 'Claude',
    icon: 'C',
    models: { list: ['default'], default: 'default' },
    installed: true,
    orchestratorCapable: true,
    installCommand: '',
    idleTimeoutMs: 800,
    ...patch,
  };
}

describe('isOrchestratorCapableAdapter', () => {
  it('derives eligibility from adapter metadata instead of a stale provider list', () => {
    expect(
      isOrchestratorCapableAdapter(
        adapter({ id: 'third-party-mcp', orchestratorCapable: true }),
      ),
    ).toBe(true);
    expect(
      isOrchestratorCapableAdapter(
        adapter({ id: 'aider', orchestratorCapable: false }),
      ),
    ).toBe(false);
    expect(isOrchestratorCapableAdapter(adapter({ installed: false }))).toBe(false);
    expect(
      isOrchestratorCapableAdapter(adapter({ kind: 'api-provider' })),
    ).toBe(false);
  });
});

describe('resolveOrchestratorRuntime', () => {
  it('keeps an explicit squad model ahead of the global orchestrator default', () => {
    expect(
      resolveOrchestratorRuntime({
        adapterId: 'claude',
        squadModel: 'claude-opus-explicit',
        defaultModel: 'claude-sonnet-default',
        defaultAccountId: '',
        accounts: [],
      }).model,
    ).toBe('claude-opus-explicit');
  });

  it('leaves model undefined when provider default should decide at spawn time', () => {
    expect(
      resolveOrchestratorRuntime({
        adapterId: 'codex',
        defaultModel: '',
        defaultAccountId: '',
        accounts: [],
      }),
    ).toEqual({ model: undefined, accountId: undefined });
  });

  it('uses only an available credentialed account owned by the selected provider', () => {
    expect(
      resolveOrchestratorRuntime({
        adapterId: 'claude',
        defaultModel: '',
        defaultAccountId: 'acct-work',
        accounts: [account()],
      }).accountId,
    ).toBe('acct-work');
    expect(
      resolveOrchestratorRuntime({
        adapterId: 'claude',
        defaultModel: '',
        defaultAccountId: 'acct-work',
        accounts: [account({ adapterId: 'codex' })],
      }).accountId,
    ).toBeUndefined();
    expect(
      resolveOrchestratorRuntime({
        adapterId: 'claude',
        defaultModel: '',
        defaultAccountId: 'acct-work',
        accounts: [account({ onCooldown: true })],
      }).accountId,
    ).toBeUndefined();

    expect(
      resolveOrchestratorRuntime({
        adapterId: 'codex',
        defaultModel: '',
        defaultAccountId: 'acct-work',
        accounts: [account({ adapterId: 'codex' })],
      }).accountId,
    ).toBe('acct-work');
  });
});
