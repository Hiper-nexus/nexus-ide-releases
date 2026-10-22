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

it('reports structured applicability without treating a configured but unavailable typecheck as not-applicable', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-code-checks-')));
  try {
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    const { dependencies } = deps();
    const result = await enforceCivilianAutoReview({ mission: missionFixture(), scope: { ...scope, rootRealPath: root },
      productFiles: ['app.ts'], completionBaseSha: BASE_SHA,
    }, { ...dependencies, typecheck: async () => ({ kind: 'typecheck', status: 'unavailable', summary: 'Compiler absent', findings: [] }) });
    expect(result.kind).toBe('approved'); // Legacy callers retain their existing outcome contract.
    if (result.kind !== 'approved') return;
    expect(result.verification).toMatchObject({ analysisFailures: [], declaredLimits: [], headSha: HEAD_SHA, baseSha: BASE_SHA,
      checks: expect.arrayContaining([{ kind: 'typecheck', status: 'unavailable', summary: 'Compiler absent' }]),
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    declaredLimits: [],
    failures: [],
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
  freshness: async () => ({ kind: 'dependency-freshness' as const, status: 'passed' as const, summary: 'Atualidade npm: orientação consultiva.', findings: [] }),
  // Portão de regressão fora dos testes de fluxo; coberto abaixo.
  regressionGate: null,
};

function regressionResult(
  partial: Partial<RegressionGateResult>,
): RegressionGateResult {
  return {
    version: 'regression-gate-v2',
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
    preexistingFailures: [],
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
  it('freshness feedback remains advisory even when an injected result labels a finding critical', async () => {
    __resetCivilianAutoReviewForTests();
    const { dependencies } = deps();
    const outcome = await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['src/app.ts'] }, {
      ...dependencies,
      freshness: async () => ({ kind: 'dependency-freshness', status: 'failed', summary: 'Aviso consultivo de versão, sem atualização aplicada.',
        findings: [{ severity: 'critical', file: '(dependência) legacy', evidence: 'newer version', recommendation: 'review later' }] }),
    });
    expect(outcome.kind).toBe('approved');
    if (outcome.kind === 'approved') expect(outcome.note).toContain('Aviso consultivo de versão');
  });
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

describe('strict completion applicability from project declarations', () => {
  it.each(['tsc -p tsconfig.app.json', 'vue-tsc --noEmit -p tsconfig.app.json', 'nx typecheck'])('declared %s is required even without root tsconfig', async script => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-required-check-')));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: script } }));
      writeFileSync(join(root, 'tsconfig.app.json'), '{}');
      const result = await enforceCivilianAutoReview({ mission: missionFixture(), scope: { ...scope, rootRealPath: root }, productFiles: ['app.ts'], completionBaseSha: BASE_SHA }, {
        ...deps().dependencies, typecheck: async () => ({ kind: 'typecheck', status: 'unavailable', summary: 'tool unavailable', findings: [] }),
      });
      expect(result.kind).toBe('approved');
      if (result.kind === 'approved') expect(result.verification?.checks.find(check => check.kind === 'typecheck')?.status).toBe('unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('dependencies without lockfile retain an unavailable required audit', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-required-audit-')));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
      const result = await enforceCivilianAutoReview({ mission: missionFixture(), scope: { ...scope, rootRealPath: root }, productFiles: ['app.js'], completionBaseSha: BASE_SHA }, {
        ...deps().dependencies, audit: async () => ({ kind: 'dependency-audit', status: 'unavailable', summary: 'lockfile missing', findings: [] }),
      });
      if (result.kind !== 'approved') throw new Error('fixture');
      expect(result.verification?.checks.find(check => check.kind === 'dependency-audit')?.status).toBe('unavailable');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('completion requests E2E and does not relabel structured skipped tests as not applicable', async () => {
    const gate = vi.fn(async () => regressionResult({ status: 'no-tests', testsRun: [],
      coverage: { indexComplete: true, skippedTests: ['e2e/app.test.ts'] } }));
    const result = await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'], completionBaseSha: BASE_SHA }, { ...deps().dependencies, regressionGate: gate });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ includeE2E: true }));
    if (result.kind !== 'approved') throw new Error('fixture');
    expect(result.verification?.regressionApplicable).toBe(true);
    expect(result.verification?.regression?.status).toBe('unavailable');
  });

  describe('a project that declares tests (vitest) and a diff with no impacted test', () => {
    const withTestedProject = async (run: (root: string) => Promise<void>) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-no-impacted-tests-')));
      try {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^5.0.0' } }));
        await run(root);
      } finally { rmSync(root, { recursive: true, force: true }); }
    };
    const strict = (root: string, productFiles: readonly string[]) => ({ mission: missionFixture({ id: `mission-no-tests-${productFiles.join('-')}` }),
      scope: { ...scope, rootRealPath: root }, productFiles, completionBaseSha: BASE_SHA, liveOrchestratorSessionId: 'maestro' });

    it.each([
      ['TS source without a test', ['src/theme.ts'], 'no-tests'],
      ['styles only', ['src/theme.css', 'src/layout.scss'], 'no-tests'],
      ['an empty diff', [], 'clean'],
    ] as const)('%s with a complete index proves no applicable test and closes without repair', async (_label, files, status) => {
      await withTestedProject(async root => {
        __resetCivilianAutoReviewForTests();
        const { dependencies, calls } = deps();
        const result = await enforceCivilianAutoReview(strict(root, files.length ? files : ['src/theme.ts']), { ...dependencies,
          regressionGate: async () => regressionResult({ status, testsRun: [], changedFiles: [...files], untestedFiles: files.filter(file => file.endsWith('.ts')),
            runner: null, coverage: { indexComplete: true, skippedTests: [] }, headSha: HEAD_SHA, baseSha: BASE_SHA }),
        });
        expect(calls.repairs).toEqual([]);
        if (result.kind !== 'approved') throw new Error(`expected approval, got ${result.kind}`);
        expect(result.verification?.regression?.status).toBe(status);
        expect(result.verification?.regressionApplicable).toBe(false);
      });
    });

    it.each([
      ['an incomplete index', ['src/theme.ts'], { indexComplete: false, skippedTests: [] }],
      ['a skipped E2E test', ['src/theme.ts'], { indexComplete: true, skippedTests: ['e2e/theme.spec.ts'] }],
      // The import graph only maps TS/JS: a Python change without a mapped
      // test is not proof that no pytest applies to it.
      ['a source the index cannot map', ['src/model.py'], { indexComplete: true, skippedTests: [] }],
      ['a JSON file a test may import', ['src/data.json'], { indexComplete: true, skippedTests: [] }],
    ] as const)('%s keeps the tests unverified', async (_label, files, coverage) => {
      await withTestedProject(async root => {
        __resetCivilianAutoReviewForTests();
        const { dependencies } = deps();
        const result = await enforceCivilianAutoReview({ ...strict(root, files), liveOrchestratorSessionId: null }, { ...dependencies,
          regressionGate: async () => regressionResult({ status: 'no-tests', testsRun: [], changedFiles: [...files], runner: null,
            coverage: { indexComplete: coverage.indexComplete, skippedTests: [...coverage.skippedTests] }, headSha: HEAD_SHA, baseSha: BASE_SHA }),
        });
        if (result.kind !== 'approved') throw new Error(`expected legacy approval, got ${result.kind}`);
        expect(result.verification?.regression?.status).toBe('unavailable');
        expect(result.verification?.regressionApplicable).toBe(true);
      });
    });

    it('native suites that ran in full and found nothing prove Go sources have no test', async () => {
      await withTestedProject(async root => {
        __resetCivilianAutoReviewForTests();
        const { dependencies } = deps();
        const result = await enforceCivilianAutoReview(strict(root, ['cmd/main.go']), { ...dependencies,
          regressionGate: async () => regressionResult({ status: 'no-tests', testsRun: [], changedFiles: ['cmd/main.go'], runner: 'go',
            coverage: { indexComplete: true, skippedTests: [] }, headSha: HEAD_SHA, baseSha: BASE_SHA }),
        });
        if (result.kind !== 'approved') throw new Error(`expected approval, got ${result.kind}`);
        expect(result.verification?.regressionApplicable).toBe(false);
      });
    });
  });

  describe('ceremony profile: a non-executable complete diff drops the typecheck', () => {
    const withTypedProject = async (run: (root: string) => Promise<void>) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-ceremony-')));
      try {
        writeFileSync(join(root, 'tsconfig.json'), '{}');
        writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' }, devDependencies: { typescript: '^6.0.0' } }));
        await run(root);
      } finally { rmSync(root, { recursive: true, force: true }); }
    };
    const styleMission = missionFixture({ id: 'mission-ceremony', intentContract: { goal: 'Ajustar a cor do botão primário na tela de login' } as Mission['intentContract'] });

    it('does not run the compiler and reports it not applicable, naming the profile', async () => {
      await withTypedProject(async root => {
        __resetCivilianAutoReviewForTests();
        const typecheck = vi.fn(healthySensors.typecheck);
        const result = await enforceCivilianAutoReview({ mission: styleMission, scope: { ...scope, rootRealPath: root },
          productFiles: ['src/theme.css'], candidatePaths: ['src/theme.css', 'public/logo.svg'], completionBaseSha: BASE_SHA, liveOrchestratorSessionId: 'maestro' },
        { ...deps().dependencies, typecheck });
        expect(typecheck).not.toHaveBeenCalled();
        if (result.kind !== 'approved') throw new Error(`expected approval, got ${result.kind}`);
        expect(result.verification?.checks.find(check => check.kind === 'typecheck')?.status).toBe('not-applicable');
        expect(result.note).toMatch(/Perfil de cerimônia: trabalho visual.*typecheck dispensado/u);
      });
    });

    it.each([
      ['a deleted module outside the read set', ['src/theme.css', 'src/legacy.tsx']],
      ['no complete diff from the caller', undefined],
    ])('%s keeps the compiler run', async (_label, candidatePaths) => {
      await withTypedProject(async root => {
        __resetCivilianAutoReviewForTests();
        const typecheck = vi.fn(healthySensors.typecheck);
        const result = await enforceCivilianAutoReview({ mission: styleMission, scope: { ...scope, rootRealPath: root },
          productFiles: ['src/theme.css'], ...(candidatePaths ? { candidatePaths } : {}), completionBaseSha: BASE_SHA },
        { ...deps().dependencies, typecheck });
        expect(typecheck).toHaveBeenCalledOnce();
        if (result.kind !== 'approved') throw new Error(`expected approval, got ${result.kind}`);
        expect(result.note).not.toContain('Perfil de cerimônia');
      });
    });

    it('legacy (non-strict) callers never subtract', async () => {
      await withTypedProject(async root => {
        __resetCivilianAutoReviewForTests();
        const typecheck = vi.fn(healthySensors.typecheck);
        await enforceCivilianAutoReview({ mission: styleMission, scope: { ...scope, rootRealPath: root },
          productFiles: ['src/theme.css'], candidatePaths: ['src/theme.css'] }, { ...deps().dependencies, typecheck });
        expect(typecheck).toHaveBeenCalledOnce();
      });
    });
  });

  it('preserves preexisting exemptions but does not claim their failed executions passed', async () => {
    const result = await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'], completionBaseSha: BASE_SHA }, {
      ...deps().dependencies, regressionGate: async () => regressionResult({ preexistingFailures: [{ file: 'src/app.test.ts', message: 'already fails at base' }] }),
    });
    if (result.kind !== 'approved') throw new Error('fixture');
    expect(result.note).toContain('pré-existente'); expect(result.note).not.toContain('1 passaram');
  });
});

