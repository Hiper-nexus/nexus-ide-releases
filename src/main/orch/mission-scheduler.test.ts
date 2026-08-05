import { describe, expect, it } from 'vitest';
import {
  computeReadySet,
  decideAdaptiveCap,
  decideSchedule,
  effectiveConcurrencyCap,
  emitPlannedTasksWithContract,
  enforceOwnershipOnDiff,
  expandScheduleOwnership,
  independentSubsetTaskIds,
  isReservedGlueFile,
  ownershipTouchesReservedGlue,
  ownershipsIntersect,
  recordConflictTelemetry,
  recordScheduleTelemetry,
  recordViolationTelemetry,
  selectDisjointWave,
  type ActiveWorker,
  type ScheduleConfig,
  type ScheduleTask,
  DEFAULT_ADAPTIVE_CAP,
  EMPTY_SCHEDULER_TELEMETRY,
} from './mission-scheduler';

const NOW = new Date('2026-07-14T12:00:00Z').getTime();

const CAP: ScheduleConfig = {
  configuredCap: 4,
  cores: 8,
  paneBudget: 8,
};

function task(
  id: string,
  overrides: Partial<ScheduleTask> = {},
): ScheduleTask {
  return {
    id,
    status: 'pending',
    dependsOn: [],
    ownership: {
      files: [`src/${id}.ts`],
      symbols: [],
      domains: [],
    },
    merged: false,
    ...overrides,
  };
}

