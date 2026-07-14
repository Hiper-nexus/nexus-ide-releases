// @vitest-environment node
/**
 * NavalhaGO acceptance: intent-first arm produces zero agent panes / zero
 * kickoff — pure launcher path (no Electron).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const armMission = vi.fn(async () => ({
  id: 'mission-armed-1',
  title: 'NavalhaGO',
  description: '',
  status: 'pending' as const,
  intentState: 'awaiting_goal' as const,
  intentVersion: 0,
  milestones: [],
  learnings: '',
  createdAt: 1,
  updatedAt: 1,
  squadId: 'navalha',
}));

const orchGet = vi.fn(async () => ({
  intentFirstMissionRuntimeV1: true,
  defaultAdapterId: 'claude',
  leanCode: false,
  seniorMode: false,
  designPro: false,
  soberMode: false,
  missionDriverActiveMode: false,
  agentRestorePolicy: 'ask' as const,
  defaultAccountId: '',
  defaultEffort: '',
  defaultPermissionMode: '',
  defaultVerbose: false,
  showCostInStatusBar: true,
}));

vi.mock('../state/home-store', () => ({
  useHomeStore: {
    getState: () => ({ hide: vi.fn() }),
  },
}));

vi.mock('../state/layout-store', () => ({
  useLayoutStore: {
    getState: () => ({
      root: { type: 'pane', pane: { id: 'shell-1', kind: 'shell' } },
      setPanes: vi.fn(),
    }),
  },
}));

vi.mock('../state/active-workspace', () => ({
  getActiveWorkspacePath: () => '/tmp/ws',
}));

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: () => null,
  waitForSession: async () => null,
}));

describe('NavalhaGO arm path (intent-first)', () => {
  beforeEach(() => {
    armMission.mockClear();
    orchGet.mockClear();
    (globalThis as { window?: unknown }).window = {
      nexus: {
        settings: { orchGet },
        accounts: { list: async () => [] },
        quota: { snapshot: async () => null },
        orch: { armMission },
        adapters: { list: async () => [] },
      },
    };
  });

  it('arms without creating panes when intent-first is on', async () => {
    const { launchSquadMission } = await import('./mission-launcher');
    const squad = {
      id: 'navalha',
      name: 'NavalhaGO',
      createdAt: '1',
      builtin: false,
      orchestratorInstructions: 'coordene',
      agents: [
        {
          id: 'o',
          agentName: 'Orq',
          category: 'orchestrator' as const,
          cli: 'claude',
        },
        {
          id: 'w',
          agentName: 'Dev',
          category: 'executor' as const,
          cli: 'claude',
        },
      ],
    };
    const result = await launchSquadMission(
      squad as never,
      [
        {
          id: 'claude',
          label: 'Claude',
          installed: true,
          quirks: { mcpAutoload: true },
        },
      ] as never,
    );
    expect(result.ok).toBe(true);
    expect(result.armed).toBe(true);
    expect(result.missionId).toBe('mission-armed-1');
    expect(result.paneId).toBeUndefined();
    expect(armMission).toHaveBeenCalledWith({
      title: 'NavalhaGO',
      squadId: 'navalha',
    });
  });
});
