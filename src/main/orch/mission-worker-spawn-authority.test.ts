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

  it('blocks kimi writers under governed', () => {
    getAdapter.mockReturnValue({ id: 'kimi', kind: 'cli-pty' });
    supportsEnforceableWorkspaceWriteNativeAuthority.mockReturnValue(false);
    expect(() =>
      assertReleaseQualifiedMissionWorkerSpawn({
        adapterId: 'kimi',
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