describe('mission-scheduler P0 pure core', () => {
  it('ready set requires dependsOn done+merged (fail-closed on missing dep)', () => {
    const tasks = [
      task('a', { status: 'done', merged: true }),
      task('b', { dependsOn: ['a'] }),
      task('c', { dependsOn: ['missing'] }),
      task('d', { status: 'done', merged: false, dependsOn: [] }),
      task('e', { dependsOn: ['d'] }),
    ];
    const ready = computeReadySet(tasks);
    expect(ready.map((t) => t.id)).toEqual(['b']);
  });

  it('dispatches a disjoint wave of 3 ready independent tasks', () => {
    const tasks = [task('a'), task('b'), task('c')];
    const decision = decideSchedule(tasks, [], CAP, NOW);
    expect(decision.plan.kind).toBe('dispatch');
    if (decision.plan.kind !== 'dispatch') return;
    expect(decision.plan.taskIds).toEqual(['a', 'b', 'c']);
    expect(decision.plan.waveSize).toBe(3);
  });

  it('respects concurrency cap', () => {
    const tasks = [task('a'), task('b'), task('c'), task('d')];
    const decision = decideSchedule(
      tasks,
      [],
      { configuredCap: 2, cores: 16, paneBudget: 10 },
      NOW,
    );
    expect(decision.plan.kind).toBe('dispatch');
    if (decision.plan.kind !== 'dispatch') return;
    expect(decision.plan.waveSize).toBe(2);
    expect(decision.plan.effectiveCap).toBe(2);
    expect(decision.deferredIds).toHaveLength(2);
  });

  it('sequential degenerate when cap=1', () => {
    const tasks = [task('a'), task('b')];
    const decision = decideSchedule(
      tasks,
      [],
      { configuredCap: 1, cores: 8, paneBudget: 8 },
      NOW,
    );
    expect(decision.plan.kind).toBe('dispatch');
    if (decision.plan.kind !== 'dispatch') return;
    expect(decision.plan.taskIds).toEqual(['a']);
    expect(decision.plan.waveSize).toBe(1);
  });

  it('prioritizes guided implementation over advisory roots without reducing the wave', () => {
    const advisory = task('guided-advisory-1', {
      ownership: {
        files: ['src/advisory.ts'],
        symbols: [],
        domains: ['guided-advisory'],
      },
    });
    const execution = task('guided-execution', {
      ownership: {
        files: ['src/execution.ts'],
        symbols: [],
        domains: ['guided-implementation'],
      },
    });

    const capOne = decideSchedule(
      [advisory, execution],
      [],
      { configuredCap: 1, cores: 8, paneBudget: 8 },
      NOW,
    );
    expect(capOne.plan.kind).toBe('dispatch');
    if (capOne.plan.kind !== 'dispatch') return;
    expect(capOne.plan.taskIds).toEqual(['guided-execution']);

    const capTwo = decideSchedule(
      [advisory, execution],
      [],
      { configuredCap: 2, cores: 8, paneBudget: 8 },
      NOW,
    );
    expect(capTwo.plan.kind).toBe('dispatch');
    if (capTwo.plan.kind !== 'dispatch') return;
    expect(capTwo.plan.taskIds).toEqual([
      'guided-execution',
      'guided-advisory-1',
    ]);
  });

  it('blocks dependent until parent is done+merged (next wave)', () => {
    const tasks = [
      task('a'),
      task('b', { dependsOn: ['a'] }),
      task('c'),
    ];
    const first = decideSchedule(tasks, [], CAP, NOW);
    expect(first.plan.kind).toBe('dispatch');
    if (first.plan.kind !== 'dispatch') return;
    expect(first.plan.taskIds).toEqual(['a', 'c']);

    const afterARunning: ScheduleTask[] = [
      task('a', { status: 'running' }),
      task('b', { dependsOn: ['a'] }),
      task('c', { status: 'running' }),
    ];
    const mid = decideSchedule(
      afterARunning,
      [
        { taskId: 'a', ownership: { files: ['src/a.ts'], symbols: [], domains: [] } },
        { taskId: 'c', ownership: { files: ['src/c.ts'], symbols: [], domains: [] } },
      ],
      CAP,
      NOW,
    );
    expect(mid.plan.kind).toBe('wait');
    expect(mid.readyIds).toEqual([]);

    const afterMerge: ScheduleTask[] = [
      task('a', { status: 'done', merged: true }),
      task('b', { dependsOn: ['a'] }),
      task('c', { status: 'done', merged: true }),
    ];
    const second = decideSchedule(afterMerge, [], CAP, NOW);
    expect(second.plan.kind).toBe('dispatch');
    if (second.plan.kind !== 'dispatch') return;
    expect(second.plan.taskIds).toEqual(['b']);
  });

  it('greedy skips overlapping ownership vs wave and running workers', () => {
    const tasks = [
      task('a', { ownership: { files: ['src/shared.ts'], symbols: [], domains: [] } }),
      task('b', { ownership: { files: ['src/shared.ts'], symbols: [], domains: [] } }),
      task('c', { ownership: { files: ['src/c.ts'], symbols: [], domains: [] } }),
    ];
    const decision = decideSchedule(tasks, [], CAP, NOW);
    expect(decision.plan.kind).toBe('dispatch');
    if (decision.plan.kind !== 'dispatch') return;
    // a admitted first (id order), b deferred (overlap), c admitted
    expect(decision.plan.taskIds).toEqual(['a', 'c']);
    expect(decision.deferredIds).toEqual(['b']);

    const workers: ActiveWorker[] = [
      {
        taskId: 'x',
        ownership: { files: ['src/c.ts'], symbols: [], domains: [] },
      },
    ];
    const vsRunning = decideSchedule(tasks, workers, CAP, NOW);
    expect(vsRunning.plan.kind).toBe('dispatch');
    if (vsRunning.plan.kind !== 'dispatch') return;
    expect(vsRunning.plan.taskIds).toEqual(['a']);
    expect(vsRunning.deferredIds).toContain('c');
  });

  it('effective cap is min(configured, cores-2, paneBudget)', () => {
    expect(
      effectiveConcurrencyCap({ configuredCap: 10, cores: 4, paneBudget: 8 }),
    ).toBe(2); // cores-2 = 2
    expect(
      effectiveConcurrencyCap({ configuredCap: 1, cores: 16, paneBudget: 8 }),
    ).toBe(1);
    expect(
      effectiveConcurrencyCap({ configuredCap: 4, cores: 16, paneBudget: 0 }),
    ).toBe(0);
  });

  it('completes when all done+merged; idle-failed when failures remain', () => {
    const done = decideSchedule(
      [
        task('a', { status: 'done', merged: true }),
        task('b', { status: 'done', merged: true }),
      ],
      [],
      CAP,
      NOW,
    );
    expect(done.plan.kind).toBe('complete');

    const failed = decideSchedule(
      [
        task('a', { status: 'done', merged: true }),
        task('b', { status: 'failed', merged: false }),
      ],
      [],
      CAP,
      NOW,
    );
    expect(failed.plan.kind).toBe('idle-failed');
  });
});

