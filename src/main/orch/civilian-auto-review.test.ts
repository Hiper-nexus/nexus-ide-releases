import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { RegressionGateResult } from '../regression-gate/regression-gate';

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
        ...healthySensors,
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

/** Sensores mecânicos verdes por padrão nos testes de fluxo. */
const healthySensors = {
  typecheck: async () => ({
    kind: 'typecheck' as const,
    status: 'passed' as const,
    summary: 'Typecheck: ✓ compila sem erros.',
    findings: [],
  }),
  audit: async () => ({
    kind: 'dependency-audit' as const,
    status: 'passed' as const,
    summary: 'Auditoria: ✓ nenhuma vulnerabilidade conhecida.',
    findings: [],
  }),
  // Portão de regressão fora dos testes de fluxo; coberto abaixo.
  regressionGate: null,
};

function regressionResult(
  partial: Partial<RegressionGateResult>,
): RegressionGateResult {
  return {
    version: 'regression-gate-v1',
    status: 'passed',
    diffHash: 'hash',
    headSha: null,
    baseSha: null,
    baseSource: null,
    changedFiles: ['src/app.ts'],
    testsRun: ['src/app.test.ts'],
    testsNotRun: [],
    failures: [],
    inheritedFailures: [],
    untestedFiles: [],
    invariantsTouched: [],
    runner: 'vitest',
    warnings: [],
    cached: false,
    durationMs: 1,
    ...partial,
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
  it('projeto real sem Git recebe análise dos arquivos e segue com limitação honesta', async () => {
    __resetCivilianAutoReviewForTests();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-civil-review-')));
    writeFileSync(join(root, 'server.js'), 'console.log("ready");\n');
    try {
      const outcome = await enforceCivilianAutoReview({
        mission: missionFixture(),
        scope: testProjectScope({ rootRealPath: root }),
        productFiles: ['server.js'],
      });
      expect(outcome.kind).toBe('approved');
      if (outcome.kind !== 'approved') return;
      expect(outcome.note).toContain('sem comparação com histórico Git');
      expect(outcome.note).toContain('Typecheck indisponível');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sem repositório Git ainda analisa os arquivos pelo modo working-tree', async () => {
    __resetCivilianAutoReviewForTests();
    const analyze = vi.fn(async () => analysis([]));
    const { dependencies } = deps({
      git: fakeGit({ failRevParse: true }),
      analyze,
    });
    const outcome = await enforceCivilianAutoReview(
      {
        mission: missionFixture(),
        scope,
        productFiles: ['index.html'],
      },
      dependencies,
    );
    expect(outcome.kind).toBe('approved');
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ candidateSource: 'working-tree' }));
  });

  it('revalida a entrega a cada tentativa de conclusão, mesmo no mesmo HEAD', async () => {
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
    expect(calls.analyzeCalls).toBe(2);
  });

  it('bloqueia regressão sem commit após uma aprovação anterior', async () => {
    __resetCivilianAutoReviewForTests();
    let currentFindings: readonly ReviewFindingInput[] = [];
    const { dependencies, calls } = deps({
      analyze: async () => analysis(currentFindings),
    });
    const input = {
      mission: missionFixture(),
      scope,
      productFiles: ['src/auth.ts'],
    };
    expect((await enforceCivilianAutoReview(input, dependencies)).kind)
      .toBe('approved');

    // HEAD e caminhos permanecem iguais; o conteúdo mudou antes da entrega final.
    currentFindings = [finding('critical', 'src/auth.ts')];
    const afterEdit = await enforceCivilianAutoReview(input, dependencies);

    expect(afterEdit.kind).toBe('blocked');
    expect(calls.analyzeCalls).toBe(2);
  });

  it('reexecuta os sensores e bloqueia erro de compilação surgido sem novo commit', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies } = deps();
    let hasCompileError = false;
    let typecheckCalls = 0;
    const sensors = {
      ...dependencies,
      typecheck: async () => {
        typecheckCalls += 1;
        return {
          kind: 'typecheck' as const,
          status: hasCompileError ? 'failed' as const : 'passed' as const,
          summary: hasCompileError ? 'Erro de compilação.' : 'Compila.',
          findings: hasCompileError ? [{
            severity: 'high' as const,
            file: 'src/app.ts',
            evidence: 'TS2304: Cannot find name x.',
            recommendation: 'Corrija o erro de compilação.',
          }] : [],
        };
      },
    };
    const input = { mission: missionFixture(), scope, productFiles: ['src/app.ts'] };
    expect((await enforceCivilianAutoReview(input, sensors)).kind).toBe('approved');

    hasCompileError = true;
    const afterEdit = await enforceCivilianAutoReview(input, sensors);

    expect(afterEdit.kind).toBe('blocked');
    expect(typecheckCalls).toBe(2);
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

