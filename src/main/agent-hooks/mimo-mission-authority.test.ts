import { afterEach, expect, it, vi } from 'vitest';
import { beginMimoMissionAuthority, forgetMimoMissionAuthority, mimoMessageMission, noteMimoMissionAuthority } from './mimo-mission-authority';
afterEach(() => { forgetMimoMissionAuthority('pty'); vi.restoreAllMocks(); });
it('uses native message creation instants and never invents pre-runtime ownership', () => {
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const timeline = beginMimoMissionAuthority('pty', 'spawn-mission');
  expect(mimoMessageMission(timeline, 999)).toEqual({ known: false });
  now = 2000; noteMimoMissionAuthority('pty', 'adopted');
  now = 3000; noteMimoMissionAuthority('pty');
  expect(mimoMessageMission(timeline, 1500)).toEqual({ known: true, missionId: 'spawn-mission' });
  expect(mimoMessageMission(timeline, 2000)).toEqual({ known: true, missionId: 'adopted' });
  expect(mimoMessageMission(timeline, 3500)).toEqual({ known: true, missionId: undefined });
  forgetMimoMissionAuthority('pty'); now = 4000; noteMimoMissionAuthority('pty', 'foreign');
  expect(mimoMessageMission(timeline, 4500).missionId).toBeUndefined();
});