describe('mission-scheduler P1 ownership + reserved glue', () => {
  it('detects file/symbol/domain intersection', () => {
    expect(
      ownershipsIntersect(
        { files: ['a.ts'], symbols: [], domains: [] },
        { files: ['a.ts'], symbols: [], domains: [] },
      ),
    ).toBe(true);
    expect(
      ownershipsIntersect(
        { files: ['a.ts'], symbols: ['Foo'], domains: [] },
        { files: ['b.ts'], symbols: ['Foo'], domains: [] },
      ),
    ).toBe(true);
    expect(
      ownershipsIntersect(
        { files: ['a.ts'], symbols: [], domains: ['auth'] },
        { files: ['b.ts'], symbols: [], domains: ['auth'] },
      ),
    ).toBe(true);
    expect(
      ownershipsIntersect(
        { files: ['a.ts'], symbols: ['X'], domains: ['a'] },
        { files: ['b.ts'], symbols: ['Y'], domains: ['b'] },
      ),
    ).toBe(false);
  });

  it('treats directory ownership as overlapping nested file ownership', () => {
    expect(
      ownershipsIntersect(
        { files: ['src/feature'], symbols: [], domains: [] },
        { files: ['src/feature/utils.ts'], symbols: [], domains: [] },
      ),
    ).toBe(true);
    expect(
      ownershipsIntersect(
        { files: ['src/feature'], symbols: [], domains: [] },
        { files: ['src/feature-utils.ts'], symbols: [], domains: [] },
      ),
    ).toBe(false);
  });

  it('reserved glue patterns cover lockfiles, barrels, migrations, .nexus/.context', () => {
    expect(isReservedGlueFile('package-lock.json')).toBe(true);
    expect(isReservedGlueFile('pnpm-lock.yaml')).toBe(true);
    expect(isReservedGlueFile('src/foo/index.ts')).toBe(true);
    expect(isReservedGlueFile('db/migrations/001.sql')).toBe(true);
    expect(isReservedGlueFile('.nexus/project.json')).toBe(true);
    expect(isReservedGlueFile('.context/memory.md')).toBe(true);
    expect(isReservedGlueFile('src/feature/service.ts')).toBe(false);
  });

  it('glue-touching tasks never join a parallel wave', () => {
    const glue = task('lock', {
      ownership: {
        files: ['package-lock.json'],
        symbols: [],
        domains: [],
      },
    });
    const a = task('a');
    const b = task('b');
    const { admitted, deferred } = selectDisjointWave(
      [a, b, glue].sort((x, y) => x.id.localeCompare(y.id)),
      [],
      4,
    );
    // a, b admitted; glue deferred while wave non-empty
    expect(admitted.map((t) => t.id)).toEqual(['a', 'b']);
    expect(deferred.map((t) => t.id)).toEqual(['lock']);

    // Alone with empty wave → sequential admit
    const alone = selectDisjointWave([glue], [], 4);
    expect(alone.admitted.map((t) => t.id)).toEqual(['lock']);
  });

  it('sequential-only / empty ownership never share a wave with peers', () => {
    const seq = task('seq', {
      ownership: {
        files: ['src/seq.ts'],
        symbols: [],
        domains: ['sequential-only'],
      },
    });
    const peer = task('peer', {
      ownership: { files: ['src/peer.ts'], symbols: [], domains: [] },
    });
    // id order: peer before seq
    const wave = selectDisjointWave(
      [peer, seq].sort((x, y) => x.id.localeCompare(y.id)),
      [],
      4,
    );
    expect(wave.admitted.map((t) => t.id)).toEqual(['peer']);
    expect(wave.deferred.map((t) => t.id)).toEqual(['seq']);

    const empty = task('empty', {
      ownership: { files: [], symbols: [], domains: [] },
    });
    const withEmpty = selectDisjointWave([empty, peer], [], 4);
    // empty is exclusive: if first by id ('empty' < 'peer'), admits alone
    expect(withEmpty.admitted).toHaveLength(1);
    expect(withEmpty.deferred).toHaveLength(1);
  });

  it('peer waits while exclusive glue worker is already running', () => {
    const peer = task('peer', {
      ownership: { files: ['src/peer.ts'], symbols: [], domains: [] },
    });
    const glueRunning: ActiveWorker[] = [
      {
        taskId: 'lock',
        ownership: {
          files: ['package-lock.json'],
          symbols: [],
          domains: [],
        },
      },
    ];
    // Ownerships do not intersect (different files) — exclusivity must still block.
    expect(
      ownershipsIntersect(peer.ownership, glueRunning[0]!.ownership),
    ).toBe(false);
    const wave = selectDisjointWave([peer], glueRunning, 4);
    expect(wave.admitted).toEqual([]);
    expect(wave.deferred.map((t) => t.id)).toEqual(['peer']);

    const viaDecide = decideSchedule(
      [
        task('lock', {
          status: 'running',
          ownership: {
            files: ['package-lock.json'],
            symbols: [],
            domains: [],
          },
        }),
        peer,
      ],
      glueRunning,
      CAP,
      NOW,
    );
    expect(viaDecide.plan.kind).toBe('wait');
    expect(viaDecide.admittedIds).toEqual([]);
    expect(viaDecide.readyIds).toContain('peer');
  });

  it('peer waits while sequential-only worker is already running', () => {
    const peer = task('peer', {
      ownership: { files: ['src/peer.ts'], symbols: [], domains: [] },
    });
    const seqRunning: ActiveWorker[] = [
      {
        taskId: 'seq',
        ownership: {
          files: ['src/seq.ts'],
          symbols: [],
          domains: ['sequential-only'],
        },
      },
    ];
    expect(
      ownershipsIntersect(peer.ownership, seqRunning[0]!.ownership),
    ).toBe(false);
    const wave = selectDisjointWave([peer], seqRunning, 4);
    expect(wave.admitted).toEqual([]);
    expect(wave.deferred.map((t) => t.id)).toEqual(['peer']);

    const viaDecide = decideSchedule(
      [
        task('seq', {
          status: 'running',
          ownership: {
            files: ['src/seq.ts'],
            symbols: [],
            domains: ['sequential-only'],
          },
        }),
        peer,
      ],
      seqRunning,
      CAP,
      NOW,
    );
    expect(viaDecide.plan.kind).toBe('wait');
    expect(viaDecide.admittedIds).toEqual([]);
  });

  it('admits sequential-only QA while a parallel advisor scout is still running', () => {
    // Release hang (0.25.1 E2E): stuck e2e-advisor-grok kept running.length>0
    // and deferred exclusive quality-gate forever after reviewer completed.
    const qa = task('qa', {
      ownership: {
        files: [],
        symbols: [],
        domains: ['guided-quality-gate', 'sequential-only'],
      },
    });
    const advisorRunning: ActiveWorker[] = [
      {
        taskId: 'advisor-grok',
        ownership: {
          files: [],
          symbols: [],
          domains: ['guided-advisory'],
        },
      },
    ];
    expect(
      ownershipsIntersect(qa.ownership, advisorRunning[0]!.ownership),
    ).toBe(false);
    const wave = selectDisjointWave([qa], advisorRunning, 4);
    expect(wave.admitted.map((t) => t.id)).toEqual(['qa']);
    expect(wave.deferred).toEqual([]);

    const viaDecide = decideSchedule(
      [
        task('advisor-grok', {
          status: 'running',
          ownership: {
            files: [],
            symbols: [],
            domains: ['guided-advisory'],
          },
        }),
        qa,
      ],
      advisorRunning,
      CAP,
      NOW,
    );
    expect(viaDecide.plan.kind).toBe('dispatch');
    expect(viaDecide.admittedIds).toEqual(['qa']);
  });

  it('blast-radius expansion makes disjointness honest', () => {
    const expand = (files: readonly string[]) =>
      files.flatMap((f) =>
        f === 'src/a.ts' ? ['src/a.ts', 'src/shared.ts'] : [f],
      );
    const left = expandScheduleOwnership(
      { files: ['src/a.ts'], symbols: [], domains: [] },
      expand,
    );
    const right = {
      files: ['src/shared.ts'],
      symbols: [],
      domains: [],
    };
    expect(ownershipsIntersect(left, right)).toBe(true);

    const tasks = [
      task('a', { ownership: { files: ['src/a.ts'], symbols: [], domains: [] } }),
      task('b', {
        ownership: { files: ['src/shared.ts'], symbols: [], domains: [] },
      }),
    ];
    const decision = decideSchedule(tasks, [], CAP, NOW, expand);
    expect(decision.plan.kind).toBe('dispatch');
    if (decision.plan.kind !== 'dispatch') return;
    // Only one admits; the other deferred due to expanded overlap
    expect(decision.plan.waveSize).toBe(1);
    expect(decision.deferredIds).toHaveLength(1);
  });

  it('guided kind domains do not intersect for wave admission', () => {
    expect(
      ownershipsIntersect(
        {
          files: ['src/a.ts'],
          symbols: [],
          domains: ['guided-implementation'],
        },
        {
          files: ['src/b.ts'],
          symbols: [],
          domains: ['guided-advisory'],
        },
      ),
    ).toBe(false);
  });

  it('wave-pack disjoint-file stories fan out; a shared file collides', () => {
    const storyOwnership = (file: string, storyId: string) => ({
      files: [file],
      symbols: [],
      domains: [
        'guided-implementation',
        'wave-pack',
        'wave-pack-disjoint-files',
        `wave-pack-story:${storyId}`,
      ],
    });
    // Distinct files → real disjointness, no intersection, they parallelize.
    expect(
      ownershipsIntersect(
        storyOwnership('src/auth/login.ts', 'a'),
        storyOwnership('src/billing/checkout.ts', 'b'),
      ),
    ).toBe(false);
    // Same file → the disjoint marker makes the file overlap authoritative.
    expect(
      ownershipsIntersect(
        storyOwnership('src/shared/util.ts', 'a'),
        storyOwnership('src/shared/util.ts', 'b'),
      ),
    ).toBe(true);
  });

  it('legacy shared-inventory wave-pack keeps the merge-permit shortcut', () => {
    // No disjoint marker: identical inventory files must NOT intersect, so the
    // existing shared-inventory fan-out (exclusivity via story domain) survives.
    const shared = (storyId: string) => ({
      files: ['src/', 'docs/'],
      symbols: [],
      domains: [
        'guided-implementation',
        'wave-pack',
        `wave-pack-story:${storyId}`,
      ],
    });
    expect(ownershipsIntersect(shared('a'), shared('b'))).toBe(false);
  });

  it('dispatches a disjoint wave of 3 wave-pack story writers', () => {
    const story = (id: string, file: string): ScheduleTask =>
      task(id, {
        ownership: {
          files: [file],
          symbols: [],
          domains: [
            'guided-implementation',
            'wave-pack',
            'wave-pack-disjoint-files',
            `wave-pack-story:${id}`,
          ],
        },
      });
    const tasks = [
      story('s1', 'src/auth/login.ts'),
      story('s2', 'src/auth/session.ts'),
      story('s3', 'src/billing/checkout.ts'),
    ];
    const decision = decideSchedule(tasks, [], CAP, NOW);
    expect(decision.plan.kind).toBe('dispatch');
    if (decision.plan.kind !== 'dispatch') return;
    expect(decision.plan.taskIds).toEqual(['s1', 's2', 's3']);
    expect(decision.plan.waveSize).toBe(3);

    // Two writers colliding on one file: only the first admits, the other waits.
    const collide = [
      story('s1', 'src/shared/util.ts'),
      story('s2', 'src/shared/util.ts'),
      story('s3', 'src/billing/checkout.ts'),
    ];
    const collideDecision = decideSchedule(collide, [], CAP, NOW);
    expect(collideDecision.plan.kind).toBe('dispatch');
    if (collideDecision.plan.kind !== 'dispatch') return;
    expect(collideDecision.plan.taskIds).toEqual(['s1', 's3']);
    expect(collideDecision.deferredIds).toEqual(['s2']);
  });

  it('ownershipTouchesReservedGlue is true for any glue file in set', () => {
    expect(
      ownershipTouchesReservedGlue({
        files: ['src/ok.ts', 'yarn.lock'],
        symbols: [],
        domains: [],
      }),
    ).toBe(true);
  });
});