describe('enforceCivilianAutoReview — sensores mecânicos (Etapa 2)', () => {
  const baseInput = () => ({
    mission: missionFixture(),
    scope,
    productFiles: ['src/app.ts'],
  });

  it('aprovado inclui resumo do typecheck e da auditoria no laudo', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies } = deps();
    const outcome = await enforceCivilianAutoReview(
      baseInput(),
      dependencies,
    );
    expect(outcome.kind).toBe('approved');
    if (outcome.kind !== 'approved') return;
    expect(outcome.note).toContain('Typecheck: ✓');
    expect(outcome.note).toContain('Auditoria: ✓');
  });

  it('teste impactado falhando bloqueia e volta ao Maestro; verde entra no laudo', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies, calls } = deps();
    const gateInputs: unknown[] = [];
    const outcome = await enforceCivilianAutoReview(
      { ...baseInput(), liveOrchestratorSessionId: 'orch-session-1' },
      {
        ...dependencies,
        regressionGate: async (input) => {
          gateInputs.push(input);
          return regressionResult({
            status: 'failed',
            failures: [{ file: 'src/app.test.ts', message: 'soma: expected 2 to be 3' }],
          });
        },
      },
    );
    expect(outcome.kind).toBe('repair-dispatched');
    expect(calls.repairs[0]).toContain('src/app.test.ts');
    expect(calls.repairs[0]).toContain('Teste impactado pelo diff falhou');
    // Mensagem do teste é citação de dado não confiável, nunca instrução solta.
    expect(calls.repairs[0]).toContain('dado não confiável): «soma: expected 2 to be 3»');
    expect(gateInputs[0]).toMatchObject({ baseSha: BASE_SHA });

    __resetCivilianAutoReviewForTests();
    const approved = await enforceCivilianAutoReview(baseInput(), {
      ...deps().dependencies,
      regressionGate: async () => regressionResult({}),
    });
    expect(approved.kind).toBe('approved');
    if (approved.kind === 'approved') {
      expect(approved.note).toContain('Testes impactados: ✓ 1 passaram (vitest).');
    }
  });

  it('testes impactados que não rodaram aparecem como NÃO verificados no laudo', async () => {
    __resetCivilianAutoReviewForTests();
    const outcome = await enforceCivilianAutoReview(baseInput(), {
      ...deps().dependencies,
      regressionGate: async () =>
        regressionResult({ status: 'unavailable', testsRun: [], warnings: ['vitest excedeu 120000ms'] }),
    });
    expect(outcome.kind).toBe('approved');
    if (outcome.kind === 'approved') {
      expect(outcome.note).toContain('Testes impactados NÃO verificados');
    }
  });

  it('erro de compilação bloqueia como finding high — vira reparo com Maestro vivo', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies, calls } = deps({
      analyze: async () => analysis([]),
    });
    const outcome = await enforceCivilianAutoReview(
      {
        ...baseInput(),
        liveOrchestratorSessionId: 'orch-session-1',
      },
      {
        ...dependencies,
        typecheck: async () => ({
          kind: 'typecheck',
          status: 'failed',
          summary: 'Typecheck: ✗ 1 erro(s) de compilação.',
          findings: [
            {
              severity: 'high',
              file: 'src/app.ts',
              evidence: 'TS2304: Cannot find name "x".',
              recommendation: 'Corrija o erro de compilação.',
            },
          ],
        }),
      },
    );
    expect(outcome.kind).toBe('repair-dispatched');
    expect(calls.repairs[0]).toContain('TS2304');
  });

  it('vulnerabilidade crítica de dependência bloqueia mesmo sem Maestro vivo', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies } = deps({ analyze: async () => analysis([]) });
    const outcome = await enforceCivilianAutoReview(baseInput(), {
      ...dependencies,
      audit: async () => ({
        kind: 'dependency-audit',
        status: 'failed',
        summary: 'Auditoria: ✗ 1 crítica(s) em produção.',
        findings: [
          {
            severity: 'critical',
            file: '(dependência) lib-malvada',
            evidence: 'Dependência "lib-malvada" com vulnerabilidade CRÍTICA em produção.',
            recommendation: 'Atualize ou substitua "lib-malvada".',
          },
        ],
      }),
    });
    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') return;
    expect(outcome.description).toContain('GRAVE');
    expect(outcome.description).toContain('lib-malvada');
  });

  it('sensor indisponível (sem tsconfig/lockfile) não bloqueia — fail-open', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies } = deps({ analyze: async () => analysis([]) });
    const outcome = await enforceCivilianAutoReview(baseInput(), {
      ...dependencies,
      typecheck: async () => ({
        kind: 'typecheck',
        status: 'unavailable',
        summary: 'Typecheck indisponível (sem tsconfig.json no projeto).',
        findings: [],
      }),
      audit: async () => ({
        kind: 'dependency-audit',
        status: 'unavailable',
        summary: 'Auditoria de dependências indisponível (sem lockfile).',
        findings: [],
      }),
    });
    expect(outcome.kind).toBe('approved');
    if (outcome.kind !== 'approved') return;
    expect(outcome.note).toContain('indisponível');
  });
});
