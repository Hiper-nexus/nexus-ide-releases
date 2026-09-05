import { useOrchStore } from '../state/orch-store';
import { useWorkspaceStore } from '../state/workspace-store';

/** A duplicate delete succeeds only after main confirms the record is absent. */
export async function removeMissionVerified(missionId: string, workspacePath: string): Promise<boolean> {
  const isCurrent = () => useWorkspaceStore.getState().current?.path === workspacePath;
  if (!isCurrent()) throw new Error('O projeto mudou. Abra a missão e tente novamente.');
  const result = await window.nexus.orch.removeMission(missionId);
  if (result.removed) return true;
  if (!isCurrent()) return false;
  const missions = await window.nexus.orch.listMissions();
  if (!isCurrent()) return false;
  useOrchStore.getState().setMissions(missions);
  if (missions.some((mission) => mission.id === missionId)) return false;
  const summaries = await window.nexus.mission.list();
  if (isCurrent()) useOrchStore.getState().setMissionSummaries(summaries);
  return true;
}