describe('mission-scheduler P3 enforcement + planner contract', () => {
  it('rejects out-of-scope worktree diff (fail-closed)', () => {
    const result = enforceOwnershipOnDiff(
      ['src/a.ts', 'src/secrets/env.ts'],
      { files: ['src/a.ts'], symbols: [], domains: [] },
    );
    expect(result.ok).toBe(false);
    expect(result.undeclaredFiles).toEqual(['src/secrets/env.ts']);
  });

  it('accepts files within ownership and expanded radius', () => {
    const expand = (files: readonly string[]) => [
      ...files,
      'src/a-helper.ts',
    ];
    const result = enforceOwnershipOnDiff(
      ['src/a.ts', 'src/a-helper.ts'],
      { files: ['src/a.ts'], symbols: [], domains: [] },
      expand,
    );
    expect(result.ok).toBe(true);
  });

  it('planner emits ownership+dependsOn; sequential chain when ownership unknown', () => {
    const sequential = emitPlannedTasksWithContract([
      { id: 't1', title: 'One' },
      { id: 't2', title: 'Two' },
      { id: 't3', title: 'Three' },
    ]);
    expect(sequential).toHaveLength(3);
    expect(sequential[0]!.dependsOn).toEqual([]);
    expect(sequential[1]!.dependsOn).toEqual(['t1']);
    expect(sequential[2]!.dependsOn).toEqual(['t2']);
    expect(sequential.every((t) => !t.parallelEligible)).toBe(true);

    const parallel = emitPlannedTasksWithContract([
      {
        id: 'p1',
        title: 'A',
        ownership: { files: ['src/a.ts'], symbols: [], domains: [] },
      },
      {
        id: 'p2',
        title: 'B',
        ownership: { files: ['src/b.ts'], symbols: [], domains: [] },
        dependsOn: [],
      },
    ]);
    expect(parallel.every((t) => t.parallelEligible)).toBe(true);
    expect(independentSubsetTaskIds(parallel)).toEqual(['p1', 'p2']);
  });

  it('preserves explicit empty dependsOn per task (glue sibling does not chain tips)', () => {
    const planned = emitPlannedTasksWithContract([
      {
        id: 'tip-a',
        title: 'Tip A',
        ownership: {
          files: [],
          symbols: [],
          domains: ['guided-isolated-advisory'],
        },
        dependsOn: [],
      },
      {
        id: 'tip-b',
        title: 'Tip B',
        ownership: {
          files: [],
          symbols: [],
          domains: ['guided-isolated-advisory'],
        },
        dependsOn: [],
      },
      {
        id: 'impl',
        title: 'Impl',
        ownership: {
          files: ['src/index.ts'],
          symbols: [],
          domains: ['guided-implementation'],
        },
        dependsOn: [],
      },
    ]);
    expect(planned.map((t) => t.dependsOn)).toEqual([[], [], []]);
    expect(planned[0]!.parallelEligible).toBe(true);
    expect(planned[1]!.parallelEligible).toBe(true);
    expect(planned[2]!.parallelEligible).toBe(false);
  });
});

