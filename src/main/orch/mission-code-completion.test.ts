import { describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { compileIntentContract } from '../../shared/mission-intent';
import type { WorkingTreeCandidateSnapshot } from '../context/candidate-working-tree-snapshot';
import type { RegressionGateResult } from '../regression-gate/regression-gate';
import { testProjectScope } from './__tests__/scope-fixture';
import { getAutomaticCompletionProof, withAutomaticCompletionProof } from './automatic-completion-proof';
import type { AutomaticCompletionProof } from './automatic-completion-proof';
import { evaluateIndependentReviewGate } from './mission-independent-review-gate';
import { ensureMissionCodeCompletion, type MissionCodeCompletionPorts, type MissionCodeReviewResult } from './mission-code-completion';

vi.mock('./mission-leadership-runtime', () => ({ getMissionLeadership: () => ({ resolveMissionLeader: () => null }) }));

const scope = testProjectScope();
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const current = (squadId?: string): Mission => ({ id: 'mission', title: 'Implementar', description: '',
  status: 'running', intentState: 'dispatched', intentVersion: 1, updatedAt: 2, createdAt: 1,
  orchestratorSessionId: 'maestro', milestones: [], learnings: '', squadId,
  intentContract: compileIntentContract({ goal: 'Implementar a entrega', lane: 'standard', freeAgentChoice: true, intentVersion: 1 }),
});
const candidate = (paths = ['src/app.ts']): WorkingTreeCandidateSnapshot => ({
  source: 'git', headSha, fingerprint: 'candidate-1', changedPaths: paths,
  deletedPaths: [], untrackedPaths: [], diff: '', complete: true, incompleteReasons: [],
});
const regression = (): RegressionGateResult => ({ status: 'passed', headSha, baseSha,
  testsRun: ['src/app.test.ts'], testsNotRun: [], failures: [],
} as unknown as RegressionGateResult);
const mechanical = () => ({ kind: 'approved' as const, evidenceId: 'mechanical:1', note: 'Main checks',
  verification: { analysisComplete: true, headSha, baseSha,
    checks: [{ kind: 'typecheck' as const, status: 'passed' as const, summary: 'Typecheck executado' }],
    regression: regression(), regressionApplicable: true,
  },
});
const review = (): MissionCodeReviewResult => ({ kind: 'reviewed', candidateFingerprint: 'candidate-1', baseSha,
  readOnly: true, verdict: { verdictId: 'review:1', missionId: 'mission', headSha, treeDirty: false,
    verdict: 'approve', reviewerAdapter: 'codex', reviewerModel: 'gpt-6.1-sol', reviewerSession: 'independent-judge',
    frontier: true, findings: [], summary: 'Revisão independente', createdAt: 3 },
});
function fixture(mission = current()) {
  const ports: MissionCodeCompletionPorts = {
    captureCandidate: vi.fn(async () => candidate()),
    runMechanical: vi.fn(async () => mechanical()),
    ensureIndependentReview: vi.fn(async () => review()),
    assertCurrent: vi.fn(),
  };
  const input = { scope, executionScope: scope, mission, baselineSha: baseSha, authorSessionIds: ['writer'] };
  const finalGate = (proof?: AutomaticCompletionProof) => {
    const check = () => evaluateIndependentReviewGate({ scope, mission, squad: null,
      handoffs: [], deliveryAttemptsOf: () => [], codeCompletionRequired: true,
      automaticProof: getAutomaticCompletionProof(scope, mission),
    }).ok;
    return proof ? withAutomaticCompletionProof(scope, mission, proof, check) : check();
  };
  return { input, ports, finalGate };
}

describe('Main code completion across pane and ordinary missions', () => {
  it.each([undefined, 'squad'])('requires independent review and all applicable checks (squad=%s)', async (squadId) => {
    const f = fixture(current(squadId));
    expect(f.finalGate()).toBe(false);
    const order: string[] = [];
    f.ports.runMechanical = async () => { order.push('mechanical'); return mechanical(); };
    f.ports.ensureIndependentReview = async () => { order.push('review'); return review(); };
    const result = await ensureMissionCodeCompletion(f.input, f.ports);
    expect(result.kind).toBe('verified');
    if (result.kind !== 'verified') return;
    expect(order).toEqual(['mechanical', 'review']);
    expect(f.finalGate(result.proof)).toBe(true);
    expect(f.finalGate({ status: 'verified', candidateFingerprint: 'candidate-1' })).toBe(false);
    expect(f.finalGate({ ...result.proof, codeCompletion: { ...result.proof.codeCompletion! } })).toBe(false);
  });

  it('does not spend a frontier review while applicable mechanics are unavailable or repairing', async () => {
    for (const status of ['failed', 'unavailable'] as const) for (const kind of ['typecheck', 'dependency-audit'] as const) {
      const f = fixture();
      f.ports.runMechanical = async () => ({ ...mechanical(), verification: { ...mechanical().verification,
        checks: [{ kind, status, summary: 'Verificação obrigatória indisponível ou falhou' }] } });
      expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).not.toBe('verified');
      expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.ports.runMechanical = async () => ({ kind: 'repair-dispatched' });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('waiting');
    expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
  });

  it.each(['failed', 'unavailable'] as const)('preserves %s dependency freshness advice without blocking independent review', async status => {
    const f = fixture();
    const advice = { kind: 'dependency-freshness' as const, status, summary: `Atualidade npm consultiva: ${status}.` };
    const receipt = { ...mechanical(), note: `${mechanical().note}\n${advice.summary}`,
      verification: { ...mechanical().verification, checks: [...mechanical().verification.checks, advice] } };
    f.ports.runMechanical = async () => receipt;
    const result = await ensureMissionCodeCompletion(f.input, f.ports);
    expect(result.kind).toBe('verified');
    expect(f.ports.ensureIndependentReview).toHaveBeenCalledOnce();
    expect(receipt.verification.checks.at(-1)).toEqual(advice);
    if (result.kind !== 'verified') return;
    expect(result.proof.note).toContain(advice.summary);
    expect(f.finalGate(result.proof)).toBe(true);
  });

  it.each(['writer', 'maestro'])('cannot accept the implementation or orchestrator session as judge: %s', async (sessionId) => {
    const f = fixture();
    const verdict = review();
    if (verdict.kind !== 'reviewed') throw new Error('fixture');
    f.ports.ensureIndependentReview = async () => ({ ...verdict, verdict: { ...verdict.verdict, reviewerSession: sessionId } });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('blocked');
  });

  it('rejects stale/cheap reviews and accepts a retry after a fresh frontier approval', async () => {
    const f = fixture();
    const verdict = review();
    if (verdict.kind !== 'reviewed') throw new Error('fixture');
    for (const patch of [{ frontier: false }, { headSha: 'c'.repeat(40) }, { verdict: 'reject' as const }]) {
      f.ports.ensureIndependentReview = async () => ({ ...verdict, verdict: { ...verdict.verdict, ...patch } });
      expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).not.toBe('verified');
    }
    f.ports.ensureIndependentReview = async () => review();
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('verified');
  });

  it('invalidates a candidate changed while checks or review were running', async () => {
    const f = fixture();
    vi.mocked(f.ports.captureCandidate).mockResolvedValueOnce(candidate()).mockResolvedValue({ ...candidate(), fingerprint: 'changed' });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('waiting');
    expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
    expect(f.finalGate()).toBe(false);
  });

  it('rejects a mutation during the independent review even after the mechanical snapshot was stable', async () => {
    const f = fixture();
    vi.mocked(f.ports.captureCandidate).mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate())
      .mockResolvedValue({ ...candidate(), fingerprint: 'changed-during-review' });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('waiting');
    expect(f.ports.ensureIndependentReview).toHaveBeenCalledOnce();
    expect(f.finalGate()).toBe(false);
  });

  it('allows complete static analysis plus independent review when no execution check applies, with an explicit limitation', async () => {
    const f = fixture();
    f.ports.captureCandidate = async () => candidate(['index.html', 'style.css']);
    f.ports.runMechanical = async () => ({ ...mechanical(), verification: { ...mechanical().verification,
      checks: [{ kind: 'typecheck', status: 'not-applicable', summary: 'Sem configuração TypeScript' }],
      regression: { ...regression(), status: 'no-tests', testsRun: [], coverage: { indexComplete: true, skippedTests: [] } }, regressionApplicable: false,
    } });
    const result = await ensureMissionCodeCompletion(f.input, f.ports);
    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') expect(result.proof.note).toMatch(/nenhum teste|não houve execução/i);
  });

  it('cannot label unexecuted applicable tests or an incomplete static scan as verified', async () => {
    for (const verification of [
      { ...mechanical().verification, regression: { ...regression(), testsNotRun: ['src/app.test.ts'] } },
      { ...mechanical().verification, regression: { ...regression(), status: 'unavailable' as const } },
      { ...mechanical().verification, analysisComplete: false },
    ]) {
      const f = fixture(); f.ports.runMechanical = async () => ({ ...mechanical(), verification });
      expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('blocked');
    }
  });

  it.each(['no-tests', 'clean'] as const)('cannot approve %s when Main identified an applicable test requirement', async status => {
    const f = fixture();
    f.ports.runMechanical = async () => ({ ...mechanical(), verification: { ...mechanical().verification,
      regressionApplicable: true, regression: { ...regression(), status, testsRun: [], coverage: { indexComplete: true, skippedTests: [] } } } });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('blocked');
    expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
  });

  it.each([{ indexComplete: false, skippedTests: [] }, { indexComplete: true, skippedTests: ['e2e/login.test.ts'] }])('cannot approve incomplete declared test coverage: %j', async coverage => {
    const f = fixture();
    f.ports.runMechanical = async () => ({ ...mechanical(), verification: { ...mechanical().verification,
      regression: { ...regression(), coverage } } });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('blocked');
    expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
  });

  it('preserves F-246 when real executed tests pass the diff gate and failures were proved preexisting', async () => {
    const f = fixture();
    f.ports.runMechanical = async () => ({ ...mechanical(), verification: { ...mechanical().verification,
      regression: { ...regression(), coverage: { indexComplete: true, skippedTests: [] },
        preexistingFailures: [{ file: 'src/legacy.test.ts', message: 'Reproduced at baseline' }] } } });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('verified');
  });

  it('preserves proven docs-only and existing text/ops authority without invoking a reviewer', async () => {
    for (const kind of ['docs', 'text', 'ops']) {
      const f = fixture();
      f.ports.captureCandidate = async () => candidate(['docs/guide.md']);
      if (kind === 'ops') f.input.mission.intentContract = compileIntentContract({ goal: 'Sincronizar o repositório', lane: 'ops', freeAgentChoice: true, intentVersion: 1 });
      const result = await ensureMissionCodeCompletion({ ...f.input, ...(kind === 'text' ? { textOnly: true } : {}) }, f.ports);
      expect(result.kind).toBe('exempt');
      if (result.kind === 'exempt') expect(f.finalGate(result.proof)).toBe(true);
      expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
    }
  });

  it.each(['CMakeLists.txt', 'requirements.txt', 'docs/requirements.txt', 'vite.config.ts', '.github/workflows/check.yml', 'LICENSE.py'])('never exempts build/dependency configuration: %s', async (file) => {
    const f = fixture(); f.ports.captureCandidate = async () => candidate([file]);
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('verified');
    expect(f.ports.ensureIndependentReview).toHaveBeenCalledOnce();
  });

  it('requires review for deleted code while known documentation remains exempt', async () => {
    const removed = fixture();
    removed.ports.captureCandidate = async () => ({ ...candidate([]), deletedPaths: ['src/old.ts'] });
    expect((await ensureMissionCodeCompletion(removed.input, removed.ports)).kind).toBe('verified');
    for (const paths of [['README.md', 'CHANGELOG.md', 'LICENSE', 'docs/guide.txt']]) {
      const f = fixture(); f.ports.captureCandidate = async () => candidate(paths);
      expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('exempt');
      expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
    }
  });

  it('does not certify a missing Git identity or invalid baseline as an empty/code-free delta', async () => {
    const f = fixture(); f.ports.captureCandidate = async () => ({ ...candidate([]), source: 'filesystem', headSha: null });
    expect((await ensureMissionCodeCompletion(f.input, f.ports)).kind).toBe('blocked');
    expect((await ensureMissionCodeCompletion({ ...f.input, baselineSha: '' }, f.ports)).kind).toBe('blocked');
    expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
  });

  it('uses explicit whole-current-state review for an unknown baseline instead of inferring authorship', async () => {
    const f = fixture();
    const verdict = review();
    if (verdict.kind !== 'reviewed') throw new Error('fixture');
    f.ports.ensureIndependentReview = async () => ({ ...verdict, baseSha: null });
    f.ports.runMechanical = async () => ({ ...mechanical(), verification: { ...mechanical().verification, baseSha: null,
      regression: { ...regression(), baseSha: null } } });
    const result = await ensureMissionCodeCompletion({ ...f.input, baselineSha: null }, f.ports);
    expect(f.ports.captureCandidate).toHaveBeenCalledWith(expect.objectContaining({ mode: 'current-state' }));
    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') expect(result.proof.note).toMatch(/autoria.*não|base.*desconhecida/i);
  });

  it('can verify a Git-less current state through a Main-bound fingerprint review without inventing a Git SHA', async () => {
    const f = fixture();
    f.ports.captureCandidate = async () => ({ ...candidate(['index.html']), source: 'filesystem', headSha: null });
    const ticket = review(); if (ticket.kind !== 'reviewed') throw new Error('fixture');
    f.ports.ensureIndependentReview = async () => ({ ...ticket, baseSha: null, verdict: { ...ticket.verdict, headSha: null } });
    f.ports.runMechanical = async () => ({ ...mechanical(), verification: { analysisComplete: true, headSha: null, baseSha: null,
      checks: [{ kind: 'typecheck', status: 'not-applicable', summary: 'Sem TypeScript' }], regression: null, regressionApplicable: false } });
    const result = await ensureMissionCodeCompletion({ ...f.input, baselineSha: null }, f.ports);
    expect(result.kind).toBe('verified');
    if (result.kind === 'verified') expect(result.proof.codeCompletion?.headSha).toBeNull();
  });
});

it('admission timeout waits without blaming code or spending frontier review', async () => {
  const f = fixture(); f.ports.runMechanical = async () => ({ kind: 'defer-to-roster-review', retryable: true, reason: 'Aguardando recursos' });
  expect(await ensureMissionCodeCompletion(f.input, f.ports)).toMatchObject({ kind: 'waiting', code: 'code_checks_pending' });
  expect(f.ports.ensureIndependentReview).not.toHaveBeenCalled();
});

describe('F-1428: release-sized candidates', () => {
  it('certifies with a declared read limit and names what was left out instead of refusing', async () => {
    const f = fixture();
    const sampled = { ...candidate(['src/app.ts', 'src/big.ts']), coveredPaths: ['src/app.ts'],
      unreadPaths: ['src/big.ts'], absentPaths: ['src/old-name.ts'] } as WorkingTreeCandidateSnapshot;
    f.ports.captureCandidate = vi.fn(async () => sampled);
    const result = await ensureMissionCodeCompletion(f.input, f.ports);
    expect(result.kind).toBe('verified');
    const note = 'proof' in result ? result.proof.note ?? '' : '';
    expect(note).toContain('src/big.ts');
    expect(note).toContain('src/old-name.ts');
  });
});
