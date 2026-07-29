import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliPtyAdapter } from '../../shared/adapter-types';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';

const deps = vi.hoisted(() => ({
  mode: 'operator-choice' as 'operator-choice' | 'governed',
  providers: [] as Partial<ProviderSettingsInfo>[],
  adapters: new Map<string, Record<string, unknown>>(),
  builtinIds: new Set<string>(),
  availableAccounts: new Set<string>(),
}));

vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ squadCliPolicy: deps.mode }),
}));
vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: () => deps.providers,
}));
vi.mock('../persistence/account-store', () => ({
  hasAvailableAccount: (adapterId: string) =>
    deps.availableAccounts.has(adapterId),
}));
vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (adapterId: string) => deps.adapters.get(adapterId) ?? null,
  isBuiltinAdapter: (adapterId: string) => deps.builtinIds.has(adapterId),
}));

import {
  hasPhysicalNexusReviewToolRoute,
  listIndependentCliReviewCandidates,
} from './cli-independent-review-policy';

function adapter(
  id: string,
  nexusMcp: 'codex' | 'agy' | 'opencode' | 'autoload',
) {
  return {
    id,
    kind: 'cli-pty' as const,
    bin: id,
    spawn: {
      interactive: [id],
      headless: [id],
      extraArgs: [],
    },
    promptInjection: { method: 'stdin' as const },
    stateParsing: {
      idle: { type: 'timeout' as const, ms: 100 },
      shellIntegration: false,
      exitCodes: {},
    },
    quirks: {
      mcpAutoload: nexusMcp === 'autoload',
      nexusMcp,
    },
  };
}

beforeEach(() => {
  deps.mode = 'operator-choice';
  deps.providers.length = 0;
  deps.adapters.clear();
  deps.builtinIds.clear();
  deps.availableAccounts.clear();
});

describe('independent CLI review policy', () => {
  it('admits every live physical review-tool route in operator-choice', () => {
    for (const [id, nexusMcp] of [
      ['codex', 'codex'],
      ['claude', 'autoload'],
      ['opencode', 'opencode'],
    ] as const) {
      deps.providers.push({
        adapterId: id,
        enabled: true,
        installed: true,
        kind: 'cli-pty',
        authStrategy: 'subscription',
        models: [`${id}-model`],
      });
      deps.adapters.set(id, adapter(id, nexusMcp));
      deps.builtinIds.add(id);
      deps.availableAccounts.add(id);
    }

    expect(
      listIndependentCliReviewCandidates().map(({ adapterId }) => adapterId),
    ).toEqual(['codex', 'claude', 'opencode']);
  });

  it('rejects AGY review until it has a physical interactive tool route', () => {
    const agy = adapter('agy', 'agy');
    deps.providers.push({
      adapterId: 'agy',
      enabled: true,
      installed: true,
      kind: 'cli-pty',
      authStrategy: 'subscription',
      models: ['agy-model'],
    });
    deps.adapters.set('agy', agy);
    deps.builtinIds.add('agy');
    deps.availableAccounts.add('agy');

    expect(
      hasPhysicalNexusReviewToolRoute(agy as unknown as CliPtyAdapter),
    ).toBe(false);
    expect(listIndependentCliReviewCandidates()).toEqual([]);
  });

  it('keeps Hardened on the mechanically-qualified Codex route', () => {
    deps.mode = 'governed';
    for (const [id, nexusMcp] of [
      ['codex', 'codex'],
      ['claude', 'autoload'],
    ] as const) {
      deps.providers.push({
        adapterId: id,
        enabled: true,
        installed: true,
        kind: 'cli-pty',
        authStrategy: 'subscription',
        models: [`${id}-model`],
      });
      const value = adapter(id, nexusMcp);
      if (id === 'codex') {
        Object.assign(value, {
          bin: 'codex',
          spawn: {
            interactive: ['codex'],
            headless: ['codex'],
            extraArgs: [],
          },
          control: {
            permission: {
              arg: '--ask-for-approval',
              safe: [
                '--sandbox',
                'workspace-write',
                '--ask-for-approval',
                'on-request',
              ],
              yolo: ['--dangerously-bypass-approvals-and-sandbox'],
              modes: {
                auto: 'never',
                default: 'on-request',
                untrusted: 'untrusted',
              },
              default: '',
            },
          },
        });
      }
      deps.adapters.set(id, value);
      deps.builtinIds.add(id);
      deps.availableAccounts.add(id);
    }

    expect(
      listIndependentCliReviewCandidates().map(({ adapterId }) => adapterId),
    ).toEqual(['codex']);
  });

  it('reserves the single Claude OAuth session and filters unavailable auth', () => {
    deps.providers.push(
      {
        adapterId: 'claude',
        enabled: true,
        installed: true,
        kind: 'cli-pty',
        authStrategy: 'subscription',
        models: ['claude-model'],
      },
      {
        adapterId: 'kimi',
        enabled: true,
        installed: true,
        kind: 'cli-pty',
        authStrategy: 'login-needed',
        models: ['kimi-model'],
      },
    );
    deps.adapters.set('claude', adapter('claude', 'autoload'));
    deps.adapters.set('kimi', adapter('kimi', 'autoload'));
    deps.builtinIds.add('claude');
    deps.builtinIds.add('kimi');
    deps.availableAccounts.add('claude');

    expect(listIndependentCliReviewCandidates({ reserveClaude: true })).toEqual(
      [],
    );
  });

  it('keeps only verified credentialless OpenCode models during account cooldown', () => {
    deps.providers.push({
      adapterId: 'opencode',
      enabled: true,
      installed: true,
      kind: 'cli-pty',
      authStrategy: 'subscription',
      models: ['openrouter/openai/gpt-5', 'opencode/big-pickle'],
    });
    deps.adapters.set('opencode', adapter('opencode', 'opencode'));
    deps.builtinIds.add('opencode');

    expect(listIndependentCliReviewCandidates()).toEqual([
      {
        adapterId: 'opencode',
        models: ['opencode/big-pickle'],
      },
    ]);
  });
});
