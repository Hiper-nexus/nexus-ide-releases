import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ADAPTIVE_CAP,
  decideSchedule,
  diagnoseWaveConcurrency,
  type ScheduleConfig,
  type ScheduleDecision,
  type ScheduleTask,
} from './mission-scheduler';
import {
  createSchedulerRuntimeState,
  runSchedulerTick,
} from './mission-scheduler-runtime';

const OWNERSHIP = (file: string) => ({
  files: [file],
  symbols: [] as string[],
  domains: ['wave-pack-disjoint-files'],
});

function disjointStories(count: number): ScheduleTask[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `story-${String(index + 1).padStart(2, '0')}`,
    status: 'pending' as const,
    dependsOn: [] as string[],
    ownership: OWNERSHIP(`src/feature-${index + 1}.ts`),
    merged: false,
  }));
}

const NOW = 1_700_000_000_000;

function diagnose(tasks: ScheduleTask[], config: ScheduleConfig) {
  return diagnoseWaveConcurrency(config, decideSchedule(tasks, [], config, NOW));
}

describe('diagnoseWaveConcurrency — silent throttling is itself a bug (P0-9)', () => {
  it('names the operator-raisable ceiling when maxWorkers is what pins the wave', () => {
    // The field symptom: 11 genuinely independent stories, only 2 panes alive.
    const diagnosis = diagnose(disjointStories(11), {
      configuredCap: 2,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.effectiveCap).toBe(2);
    expect(diagnosis.binding).toBe('configured');
    expect(diagnosis.readyCount).toBe(11);
    expect(diagnosis.admittedCount).toBe(2);
    expect(diagnosis.deferredByCap).toBe(9);
    expect(diagnosis.phase).toBe('throttled');
    expect(diagnosis.operatorRaisable).toBe(true);
    // The operator must be able to READ why, not guess.
    expect(diagnosis.summary).toContain('11');
    expect(diagnosis.summary).toContain('2');
    expect(diagnosis.summary).toMatch(/maxWorkers/i);
  });

  it('names the host cores when the machine — not the contract — is the ceiling', () => {
    // This machine: 10 cores → coreBudget 8. 11 stories can never run 11-wide.
    const diagnosis = diagnose(disjointStories(11), {
      configuredCap: 16,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.effectiveCap).toBe(8);
    expect(diagnosis.binding).toBe('cores');
    expect(diagnosis.deferredByCap).toBe(3);
    expect(diagnosis.phase).toBe('throttled');
    // Raising maxWorkers would change nothing — say so instead of implying it.
    expect(diagnosis.operatorRaisable).toBe(false);
    expect(diagnosis.summary).toMatch(/núcleos/i);
  });

  it('names the pane budget when the layout is the binding ceiling', () => {
    const diagnosis = diagnose(disjointStories(11), {
      configuredCap: 16,
      cores: 64,
      paneBudget: 4,
    });

    expect(diagnosis.effectiveCap).toBe(4);
    expect(diagnosis.binding).toBe('panes');
    expect(diagnosis.operatorRaisable).toBe(false);
    expect(diagnosis.summary).toMatch(/panes/i);
  });

  it('prefers the operator-raisable constraint when ceilings tie', () => {
    // configured === coreBudget === 8: reporting "cores" would send the operator
    // to a dead end when raising maxWorkers is the actionable half of the tie.
    const diagnosis = diagnose(disjointStories(11), {
      configuredCap: 8,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.effectiveCap).toBe(8);
    expect(diagnosis.binding).toBe('configured');
    expect(diagnosis.operatorRaisable).toBe(true);
  });

  it('reports PHASE honesty: one eligible unit is the plan, not a throttle', () => {
    // A legitimately serial phase (single doc/manifest). The UI must say so
    // instead of leaving the operator guessing why only one pane is alive.
    const diagnosis = diagnose(disjointStories(1), {
      configuredCap: 8,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.phase).toBe('sequential');
    expect(diagnosis.deferredByCap).toBe(0);
    expect(diagnosis.readyCount).toBe(1);
    expect(diagnosis.summary).toMatch(/sequencial/i);
    expect(diagnosis.summary).toContain('1 unidade elegível');
  });

  it('reports a serial CHAIN as a sequential phase, not as a cap problem', () => {
    // The planner-emitted chain: 11 stories where each depends on the previous.
    // Exactly one is ever ready — the ceiling is the DECOMPOSITION.
    const chain = disjointStories(11).map((task, index) =>
      index === 0 ? task : { ...task, dependsOn: [`story-${String(index).padStart(2, '0')}`] },
    );
    const diagnosis = diagnose(chain, {
      configuredCap: 8,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.readyCount).toBe(1);
    expect(diagnosis.phase).toBe('sequential');
    expect(diagnosis.binding).toBe('none');
    expect(diagnosis.deferredByCap).toBe(0);
  });

  it('is silent about throttling when the whole ready set fits the wave', () => {
    const diagnosis = diagnose(disjointStories(4), {
      configuredCap: 8,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.phase).toBe('parallel');
    expect(diagnosis.admittedCount).toBe(4);
    expect(diagnosis.deferredByCap).toBe(0);
    expect(diagnosis.binding).toBe('none');
  });

  it('does not blame the cap when overlap — not capacity — deferred the work', () => {
    // Two stories fighting over the SAME file: the cap has open slots, the
    // ownership does not. Calling that a throttle would misdirect the operator.
    const overlapping: ScheduleTask[] = [
      {
        id: 'story-a',
        status: 'pending',
        dependsOn: [],
        ownership: OWNERSHIP('src/same.ts'),
        merged: false,
      },
      {
        id: 'story-b',
        status: 'pending',
        dependsOn: [],
        ownership: OWNERSHIP('src/same.ts'),
        merged: false,
      },
    ];
    const diagnosis = diagnose(overlapping, {
      configuredCap: 8,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.admittedCount).toBe(1);
    expect(diagnosis.deferredByCap).toBe(0);
    expect(diagnosis.phase).not.toBe('throttled');
  });

  it('diagnoses the RESOLVED wave config, not the raw contract ceiling', async () => {
    // The governed adaptive ladder clamps the wave to currentCap=2 while the
    // approved contract says 8. Reporting the contract number would tell the
    // operator to raise a ceiling that is not the one binding them.
    const seen: Array<{ decision: ScheduleDecision; config: ScheduleConfig }> = [];
    await runSchedulerTick(
      {
        isParallelSchedulerEnabled: () => true,
        listTasks: () =>
          disjointStories(11).map((task) => ({
            ...task,
            parallelEligible: true,
          })),
        listActiveWorkers: () => [],
        scheduleConfig: () => ({ configuredCap: 8, cores: 10, paneBudget: 14 }),
        // Governed: adaptive ladder ON, so the wave is clamped to 2.
        isAdaptiveCapEnabled: () => true,
        now: () => NOW,
        onDecision: (decision, config) => seen.push({ decision, config }),
        dispatchTask: async () => undefined,
        getChangedFiles: async () => [],
        mergeTask: async () => undefined,
        markMerged: async () => undefined,
        markFailed: async () => undefined,
        reRunSequentially: async () => undefined,
      },
      { ...createSchedulerRuntimeState(), adaptiveCap: DEFAULT_ADAPTIVE_CAP },
    );

    expect(seen).toHaveLength(1);
    const diagnosis = diagnoseWaveConcurrency(seen[0]!.config, seen[0]!.decision);
    expect(diagnosis.effectiveCap).toBe(2);
    expect(diagnosis.binding).toBe('configured');
    expect(diagnosis.phase).toBe('throttled');
    expect(diagnosis.deferredByCap).toBe(9);
  });

  it('blames the adaptive ladder — not the contract — when the ladder narrowed the wave', () => {
    // Hardened policy clamps the wave to DEFAULT_ADAPTIVE_CAP.currentCap = 2
    // while the approved contract says 12. Telling the operator to "raise
    // maxWorkers" here is a dead end: the contract is already 12. The
    // actionable fix is the policy, and the verdict must say so.
    const diagnosis = diagnoseWaveConcurrency(
      { configuredCap: 2, cores: 10, paneBudget: 14 },
      decideSchedule(
        disjointStories(11),
        [],
        { configuredCap: 2, cores: 10, paneBudget: 14 },
        NOW,
      ),
      { contractCap: 12 },
    );

    expect(diagnosis.effectiveCap).toBe(2);
    expect(diagnosis.binding).toBe('adaptive');
    expect(diagnosis.operatorRaisable).toBe(false);
    expect(diagnosis.summary).toMatch(/adaptativa/i);
    expect(diagnosis.summary).not.toMatch(/ajustável no contrato/i);
  });

  it('still blames the contract when the contract IS the narrowest ceiling', () => {
    const diagnosis = diagnoseWaveConcurrency(
      { configuredCap: 2, cores: 10, paneBudget: 14 },
      decideSchedule(
        disjointStories(11),
        [],
        { configuredCap: 2, cores: 10, paneBudget: 14 },
        NOW,
      ),
      { contractCap: 2 },
    );

    expect(diagnosis.binding).toBe('configured');
    expect(diagnosis.operatorRaisable).toBe(true);
  });

  it('never blames the ladder for a ceiling the machine imposed', () => {
    // Ladder at 12, contract at 12, but the host only affords 8. The ladder is
    // not narrowing anything here — cores are.
    const diagnosis = diagnoseWaveConcurrency(
      { configuredCap: 12, cores: 10, paneBudget: 14 },
      decideSchedule(
        disjointStories(11),
        [],
        { configuredCap: 12, cores: 10, paneBudget: 14 },
        NOW,
      ),
      { contractCap: 12 },
    );

    expect(diagnosis.effectiveCap).toBe(8);
    expect(diagnosis.binding).toBe('cores');
  });

  it('surfaces a zero cap as a throttle, never as a quiet stall', () => {
    const diagnosis = diagnose(disjointStories(11), {
      configuredCap: 0,
      cores: 10,
      paneBudget: 14,
    });

    expect(diagnosis.effectiveCap).toBe(0);
    expect(diagnosis.phase).toBe('throttled');
    expect(diagnosis.binding).toBe('configured');
    expect(diagnosis.deferredByCap).toBe(11);
  });
});

describe('caso HiperGO 06/08 — elegíveis vs teto, não só a fase', () => {
  // Voo real: plano de 6 unidades, DAG em diamante (t1 -> {t2,t3} -> {t4,t5} -> t6).
  // Só a raiz está elegível, então UM worker é o número CERTO. O usuário viu
  // "só 2 panes" e concluiu que a máquina estava se segurando. O veredito dizia
  // "fase sequencial: 1 unidade elegível" — verdadeiro, mas mudo sobre as duas
  // coisas que ele precisava: quantas unidades existem ao todo, e quanto teto
  // está sobrando. Sem isso, decisão deliberada é indistinguível de freio.
  it('diz elegíveis DE quantas e o teto disponível numa fase sequencial', () => {
    const diagnosis = diagnoseWaveConcurrency(
      { configuredCap: 12, cores: 10, paneBudget: 14 },
      decideSchedule(disjointStories(1), [], { configuredCap: 12, cores: 10, paneBudget: 14 }, NOW),
      { plannedTotal: 6 },
    );

    expect(diagnosis.phase).toBe('sequential');
    expect(diagnosis.summary).toContain('1 de 6');
    expect(diagnosis.summary).toContain('8');
  });

  it('numa onda paralela diz que TODAS as elegíveis estão rodando e sobra teto', () => {
    const diagnosis = diagnoseWaveConcurrency(
      { configuredCap: 12, cores: 10, paneBudget: 14 },
      decideSchedule(disjointStories(2), [], { configuredCap: 12, cores: 10, paneBudget: 14 }, NOW),
      { plannedTotal: 6 },
    );

    expect(diagnosis.phase).toBe('parallel');
    expect(diagnosis.summary).toContain('2 de 6');
    expect(diagnosis.summary).toContain('8');
  });

  it('sem plannedTotal continua falando só das elegíveis (compatível)', () => {
    const diagnosis = diagnoseWaveConcurrency(
      { configuredCap: 12, cores: 10, paneBudget: 14 },
      decideSchedule(disjointStories(1), [], { configuredCap: 12, cores: 10, paneBudget: 14 }, NOW),
    );

    expect(diagnosis.summary).toContain('1 unidade elegível');
    // Sem total do plano não se inventa "de N", nem se promete teto que não foi medido.
    expect(diagnosis.summary).not.toMatch(/\d+ de \d+/);
    expect(diagnosis.summary).not.toContain('teto disponível');
  });
})
