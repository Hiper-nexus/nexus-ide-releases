// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  applyEffectfulSpend,
  applyWorkerSpawnPolicy,
  assertStepAndTokenBudget,
  assertWorkerBudget,
  canDispatchWorkers,
  canRunBootstrapEffects,
  canSubmitMissionHandoff,
  childRespectsParentDenials,
  classifyGoalRisk,
  compileIntentContract,
  defaultBudgetsForRisk,
  estimateEffectfulToolTokens,
  isConsultLane,
  canCompleteConsultLane,
  canCompleteOpsLane,
  hasApprovedDispatchContract,
  hasCurrentDispatchAuthority,
  isAutoDerivedCriterion,
  isDocumentWritablePath,
  isHumanWaitIntentState,
  isRecoveryEligibleIntentState,
  missionBlockPatch,
  missionAttachmentSnapshotSchema,
  missionIntentContractSchema,
  resolveDispatchAuthorizedAt,
  resolveMissionBlockingIntentState,
  resolveEffectiveIntentState,
  reserveEffectfulSpend,
  synthesizeImmediateDispatchContract,
  transitionIntentState,
  type MissionIntentContract,
} from './mission-intent';
import { isExplicitGitSyncGoal, suggestMissionLaneFromGoal } from './mission-intent';
import type { Mission } from './orch-types';

