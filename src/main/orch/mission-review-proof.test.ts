import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { compileMissionContract } from '../context/contract-compiler';
import { ContextWorkflowService } from '../context/context-workflow-service';
import { createContextWorkflowStore } from '../context/context-workflow-store';
import { createWorkflowState } from '../context/prevc-engine';
import {
  CANDIDATE_REVIEW_EVALUATOR_VERSION, PRE_EXECUTION_REVIEW_EVALUATOR_VERSION,
  ReviewCouncil, type ReviewBinding, type ReviewFindingInput, type ReviewPurpose,
} from '../context/review-council';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { createScopedMissionStore } from './mission-store';
import { testProjectScope } from './__tests__/scope-fixture';
import { evaluateIndependentReviewGate } from './mission-independent-review-gate';
import {
  isFrozenMissionReviewProof, readFrozenMissionReviewContext, resolveFrozenMissionReviewProof,
} from './mission-review-proof';

const fixtures: Array<{ root: string; manager: ProjectRuntimeManager }> = [];
const author = { id: 'builder', sessionId: 'builder-session', provider: 'codex' };
const blocker: ReviewFindingInput = {
  severity: 'high', category: 'correctness', file: 'src/login.ts', line: 1,
  criterionRefs: ['works'], invariantRefs: [], evidence: 'Login rejects valid credentials.',
  recommendation: 'Correct the credential comparison and verify login.',
};

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-review-proof-')));
  const scope = testProjectScope({ rootRealPath: root });
  const manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'state'), appVersion: 'test' });
  fixtures.push({ root, manager });
  const created = createScopedMissionStore(manager, scope, { idFactory: () => 'mission-a' }).create({ title: 'Small change' });
  const contract = compileMissionContract({
    schemaVersion: 1, scope, missionId: created.id, goal: 'Small change',
    baseCommit: 'a'.repeat(40), contextRevision: 'c'.repeat(64),
    acceptanceCriteria: [{ id: 'works', statement: 'Login works' }],
  }, { invariantRefs: new Set(), availableSensorIds: new Set(), blockingConflictIds: [] });
  const binding: ReviewBinding = {
    projectId: scope.projectId, checkoutId: scope.checkoutId, missionId: created.id,
    contractHash: contract.contractHash, contextHash: contract.contextRevision,
    baseSha: contract.baseCommit, headSha: contract.baseCommit, diffHash: 'd'.repeat(64),
  };
  const store = createContextWorkflowStore(manager, scope);
  store.freeze(contract, createWorkflowState(contract.risk, binding), author);
  const service = new ContextWorkflowService(manager, scope, { appVersion: 'test' });
  const mission: Mission = { ...created, squadId: 'squad-a', intentVersion: 1,
    intentContract: { lane: 'standard', goal: contract.goal } as Mission['intentContract'] };
  return { scope, store, service, mission, contract, binding };
}

function recordReview(
  f: ReturnType<typeof fixture>,
  binding = f.binding,
  findings: readonly ReviewFindingInput[] = [],
  reviewId = 'review-a',
  purpose: ReviewPurpose = 'candidate',
) {
  const report = new ReviewCouncil(f.contract.risk, binding).submit({
    reviewId, binding, reviewerId: `reviewer-${reviewId}`, reviewerSessionId: `session-${reviewId}`,
    reviewerProvider: 'claude', authorId: author.id, authorSessionId: author.sessionId,
    authorProvider: author.provider, findings, reviewPurpose: purpose,
    evaluatorVersion: purpose === 'candidate' ? CANDIDATE_REVIEW_EVALUATOR_VERSION : PRE_EXECUTION_REVIEW_EVALUATOR_VERSION,
  });
  f.store.recordMergeReviewReport(report);
  return report;
}

function proofFor(f: ReturnType<typeof fixture>, git = f.binding) {
  return resolveFrozenMissionReviewProof(f.scope, f.mission, {
    getService: () => f.service, inspectGit: () => git,
  });
}

function gateFor(f: ReturnType<typeof fixture>, proof = proofFor(f)) {
  return evaluateIndependentReviewGate({
    scope: f.scope, mission: f.mission, squad: { id: 'squad-a', agents: [] },
    handoffs: [{ id: 'old-handoff', fromAgent: 'Reviewer', status: 'failed', summary: '[REPROVADA] Revisão antiga' }],
    deliveryAttemptsOf: () => [], frozenReviewProof: proof,
  });
}

afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.manager.closeAll();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

describe('frozen candidate review proof', () => {
  it('uses the durable candidate report without requiring a manual handoff or evidence ID', () => {
    const f = fixture();
    recordReview(f);
    expect(gateFor(f)).toEqual({ ok: true, reviewerHandoffId: 'review:review-a' });
  });

  it('keeps an unchanged rejected candidate blocked despite a later positive report', () => {
    const f = fixture();
    recordReview(f, f.binding, [blocker], 'negative');
    recordReview(f, f.binding, [], 'positive');
    expect(gateFor(f)).toMatchObject({ ok: false, code: 'review_rejected' });
  });

  it('rejects, accepts a corrected candidate, and preserves the old negative report', () => {
    const f = fixture();
    recordReview(f, f.binding, [blocker], 'negative');
    expect(gateFor(f)).toMatchObject({ ok: false, code: 'review_rejected' });
    const corrected = { ...f.binding, headSha: 'b'.repeat(40), diffHash: 'e'.repeat(64) };
    f.store.refreeze(f.contract, createWorkflowState(f.contract.risk, corrected), author);
    recordReview(f, corrected, [], 'corrected');

    expect(gateFor(f, proofFor(f, corrected))).toEqual({ ok: true, reviewerHandoffId: 'review:corrected' });
    expect(f.store.listReviewReports(f.mission.id)).toHaveLength(2);
  });

  it('does not count a planning report as a candidate review', () => {
    const f = fixture();
    recordReview(f, f.binding, [], 'plan', 'pre-execution');
    expect(gateFor(f)).toMatchObject({ ok: false, code: 'review_without_evidence' });
  });

  it('rejects a stale candidate, changed intent, and serialized proof', () => {
    const f = fixture();
    recordReview(f);
    expect(gateFor(f, proofFor(f, { ...f.binding, headSha: 'b'.repeat(40) })))
      .toMatchObject({ ok: false, code: 'review_without_evidence' });
    const proof = proofFor(f)!;
    expect(isFrozenMissionReviewProof(proof, f.scope, { ...f.mission, intentVersion: 2 })).toBe(false);
    expect(isFrozenMissionReviewProof(JSON.parse(JSON.stringify(proof)), f.scope, f.mission)).toBe(false);
  });

  it('rejects a self-review even if a malformed report reached the durable store', () => {
    const f = fixture();
    const report = recordReview(f);
    f.store.recordMergeReviewReport({ ...report, reviewId: 'self',
      reviewerId: author.id, reviewerSessionId: author.sessionId });
    expect(() => proofFor(f)).toThrow('author cannot review');
  });

  it('returns absence for non-frozen missions and propagates errors and scope mismatch', () => {
    const f = fixture();
    expect(readFrozenMissionReviewContext(f.scope, 'other', () => f.service)).toBeNull();
    expect(readFrozenMissionReviewContext(f.scope, f.mission.id, () => { throw new Error('context workflow service is not initialized'); })).toBeNull();
    expect(() => readFrozenMissionReviewContext(f.scope, f.mission.id, () => { throw new Error('database corruption'); })).toThrow('database corruption');
    expect(() => readFrozenMissionReviewContext({ ...f.scope, checkoutId: 'other' }, f.mission.id, () => f.service)).toThrow('another project scope');
  });
});
