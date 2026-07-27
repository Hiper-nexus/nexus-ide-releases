import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/account-types';
import type { AdapterInfo } from '../../shared/types';
import {
  automaticOrchestratorAdapterId,
  isDeclaredOrchestratorAdapter,
  isVerifiedOrchestratorAdapter,
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
    orchestrationEvidence: 'verified',
    installCommand: '',
    idleTimeoutMs: 800,
    ...patch,
  };
}

describe('orchestrator route evidence', () => {
  it('separates a declared route from a verified automatic Maestro', () => {
    const experimental = adapter({
      id: 'third-party-mcp',
      orchestratorCapable: true,
      orchestrationEvidence: 'experimental',
    });
    expect(
      isDeclaredOrchestratorAdapter(experimental),
    ).toBe(true);
    expect(isVerifiedOrchestratorAdapter(experimental)).toBe(false);
    expect(isVerifiedOrchestratorAdapter(adapter())).toBe(true);
    expect(
      isDeclaredOrchestratorAdapter(
        adapter({ id: 'aider', orchestratorCapable: false }),
      ),
    ).toBe(false);
    expect(isDeclaredOrchestratorAdapter(adapter({ installed: false }))).toBe(false);
    expect(
      isDeclaredOrchestratorAdapter(adapter({ kind: 'api-provider' })),
    ).toBe(false);
  });

  it('nunca usa o primeiro adapter experimental como fallback automático', () => {
    const kimi = adapter({
      id: 'kimi',
      orchestrationEvidence: 'experimental',
    });
    const codex = adapter({ id: 'codex' });

    expect(
      automaticOrchestratorAdapterId([kimi, codex], 'kimi'),
    ).toBe('codex');
    expect(
      automaticOrchestratorAdapterId([kimi], 'kimi'),
    ).toBeNull();
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

  it('uses the product defaults for Grok and AGY when no squad/global model is set', () => {
    expect(
      resolveOrchestratorRuntime({
        adapterId: 'grok',
        defaultModel: '',
        defaultAccountId: '',
        accounts: [],
      }).model,
    ).toBe('grok-4.5');
    expect(
      resolveOrchestratorRuntime({
        adapterId: 'agy',
        defaultModel: '',
        defaultAccountId: '',
        accounts: [],
      }).model,
    ).toBe('gemini-3.6-flash-high');
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