const baseMission = (over: Partial<Mission> = {}): Mission => ({
  id: 'm1',
  title: 'NavalhaGO',
  description: '',
  status: 'pending',
  milestones: [],
  learnings: '',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('mission intent transitions', () => {
  it('canonicalizes approval text before PREVC freezes the same authority', () => {
    const boundaryGoal = `${'x'.repeat(199)} continua`;
    const derived = compileIntentContract({
      goal: `  ${boundaryGoal}  `,
      intentVersion: 1,
    });
    expect(derived.goal).toBe(boundaryGoal);
    expect(derived.acceptanceCriteria[0]).toBe(
      `Objetivo concluído conforme: ${boundaryGoal}`,
    );
    expect(derived.acceptanceCriteria[0]).not.toMatch(/\s$/);

    const longGoal = `${'y'.repeat(500)} requisito-final`;
    const longDerived = compileIntentContract({
      goal: longGoal,
      intentVersion: 1,
    });
    expect(longDerived.acceptanceCriteria[0]).toContain('requisito-final');
    expect(longDerived.acceptanceCriteria[0]).toHaveLength(
      'Objetivo concluído conforme: '.length + longGoal.length,
    );

    const explicit = compileIntentContract({
      goal: 'Entrega explícita',
      acceptanceCriteria: ['  Resultado integrado e validado  '],
      intentVersion: 1,
    });
    expect(explicit.acceptanceCriteria).toEqual([
      'Resultado integrado e validado',
    ]);
  });

  it('accepts only an exact optional SHA-256 native-review receipt', () => {
    const contract = compileIntentContract({
      goal: 'Ship with an auditable approval',
      intentVersion: 1,
    });
    expect(
      missionIntentContractSchema.safeParse({
        ...contract,
        approvalReviewSha256: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      missionIntentContractSchema.safeParse({
        ...contract,
        approvalReviewSha256: 'A'.repeat(64),
      }).success,
    ).toBe(false);
  });

  it('parses legacy generic attachment snapshots and all-or-nothing sealed metadata', () => {
    const legacy = {
      path: '/tmp/legacy-proof.png',
      sha256: 'a'.repeat(64),
      size: 12,
    };
    expect(missionAttachmentSnapshotSchema.parse(legacy)).toEqual(legacy);

    const sealed = {
      ...legacy,
      path:
        '/Users/test/.nexus/mission-attachments/checkout-a/' +
        '0123456789abcdef0123456789abcdef.png',
      sourcePath: '/workspace/.nexus/attachments/reference.png',
      sealId: '0123456789abcdef0123456789abcdef',
      device: '16777234',
      inode: '984721',
    };
    expect(missionAttachmentSnapshotSchema.parse(sealed)).toEqual(sealed);
    expect(
      missionAttachmentSnapshotSchema.safeParse({
        ...legacy,
        sourcePath: sealed.sourcePath,
      }).success,
    ).toBe(false);
    expect(
      missionAttachmentSnapshotSchema.safeParse({
        ...sealed,
        executionPath: '/renderer/grant.png',
      }).success,
    ).toBe(false);
  });

  it('persists only project-relative operator context paths', () => {
    const contract = compileIntentContract({
      goal: 'Corrigir checkout',
      intentVersion: 1,
      contextPaths: ['src/checkout.ts', 'src/checkout.test.ts'],
    });

    expect(contract.contextPaths).toEqual([
      'src/checkout.ts',
      'src/checkout.test.ts',
    ]);
    expect(
      compileIntentContract({
        goal: 'Corrigir checkout',
        intentVersion: 1,
        contextPaths: ['src\\checkout.ts'],
      }).contextPaths,
    ).toEqual(['src/checkout.ts']);
    for (const invalid of [
      '/etc/passwd',
      '../outside.ts',
      'src/../outside.ts',
      'C:\\outside.ts',
      'https://example.com/spec.md',
    ]) {
      expect(() =>
        compileIntentContract({
          goal: 'Corrigir checkout',
          intentVersion: 1,
          contextPaths: [invalid],
        }),
      ).toThrow(/project-relative|context path/i);
    }
  });

  it('keeps orchestrationMode optional and accepts Livre/Pack/Guiado overrides', () => {
    const contract = compileIntentContract({
      goal: 'Ship multi-story pack',
      intentVersion: 1,
    });
    expect(missionIntentContractSchema.safeParse(contract).success).toBe(true);
    expect(
      missionIntentContractSchema.safeParse({
        ...contract,
        orchestrationMode: 'pack',
      }).success,
    ).toBe(true);
    expect(
      missionIntentContractSchema.safeParse({
        ...contract,
        orchestrationMode: 'guided',
      }).success,
    ).toBe(true);
    expect(
      missionIntentContractSchema.safeParse({
        ...contract,
        orchestrationMode: 'yolo',
      }).success,
    ).toBe(false);
  });

  it('materializes Pack template stories at compile when mode is pack', () => {
    const contract = compileIntentContract({
      goal: 'Ship a landing page',
      intentVersion: 1,
      orchestrationMode: 'pack',
      wavePackTemplateId: 'landing',
    });
    expect(contract.orchestrationMode).toBe('pack');
    expect(contract.wavePackTemplateId).toBe('landing');
    expect(contract.wavePackStories).toHaveLength(3);
  });

  it('rejects Pack without a template at compile', () => {
    expect(() =>
      compileIntentContract({
        goal: 'Ship a landing page',
        intentVersion: 1,
        orchestrationMode: 'pack',
      }),
    ).toThrow(/wave_pack_template_required/);
  });

  it('coerces Pack to Guiado when the goal is destructive', () => {
    const contract = compileIntentContract({
      goal: 'Apagar o banco de produção e wipe do cluster',
      intentVersion: 1,
      orchestrationMode: 'pack',
      wavePackTemplateId: 'fix',
    });
    expect(contract.risk).toBe('destructive');
    expect(contract.orchestrationMode).toBe('guided');
    expect(contract.wavePackStories).toBeUndefined();
  });

  it('walks the happy path select → goal → compile → start', () => {
    expect(transitionIntentState({ from: 'draft', event: 'select_squad' })).toEqual({
      ok: true,
      to: 'awaiting_goal',
    });
    expect(
      transitionIntentState({ from: 'awaiting_goal', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
    expect(
      transitionIntentState({ from: 'intent_compiling', event: 'compile_ok' }),
    ).toEqual({ ok: true, to: 'ready_to_start' });
    expect(
      transitionIntentState({ from: 'ready_to_start', event: 'start' }),
    ).toEqual({ ok: true, to: 'dispatched' });
  });

  it('needs_approval não existe mais — nada ENTRA em awaiting_approval (06/08)', () => {
    expect(
      transitionIntentState({ from: 'intent_compiling', event: 'needs_approval' }),
    ).toMatchObject({ ok: false });
    expect(
      transitionIntentState({ from: 'ready_to_start', event: 'needs_approval' }),
    ).toMatchObject({ ok: false });
    // Linhas legadas ainda SAEM do estado estacionado.
    expect(
      transitionIntentState({ from: 'awaiting_approval', event: 'approve' }),
    ).toEqual({ ok: true, to: 'ready_to_start' });
  });

  it('rejects invalid transitions', () => {
    expect(
      transitionIntentState({ from: 'awaiting_goal', event: 'start' }).ok,
    ).toBe(false);
    expect(
      transitionIntentState({ from: 'done', event: 'submit_goal' }).ok,
    ).toBe(false);
  });

  it('lets a new user message preempt a plan but not a frozen active workflow', () => {
    expect(
      transitionIntentState({ from: 'ready_to_start', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
    expect(
      transitionIntentState({ from: 'dispatched', event: 'submit_goal' }).ok,
    ).toBe(false);
    expect(
      transitionIntentState({ from: 'executing', event: 'submit_goal' }).ok,
    ).toBe(false);
  });

  it('lets a new user message redirect a blocked mission', () => {
    // Field trap (28/07): a mission blocked at preflight accepted no new goal,
    // so `Retomar`/`re-armar` could only replay the same failing contract and
    // the operator had no way out of blocked_technical. Recompiling bumps
    // intentVersion, which revokes the old approval — the mission must be
    // approved again before any effect, so this exit never widens authority.
    expect(
      transitionIntentState({ from: 'blocked_technical', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
    expect(
      transitionIntentState({ from: 'blocked_user', event: 'submit_goal' }),
    ).toEqual({ ok: true, to: 'intent_compiling' });
  });
});

describe('mission dispatch authority', () => {
  it('requires both a current approval and a dispatch-capable state', () => {
    const contract = {
      ...compileIntentContract({ goal: 'Ship safely', intentVersion: 2 }),
      approvedAt: 100,
      dispatchedAt: 100,
    };
    expect(
      hasCurrentDispatchAuthority(
        baseMission({
          intentState: 'ready_to_start',
          intentVersion: 2,
          intentContract: contract,
        }),
      ),
    ).toBe(false);
    expect(
      hasCurrentDispatchAuthority(
        baseMission({
          status: 'running',
          intentState: 'dispatched',
          intentVersion: 2,
          intentContract: contract,
        }),
      ),
    ).toBe(true);
    expect(
      hasCurrentDispatchAuthority(
        baseMission({
          status: 'running',
          intentState: 'dispatched',
          intentVersion: 3,
          intentContract: contract,
        }),
      ),
    ).toBe(false);
  });
});

describe('supervisor eligibility', () => {
  it('does not supervise human-wait states', () => {
    for (const state of [
      'awaiting_goal',
      'intent_compiling',
      'ready_to_start',
      'awaiting_approval',
      'blocked_user',
    ] as const) {
      expect(isHumanWaitIntentState(state)).toBe(true);
      expect(isRecoveryEligibleIntentState(state)).toBe(false);
    }
  });

  it('allows recovery only after dispatch', () => {
    for (const state of ['dispatched', 'executing', 'validating'] as const) {
      expect(isRecoveryEligibleIntentState(state)).toBe(true);
      expect(canDispatchWorkers(state)).toBe(true);
    }
  });

  it('keeps an explicit technical block recoverable instead of treating it as human wait', () => {
    const effective = resolveEffectiveIntentState({
      mission: baseMission({
        status: 'blocked',
        intentState: 'blocked_technical',
      }),
      taskCount: 1,
      workerPaneCount: 0,
    });

    expect(effective).toBe('blocked_technical');
    expect(isRecoveryEligibleIntentState(effective)).toBe(true);
    expect(isHumanWaitIntentState(effective)).toBe(false);
  });
});

describe('canonical mission blocking contract', () => {
  it('creates typed user and technical block patches', () => {
    expect(missionBlockPatch('user')).toEqual({
      status: 'blocked',
      intentState: 'blocked_user',
    });
    expect(missionBlockPatch('technical')).toEqual({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
  });

  it('preserves an explicit block kind and defaults only an unspecified block to user', () => {
    expect(
      resolveMissionBlockingIntentState({
        status: 'blocked',
        intentState: 'blocked_technical',
      }),
    ).toBe('blocked_technical');
    expect(
      resolveMissionBlockingIntentState({
        status: 'blocked',
        intentState: 'blocked_user',
      }),
    ).toBe('blocked_user');
    expect(
      resolveMissionBlockingIntentState({
        status: 'blocked',
        intentState: 'executing',
      }),
    ).toBe('blocked_user');
    expect(
      resolveMissionBlockingIntentState({
        status: 'failed',
        intentState: 'blocked_user',
      }),
    ).toBe('blocked_technical');
    expect(
      resolveMissionBlockingIntentState({
        status: 'running',
        intentState: 'blocked_technical',
      }),
    ).toBeNull();
  });
});

describe('resolveEffectiveIntentState (legacy inference)', () => {
  it('treats empty squad selection as awaiting_goal — never a stall', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({ status: 'pending' }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('awaiting_goal');

    expect(
      resolveEffectiveIntentState({
        mission: baseMission({ status: 'running' }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('awaiting_goal');
  });

  it('does NOT treat bare description as a real goal (NavalhaGO / legacy)', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({
          status: 'running',
          description: 'NavalhaGO squad notes only',
          intentState: 'legacy',
        }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('awaiting_goal');
  });

  it('keeps active work as executing when tasks or workers exist', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({ status: 'running' }),
        taskCount: 1,
        workerPaneCount: 0,
      }),
    ).toBe('executing');
  });

  it('honors persisted intentState over inference', () => {
    expect(
      resolveEffectiveIntentState({
        mission: baseMission({
          status: 'pending',
          intentState: 'ready_to_start',
        }),
        taskCount: 0,
        workerPaneCount: 0,
      }),
    ).toBe('ready_to_start');
  });
});

describe('compileIntentContract', () => {
  it('builds a validated contract and classifies risk', () => {
    const normal = compileIntentContract({
      goal: 'Corrigir o botão de salvar no formulário',
      intentVersion: 1,
    });
    expect(normal.risk).toBe('normal');
    expect(normal.goal).toContain('botão');
    expect(normal.budgets.planningTokens).toBe(1_200);
    expect(normal.executionMode).toBe('autopilot');

    expect(classifyGoalRisk('implementar pagamento com PIX')).toBe('sensitive');
    expect(classifyGoalRisk('apagar a tabela users em produção')).toBe(
      'destructive',
    );
  });

  it('rejects empty goals', () => {
    expect(() =>
      compileIntentContract({ goal: '   ', intentVersion: 1 }),
    ).toThrow(/intent_required/);
  });

  it('carimba freeAgentChoice quando o opt-in de modo livre é pedido', () => {
    const free = compileIntentContract({
      goal: 'Corrigir o botão de salvar',
      intentVersion: 1,
      freeAgentChoice: true,
    });
    expect(free.freeAgentChoice).toBe(true);

    // Ausente por padrão: nunca default silencioso.
    const normal = compileIntentContract({
      goal: 'Corrigir o botão de salvar',
      intentVersion: 1,
    });
    expect(normal.freeAgentChoice).toBeUndefined();
  });
  it('marks the synthesized criterion so prompt builders can dedupe it', () => {
    const derived = compileIntentContract({
      goal: 'Corrigir o botão de salvar',
      intentVersion: 1,
    });
    expect(derived.acceptanceCriteria).toHaveLength(1);
    expect(isAutoDerivedCriterion(derived.acceptanceCriteria[0]!)).toBe(true);

    const explicit = compileIntentContract({
      goal: 'Corrigir o botão de salvar',
      intentVersion: 1,
      acceptanceCriteria: ['Formulário salva sem erro'],
    });
    expect(explicit.acceptanceCriteria.some(isAutoDerivedCriterion)).toBe(false);
  });

  it('builds a consult-lane contract with zero workers and explicit lane', () => {
    const consult = compileIntentContract({
      goal: 'Ler logs da Vercel e resumir erros',
      intentVersion: 1,
      lane: 'consult',
    });
    expect(consult.lane).toBe('consult');
    expect(consult.budgets.maxWorkers).toBe(0);
    expect(isConsultLane({ intentContract: consult })).toBe(true);
    expect(isConsultLane({ intentContract: undefined })).toBe(false);
    expect(canCompleteConsultLane({ note: 'curto' })).toBe(false);
    expect(
      canCompleteConsultLane({
        note: 'Resumo: 3 deploys falharam por timeout no build step de TypeScript.',
      }),
    ).toBe(true);
  });

  it('builds an ops-lane contract with real budgets but zero workers', () => {
    const ops = compileIntentContract({
      goal: 'Fazer backup na VPS e subir a landing page',
      intentVersion: 1,
      lane: 'ops',
    });
    expect(ops.lane).toBe('ops');
    // Delegation is denied in the ops lane — workers are never expected.
    expect(ops.budgets.maxWorkers).toBe(0);
    expect(ops.budgets.maxSteps).toBeGreaterThan(32);
    expect(canCompleteOpsLane({ note: 'curto' })).toBe(false);
    expect(
      canCompleteOpsLane({
        note: 'Backup tar.gz gerado na VPS e landing page publicada no nginx.',
      }),
    ).toBe(true);
    expect(
      canCompleteOpsLane({
        learnings: 'Backup ok.',
        note: 'Landing page publicada e DNS propagado com sucesso.',
      }),
    ).toBe(true);
  });
});

describe('bootstrap gate', () => {
  const prepareContract = {
    version: 1 as const,
    source: 'typed' as const,
    goal: 'Preparar contexto do projeto',
    acceptanceCriteria: ['map'],
    risk: 'normal' as const,
    executionMode: 'manual' as const,
    contextPolicy: 'prepare-project' as const,
    intentVersion: 1,
    budgets: {
      planningTokens: 1,
      executionTokens: 1,
      maxWorkers: 1,
      maxSteps: 10,
    },
  };

  it('denies context_doctor before dispatch unless prepare-project', () => {
    expect(canRunBootstrapEffects('awaiting_goal', null)).toBe(false);
    expect(canRunBootstrapEffects('awaiting_goal', prepareContract)).toBe(true);
    expect(canRunBootstrapEffects('dispatched', null)).toBe(true);
  });

  it('restricts prepare-project to warm tools only', () => {
    expect(
      canRunBootstrapEffects('awaiting_goal', prepareContract, 'nexus_context_doctor'),
    ).toBe(true);
    expect(
      canRunBootstrapEffects('awaiting_goal', prepareContract, 'nexus_mission_freeze_contract'),
    ).toBe(false);
    expect(
      canRunBootstrapEffects('awaiting_goal', prepareContract, 'nexus_context_draft_apply'),
    ).toBe(false);
  });
});

describe('dispatch SLA anchor', () => {
  it('uses approvedAt/dispatchedAt and never invents arm time', () => {
    expect(
      resolveDispatchAuthorizedAt({
        intentContract: undefined,
      }),
    ).toBeNull();
    expect(
      resolveDispatchAuthorizedAt({
        intentContract: compileIntentContract({
          goal: 'x',
          intentVersion: 1,
        }),
      }),
    ).toBeNull();
    const withApprove = compileIntentContract({ goal: 'ship fix', intentVersion: 1 });
    const approved = {
      ...withApprove,
      approvedAt: 1_000,
      dispatchedAt: 1_100,
    };
    expect(resolveDispatchAuthorizedAt({ intentContract: approved })).toBe(1_100);
  });
});

describe('budget and parent/child ceilings', () => {
  it('denies workers beyond maxWorkers', () => {
    const contract = compileIntentContract({
      goal: 'small task',
      intentVersion: 1,
    });
    // default maxWorkers for normal is 64 (schema ceiling, free operation)
    expect(assertWorkerBudget(contract, 63).ok).toBe(true);
    expect(assertWorkerBudget(contract, 64).ok).toBe(false);
    // No contract = no ceiling (legacy mid-migration).
    expect(assertWorkerBudget(null, 99).ok).toBe(true);
  });

  it('risk gates the approval surface, not parallelism', () => {
    // No modo livre todos os riscos usam o teto do schema; a aprovação é que
    // controla o risco, não o paralelismo.
    expect(defaultBudgetsForRisk('normal').maxWorkers).toBe(64);
    expect(defaultBudgetsForRisk('sensitive').maxWorkers).toBe(64);
    expect(defaultBudgetsForRisk('destructive').maxWorkers).toBe(64);
  });

  it('synthesizes an approved contract for immediate legacy/pet shells', () => {
    const c = synthesizeImmediateDispatchContract({ title: 'Pet hatch' });
    expect(hasApprovedDispatchContract(c)).toBe(true);
    expect(c.budgets.maxWorkers).toBeGreaterThan(0);
    expect(c.dispatchedAt).toBeDefined();
  });

  it('synthesizes Pet Studio as a sealed single-session profile', () => {
    const c = synthesizeImmediateDispatchContract({
      title: 'Pet hatch',
      goal: 'Crie o pet usando /tmp/source.png',
      profile: 'pet-studio',
      now: 5_000,
    });
    expect(hasApprovedDispatchContract(c)).toBe(true);
    expect(c.budgets.maxWorkers).toBe(0);
    expect(c.acceptanceCriteria.join('\n')).toContain('nexus-pet-studio');
    expect(c.acceptanceCriteria.join('\n')).not.toMatch(/workers?|PREVC/i);
    expect(c.deniedTools).toEqual(
      expect.arrayContaining(['pane_spawn', 'route_task', 'worktree_merge']),
    );
  });

  it('steps/tokens são ledger, nunca teto — missão esgotada não bloqueia', () => {
    const base = compileIntentContract({ goal: 'x', intentVersion: 1 });
    // Caso de campo 17/07: contrato "sensível" com 12k tokens sintéticos
    // esgotados no bootstrap travava a missão inteira.
    const exhausted = {
      ...base,
      budgets: { ...base.budgets, executionTokens: 150, maxSteps: 1 },
      spentSteps: 999,
      spentTokens: 999_999,
    };
    expect(assertStepAndTokenBudget(exhausted).ok).toBe(true);
    expect(assertStepAndTokenBudget(null).ok).toBe(true);
  });

  it('ledger continua contando spend por tool com efeito', () => {
    const base = compileIntentContract({ goal: 'x', intentVersion: 1 });
    expect(estimateEffectfulToolTokens('nexus_file_write')).toBeGreaterThan(0);
    const contract = applyEffectfulSpend(
      {
        ...base,
        budgets: { ...base.budgets, executionTokens: 150 },
        spentTokens: 0,
        spentSteps: 0,
      } satisfies MissionIntentContract,
      'nexus_file_write',
    );
    expect(contract.spentSteps).toBe(1);
    expect(contract.spentTokens).toBeGreaterThan(0);
  });

  it('reserva registra o gasto e nunca nega, mesmo além do teto antigo', () => {
    const base = compileIntentContract({ goal: 'x', intentVersion: 1 });
    const beyondOldCaps = {
      ...base,
      budgets: { ...base.budgets, executionTokens: 150, maxSteps: 1 },
      spentSteps: 50,
      spentTokens: 150,
    };
    const reserved = reserveEffectfulSpend(beyondOldCaps, 'nexus_file_write');
    expect(reserved.ok).toBe(true);
    if (reserved.ok) {
      expect(reserved.contract.spentSteps).toBe(51);
      expect(reserved.contract.spentTokens).toBeGreaterThan(150);
    }
  });

  it('denies second worker at maxWorkers and strips denied tools on spawn policy', () => {
    const contract = compileIntentContract({ goal: 'x', intentVersion: 1 });
    const capped = {
      ...contract,
      budgets: { ...contract.budgets, maxWorkers: 1 },
      deniedTools: ['terminal_run', 'file_write'],
    };
    expect(
      applyWorkerSpawnPolicy({
        contract: capped,
        currentWorkerCount: 1,
        allowedTools: ['file_read', 'terminal_run', 'grep'],
      }).ok,
    ).toBe(false);
    const ok = applyWorkerSpawnPolicy({
      contract: capped,
      currentWorkerCount: 0,
      allowedTools: ['file_read', 'terminal_run', 'grep'],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.allowedTools) {
      expect(ok.allowedTools).toContain('file_read');
      expect(ok.allowedTools).not.toContain('terminal_run');
    }
  });

  it('requires child denials to respect parent', () => {
    expect(childRespectsParentDenials(['terminal_run'], ['terminal_run', 'file_write'])).toBe(
      true,
    );
    expect(childRespectsParentDenials(['terminal_run'], ['file_write'])).toBe(false);
  });

  it('requires handoff origin binding', () => {
    expect(
      canSubmitMissionHandoff({
        role: 'worker',
        missionId: 'm1',
        sessionId: 's1',
        intentState: 'dispatched',
      }).ok,
    ).toBe(true);
    expect(
      canSubmitMissionHandoff({
        role: 'user',
        missionId: 'm1',
        sessionId: 's1',
        intentState: 'dispatched',
      }).ok,
    ).toBe(false);
    expect(
      canSubmitMissionHandoff({
        role: 'worker',
        missionId: 'm1',
        sessionId: 's1',
        intentState: 'awaiting_goal',
      }).ok,
    ).toBe(false);
  });
});

describe('documentation write fence', () => {
  it('accepts real documentation, including plain-text notes', () => {
    for (const file of [
      'plan.md',
      'docs/plan.md',
      'README.md',
      'docs/adr/0007-merge-queue.md',
      'documentation/guide.rst',
      'NOTES.txt',
      'docs/release-notes.txt',
      'src/components/Button.md',
    ]) {
      expect(isDocumentWritablePath(file)).toBe(true);
    }
  });

  it('rejects dependency manifests and build scripts that only look like text', () => {
    // The guided ownership catalog seeds EVERY plan with these three names
    // unconditionally (guided-mission-ownership), so a `doc` mission would
    // otherwise own a dependency pin and a build script.
    for (const file of [
      'requirements.txt',
      'requirements-dev.txt',
      'CMakeLists.txt',
      'cmakelists.txt',
      'conanfile.txt',
      'constraints.txt',
      'dev-requirements.txt',
      'test_requirements.txt',
      'server/requirements.txt',
      // A manifest under a documentation directory is still a manifest.
      'docs/requirements.txt',
      'docs/CMakeLists.txt',
    ]) {
      expect(isDocumentWritablePath(file)).toBe(false);
    }
  });

  it('still rejects code, config and directory claims that are not documentation', () => {
    for (const file of [
      'src',
      'src/app.ts',
      'package.json',
      'vite.config.ts',
      'Makefile',
    ]) {
      expect(isDocumentWritablePath(file)).toBe(false);
    }
  });
});

describe('suggestMissionLaneFromGoal — o que o leigo pede de verdade', () => {
  it('recusa explícita de código vence o detector de implementação', () => {
    // Sonda 23/08: "sem escrever código" casava em "escrever código" e a
    // missão de planejamento virava implementação — o oposto do pedido.
    expect(
      suggestMissionLaneFromGoal(
        'planeje adicionar uma seção de contato no rodapé, só o plano, sem escrever código',
      ),
    ).toBe('plan');
    expect(
      suggestMissionLaneFromGoal('planeje o módulo de pix, sem código'),
    ).toBe('plan');
    expect(
      suggestMissionLaneFromGoal('não implemente ainda, só desenhe a solução'),
    ).toBe('plan');
  });

  it('"antes de implementar" é planejamento, não implementação', () => {
    expect(
      suggestMissionLaneFromGoal(
        'me ajude a decidir a arquitetura do módulo de relatórios antes de implementar',
      ),
    ).toBe('plan');
  });

  it('auditoria QUE PEDE CONSERTO não pode cair em somente-leitura', () => {
    // `consult` é "investigar sem alterar arquivos": uma missão que pede o
    // conserto ficaria proibida de consertar.
    expect(
      suggestMissionLaneFromGoal(
        'faça uma auditoria de segurança no login e corrija o que estiver vulnerável',
      ),
    ).not.toBe('consult');
    expect(
      suggestMissionLaneFromGoal(
        'revise as permissões de acesso e proteja as rotas de admin',
      ),
    ).not.toBe('consult');
  });

  it('investigação pura continua somente-leitura', () => {
    expect(
      suggestMissionLaneFromGoal('investigue por que o login está lento'),
    ).toBe('consult');
  });

  it('"revise ..., sem corrigir" é consult, não lane de escrita (F-1304)', () => {
    // O passo 4 casa "corrigir" sem honrar o "sem": a recusa de escrita
    // precisava negar corrigir/aplicar/consertar/resolver também.
    expect(
      suggestMissionLaneFromGoal(
        'revise este PR com olhar adversarial e consolide os achados, sem corrigir',
      ),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('audite a entrega e me diga o que está errado, sem aplicar nada'),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('analise o bug e aponte a causa, sem consertar'),
    ).toBe('consult');
  });

  it('"corrija X sem corrigir Y" é escrita: a negação só nega o objeto dela (F-1304, revisão Fable)', () => {
    // Revisão Fable: a recusa do passo 1 "vencia TUDO" e casava "sem
    // corrigir"/"sem aplicar" mesmo com o verbo principal de escrita.
    expect(
      suggestMissionLaneFromGoal(
        'implemente o endpoint de exportação CSV sem aplicar o lint nos arquivos antigos',
      ),
    ).toBeNull();
    expect(
      suggestMissionLaneFromGoal('corrija o bug do login sem corrigir os warnings antigos'),
    ).toBeNull();
    expect(
      suggestMissionLaneFromGoal('adicione o filtro por data sem alterar o schema do banco'),
    ).toBeNull();
    // A recusa sem verbo principal de escrita continua só-leitura, inclusive
    // quando o verbo de escrita aparece só como complemento ("como corrigir").
    expect(
      suggestMissionLaneFromGoal('não altere nada, me diga como corrigir o login'),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('revise o módulo de pagamento sem corrigir nem refatorar'),
    ).toBe('consult');
    expect(
      suggestMissionLaneFromGoal('corrija o login, mas somente leitura por enquanto'),
    ).toBe('consult');
  });

  it('recusa global, cadeia negada e verbo fora do início de oração seguem consult (F-1304, revisão Fable #2)', () => {
    for (const goal of [
      'não mexa em nada; só quero saber se a tela cria o registro certo',
      'sem alterar nada, verifique se a tela cria o registro',
      'revise o módulo de pagamento sem alterar ou corrigir nada',
      'analise o fluxo e aponte o que precisa resolver, sem corrigir',
    ]) {
      expect(suggestMissionLaneFromGoal(goal), goal).toBe('consult');
    }
    // "nada além do X" é escopo, não recusa global.
    expect(
      suggestMissionLaneFromGoal('corrija o typo do rodapé sem alterar nada além do README'),
    ).toBeNull();
  });
});

/**
 * F-1304 — tabela das revisões Fable #1, #2 e #3. Princípio: na dúvida,
 * ESCRITA (null); consult só quando o pedido é claramente só-leitura — a lane
 * consult tira o worker que escreve no Expresso e libera entrega sem arquivo.
 */
describe('F-1304 — negação com escopo × recusa só-leitura (revisões Fable #1–#3)', () => {
  it.each<[string, 'consult' | null]>([
    // Fable #1: "sem X" só nega X.
    ['implemente o endpoint de exportação CSV sem aplicar o lint nos arquivos antigos', null],
    ['corrija o bug do login sem corrigir os warnings antigos', null],
    ['adicione o filtro por data sem alterar o schema do banco', null],
    ['corrija o typo do rodapé sem alterar nada além do README', null],
    // Fable #3 (1): pedido de escrita em PT-BR corrente.
    ['quero que você corrija o bug do login sem alterar o schema', null],
    ['preciso corrigir o bug sem alterar o schema', null],
    ['pode corrigir o bug sem alterar o schema', null],
    ['vamos corrigir o bug sem alterar o schema', null],
    ['tem que corrigir o bug sem alterar o schema', null],
    ['preciso que você adicione o filtro sem alterar o schema', null],
    ['quero que você refatore o módulo sem mudar a API', null],
    ['a tarefa é corrigir o bug sem alterar o schema', null],
    // Fable #3 (2): "nada no/do X" é escopo, não recusa global.
    ['corrija o login sem alterar nada no banco', null],
    ['adicione o índice sem mexer em nada do schema', null],
    ['implemente o cache, mas não altere nada no banco', null],
    // Fable #3 (3): "não mexa" sozinho não é global.
    ['corrija o bug do login; no resto, não mexa', null],
    // Fable #2: recusa global, cadeia negada, verbo de complemento.
    ['não mexa em nada; só quero saber se a tela cria o registro certo', 'consult'],
    ['sem alterar nada, verifique se a tela cria o registro', 'consult'],
    ['revise o módulo de pagamento sem alterar ou corrigir nada', 'consult'],
    ['analise o fluxo e aponte o que precisa resolver, sem corrigir', 'consult'],
    // F-1304 original e vizinhos.
    ['revise este PR com olhar adversarial e consolide os achados, sem corrigir', 'consult'],
    ['audite a entrega e me diga o que está errado, sem aplicar nada', 'consult'],
    ['analise o bug e aponte a causa, sem consertar', 'consult'],
    ['não altere nada, me diga como corrigir o login', 'consult'],
    ['revise o módulo de pagamento sem corrigir nem refatorar', 'consult'],
    ['corrija o login, mas somente leitura por enquanto', 'consult'],
  ])('%j → %s', (goal, lane) => {
    expect(suggestMissionLaneFromGoal(goal)).toBe(lane);
  });
});

describe('missão MISTA — a lane não pode proibir a outra metade', () => {
  it('construir E auditar não vira somente-leitura', () => {
    // Sonda 23/08: caía em `consult` por causa de "auditoria", e a missão
    // ficava proibida de construir o que foi mandada construir.
    expect(
      suggestMissionLaneFromGoal(
        'construa a area de login do sistema e faça uma auditoria de seguranca nela',
      ),
    ).not.toBe('consult');
  });

  it('planejar E depois implementar não vira só-plano', () => {
    // `plan` faz o coordenador escrever o plano e NÃO abrir trabalhadores:
    // o "depois implemente" nunca aconteceria.
    expect(
      suggestMissionLaneFromGoal(
        'planeje a arquitetura do modulo de relatorios e depois implemente',
      ),
    ).not.toBe('plan');
  });

  it('mas a recusa EXPLÍCITA de código continua valendo', () => {
    expect(
      suggestMissionLaneFromGoal(
        'planeje o formulario de contato, só o plano, sem escrever codigo',
      ),
    ).toBe('plan');
  });

  it('investigação pura continua somente-leitura', () => {
    expect(
      suggestMissionLaneFromGoal('investigue por que o login esta lento'),
    ).toBe('consult');
  });
});

describe('sincronização Git somente operacional (F-785)', () => {
  it('pedido de só sincronizar/atualizar o repositório é ops, não standard', () => {
    // Campo 03/10: "atualiza o repositório local com o GitHub" nasceu standard
    // e o set_status recusou o done sem arquivo — mas o gate de entrega já
    // aceita ops com nota durável. O merge/pull aqui é o TRANSPORTE da
    // sincronização, não integração de código novo.
    expect(
      suggestMissionLaneFromGoal('atualiza o repositório local com o GitHub'),
    ).toBe('ops');
    expect(
      suggestMissionLaneFromGoal('Sincronizar git com git merge --ff-only origin/main'),
    ).toBe('ops');
    expect(suggestMissionLaneFromGoal('sincronize o repositório com origin')).toBe('ops');
    expect(suggestMissionLaneFromGoal('faça git pull --ff-only na branch principal')).toBe('ops');
  });

  it('pedido MISTO ("sincronize e corrija") continua standard', () => {
    expect(
      suggestMissionLaneFromGoal('sincronize o repositório e corrija o bug do login'),
    ).toBeNull();
    expect(
      suggestMissionLaneFromGoal('atualiza o repositório e implementa a tela de perfil'),
    ).toBeNull();
  });

  it('"sincronização de dados" como feature não é operação Git', () => {
    expect(
      suggestMissionLaneFromGoal('implementar a sincronização de dados em tempo real'),
    ).toBeNull();
  });
});

/**
 * F-811: o classificador "só sincronização" era largo — verbo de sync + a
 * palavra git/github/repo virava `ops`, e em `ops` o done é aceito sem arquivo
 * (e `maxWorkers` zera). Agora o texto INTEIRO precisa ser sincronização, em
 * forma explícita.
 */
describe('sincronização Git EXPLÍCITA (F-811)', () => {
  it.each([
    'atualize as dependências do repositório para a versão mais nova',
    'atualizar o workflow do GitHub Actions',
    'atualize o README do repositório',
    'fetch os dados da API do GitHub e mostre no dashboard',
    'puxe as issues do github e gere um relatório em docs/',
    'atualize o repositório com as novas regras de lint',
    'atualize o repositório e reescreva o módulo de pagamentos',
    'atualiza o repositório, depois mexa nos testes',
    'update the repo dependencies',
    'puxe os pacotes do repositório e rode o build',
    'sincronize o projeto com o github',
    'faça merge da branch feature na main',
    'git pull --rebase origin main',
  ])('tarefa de escrita/outro objeto NÃO é ops: %s', (goal) => {
    expect(isExplicitGitSyncGoal(goal)).toBe(false);
    expect(suggestMissionLaneFromGoal(goal)).not.toBe('ops');
  });

  it('"investigue por que o git pull falha" é investigação (consult), não ops', () => {
    expect(isExplicitGitSyncGoal('investigue por que o git pull falha')).toBe(false);
    expect(suggestMissionLaneFromGoal('investigue por que o git pull falha')).toBe('consult');
    expect(suggestMissionLaneFromGoal('analise por que o git fetch demora tanto')).toBe('consult');
  });

  it.each([
    'atualiza o repositório local com o GitHub',
    'Atualiza o repositório local com o GitHub.',
    'Sincronizar git com git merge --ff-only origin/main',
    'sincronize o repositório com origin',
    'faça git pull --ff-only na branch principal',
    'git pull',
    'git fetch origin',
    'Sync repo com upstream/main (fast-forward)',
    'puxe as últimas mudanças do origin',
    'sincronize a branch main com o origin/main, por favor',
    'faça fast-forward da main',
    'Sincronizar repositório — somente fast-forward',
  ])('forma explícita de sincronização É ops: %s', (goal) => {
    expect(isExplicitGitSyncGoal(goal)).toBe(true);
    expect(suggestMissionLaneFromGoal(goal)).toBe('ops');
  });

  it('merge só é transporte quando a própria frase diz fast-forward', () => {
    expect(isExplicitGitSyncGoal('git merge origin/main')).toBe(false);
    expect(isExplicitGitSyncGoal('atualize o repositório com merge do origin')).toBe(false);
    expect(isExplicitGitSyncGoal('git merge --ff-only origin/main')).toBe(true);
  });

  it('verbo sem objeto de repositório, ou objeto sem verbo, não basta', () => {
    expect(isExplicitGitSyncGoal('atualize')).toBe(false);
    expect(isExplicitGitSyncGoal('pull')).toBe(false);
    expect(isExplicitGitSyncGoal('o repositório local')).toBe(false);
    expect(isExplicitGitSyncGoal('')).toBe(false);
  });

  it('recusa explícita de alterar continua vencendo (consult)', () => {
    expect(
      suggestMissionLaneFromGoal('sem alterar nada, mostre o que o git pull traria'),
    ).toBe('consult');
  });

  describe('varredura linear', () => {
    const SIZE = 16_384;
    const inputs: Array<[string, string]> = [
      ['"atualiza " repetido', 'atualiza '.repeat(SIZE / 9)],
      ['"git pull " repetido', 'git pull '.repeat(SIZE / 9)],
      ['verbo + espaços sem objeto', `atualiza${' '.repeat(SIZE - 8)}`],
      ['só espaços', ' '.repeat(SIZE)],
      ['pontuação solta', '.'.repeat(SIZE)],
      ['aspas aninhadas', `${'"\'`('.repeat(SIZE / 4)}`],
      ['"--ff-" parcial repetido', '--ff-'.repeat(SIZE / 5)],
      ['origin/ longo', `origin/${'a'.repeat(SIZE - 7)}`],
      ['acentos combinantes', `a${'́'.repeat(SIZE - 1)}`],
      ['frase de sync + lixo', `sincronize o repositório com origin ${'x'.repeat(SIZE - 36)}`],
    ];

    it.each(inputs)('%s: tempo linear (teto 50 ms)', (_label, text) => {
      // Aquece: compilação/tier-up não é o que está sendo medido.
      isExplicitGitSyncGoal(text);
      suggestMissionLaneFromGoal(text);
      const startedAt = performance.now();
      const verdict = isExplicitGitSyncGoal(text);
      const lane = suggestMissionLaneFromGoal(text);
      const elapsedMs = performance.now() - startedAt;
      expect(verdict).toBe(false);
      expect(lane).not.toBe('ops');
      expect(elapsedMs).toBeLessThan(50);
    });
  });
});
