import type { Mission, MissionStatus } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Phase D — Voice → mission bridge.
 *
 * Pure start-or-resume policy used when WakeEngine fires onDetected.
 * Does not own wake dispose/ownership; callers invoke after detection is
 * already authorized for the active project scope.
 *
 * Policy (once per detection):
 *  1. Prefer resume an existing runnable mission in scope:
 *     running > blocked > pending (most recently updated first within tier)
 *  2. Otherwise start a new mission titled from the wake label and set running
 */

export type VoiceMissionIntent =
  | { readonly kind: 'resumed'; readonly missionId: string; readonly fromStatus: MissionStatus }
  | { readonly kind: 'started'; readonly missionId: string }
  | { readonly kind: 'noop'; readonly reason: string };

export interface VoiceMissionPorts {
  listMissions(): readonly Pick<Mission, 'id' | 'status' | 'updatedAt' | 'title'>[];
  createMission(input: { title: string; description?: string }): { id: string };
  setStatus(missionId: string, status: MissionStatus): void;
}

const RESUME_ORDER: readonly MissionStatus[] = [
  'running',
  'blocked',
  'pending',
];

function pickResumeCandidate(
  missions: readonly Pick<Mission, 'id' | 'status' | 'updatedAt'>[],
): Pick<Mission, 'id' | 'status' | 'updatedAt'> | null {
  for (const status of RESUME_ORDER) {
    const candidates = missions
      .filter((mission) => mission.status === status)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (candidates[0]) return candidates[0];
  }
  return null;
}

/**
 * Start a new mission or resume an existing runnable one in the active scope.
 * Pure decision + port calls — no wake engine coupling.
 */
export function startOrResumeMissionFromVoice(
  ports: VoiceMissionPorts,
  options: { title?: string; description?: string } = {},
): VoiceMissionIntent {
  const missions = ports.listMissions();
  const resume = pickResumeCandidate(missions);
  if (resume) {
    const fromStatus = resume.status;
    if (fromStatus !== 'running') {
      ports.setStatus(resume.id, 'running');
    }
    return {
      kind: 'resumed',
      missionId: resume.id,
      fromStatus,
    };
  }
  const created = ports.createMission({
    title: options.title ?? 'Missão por voz',
    ...(options.description
      ? { description: options.description }
      : { description: 'Iniciada via wake word (Hey Jarvis)' }),
  });
  ports.setStatus(created.id, 'running');
  return { kind: 'started', missionId: created.id };
}

/**
 * Build ports from project domain stores for a given scope.
 * Lazy-import style to keep this module free of store registry at test time
 * when fakes are injected.
 */
export function createVoiceMissionPorts(
  scope: ProjectExecutionScope,
  getStores: (scope: ProjectExecutionScope) => {
    missions: {
      list: () => readonly Mission[];
      create: (input: {
        title: string;
        description?: string;
      }) => { id: string };
      setStatus: (id: string, status: MissionStatus) => unknown;
    };
  },
): VoiceMissionPorts {
  return {
    listMissions: () => getStores(scope).missions.list(),
    createMission: (input) => getStores(scope).missions.create(input),
    setStatus: (missionId, status) => {
      getStores(scope).missions.setStatus(missionId, status);
    },
  };
}
