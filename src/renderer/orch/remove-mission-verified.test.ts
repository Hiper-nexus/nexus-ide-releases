/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';
import { removeMissionVerified } from './remove-mission-verified';
const mocks = vi.hoisted(() => ({ setMissions: vi.fn(), setSummaries: vi.fn() }));
vi.mock('../state/workspace-store', () => ({ useWorkspaceStore: { getState: () => ({ current: { path: '/project' } }) } }));
vi.mock('../state/orch-store', () => ({ useOrchStore: { getState: () => ({ setMissions: mocks.setMissions, setMissionSummaries: mocks.setSummaries }) } }));
it.each([false, true])('verifies absence instead of assuming that removed:false means failure (exists=%s)', async (exists) => {
  const remaining = exists ? [{ id: 'one' }] : [];
  Object.defineProperty(window, 'nexus', { configurable: true, value: {
    orch: { removeMission: vi.fn().mockResolvedValue({ removed: false }), listMissions: vi.fn().mockResolvedValue(remaining) },
    mission: { list: vi.fn().mockResolvedValue([]) },
  } });
  expect(await removeMissionVerified('one', '/project')).toBe(!exists);
  expect(mocks.setMissions).toHaveBeenLastCalledWith(remaining);
});
it('refuses to delete from another workspace', async () => {
  await expect(removeMissionVerified('one', '/other')).rejects.toThrow('O projeto mudou');
});
