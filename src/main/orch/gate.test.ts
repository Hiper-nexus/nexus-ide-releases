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
  registerHardenedSpawnPolicy,
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

describe('F-1157: o gate não nega tool nem skill a nenhum agente', () => {
  it.each([[null], [[]], [['Read', 'Grep']], [['nexus_pane_read']]] as Array<[string[] | null]>)('allowlist %j não nega nada', (allowed) => {
    for (const tool of [
      'Bash', 'nexus_pane_spawn', 'nexus_pane_write', 'nexus_pr_enqueue', 'nexus_terminal_run',
      // Antes exigiam concessão explícita mesmo com allowlist livre.
      'nexus_remote_spawn', 'nexus_agent_spec_write', 'nexus_remote_cli_detect',
      'nexus_remote_bridge_status', 'nexus_cron', 'nexus_catalog_install', 'nexus_skills',
    ]) {
      expect(isToolAllowed(allowed, tool), tool).toBe(true);
    }
  });

  it.each(['orchestrator', 'worker', 'user'] as const)('o papel %s alcança escrita, git, terminal e mídia', (role) => {
    for (const tool of [
      'nexus_file_write', 'nexus_editor_apply_patch', 'nexus_git_commit', 'nexus_git_push',
      'nexus_terminal_kill', 'nexus_image_generate', 'nexus_terminal_run',
    ]) {
      expect(isToolAllowedForRole(role, [], tool), `${role} ${tool}`).toBe(true);
    }
  });

  it('isSkillAllowed libera toda skill, com qualquer lista', () => {
    for (const allowed of [null, [], ['code-review']]) {
      expect(isSkillAllowed(allowed, 'deploy')).toBe(true);
      expect(isSkillAllowed(allowed, 'Code-Review')).toBe(true);
    }
  });

  it('canonicalToolName segue normalizando o namespace', () => {
    expect(canonicalToolName('nexus_pane_read')).toBe('pane_read');
  });

  it('F-1477: a marca de revisão informativa do spawn chega ao token (e só quando o Main a deu)', () => {
    resetGateForTests();
    const informative = mintToken({ label: 'info', role: 'worker', missionId: 'm-info', readOnly: true, informativeReview: true, scope: testProjectScope() });
    expect(informative.informativeReview).toBe(true);
    const judge = mintToken({ label: 'juiz', role: 'worker', missionId: 'm-info', readOnly: true, scope: testProjectScope() });
    expect(judge.informativeReview).toBeUndefined();
  });

  it('readOnly só vira fronteira (readOnlyEnforced) quando o operador escolheu o Hardened', () => {
    resetGateForTests();
    const label = mintToken({ label: 'rotulo', role: 'worker', missionId: 'm-ro', readOnly: true, scope: testProjectScope() });
    expect(label.readOnly).toBe(true);
    expect(label.readOnlyEnforced).toBeUndefined();
    registerHardenedSpawnPolicy(() => true);
    try {
      const confined = mintToken({ label: 'hardened', role: 'worker', missionId: 'm-ro', readOnly: true, scope: testProjectScope() });
      expect(confined.readOnlyEnforced).toBe(true);
      const writer = mintToken({ label: 'writer', role: 'worker', missionId: 'm-ro', scope: testProjectScope() });
      expect(writer.readOnlyEnforced).toBeUndefined();
      // Retomada de pane persistido: o rótulo restaurado também confina no Hardened.
      const resumed = mintToken({ label: 'retomado', role: 'user', scope: testProjectScope() });
      bindTokenToSession(resumed.token, 'sess-ro-resume');
      expect(restoreSessionAuthority('sess-ro-resume', { missionId: 'm-ro', role: 'worker', readOnly: true })).toBe(true);
      expect(resumed.readOnlyEnforced).toBe(true);
    } finally {
      registerHardenedSpawnPolicy(() => false);
    }
    // Lookup quebrado é o Autopilot: o rótulo não confina.
    registerHardenedSpawnPolicy(() => { throw new Error('settings indisponíveis'); });
    try {
      expect(mintToken({ label: 'falha', role: 'worker', missionId: 'm-ro', readOnly: true, scope: testProjectScope() }).readOnlyEnforced).toBeUndefined();
    } finally {
      registerHardenedSpawnPolicy(() => false);
    }
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
    // F-1157: o marcador continua sendo prova de mint, mas mídia deixou de ser
    // exclusiva dele — todo orquestrador alcança as tools de geração.
    expect(
      isToolAllowedForRole(
        pet.role,
        pet.allowedTools,
        'nexus_video_generate',
        pet.petStudioMediaAuthority,
      ),
    ).toBe(true);
    expect(
      isToolAllowedForRole(
        'orchestrator',
        maker.allowedTools ?? null,
        'nexus_image_generate',
      ),
    ).toBe(true);

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
