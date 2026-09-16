import type { ProjectExecutionScope } from '../../shared/project-identity-types';
import { MissionLeadershipError, type MissionLeader } from './mission-leadership';
import { getMissionLeadership } from './mission-leadership-runtime';

export type MissionLeaderGateCode = 'no-leader' | 'stale-session' | 'split-brain' | 'unproven';

export interface MissionLeaderGateContext {
  /**
   * The candidate/acting session whose leadership claim is being checked.
   * Omit the KEY entirely to just resolve the current proven leader with no
   * identity check (readers with no candidate, e.g. delivery routing).
   * Passing the key with `null`/`undefined` (e.g. an unbound `ctx.sessionId`)
   * is a candidate with no proven identity and is denied as stale — it must
   * never be treated the same as omitting the key.
   */
  readonly sessionId?: string | null;
}

export type MissionLeaderGateResult =
  | { readonly ok: true; readonly leader: MissionLeader }
  | { readonly ok: false; readonly code: MissionLeaderGateCode; readonly hint: string };

const HINT: Readonly<Record<MissionLeaderGateCode, string>> = {
  'no-leader':
    'nenhuma sessão líder está vinculada a esta missão; use "Retomar missão" para religar a autoridade',
  'stale-session':
    'esta sessão não é mais a líder atual da missão; use "Retomar missão" para restaurar a autoridade correta',
  'split-brain':
    'duas sessões físicas reivindicam a mesma missão ao mesmo tempo; recusado por segurança até a divergência ser resolvida',
  unproven:
    'a sessão líder registrada ainda não tem prova física de estar viva',
};

/**
 * Fail-closed wrapper around MissionLeadership#resolveMissionLeader for every
 * authorization/reader site: it never throws, so a caller always gets a
 * typed decision even when the engine disagrees with itself (split-brain) or
 * the observed scope/session data is otherwise unusable. Role/capability
 * checks (ctx.role === 'orchestrator', allowlists, …) stay at the caller —
 * this only answers "who is the current proven leader" for the mission.
 */
export function requireMissionLeaderSession(
  scope: ProjectExecutionScope,
  missionId: string,
  ctx: MissionLeaderGateContext,
): MissionLeaderGateResult {
  let leader: MissionLeader | null;
  try {
    leader = getMissionLeadership().resolveMissionLeader(scope, missionId);
  } catch (error) {
    const code: MissionLeaderGateCode =
      error instanceof MissionLeadershipError && error.code === 'split_brain'
        ? 'split-brain'
        : 'no-leader';
    return { ok: false, code, hint: HINT[code] };
  }
  if (!leader) {
    return { ok: false, code: 'no-leader', hint: HINT['no-leader'] };
  }
  if (!leader.proven) {
    return { ok: false, code: 'unproven', hint: HINT.unproven };
  }
  if (Object.hasOwn(ctx, 'sessionId') && ctx.sessionId !== leader.sessionId) {
    return { ok: false, code: 'stale-session', hint: HINT['stale-session'] };
  }
  return { ok: true, leader };
}
