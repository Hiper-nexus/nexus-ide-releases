import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAdapter = vi.fn();
const isBuiltinAdapter = vi.fn();
const getOrchSettings = vi.fn();
const supportsEnforceableWorkspaceWriteNativeAuthority = vi.fn();
const supportsEnforceableReadOnlyNativeAuthority = vi.fn();

vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (...args: unknown[]) => getAdapter(...args),
  isBuiltinAdapter: (...args: unknown[]) => isBuiltinAdapter(...args),
}));
vi.mock('../persistence/settings-store', () => ({
  getOrchSettings: (...args: unknown[]) => getOrchSettings(...args),
}));
vi.mock('../pty/autonomous-cli-policy', () => ({
  supportsEnforceableWorkspaceWriteNativeAuthority: (...args: unknown[]) =>
    supportsEnforceableWorkspaceWriteNativeAuthority(...args),
  supportsEnforceableReadOnlyNativeAuthority: (...args: unknown[]) =>
    supportsEnforceableReadOnlyNativeAuthority(...args),
}));

import {
  assertReleaseQualifiedMissionWorkerSpawn,
  isRevisionBoundWritableWorkerAdapterAllowed,
} from './mission-worker-spawn-authority';

describe('mission-worker-spawn-authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrchSettings.mockReturnValue({ squadCliPolicy: 'governed' });
    isBuiltinAdapter.mockReturnValue(true);
  });

  it('allows Codex governed writers', () => {
    getAdapter.mockReturnValue({ id: 'codex', kind: 'cli-pty' });
    supportsEnforceableWorkspaceWriteNativeAuthority.mockReturnValue(true);
    supportsEnforceableReadOnlyNativeAuthority.mockReturnValue(true);
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'codex',
        missionId: 'm1',
        role: 'worker',
      }),
    ).not.toThrow();
  });

  it('F-525: allows kimi writers under governed via task-worktree boundary', () => {
    // Decisão do dono do produto: builtin writáveis sem sandbox nativo usam o
    // boundary worktree+merge em vez de ficarem fora da lane governada.
    getAdapter.mockReturnValue({ id: 'kimi', kind: 'cli-pty' });
    supportsEnforceableWorkspaceWriteNativeAuthority.mockReturnValue(false);
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'kimi',
        missionId: 'm1',
        role: 'worker',
      }),
    ).not.toThrow();
  });

  it('F-525: still fails closed for adapters outside the release-qualified set', () => {
    getAdapter.mockReturnValue({ id: 'opencode', kind: 'cli-pty' });
    supportsEnforceableWorkspaceWriteNativeAuthority.mockReturnValue(false);
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'opencode',
        missionId: 'm1',
        role: 'worker',
      }),
    ).toThrow(/governed_worker_spawn_unsupported/);
  });

  it('allows kimi writers under operator-choice', () => {
    getOrchSettings.mockReturnValue({ squadCliPolicy: 'operator-choice' });
    getAdapter.mockReturnValue({ id: 'kimi', kind: 'cli-pty' });
    supportsEnforceableWorkspaceWriteNativeAuthority.mockReturnValue(false);
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'kimi',
        missionId: 'm1',
        role: 'worker',
      }),
    ).not.toThrow();
    expect(isRevisionBoundWritableWorkerAdapterAllowed('kimi')).toBe(true);
  });

  it('modo livre da missão libera kimi writer mesmo sob governed', () => {
    getOrchSettings.mockReturnValue({ squadCliPolicy: 'governed' });
    getAdapter.mockReturnValue({ id: 'kimi', kind: 'cli-pty' });
    supportsEnforceableWorkspaceWriteNativeAuthority.mockReturnValue(false);
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'kimi',
        missionId: 'm1',
        role: 'worker',
        freeAgentChoice: true,
      }),
    ).not.toThrow();
  });

  it('modo livre não vale para adapter que não é cli-pty', () => {
    getOrchSettings.mockReturnValue({ squadCliPolicy: 'governed' });
    getAdapter.mockReturnValue({ id: 'openai', kind: 'api' });
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'openai',
        missionId: 'm1',
        role: 'worker',
        freeAgentChoice: true,
      }),
    ).toThrow(/governed_worker_spawn_unsupported/);
  });

  it('still allows kimi as read_only advisor under governed', () => {
    getAdapter.mockReturnValue({ id: 'kimi', kind: 'cli-pty' });
    supportsEnforceableWorkspaceWriteNativeAuthority.mockReturnValue(false);
    supportsEnforceableReadOnlyNativeAuthority.mockReturnValue(false);
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'kimi',
        missionId: 'm1',
        role: 'worker',
        readOnly: true,
      }),
    ).not.toThrow();
  });
});
