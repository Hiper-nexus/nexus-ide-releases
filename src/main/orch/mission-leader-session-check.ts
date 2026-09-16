/**
 * Late-bound "who is the current mission leader" check shared by the
 * low-level authority gate (gate.ts) and its provider (mission-leader-gate.ts).
 *
 * Why a leaf module: gate.ts is loaded early by the plugin/catalog chain
 * (agent-plugin-skill → gate). A static import of mission-leader-gate from
 * gate.ts closed an ESM cycle (leader-gate → leadership-runtime → fast-lane →
 * squad-store → guided-squad-skills → catalog → plugin-skill → gate) that left
 * BUILTIN_SQUADS/NEXUS_GUIDED_SKILLS in TDZ. Registering through this module
 * keeps both sides free of each other, and test doubles of either module
 * keep working (no new export is required from `./gate`).
 */
import type { ProjectExecutionScope } from '../../shared/types';

export type MissionLeaderSessionCheck = (
  scope: ProjectExecutionScope,
  missionId: string,
  ctx: { readonly sessionId?: string | null },
) => { ok: true } | { ok: false; code: string; hint: string };

let current: MissionLeaderSessionCheck | null = null;

export function registerMissionLeaderSessionCheck(
  check: MissionLeaderSessionCheck | null,
): void {
  current = check;
}

export function getMissionLeaderSessionCheck(): MissionLeaderSessionCheck | null {
  return current;
}
