import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PET_STUDIO_SQUAD } from '../../shared/pet-studio';
import { requiresSpawnGate } from './spawn-home-policy';
import { testProjectScope } from './__tests__/scope-fixture';
import type { MissionLeaderGateResult } from './mission-leader-gate';

const requireMissionLeaderSession = vi.fn<(...args: unknown[]) => MissionLeaderGateResult>();
vi.mock('./mission-leader-gate', () => ({
  requireMissionLeaderSession: (...args: unknown[]) => requireMissionLeaderSession(...args),
}));

const {
  adoptUserSessionAsMissionOrchestrator,
  assertCurrentMissionOrchestratorSession,
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
  rollbackSessionAuthorityMission,
  returnOperatorHandFromEndedMission,
  registerMissionLeaderSessionCheck,
  releaseSession,
  resetGateForTests,
  restoreSessionAuthority,
  rotateContextRevisionAuthority,
} = await import('./gate');

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

  it('terminal_run segue o Bash da lane do WORKER: instrumentado quando execução já é permitida (R5)', () => {
    // Rodada 3 R5: worker de lane [Bash,Read,Edit] podia o Bash NATIVO mas
    // não o nexus_terminal_run (forma instrumentada que o main observa) —
    // o gate de evidência pedia prova da coisa que a allowlist proibia de
    // instrumentar. Regra (worker apenas): terminal_run liberado sse a lane
    // libera Bash (ou é irrestrita). Operador/renderer mantém o regime
    // próprio (destructive gate exige contexto de missão — travado em
    // mcp-ipc.test); orquestrador não executa.
    expect(
      isToolAllowedForRole('worker', ['Bash', 'Read', 'Edit'], 'nexus_terminal_run'),
    ).toBe(true);
    expect(isToolAllowedForRole('worker', null, 'nexus_terminal_run')).toBe(true);
    expect(isToolAllowedForRole('worker', ['Read', 'Grep'], 'nexus_terminal_run')).toBe(false);
    expect(isToolAllowedForRole('worker', [], 'nexus_terminal_run')).toBe(false);
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
    expect(isToolAllowed([], 'nexus_pr_inspect')).toBe(true);
    expect(isToolAllowed([], 'nexus_pr_enqueue')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_write')).toBe(false);
    expect(isToolAllowed([], 'nexus_pane_spawn')).toBe(false);
  });

  it('always allows the shared-memory tools, even with empty allowlist (F-769)', () => {
    expect(isToolAllowed([], 'nexus_memory_recall')).toBe(true);
    expect(isToolAllowed([], 'nexus_memory_stats')).toBe(true);
    expect(isToolAllowed([], 'nexus_memory_retain')).toBe(true);
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

  it('C-194.1: never blocks a worker stop — short answers end the turn', () => {
    // A doutrina do worker é condicional (≤280 chars → NÃO chama tool); o
    // fechamento mecânico (turn-end-handoff) garante a entrega. Bloquear o
    // stop contradiria o contrato que o próprio gate serve.
    const ctx = token('w', 'worker');
    expect(evaluateStop(ctx).allow).toBe(true);
    markHandoffSubmitted(ctx);
    expect(evaluateStop(ctx).allow).toBe(true);
  });

  it('revokes a cached stop receipt when its evidence becomes stale', () => {
    const ctx = token('w-stale', 'worker');
    markHandoffSubmitted(ctx);

    const verdict = evaluateStop(ctx, false);
    expect(verdict.allow).toBe(true);
    expect(ctx.handoffSubmitted).toBe(false);
  });

  it('counts stop attempts for observability but still allows', () => {
    const ctx = token('w', 'worker');
    let allowed = false;
    for (let i = 0; i < MAX_STOP_ATTEMPTS; i++) {
      allowed = evaluateStop(ctx).allow;
    }
    expect(allowed).toBe(true);
    expect(ctx.stopAttempts).toBe(MAX_STOP_ATTEMPTS);
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

  it('devolve ao pane a autoridade de criar missão quando a missão dele some', () => {
    // Campo 09/09: o operador pediu panes num terminal, o Nexus exigiu missão,
    // ele criou uma, descartou, e a partir dali o pane NUNCA mais pôde criar
    // outra ("only a user-owned session may create a mission"). A promoção
    // user→orchestrator do nexus_mission_create era porta de mão única.
    const scope = testProjectScope();
    const pane = mintToken({
      label: 'pane do operador',
      role: 'user',
      scope,
      allowedTools: null,
    });
    bindTokenToSession(pane.token, 'pty-operador');

    const ctx = getContextBySession('pty-operador')!;
    // O que nexus_mission_create faz ao promover o criador.
    ctx.missionId = 'mission-descartada';
    ctx.role = 'orchestrator';
    ctx.promotedFromUserSession = true;

    expect(
      rollbackSessionAuthorityMission('pty-operador', 'mission-descartada'),
    ).toBe(true);

    const after = getContextBySession('pty-operador')!;
    expect(after.role).toBe('user');
    expect(after.missionId).toBeUndefined();
    expect(after).not.toHaveProperty('promotedFromUserSession');
  });

  it('nunca promove um worker a user ao desfazer a missão dele', () => {
    // A devolução vale só para quem ERA user antes. Um worker perdeu a missão,
    // mas continua worker: virar `user` seria escalada de privilégio.
    const scope = testProjectScope();
    const worker = mintToken({
      label: 'worker',
      role: 'worker',
      missionId: 'mission-descartada',
      scope,
      allowedTools: [],
    });
    bindTokenToSession(worker.token, 'pty-worker-orfao');

    expect(
      rollbackSessionAuthorityMission('pty-worker-orfao', 'mission-descartada'),
    ).toBe(true);

    const after = getContextBySession('pty-worker-orfao')!;
    expect(after.role).toBe('worker');
    expect(after.missionId).toBeUndefined();
  });

  it('não devolve autoridade citando a missão errada', () => {
    const scope = testProjectScope();
    const pane = mintToken({ label: 'pane', role: 'user', scope, allowedTools: null });
    bindTokenToSession(pane.token, 'pty-outro');
    const ctx = getContextBySession('pty-outro')!;
    ctx.missionId = 'mission-viva';
    ctx.role = 'orchestrator';
    ctx.promotedFromUserSession = true;

    expect(
      rollbackSessionAuthorityMission('pty-outro', 'mission-descartada'),
    ).toBe(false);
    expect(getContextBySession('pty-outro')?.role).toBe('orchestrator');
  });

  it('missão encerrada devolve a mão do operador sem alargar o allowlist dela', () => {
    // Campo 25/09: o pane aberto pelo "+ Pane" criou uma missão, ela falhou, e
    // o pane seguiu orquestrador de uma missão morta — sem pane_spawn e sem
    // poder criar outra missão. O rollback só rodava quando a missão era apagada.
    const scope = testProjectScope();
    const pane = mintToken({
      label: 'pane do operador',
      role: 'user',
      scope,
      allowedTools: ['nexus_pane_spawn', 'nexus_mission_create'],
    });
    bindTokenToSession(pane.token, 'pty-operador-falhou');
    const ctx = getContextBySession('pty-operador-falhou')!;
    ctx.missionId = 'mission-falhou';
    ctx.role = 'orchestrator';
    ctx.promotedFromUserSession = true;
    ctx.contextRevision = 'c'.repeat(64);

    expect(returnOperatorHandFromEndedMission(ctx)).toBe(true);

    expect(ctx.role).toBe('user');
    expect(ctx.missionId).toBeUndefined();
    expect(ctx.contextRevision).toBeUndefined();
    expect(ctx).not.toHaveProperty('promotedFromUserSession');
    expect(ctx.allowedTools).toEqual(['nexus_pane_spawn', 'nexus_mission_create']);
  });

  it('missão encerrada nunca devolve como user quem não era a mão do operador', () => {
    const scope = testProjectScope();
    const worker = mintToken({
      label: 'worker',
      role: 'worker',
      missionId: 'mission-falhou',
      scope,
      allowedTools: [],
    });
    bindTokenToSession(worker.token, 'pty-worker-falhou');
    const workerCtx = getContextBySession('pty-worker-falhou')!;
    expect(returnOperatorHandFromEndedMission(workerCtx)).toBe(false);
    expect(workerCtx).toMatchObject({ role: 'worker', missionId: 'mission-falhou' });

    // Worker com a marca de promoção: a troca de coroa não produz mais esse
    // estado (devolve a `user`), então só autoridade da missão chega aqui.
    const pane = mintToken({ label: 'pane', role: 'user', scope, allowedTools: null });
    bindTokenToSession(pane.token, 'pty-rebaixado');
    const demoted = getContextBySession('pty-rebaixado')!;
    demoted.missionId = 'mission-falhou';
    demoted.role = 'worker';
    demoted.promotedFromUserSession = true;
    expect(returnOperatorHandFromEndedMission(demoted)).toBe(false);
    expect(demoted.role).toBe('worker');
  });

  it('troca de coroa devolve a `user` o líder que era a mão do operador, com o allowlist que tinha', () => {
    const scope = testProjectScope();
    const hand = mintToken({ label: 'hand', role: 'user', scope, allowedTools: ['nexus_pane_list'] });
    bindTokenToSession(hand.token, 'pty-hand');
    expect(adoptUserSessionAsMissionOrchestrator('pty-hand', 'mission-a')).toBe(true);
    const worker = mintToken({ label: 'w', role: 'worker', missionId: 'mission-a', scope, allowedTools: [] });
    bindTokenToSession(worker.token, 'pty-w');

    expect(
      promoteMissionSessionAuthority({ missionId: 'mission-a', promotedSessionId: 'pty-w', previousSessionId: 'pty-hand' }),
    ).toBe(true);

    const previous = getContextBySession('pty-hand')!;
    expect(previous.role).toBe('user');
    expect(previous.missionId).toBeUndefined();
    expect(previous.promotedFromUserSession).toBeUndefined();
    expect(previous.allowedTools).toEqual(['nexus_pane_list']);
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

  describe('assertCurrentMissionOrchestratorSession', () => {
    const scope = testProjectScope();
    const mission = { id: 'mission-a', orchestratorSessionId: 'leader-session' };
    const ctx = { role: 'orchestrator' as const, missionId: 'mission-a', sessionId: 'leader-session', scope };

    beforeEach(() => {
      requireMissionLeaderSession.mockReset();
      // gate.ts não importa mission-leader-gate (ciclo ESM); o leader-gate se
      // registra no boot. Aqui registramos o mock explicitamente.
      registerMissionLeaderSessionCheck((...args: unknown[]) =>
        requireMissionLeaderSession(...args),
      );
    });

    afterEach(() => {
      registerMissionLeaderSessionCheck(null);
    });

    it('sem leader-gate registrado, vale a ligação durável: mesma sessão passa, outra é stale', () => {
      registerMissionLeaderSessionCheck(null);
      expect(() => assertCurrentMissionOrchestratorSession(ctx, mission)).not.toThrow();
      expect(() =>
        assertCurrentMissionOrchestratorSession({ ...ctx, sessionId: 'someone-else' }, mission),
      ).toThrow(/orchestrator_session_stale/);
      expect(requireMissionLeaderSession).not.toHaveBeenCalled();
    });

    it('passes a proven current leader through to the resolver and allows it', () => {
      requireMissionLeaderSession.mockReturnValue({
        ok: true,
        leader: { sessionId: 'leader-session', paneId: 'pane-1', source: 'durable', proven: true },
      });
      expect(() => assertCurrentMissionOrchestratorSession(ctx, mission)).not.toThrow();
      expect(requireMissionLeaderSession).toHaveBeenCalledWith(scope, 'mission-a', { sessionId: 'leader-session' });
    });

    it('never lets a worker token through: role capability stays a separate check', () => {
      requireMissionLeaderSession.mockReturnValue({
        ok: true,
        leader: { sessionId: 'leader-session', paneId: 'pane-1', source: 'durable', proven: true },
      });
      expect(() =>
        assertCurrentMissionOrchestratorSession({ ...ctx, role: 'worker' }, mission),
      ).toThrow(/only the mission orchestrator/);
      expect(requireMissionLeaderSession).not.toHaveBeenCalled();
    });

    it('rejects a stale session with the resolver code in the message', () => {
      requireMissionLeaderSession.mockReturnValue({
        ok: false, code: 'stale-session', hint: 'reabra a missão',
      });
      expect(() =>
        assertCurrentMissionOrchestratorSession({ ...ctx, sessionId: 'old-session' }, mission),
      ).toThrow(/orchestrator_session_stale \(stale-session\)/);
    });

    it('rejects split-brain by code instead of picking a winner or looping', () => {
      requireMissionLeaderSession.mockReturnValue({
        ok: false, code: 'split-brain', hint: 'duas sessões vivas',
      });
      expect(() => assertCurrentMissionOrchestratorSession(ctx, mission))
        .toThrow(/orchestrator_session_stale \(split-brain\)/);
    });

    it('skips the resolver entirely for legacy missions with no durable orchestrator binding', () => {
      expect(() =>
        assertCurrentMissionOrchestratorSession(ctx, { id: 'mission-a', orchestratorSessionId: null }),
      ).not.toThrow();
      expect(requireMissionLeaderSession).not.toHaveBeenCalled();
    });
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

  describe('allowedSkills semantics (T6)', () => {
    it('treats [] as a hard gate where NO skills are allowed', () => {
      expect(isSkillAllowed([], 'ponytail')).toBe(false);
      expect(isSkillAllowed([], 'impeccable')).toBe(false);
      expect(isSkillAllowed([], 'review')).toBe(false);
    });

    it('treats null/omitted as unrestricted where ANY skill is allowed', () => {
      expect(isSkillAllowed(null, 'ponytail')).toBe(true);
      expect(isSkillAllowed(null, 'impeccable')).toBe(true);
      expect(isSkillAllowed(null, 'any-custom-skill')).toBe(true);
    });

    it('treats populated array as an allowlist permitting only listed skills', () => {
      const list = ['impeccable', 'ponytail'];
      expect(isSkillAllowed(list, 'impeccable')).toBe(true);
      expect(isSkillAllowed(list, 'IMPECCABLE')).toBe(true);
      expect(isSkillAllowed(list, 'ponytail')).toBe(true);
      expect(isSkillAllowed(list, 'review')).toBe(false);
      expect(isSkillAllowed(list, 'blocked')).toBe(false);
    });

    it('arms requiresSpawnGate when allowedSkills is [] but not when null', () => {
      expect(requiresSpawnGate({ role: 'worker', allowedSkills: [] })).toBe(true);
      expect(requiresSpawnGate({ role: 'worker', allowedSkills: ['review'] })).toBe(true);
      expect(requiresSpawnGate({ role: 'worker', allowedSkills: null })).toBe(false);
    });
  });
});

describe('operatorBrief (Jev dispatch guard — filho do operador)', () => {
  beforeEach(() => resetGateForTests());

  it('token do filho do operador carrega o brief mintado', () => {
    const ctx = mintToken({
      label: 'filho do operador',
      role: 'user',
      scope: testProjectScope(),
      operatorBrief: 'implemente a tela de login',
    });
    expect(ctx.operatorBrief).toBe('implemente a tela de login');
  });

  it('worker de missão não ganha operatorBrief', () => {
    const ctx = mintToken({
      label: 'worker',
      role: 'worker',
      missionId: 'mission-1',
      scope: testProjectScope(),
    });
    expect(ctx.operatorBrief).toBeUndefined();
  });
});