it('strict completion executes its tests even when the optional worker fast gate is disabled', async () => {
  const gate = await import('../regression-gate/regression-gate');
  const enabled = vi.spyOn(gate, 'isRegressionGateEnabled').mockReturnValue(false);
  const run = vi.spyOn(gate, 'runRegressionGate').mockResolvedValue(regressionResult({
    coverage: { indexComplete: true, skippedTests: [] }, headSha: HEAD_SHA, baseSha: BASE_SHA,
  }));
  const { regressionGate: _fixtureOverride, ...dependencies } = deps().dependencies;
  try {
    await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'], completionBaseSha: BASE_SHA }, dependencies);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ includeE2E: true }));
    run.mockClear();
    await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'] }, dependencies);
    expect(run).not.toHaveBeenCalled();
    await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'], completionBaseSha: BASE_SHA }, { ...dependencies, regressionGate: null });
    expect(run).not.toHaveBeenCalled();
  } finally { run.mockRestore(); enabled.mockRestore(); }
});

it('strict admission retries never consume repair budget or dispatch code repair', async () => {
  __resetCivilianAutoReviewForTests(); const { dependencies, calls } = deps();
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'], completionBaseSha: BASE_SHA,
      liveOrchestratorSessionId: 'maestro',
    }, { ...dependencies, typecheck: async () => ({ kind: 'typecheck', status: 'unavailable', retryable: true, summary: 'Aguardando recursos', findings: [] }) });
    expect(result).toMatchObject({ kind: 'defer-to-roster-review', retryable: true });
  }
  expect(calls.repairs).toEqual([]);
});

