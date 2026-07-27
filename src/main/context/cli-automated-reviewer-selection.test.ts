import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsInfo } from '../../shared/provider-settings-types';
import type { MissionContract } from './contract-compiler';

const deps = vi.hoisted(() => ({
  providers: [] as Partial<ProviderSettingsInfo>[],
  builtin: true,
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
vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (adapterId: string) =>
    adapterId === 'codex' ? deps.adapter : null,
  isBuiltinAdapter: (adapterId: string) =>
    adapterId === 'codex' && deps.builtin,
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
  deps.builtin = true;
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
      [{ id: 'codex', installed: true, models: ['gpt-5.6-sol'] }],
      undefined,
      'medium',
      true,
    );
  });

  it('uses distinct Codex sessions for a critical two-reviewer quorum', () => {
    const routes = selectAutomatedReviewerRoutes(
      contract('critical', 2),
      ['codex'],
    );

    expect(routes).toHaveLength(2);
    expect(routes.every((route) => route.adapterId === 'codex')).toBe(true);
    expect(deps.routeTask).toHaveBeenCalledOnce();
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
      [{ id: 'codex', installed: true, models: ['gpt-5.6-sol'] }],
      undefined,
      'hard',
      true,
    );
  });

  it('rejects a non-builtin Codex lookalike before routing', () => {
    deps.builtin = false;

    expect(() =>
      selectAutomatedReviewerRoutes(contract('medium', 1), ['claude']),
    ).toThrow(/independent review quorum unavailable/i);
    expect(deps.routeTask.mock.calls[0]?.[1]).toEqual([]);
  });
});