describe('mission-scheduler dependency validation', () => {
  it('fails closed on self-dependencies and cycles instead of waiting forever', () => {
    const self = decideSchedule(
      [task('self', { dependsOn: ['self'] })],
      [],
      CAP,
      NOW,
    );
    expect(self.plan).toMatchObject({
      kind: 'idle-invalid',
      invalidTaskIds: ['self'],
    });

    const cycle = decideSchedule(
      [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })],
      [],
      CAP,
      NOW,
    );
    expect(cycle.plan).toMatchObject({
      kind: 'idle-invalid',
      invalidTaskIds: ['a', 'b'],
    });
  });

  it('fails closed on unknown dependencies', () => {
    const decision = decideSchedule(
      [task('orphan', { dependsOn: ['missing'] })],
      [],
      CAP,
      NOW,
    );
    expect(decision.plan).toMatchObject({
      kind: 'idle-invalid',
      invalidTaskIds: ['orphan'],
    });
  });
});

describe('mission-scheduler P4 adaptive cap + telemetry', () => {
  it('starts at 2 and widens only after clean waves', () => {
    let state = { ...DEFAULT_ADAPTIVE_CAP };
    expect(state.currentCap).toBe(2);
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    expect(state.currentCap).toBe(3);
  });

  it('shrinks immediately on conflict or violation, then can recover', () => {
    let state = decideAdaptiveCap(
      { ...DEFAULT_ADAPTIVE_CAP, currentCap: 3 },
      { kind: 'conflict' },
    );
    expect(state.currentCap).toBe(2);
    expect(state.conflictCount).toBe(1);
    expect(state.consecutiveCleanWaves).toBe(0);
    state = decideAdaptiveCap(state, { kind: 'violation' });
    expect(state.currentCap).toBe(1);
    expect(state.violationCount).toBe(1);
    // Lifetime counters stay elevated but consecutive clean waves can re-widen.
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    state = decideAdaptiveCap(state, { kind: 'wave', waveSize: 2 });
    expect(state.currentCap).toBe(2);
  });

  it('records wave size, sequential fallback, conflict, violation counters', () => {
    let tel = EMPTY_SCHEDULER_TELEMETRY;
    tel = recordScheduleTelemetry(tel, {
      kind: 'dispatch',
      taskIds: ['a', 'b', 'c'],
      waveSize: 3,
      effectiveCap: 4,
      reason: 'wave',
    });
    expect(tel.waves).toBe(1);
    expect(tel.maxWaveSize).toBe(3);
    expect(tel.totalDispatched).toBe(3);
    expect(tel.sequentialFallbacks).toBe(0);

    tel = recordScheduleTelemetry(tel, {
      kind: 'dispatch',
      taskIds: ['d'],
      waveSize: 1,
      effectiveCap: 1,
      reason: 'seq',
    });
    expect(tel.sequentialFallbacks).toBe(1);

    tel = recordConflictTelemetry(tel);
    tel = recordViolationTelemetry(tel);
    expect(tel.conflicts).toBe(1);
    expect(tel.violations).toBe(1);
  });
});
