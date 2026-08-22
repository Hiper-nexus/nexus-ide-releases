import { describe, expect, it } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';
import type { CandidateQualityAnalysis } from '../context/candidate-quality-scanner';
import type { ReviewFindingInput } from '../context/review-council';
import type { AsyncGitRunner, GitResult } from '../runtime/git-command';
import {
  __resetCivilianAutoReviewForTests,
  blockingFindingsOf,
  CIVILIAN_REPAIR_BUDGET_PER_MISSION,
  civilianAutoReviewEvidenceNote,
  describeFindingsForOperator,
  enforceCivilianAutoReview,
  resolveAutoReviewBaseSha,
} from './civilian-auto-review';

const scope = testProjectScope({ rootRealPath: '/workspace/loja' });

const HEAD_SHA = 'b'.repeat(40);
const BASE_SHA = 'a'.repeat(40);
const ROOT_COMMIT = 'c'.repeat(40);

function missionFixture(
  overrides: Partial<Mission> = {},
): Mission {
  return {
    id: 'mission-autoreview',
    title: 'Loja',
    description: 'criar uma loja simples',
    status: 'running',
    squadId: 'nexus-fullstack',
    milestones: [],
    learnings: '',
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  } as Mission;
}

function gitResult(stdout: string): GitResult {
  return { status: 0, stdout, stderr: '' };
}

