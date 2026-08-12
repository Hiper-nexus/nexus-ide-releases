import { beforeEach, describe, expect, it } from 'vitest';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import {
  assertOrchestratorMission,
  bindContextRevision,
  bindTokenToSession,
  canonicalToolName,
  evaluateStop,
  getContext,
  getContextBySession,
  isSkillAllowed,
  isToolAllowed,
  isToolAllowedForRole,
  markHandoffSubmitted,
  MAX_STOP_ATTEMPTS,
  mintToken,
  promoteMissionSessionAuthority,
  releaseSession,
  resetGateForTests,
  restoreSessionAuthority,
  rotateContextRevisionAuthority,
} from './gate';
import { testProjectScope } from './__tests__/scope-fixture';

function token(label: string, role: 'worker' | 'orchestrator' | 'user') {
  return mintToken({ label, role, scope: testProjectScope() });
}

describe('canonicalToolName', () => {
  it('strips the nexus_ namespace', () => {
    expect(canonicalToolName('nexus_pane_spawn')).toBe('pane_spawn');
    expect(canonicalToolName('pane_spawn')).toBe('pane_spawn');
  });

  it('lowercases mixed-case client tool names', () => {
    expect(canonicalToolName('ToolSearch')).toBe('toolsearch');
  });
});

describe('isToolAllowed', () => {
  it('treats a null allowlist as unrestricted', () => {
    expect(isToolAllowed(null, 'nexus_pane_spawn')).toBe(true);
    expect(isToolAllowed(null, 'Bash')).toBe(true);
  });

  it('blocks tools outside the allowlist', () => {
    expect(isToolAllowed(['Read', 'Grep'], 'Bash')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_spawn')).toBe(false);
  });

  it('matches across the nexus_ namespace and bare names', () => {
    expect(isToolAllowed(['nexus_pane_read'], 'pane_read')).toBe(true);
    expect(isToolAllowed(['pane_read'], 'nexus_pane_read')).toBe(true);
  });

  it('always allows handoff tools, pane observation, and ToolSearch, even with empty allowlist', () => {
    expect(isToolAllowed([], 'nexus_handoff_submit')).toBe(true);
    expect(isToolAllowed([], 'handoff_list')).toBe(true);
    expect(isToolAllowed([], 'nexus_handoff_ack')).toBe(true);
    expect(isToolAllowed([], 'nexus_worker_heartbeat')).toBe(true);
    expect(isToolAllowed([], 'ToolSearch')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_read')).toBe(true);
    expect(isToolAllowed([], 'pane_read_many')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_list')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_whoami')).toBe(true);
    expect(isToolAllowed([], 'nexus_pane_write')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_spawn')).toBe(false);
  });

  it('never grants high-impact tools implicitly (null allowlist)', () => {
    // These reach outside the sandbox — a prompt-injected agent with the
    // default (unrestricted) allowlist must NOT inherit them.
    expect(isToolAllowed(null, 'nexus_remote_spawn')).toBe(false);
    expect(isToolAllowed(null, 'nexus_agent_spec_write')).toBe(false);
    expect(isToolAllowed(null, 'nexus_remote_cli_detect')).toBe(false);
    expect(isToolAllowed(null, 'nexus_remote_bridge_status')).toBe(false);
    expect(isToolAllowed(null, 'nexus_cron')).toBe(false);
  });

  it('grants high-impact tools only when named explicitly', () => {
    expect(isToolAllowed(['nexus_remote_spawn'], 'nexus_remote_spawn')).toBe(true);
    expect(isToolAllowed(['remote_spawn'], 'nexus_remote_spawn')).toBe(true);
    expect(isToolAllowed(['agent_spec_write'], 'nexus_agent_spec_write')).toBe(true);
    expect(isToolAllowed(['cron'], 'nexus_cron')).toBe(true);
    // A different explicit grant does not leak the dangerous one.
    expect(isToolAllowed(['nexus_pane_read'], 'nexus_remote_spawn')).toBe(false);
    expect(isToolAllowed(['nexus_pane_read'], 'nexus_cron')).toBe(false);
  });
});

describe('isSkillAllowed', () => {
  it('null allowlist is unrestricted', () => {
    expect(isSkillAllowed(null, 'anything')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isSkillAllowed(['code-review'], 'Code-Review')).toBe(true);
    expect(isSkillAllowed(['code-review'], 'deploy')).toBe(false);
  });
});

describe('token registry + stop gate', () => {
  beforeEach(() => resetGateForTests());

  it('mints unique tokens and binds them to sessions', () => {
    const a = token('worker-a', 'worker');
    const b = token('worker-b', 'worker');
    expect(a.token).not.toBe(b.token);

    bindTokenToSession(a.token, 'pty-1');
    expect(getContextBySession('pty-1')?.label).toBe('worker-a');

    releaseSession('pty-1');
    expect(getContextBySession('pty-1')).toBeNull();
    expect(getContext(a.token)).toBeNull();
    expect(getContext(b.token)).not.toBeNull();
  });

  it('blocks a worker stop until handoff, then allows', () => {
    const ctx = token('w', 'worker');
    expect(evaluateStop(ctx).allow).toBe(false);
    markHandoffSubmitted(ctx);
    expect(evaluateStop(ctx).allow).toBe(true);
  });

  it('revokes a cached stop receipt when its evidence becomes stale', () => {
    const ctx = token('w-stale', 'worker');
    markHandoffSubmitted(ctx);

    expect(evaluateStop(ctx, false).allow).toBe(false);
    expect(ctx.handoffSubmitted).toBe(false);
  });

  it('gives up blocking after MAX_STOP_ATTEMPTS (never traps an agent)', () => {
    const ctx = token('w', 'worker');
    let allowed = false;
    for (let i = 0; i < MAX_STOP_ATTEMPTS; i++) {
      allowed = evaluateStop(ctx).allow;
    }
    expect(allowed).toBe(true);
  });

  it('never blocks orchestrators or user panes', () => {
    expect(evaluateStop(token('o', 'orchestrator')).allow).toBe(true);
    expect(evaluateStop(token('u', 'user')).allow).toBe(true);
  });

  it('promotes one mission session to orchestrator and demotes the previous leader', () => {
    const scope = testProjectScope();
    const oldLeader = mintToken({
      label: 'old',
      role: 'orchestrator',
      missionId: 'mission-a',
      scope,
      allowedTools: null,
    });
    const newLeader = mintToken({
      label: 'new',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-new',
      scope,
      allowedTools: ['nexus_handoff_submit'],
    });
    bindTokenToSession(oldLeader.token, 'pty-old');
    bindTokenToSession(newLeader.token, 'pty-new');

    expect(
      promoteMissionSessionAuthority({
        missionId: 'mission-a',
        promotedSessionId: 'pty-new',
        previousSessionId: 'pty-old',
      }),
    ).toBe(true);

    expect(getContextBySession('pty-new')).toMatchObject({
      role: 'orchestrator',
      missionId: 'mission-a',
      allowedTools: null,
    });
    expect(getContextBySession('pty-new')).not.toHaveProperty(
      'workerIncarnationId',
    );
    expect(getContextBySession('pty-old')).toMatchObject({
      role: 'worker',
      missionId: 'mission-a',
      allowedTools: [],
    });
    expect(isToolAllowedForRole('worker', getContextBySession('pty-old')!.allowedTools, 'nexus_handoff_submit')).toBe(true);
  });

  it('refuses to promote a session from another mission', () => {
    const scope = testProjectScope();
    const worker = mintToken({
      label: 'other',
      role: 'worker',
      missionId: 'mission-b',
      scope,
      allowedTools: [],
    });
    bindTokenToSession(worker.token, 'pty-other');

    expect(
      promoteMissionSessionAuthority({
        missionId: 'mission-a',
        promotedSessionId: 'pty-other',
      }),
    ).toBe(false);
    expect(getContextBySession('pty-other')?.role).toBe('worker');
  });

  it('reserves mission authority to its exact orchestrator', () => {
    expect(() =>
      assertOrchestratorMission(
        { role: 'orchestrator', missionId: 'mission-a' },
        'mission-a',
      ),
    ).not.toThrow();
    expect(() =>
      assertOrchestratorMission(
        { role: 'worker', missionId: 'mission-a' },
        'mission-a',
      ),
    ).toThrow(/only the mission orchestrator/);
    expect(() =>
      assertOrchestratorMission(
        { role: 'orchestrator', missionId: 'mission-b' },
        'mission-a',
      ),
    ).toThrow(/does not match/);
  });

  it('copies and freezes the project scope at mint time', () => {
    const scope = testProjectScope({ projectId: 'project-a' });
    const ctx = mintToken({ label: 'scoped', role: 'worker', scope });

    expect(ctx.scope).not.toBe(scope);
    expect(Object.isFrozen(ctx.scope)).toBe(true);
    expect(ctx.scope.projectId).toBe('project-a');
  });

  it('binds one immutable frozen context revision to a token', () => {
    const ctx = mintToken({
      label: 'revision-bound',
      role: 'worker',
      missionId: 'mission-a',
      contextRevision: 'context-revision-a',
      scope: testProjectScope(),
    });

    expect(ctx.contextRevision).toBe('context-revision-a');
    expect(() => bindContextRevision(ctx, 'context-revision-a')).not.toThrow();
    expect(() => bindContextRevision(ctx, 'context-revision-b')).toThrow(
      /does not match the frozen mission/,
    );
  });

  it('rotates context authority only from the exact PREVC revision', () => {
    const ctx = mintToken({
      label: 'revision-rotation',
      role: 'orchestrator',
      missionId: 'mission-a',
      contextRevision: 'context-revision-a',
      scope: testProjectScope(),
    });

    rotateContextRevisionAuthority(
      ctx,
      'context-revision-a',
      'context-revision-b',
    );
    expect(ctx.contextRevision).toBe('context-revision-b');
    expect(() =>
      rotateContextRevisionAuthority(
        ctx,
        'context-revision-a',
        'context-revision-c',
      ),
    ).toThrow(/changed before PREVC authority rotation/i);
  });

  it('never mints revision authority without its mission coordinate', () => {
    expect(() => mintToken({
      label: 'invalid-revision',
      role: 'worker',
      contextRevision: 'context-revision-a',
      scope: testProjectScope(),
    })).toThrow(/requires a mission/);
  });

  it('mints a governed native marker only for its matching writable mission worker', () => {
    expect(() =>
      mintToken({
        label: 'governed-codex-worker',
        role: 'worker',
        missionId: 'mission-a',
        providerId: 'codex',
        governedNativeProvider: 'codex',
        scope: testProjectScope(),
      }),
    ).not.toThrow();
    expect(() =>
      mintToken({
        label: 'wrong-provider',
        role: 'worker',
        missionId: 'mission-a',
        providerId: 'claude',
        governedNativeProvider: 'codex',
        scope: testProjectScope(),
      }),
    ).toThrow(/matching writable mission worker/);
    expect(() =>
      mintToken({
        label: 'read-only-provider',
        role: 'worker',
        missionId: 'mission-a',
        providerId: 'codex',
        governedNativeProvider: 'codex',
        readOnly: true,
        scope: testProjectScope(),
      }),
    ).toThrow(/matching writable mission worker/);
  });

  it('mints the Pet media marker only for the exact canonical Codex maker', () => {
    const maker = PET_STUDIO_SQUAD.agents[0]!;
    const pet = mintToken({
      label: maker.agentName,
      role: 'orchestrator',
      agentName: maker.agentName,
      providerId: 'codex',
      petStudioMediaAuthority: true,
      petStudioAuthoritySource: 'legacy-squad',
      petStudioSquadId: PET_STUDIO_SQUAD.id,
      allowedTools: [...(maker.allowedTools ?? [])],
      allowedSkills: [...(maker.allowedSkills ?? [])],
      scope: testProjectScope(),
    });

    expect(pet.petStudioMediaAuthority).toBe(true);
    expect(
      isToolAllowedForRole(
        pet.role,
        pet.allowedTools,
        'nexus_image_generate',
        pet.petStudioMediaAuthority,
      ),
    ).toBe(true);
    expect(
      isToolAllowedForRole(
        pet.role,
        pet.allowedTools,
        'nexus_video_generate',
        pet.petStudioMediaAuthority,
      ),
    ).toBe(false);
    expect(
      isToolAllowedForRole(
        'orchestrator',
        maker.allowedTools ?? null,
        'nexus_image_generate',
      ),
    ).toBe(false);

    expect(() =>
      mintToken({
        label: maker.agentName,
        role: 'orchestrator',
        missionId: 'mission-pet-lookalike',
        agentName: maker.agentName,
        providerId: 'codex',
        petStudioMediaAuthority: true,
        petStudioAuthoritySource: 'legacy-squad',
        petStudioSquadId: PET_STUDIO_SQUAD.id,
        allowedTools: [
          ...(maker.allowedTools ?? []),
          'nexus_video_generate',
        ],
        allowedSkills: [...(maker.allowedSkills ?? [])],
        scope: testProjectScope(),
      }),
    ).toThrow(/exact writable main-owned Codex maker profile/);

    expect(() =>
      mintToken({
        label: maker.agentName,
        role: 'orchestrator',
        agentName: maker.agentName,
        providerId: 'codex',
        petStudioMediaAuthority: true,
        petStudioAuthoritySource: 'persisted-pane',
        petStudioSquadId: PET_STUDIO_SQUAD.id,
        allowedTools: [...(maker.allowedTools ?? [])],
        allowedSkills: [...(maker.allowedSkills ?? [])],
        scope: testProjectScope(),
      }),
    ).toThrow(/exact writable main-owned Codex maker profile/);
  });

  it('never rebinds a token or session to another PTY', () => {
    const a = token('a', 'worker');
    const b = token('b', 'worker');
    bindTokenToSession(a.token, 'pty-a');

    expect(() => bindTokenToSession(a.token, 'pty-b')).toThrow(/already bound/i);
    expect(() => bindTokenToSession(b.token, 'pty-a')).toThrow(/already bound/i);
  });

  it('restores a resumed user pane as a mission-scoped worker with no MCP powers', () => {
    const resumed = token('resumed', 'user');
    bindTokenToSession(resumed.token, 'pty-resumed');

    expect(
      restoreSessionAuthority('pty-resumed', {
        missionId: 'mission-a',
        role: 'worker',
        agentName: 'QA',
      }),
    ).toBe(true);
    expect(getContextBySession('pty-resumed')).toMatchObject({
      missionId: 'mission-a',
      role: 'worker',
      agentName: 'QA',
      allowedTools: [],
    });
  });

  it('preserves an existing worker allowlist when its persisted binding is replayed', () => {
    const worker = mintToken({
      label: 'worker',
      role: 'worker',
      missionId: 'mission-a',
      scope: testProjectScope(),
      allowedTools: ['nexus_file_read'],
    });
    bindTokenToSession(worker.token, 'pty-worker');

    expect(
      restoreSessionAuthority('pty-worker', {
        missionId: 'mission-a',
        role: 'worker',
      }),
    ).toBe(true);
    expect(worker.allowedTools).toEqual(['nexus_file_read']);
  });

  it('binds one worker token to one immutable physical incarnation', () => {
    const worker = mintToken({
      label: 'worker',
      role: 'worker',
      missionId: 'mission-a',
      workerIncarnationId: 'worker-incarnation-current',
      scope: testProjectScope(),
    });
    bindTokenToSession(worker.token, 'pty-worker-incarnation');

    expect(getContextBySession('pty-worker-incarnation')).toMatchObject({
      workerIncarnationId: 'worker-incarnation-current',
    });
    expect(
      restoreSessionAuthority('pty-worker-incarnation', {
        missionId: 'mission-a',
        role: 'worker',
        workerIncarnationId: 'worker-incarnation-stale',
      }),
    ).toBe(false);
    expect(() => mintToken({
      label: 'orchestrator',
      role: 'orchestrator',
      workerIncarnationId: 'worker-incarnation-invalid',
      scope: testProjectScope(),
    })).toThrow(/worker incarnation/i);
  });

  it('restores the persisted worker capability snapshot on a resumed user token', () => {
    const resumed = token('resumed-custom', 'user');
    bindTokenToSession(resumed.token, 'pty-resumed-custom');

    expect(
      restoreSessionAuthority('pty-resumed-custom', {
        missionId: 'mission-a',
        contextRevision: 'context-revision-a',
        role: 'worker',
        readOnly: true,
        allowedTools: ['nexus_file_read'],
        allowedSkills: ['review'],
      }),
    ).toBe(true);
    expect(getContextBySession('pty-resumed-custom')).toMatchObject({
      role: 'worker',
      readOnly: true,
      contextRevision: 'context-revision-a',
      allowedTools: ['nexus_file_read'],
      allowedSkills: ['review'],
    });
  });

  it('refuses mission changes and worker-to-orchestrator escalation', () => {
    const worker = mintToken({
      label: 'worker',
      role: 'worker',
      missionId: 'mission-a',
      scope: testProjectScope(),
    });
    bindTokenToSession(worker.token, 'pty-worker');

    expect(
      restoreSessionAuthority('pty-worker', {
        missionId: 'mission-b',
        role: 'worker',
      }),
    ).toBe(false);
    expect(
      restoreSessionAuthority('pty-worker', {
        missionId: 'mission-a',
        role: 'orchestrator',
      }),
    ).toBe(false);
  });
});
