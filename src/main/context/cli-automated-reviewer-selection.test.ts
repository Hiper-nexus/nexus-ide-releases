import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { MissionContract } from './contract-compiler';

const deps = vi.hoisted(() => ({
  mode: 'governed' as 'governed' | 'operator-choice',
  providers: [] as Partial<ProviderSettingsInfo>[],
  builtin: true,
  additionalAdapters: new Map<string, Record<string, unknown>>(),
  additionalBuiltinIds: new Set<string>(),
  adapter: {
    id: 'codex',
    kind: 'cli-pty' as const,
    bin: 'codex',
    spawn: {
      interactive: ['codex'],
      extraArgs: [],
    },
    models: {
      default: 'gpt-5.6-sol',
      list: ['gpt-5.6-sol'],
    },
    quirks: {
      nexusMcp: 'codex' as const,
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
  },
  routeTask: vi.fn(
    (
      _task: string,
      candidates: Array<{
        id: string;
        installed: boolean;
        models: readonly string[];
      }>,
    ) => {
      const candidate = candidates.find((item) => item.installed);
      return candidate
        ? {
            adapterId: candidate.id,
            model: candidate.models[0],
            effort: 'high',
          }
        : null;
    },
  ),
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: () => deps.providers,
}));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: () => ({ squadCliPolicy: deps.mode }),
}));
vi.mock('../persistence/account-store', () => ({
  hasAvailableAccount: () => true,
}));
vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (adapterId: string) =>
    adapterId === 'codex'
      ? deps.adapter
      : (deps.additionalAdapters.get(adapterId) ?? null),
  isBuiltinAdapter: (adapterId: string) =>
    (adapterId === 'codex' && deps.builtin) ||
    deps.additionalBuiltinIds.has(adapterId),
}));
vi.mock('../orch/task-router', () => ({
  routeTask: deps.routeTask,
}));

import { selectAutomatedReviewerRoutes } from './cli-automated-reviewer';

function contract(
  risk: MissionContract['risk'],
  minimumReviewers: number,
): MissionContract {
  return {
    goal: 'Review the governed mission output',
    risk,
    reviewerPolicy: {
      minimumReviewers,
      requireIndependentAuthor: true,
      requireDifferentProvider: false,
      blockingSeverities: ['critical', 'high'],
    },
  } as unknown as MissionContract;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.mode = 'governed';
  deps.builtin = true;
  deps.additionalAdapters.clear();
  deps.additionalBuiltinIds.clear();
  deps.providers.length = 0;
  deps.providers.push(
    {
      adapterId: 'codex',
      enabled: true,
      installed: true,
      authStrategy: 'subscription',
      kind: 'cli-pty',
      models: ['gpt-5.6-sol'],
    },
    {
      adapterId: 'claude',
      enabled: true,
      installed: true,
      authStrategy: 'subscription',
      kind: 'cli-pty',
      models: ['claude-sonnet'],
    },
  );
});

describe('automated PREVC reviewer route release boundary', () => {
  it('selects only the live builtin Codex route for a non-Codex author', () => {
    expect(selectAutomatedReviewerRoutes(contract('medium', 1), ['claude']))
      .toEqual([
        {
          adapterId: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
      ]);

    expect(deps.routeTask).toHaveBeenCalledWith(
      expect.any(String),
      // F-957: a prova viva da CLI segue junto (sem cache de descoberta no teste).
      [{ id: 'codex', installed: true, models: ['gpt-5.6-sol'], liveModels: [] }],
      undefined,
      'medium',
      false,
    );
  });

  it('uses distinct Codex sessions for a critical two-reviewer quorum', () => {
    const routes = selectAutomatedReviewerRoutes(
      contract('critical', 2),
      ['codex'],
    );

    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.adapterId === 'codex')).toBe(true);
    expect(deps.routeTask).toHaveBeenCalledTimes(2);
    expect(routes[0]).not.toBe(routes[1]);
  });

  it('routes high-risk Codex-authored work to a fresh Codex reviewer session', () => {
    expect(
      selectAutomatedReviewerRoutes(contract('high', 1), ['codex']),
    ).toEqual([
      {
        adapterId: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    ]);

    expect(deps.routeTask).toHaveBeenCalledWith(
      expect.any(String),
      [{ id: 'codex', installed: true, models: ['gpt-5.6-sol'], liveModels: [] }],
      undefined,
      'hard',
      false,
    );
  });

  it('diversifies a critical quorum across every live review CLI in operator-choice', () => {
    deps.mode = 'operator-choice';
    deps.additionalAdapters.set('claude', {
      id: 'claude',
      kind: 'cli-pty',
      quirks: { mcpAutoload: true, nexusMcp: 'autoload' },
    });
    deps.additionalBuiltinIds.add('claude');
    deps.providers.push(
      {
        adapterId: 'kimi',
        enabled: true,
        installed: true,
        authStrategy: 'subscription',
        kind: 'cli-pty',
        models: ['kimi-code/k3'],
      },
      {
        adapterId: 'grok',
        enabled: true,
        installed: true,
        authStrategy: 'subscription',
        kind: 'cli-pty',
        models: ['grok-4.1'],
      },
    );
    deps.additionalAdapters.set('kimi', {
      id: 'kimi',
      kind: 'cli-pty',
      quirks: { mcpAutoload: false, nexusMcp: 'kimi' },
    });
    deps.additionalAdapters.set('grok', {
      id: 'grok',
      kind: 'cli-pty',
      quirks: { mcpAutoload: false, nexusMcp: 'grok' },
    });
    deps.additionalBuiltinIds.add('kimi');
    deps.additionalBuiltinIds.add('grok');

    const routes = selectAutomatedReviewerRoutes(
      contract('critical', 3),
      [],
    );

    expect(routes.map((route) => route.adapterId)).toEqual([
      'codex',
      'claude',
      'kimi',
    ]);
    expect(deps.routeTask).toHaveBeenCalledTimes(3);
  });

  it('reserves Claude when an author already owns its single OAuth session', () => {
    deps.mode = 'operator-choice';
    deps.additionalAdapters.set('claude', {
      id: 'claude',
      kind: 'cli-pty',
      quirks: { mcpAutoload: true, nexusMcp: 'autoload' },
    });
    deps.additionalBuiltinIds.add('claude');

    const routes = selectAutomatedReviewerRoutes(
      contract('critical', 2),
      ['claude'],
    );

    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.adapterId === 'codex')).toBe(true);
  });

  it('rejects a non-builtin Codex lookalike before routing', () => {
    deps.builtin = false;

    expect(() =>
      selectAutomatedReviewerRoutes(contract('medium', 1), ['claude']),
    ).toThrow(/independent review quorum unavailable/i);
    expect(deps.routeTask).not.toHaveBeenCalled();
  });
});