/** Git falso: HEAD existe; histórico antes da missão é configurável. */
function fakeGit(options: {
  hasHead?: boolean;
  priorCommit?: string | null;
  rootCommit?: string | null;
  failRevParse?: boolean;
}): AsyncGitRunner {
  return {
    run: async (_cwd, args) => {
      if (args[0] === 'rev-parse') {
        if (options.failRevParse || options.hasHead === false) {
          throw new Error('not a git repository');
        }
        return gitResult(`${HEAD_SHA}\n`);
      }
      if (args[0] === 'log') {
        return gitResult(options.priorCommit ? `${options.priorCommit}\n` : '');
      }
      if (args[0] === 'rev-list') {
        return gitResult(
          options.rootCommit ? `${options.rootCommit}\n` : '',
        );
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`);
    },
  };
}

function finding(
  severity: ReviewFindingInput['severity'],
  file = 'src/app.ts',
): ReviewFindingInput {
  return {
    severity,
    category: 'correctness',
    file,
    line: 10,
    criterionRefs: [],
    invariantRefs: [],
    evidence: 'função exportada nunca referenciada',
    recommendation: 'remover ou integrar',
  };
}

function analysis(
  findings: readonly ReviewFindingInput[],
  complete = true,
): CandidateQualityAnalysis {
  return {
    version: 'candidate-quality-v1',
    complete,
    analysisHash: 'f'.repeat(64),
    findings,
    inspectedFiles: findings.length + 3,
    inspectedBytes: 4_096,
    incompleteReasons: [],
    reviewerMarkdown: '',
  };
}

function deps(overrides: {
  git?: AsyncGitRunner;
  analyze?: (input: unknown) => Promise<CandidateQualityAnalysis>;
  deliverRepair?: (sessionId: string, prompt: string) => Promise<boolean>;
  now?: () => number;
} = {}) {
  const analyze =
    overrides.analyze ?? (async () => analysis([]));
  const deliverRepair =
    overrides.deliverRepair ?? (async () => true);
  const calls = { analyzeCalls: 0, repairs: [] as string[] };
  return {
    calls,
    dependencies: {
      git: overrides.git ?? fakeGit({ priorCommit: BASE_SHA }),
      analyze: async (input: unknown) => {
        calls.analyzeCalls += 1;
        return analyze(input);
      },
      deliverRepair: async (sessionId: string, prompt: string) => {
        calls.repairs.push(prompt);
        return deliverRepair(sessionId, prompt);
      },
      ...(overrides.now ? { now: overrides.now } : {}),
    },
  };
}

describe('resolveAutoReviewBaseSha', () => {
  it('usa o último commit anterior ao nascimento da missão', async () => {
    const sha = await resolveAutoReviewBaseSha(
      fakeGit({ priorCommit: BASE_SHA }),
      '/workspace/loja',
      5_000,
    );
    expect(sha).toBe(BASE_SHA);
  });

  it('greenfield sem commit prévio cai no commit raiz', async () => {
    const sha = await resolveAutoReviewBaseSha(
      fakeGit({ priorCommit: null, rootCommit: ROOT_COMMIT }),
      '/workspace/loja',
      5_000,
    );
    expect(sha).toBe(ROOT_COMMIT);
  });

  it('sem nenhum commit retorna null', async () => {
    const sha = await resolveAutoReviewBaseSha(
      fakeGit({ priorCommit: null, rootCommit: null }),
      '/workspace/loja',
      5_000,
    );
    expect(sha).toBeNull();
  });
});

describe('blockingFindingsOf / describeFindingsForOperator', () => {
  it('bloqueia apenas critical/high', () => {
    const blocking = blockingFindingsOf(
      analysis([
        finding('critical'),
        finding('high'),
        finding('medium'),
        finding('low'),
      ]),
    );
    expect(blocking.map((f) => f.severity)).toEqual(['critical', 'high']);
  });

  it('resumo do operador é em PT, nomeia gravidade e arquivo', () => {
    const text = describeFindingsForOperator([
      finding('critical', 'src/pagamento.ts'),
      finding('high', 'src/carrinho.ts'),
    ]);
    expect(text).toContain('problema grave');
    expect(text).toContain('problema importante');
    expect(text).toContain('src/pagamento.ts');
    expect(text).toContain('Retomar');
  });
});

describe('enforceCivilianAutoReview', () => {
  it('sem repositório git → defer-to-roster-review (nunca trava)', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies } = deps({
      git: fakeGit({ failRevParse: true }),
    });
    const outcome = await enforceCivilianAutoReview(
      {
        mission: missionFixture(),
        scope,
        productFiles: ['index.html'],
      },
      dependencies,
    );
    expect(outcome.kind).toBe('defer-to-roster-review');
  });

  it('aprovado → evidência + nota; segundo tick no mesmo HEAD não re-escaneia', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies, calls } = deps();
    const input = {
      mission: missionFixture(),
      scope,
      productFiles: ['server.js'],
    };
    const first = await enforceCivilianAutoReview(input, dependencies);
    expect(first.kind).toBe('approved');
    if (first.kind !== 'approved') return;
    expect(first.evidenceId).toMatch(/^nexus-auto-review:/);
    expect(first.note).toContain('aprovado');
    const second = await enforceCivilianAutoReview(input, dependencies);
    expect(second.kind).toBe('approved');
    expect(calls.analyzeCalls).toBe(1);
  });

  it('reprovado com Maestro vivo → despacha reparo e entra em cooldown', async () => {
    __resetCivilianAutoReviewForTests();
    let clock = 10_000;
    const { dependencies, calls } = deps({
      analyze: async () =>
        analysis([finding('critical', 'src/auth.ts')]),
      now: () => clock,
    });
    const input = {
      mission: missionFixture(),
      scope,
      productFiles: ['src/auth.ts'],
      liveOrchestratorSessionId: 'orch-session-1',
    };
    const outcome = await enforceCivilianAutoReview(input, dependencies);
    expect(outcome.kind).toBe('repair-dispatched');
    expect(calls.repairs).toHaveLength(1);
    expect(calls.repairs[0]).toContain('[NEXUS_QUALITY_REPAIR]');
    expect(calls.repairs[0]).toContain('src/auth.ts');

    // Durante o cooldown, nem escaneia de novo.
    clock += 1_000;
    const duringCooldown = await enforceCivilianAutoReview(
      input,
      dependencies,
    );
    expect(duringCooldown.kind).toBe('repair-dispatched');
    expect(calls.analyzeCalls).toBe(1);
    expect(calls.repairs).toHaveLength(1);

    // Depois do cooldown, re-escaneia e consome o 2º ciclo.
    clock += 120_000;
    const secondCycle = await enforceCivilianAutoReview(input, dependencies);
    expect(secondCycle.kind).toBe('repair-dispatched');
    expect(calls.repairs).toHaveLength(2);
  });

  it(`orçamento esgotado (${CIVILIAN_REPAIR_BUDGET_PER_MISSION} ciclos) → bloqueio visível`, async () => {
    __resetCivilianAutoReviewForTests();
    let clock = 10_000;
    const { dependencies, calls } = deps({
      analyze: async () => analysis([finding('high')]),
      now: () => clock,
    });
    const input = {
      mission: missionFixture(),
      scope,
      productFiles: ['src/app.ts'],
      liveOrchestratorSessionId: 'orch-session-1',
    };
    for (let cycle = 0; cycle < CIVILIAN_REPAIR_BUDGET_PER_MISSION; cycle += 1) {
      clock += 120_000;
      const outcome = await enforceCivilianAutoReview(input, dependencies);
      expect(outcome.kind).toBe('repair-dispatched');
    }
    clock += 120_000;
    const blocked = await enforceCivilianAutoReview(input, dependencies);
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind !== 'blocked') return;
    expect(blocked.description).toContain('IMPORTANTE');
    // Bloqueio NÃO consome mais entrega de reparo.
    expect(calls.repairs).toHaveLength(CIVILIAN_REPAIR_BUDGET_PER_MISSION);
  });

  it('reprovado sem Maestro vivo → bloqueio imediato com resumo simples', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies, calls } = deps({
      analyze: async () => analysis([finding('critical')]),
    });
    const outcome = await enforceCivilianAutoReview(
      {
        mission: missionFixture(),
        scope,
        productFiles: ['src/app.ts'],
      },
      dependencies,
    );
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.description).toContain('GRAVE');
    expect(calls.repairs).toHaveLength(0);
  });

  it('entrega de reparo que falha → bloqueio visível na mesma rodada', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies, calls } = deps({
      analyze: async () => analysis([finding('high')]),
      deliverRepair: async () => false,
    });
    const outcome = await enforceCivilianAutoReview(
      {
        mission: missionFixture(),
        scope,
        productFiles: ['src/app.ts'],
        liveOrchestratorSessionId: 'orch-session-1',
      },
      dependencies,
    );
    expect(outcome.kind).toBe('blocked');
    expect(calls.repairs).toHaveLength(1);
  });
});

describe('civilianAutoReviewEvidenceNote', () => {
  it('nota completa vs parcial são honestas sobre o que rodou', () => {
    const full = civilianAutoReviewEvidenceNote(analysis([]));
    expect(full).toContain('aprovado');
    expect(full).not.toContain('ressalvas');
    const partial = civilianAutoReviewEvidenceNote(analysis([], false));
    expect(partial).toContain('ressalvas');
  });
});