it('strict completion uses Main owned sensors sequentially, while legacy keeps its sensor ports', async () => {
  const module = await import('./completion-check-executors');
  let finishCompiler!: () => void;
  const compiler = new Promise<void>(resolve => { finishCompiler = resolve; });
  const typecheck = vi.fn(async () => { await compiler; return healthySensors.typecheck(); });
  const audit = vi.fn(healthySensors.audit);
  const configured = vi.spyOn(module, 'createCompletionCheckExecutors').mockReturnValue({ typecheck, audit,
    regression: async () => ({ exitCode: 0, timedOut: false, aborted: false, stdout: '', stderr: '' }),
  });
  try {
    const { dependencies } = deps();
    const running = enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'], completionBaseSha: BASE_SHA }, { ...dependencies, typecheck: undefined, audit: undefined });
    await vi.waitFor(() => expect(typecheck).toHaveBeenCalledOnce());
    expect(audit).not.toHaveBeenCalled(); finishCompiler(); await running;
    expect(audit).toHaveBeenCalledOnce(); expect(configured).toHaveBeenCalledWith(expect.objectContaining({ scope, missionId: 'mission-autoreview' }));
    configured.mockClear(); await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'] }, dependencies);
    expect(configured).not.toHaveBeenCalled();
  } finally { finishCompiler(); configured.mockRestore(); }
});

it('strict completion runs applicable checks without a Git repository or an invented baseline', async () => {
  __resetCivilianAutoReviewForTests();
  const regressionGate = vi.fn(async (_input: unknown) => regressionResult({ headSha: null, baseSha: null }));
  const result = await enforceCivilianAutoReview({ mission: missionFixture(), scope, productFiles: ['app.ts'], completionBaseSha: null }, {
    ...deps({ git: fakeGit({ failRevParse: true }) }).dependencies, regressionGate,
  });
  expect(regressionGate).toHaveBeenCalledOnce();
  expect(regressionGate.mock.calls[0]?.[0]).not.toHaveProperty('baseSha');
  if (result.kind !== 'approved') throw new Error('fixture');
  expect(result.verification).toMatchObject({ headSha: null, baseSha: null, regression: { headSha: null, status: 'passed' } });
});
