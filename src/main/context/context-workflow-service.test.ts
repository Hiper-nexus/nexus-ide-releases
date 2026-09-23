import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { createScopedMissionStore } from '../orch/mission-store';
import { createScopedHandoffStore } from '../orch/handoff-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ensureContextScaffold } from './context-doctor';
import {
  createContextAttestation,
  writeContextAttestation,
} from './context-attestation';
import {
  ContextWorkflowService,
  milestoneValidationEvidenceId,
} from './context-workflow-service';
import { processSandboxRuntimeAvailable } from '../runtime/process-sandbox-capability';
import { inspectGitBinding } from './git-binding';
import type { EvidenceBinding } from './prevc-engine';
import {
  ReviewCouncil,
  type ReviewBinding,
  type ReviewFindingInput,
  type ReviewReport,
} from './review-council';

let baseDir = '';
const roots: string[] = [];
const managers: ProjectRuntimeManager[] = [];

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function hashFile(root: string, relative: string): string {
  return createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex');
}

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workflow-service-')));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Nexus Test');
  git(root, 'config', 'user.email', 'nexus@example.test');
  const scope = testProjectScope({ rootRealPath: root });
  ensureContextScaffold(scope);
  fs.writeFileSync(
    path.join(root, '.context/config/sensors.json'),
    JSON.stringify({
      schemaVersion: 1,
      sensors: [
        { id: 'typecheck', command: ['/usr/bin/true'], timeoutMs: 60_000, network: false },
        { id: 'unit', command: ['/usr/bin/true'], timeoutMs: 60_000, network: false },
      ],
    }),
  );
  for (const name of [
    'project-overview', 'business-model', 'domain-glossary', 'architecture', 'testing',
  ]) {
    fs.writeFileSync(path.join(root, `.context/docs/${name}.md`), `# ${name}\nFonte versionada.\n`);
  }
  fs.writeFileSync(
    path.join(root, '.context/nexus/invariants/core.json'),
    JSON.stringify({
      schemaVersion: 1,
      facts: [{
        id: 'scope-required',
        statement: 'Every mutation has project scope.',
        claimKey: 'project.scope.required',
        value: true,
        kind: 'asserted',
        domains: ['core'],
        relatedSymbols: [],
      }],
    }),
  );
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: {
      typecheck: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)" --',
    },
  }));
  for (const targetPath of [
    '.context/docs/project-overview.md',
    '.context/docs/business-model.md',
    '.context/docs/domain-glossary.md',
    '.context/docs/architecture.md',
    '.context/docs/testing.md',
    '.context/nexus/invariants/core.json',
  ]) {
    writeContextAttestation(scope, createContextAttestation(scope, {
      targetPath,
      targetHash: hashFile(root, targetPath),
      sources: [{
        type: 'file',
        locator: 'package.json',
        sourceHash: hashFile(root, 'package.json'),
      }],
      author: { id: 'context-author', sessionId: `author:${targetPath}`, provider: 'codex' },
      reviewer: { id: 'context-reviewer', sessionId: `reviewer:${targetPath}`, provider: 'claude' },
      reviewedAt: '2026-07-10T12:00:00.000Z',
      nexusVersion: 'test',
    }));
  }
  git(root, 'add', '.context', 'package.json');
  git(root, 'commit', '-qm', 'context');

  const manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  managers.push(manager);
  createScopedMissionStore(manager, scope, { idFactory: () => 'mission-a' })
    .create({
      title: 'Implement safely',
      milestones: [
        {
          id: 'step-a',
          label: 'Verified delivery',
          status: 'in-progress',
          evidenceIds: [],
        },
      ],
    });
  let id = 0;
  const integration = (
    integrationScope: typeof scope,
    _missionId: string,
    frozenBaseSha: string,
  ) => {
    const binding = inspectGitBinding(integrationScope, frozenBaseSha);
    return {
      worktreeId: 'worktree-a',
      ...binding,
    };
  };
  const service = new ContextWorkflowService(manager, scope, {
    appVersion: 'test',
    makeId: () => `id-${++id}`,
    now: () => id + 1,
    resolveIntegratedMission: integration,
  });
  return { root, scope, manager, service };
}

function recordTrustedSensor(
  manager: ProjectRuntimeManager,
  scope: ReturnType<typeof testProjectScope>,
  binding: EvidenceBinding,
  id: string,
  sensorId: string,
): void {
  const nowIso = '2026-07-12T00:00:00.000Z';
  const evidence = {
    id,
    producer: 'nexus' as const,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    missionId: binding.missionId,
    sensorId,
    baseSha: binding.baseSha,
    headSha: binding.headSha,
    diffHash: binding.diffHash,
    contextHash: binding.contextHash,
    contractHash: binding.contractHash,
    sensorConfigHash: 'a'.repeat(64),
    command: ['/usr/bin/true'],
    exitCode: 0,
    stdoutHash: 'b'.repeat(64),
    stderrHash: 'c'.repeat(64),
    timedOut: false,
    truncated: false,
    startedAt: nowIso,
    finishedAt: nowIso,
  };
  manager.open(scope).db.prepare(
    `INSERT INTO sensor_evidence
       (id, mission_id, sensor_id, head_sha, diff_hash, passed,
        evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    binding.missionId,
    sensorId,
    binding.headSha,
    binding.diffHash,
    JSON.stringify(evidence),
    Date.parse(nowIso),
  );
}

function recordMilestoneAttestationForTest(
  manager: ProjectRuntimeManager,
  scope: ReturnType<typeof testProjectScope>,
  binding: EvidenceBinding,
  stepId: string,
  sourceEvidenceIds: readonly string[] = [`source:${stepId}`],
): string {
  const id = milestoneValidationEvidenceId(binding.missionId, stepId, binding);
  const digest = id.slice('milestone:'.length);
  const sources = [...new Set(sourceEvidenceIds)].sort();
  const nowIso = '2026-07-12T00:00:00.000Z';
  const evidence = {
    id,
    producer: 'nexus' as const,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    missionId: binding.missionId,
    sensorId: 'nexus-milestone-attestation',
    baseSha: binding.baseSha,
    headSha: binding.headSha,
    diffHash: binding.diffHash,
    contextHash: binding.contextHash,
    contractHash: binding.contractHash,
    sensorConfigHash: digest,
    command: [
      'nexus-internal',
      'attest-final-validation',
      stepId,
      ...sources,
    ],
    exitCode: 0,
    stdoutHash: createHash('sha256')
      .update(JSON.stringify({ stepId, sources }))
      .digest('hex'),
    stderrHash: createHash('sha256').update('').digest('hex'),
    timedOut: false,
    truncated: false,
    startedAt: nowIso,
    finishedAt: nowIso,
  };
  manager.open(scope).db.prepare(
    `INSERT INTO sensor_evidence
       (id, mission_id, sensor_id, head_sha, diff_hash, passed,
        evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    binding.missionId,
    evidence.sensorId,
    binding.headSha,
    binding.diffHash,
    JSON.stringify(evidence),
    Date.parse(nowIso),
  );
  return id;
}

function createMergeReviewReport(
  binding: ReviewBinding,
  input: {
    readonly id: string;
    readonly provider?: string;
    readonly findings?: readonly ReviewFindingInput[];
    readonly reviewPurpose?: "pre-execution" | "candidate" | "legacy";
    readonly evaluatorVersion?: string;
    readonly preExecutionPlanBinding?: {
      readonly intentVersion: number;
      readonly planHash: string;
    };
  },
): ReviewReport {
  return new ReviewCouncil('low', binding).submit({
    reviewId: `review-${input.id}`,
    reviewerId: `reviewer-${input.id}`,
    reviewerSessionId: `reviewer-session-${input.id}`,
    reviewerProvider: input.provider ?? 'claude',
    authorId: 'author-a',
    authorSessionId: 'author-session',
    authorProvider: 'codex',
    binding,
    findings: input.findings ?? [],
    ...(input.reviewPurpose
      ? { reviewPurpose: input.reviewPurpose }
      : {}),
    ...(input.evaluatorVersion
      ? { evaluatorVersion: input.evaluatorVersion }
      : {}),
    ...(input.preExecutionPlanBinding
      ? { preExecutionPlanBinding: input.preExecutionPlanBinding }
      : {}),
  });
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workflow-runtime-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  // A full concurrent suite can briefly repopulate Git's info files while a
  // fixture is being removed. Bound the native ENOTEMPTY retry instead of
  // failing a passing workflow assertion on transient teardown timing.
  for (const root of roots.splice(0)) fs.rmSync(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 50,
  });
  fs.rmSync(baseDir, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 50,
  });
});

describe('native context workflow service', () => {
  it('reuses pre-execution evidence only for the exact sealed plan receipt', () => {
    const { service } = fixture();
    service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Harden authentication and authorization safely',
        acceptanceCriteria: [{
          id: 'secure',
          statement: 'Authentication remains secure',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    service.advance('mission-a', 'review-primary');
    const binding = service.getMissionWorkflow('mission-a').workflow!.binding;
    const planA = {
      intentVersion: 1,
      planHash: 'a'.repeat(64),
    };
    const unbound = createMergeReviewReport(binding, {
      id: 'unbound-current-evaluator',
      findings: [],
      reviewPurpose: 'pre-execution',
      evaluatorVersion: 'pre-execution-plan-v2',
    });
    const report = createMergeReviewReport(binding, {
      id: 'plan-a',
      findings: [],
      reviewPurpose: 'pre-execution',
      evaluatorVersion: 'pre-execution-plan-v2',
      preExecutionPlanBinding: planA,
    });
    service.recordMergeReviewReport(unbound);
    service.recordMergeReviewReport(report);

    expect(
      service.inspectCurrentPreExecutionReviewGate('mission-a', planA),
    ).toMatchObject({
      ready: true,
      reportCount: 1,
      evidenceIds: [`review:${report.reviewId}`],
    });
    expect(
      service.inspectCurrentPreExecutionReviewGate('mission-a', {
        intentVersion: 2,
        planHash: 'b'.repeat(64),
      }),
    ).toMatchObject({
      ready: false,
      reason: 'review-quorum-missing',
      reportCount: 0,
      evidenceIds: [],
    });
    expect(() =>
      service.advance('mission-a', 'execution', {
        preExecutionPlanBinding: {
          intentVersion: 2,
          planHash: 'b'.repeat(64),
        },
      }),
    ).toThrow(/independent review.*missing/i);
    expect(service.getMissionWorkflow('mission-a').workflow?.stage).toBe(
      'review-primary',
    );
    expect(
      service.advance('mission-a', 'execution', {
        preExecutionPlanBinding: planA,
      }),
    ).toMatchObject({ stage: 'execution' });
  });

  it('compiles blocking guidance only from the current sealed plan', () => {
    const { service } = fixture();
    service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Harden authentication and authorization safely',
        acceptanceCriteria: [{
          id: 'secure',
          statement: 'Authentication remains secure',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    service.advance('mission-a', 'review-primary');
    const binding = service.getMissionWorkflow('mission-a').workflow!.binding;
    const currentPlan = { intentVersion: 2, planHash: '2'.repeat(64) };
    const stale = createMergeReviewReport(binding, {
      id: 'stale-plan',
      reviewPurpose: 'pre-execution',
      evaluatorVersion: 'pre-execution-plan-v2',
      preExecutionPlanBinding: {
        intentVersion: 1,
        planHash: '1'.repeat(64),
      },
      findings: [{
        severity: 'critical',
        category: 'security',
        file: 'src/stale.ts',
        criterionRefs: ['secure'],
        invariantRefs: [],
        evidence: 'STALE PLAN FINDING',
        recommendation: 'Ignore stale guidance.',
      }],
    });
    const current = createMergeReviewReport(binding, {
      id: 'current-plan',
      reviewPurpose: 'pre-execution',
      evaluatorVersion: 'pre-execution-plan-v2',
      preExecutionPlanBinding: currentPlan,
      findings: [{
        severity: 'high',
        category: 'correctness',
        file: 'src/auth.ts',
        line: 42,
        criterionRefs: ['secure'],
        invariantRefs: [],
        evidence: 'The sealed plan omits the token revocation path.',
        recommendation: 'Verify and implement token revocation in the candidate.',
      }],
    });
    service.recordMergeReviewReport(stale);
    service.recordMergeReviewReport(current);

    const guidance = service.compilePreExecutionReviewGuidance(
      'mission-a',
      currentPlan,
    );

    expect(guidance).toContain('Pre-execution repair guidance');
    expect(guidance).toContain(`review:${current.reviewId}`);
    expect(guidance).toContain('src/auth.ts:42');
    expect(guidance).toContain('omits the token revocation path');
    expect(guidance).not.toContain('STALE PLAN FINDING');
    expect(guidance.length).toBeLessThanOrEqual(12_000);
    expect(
      service.advance('mission-a', 'execution', {
        preExecutionPlanBinding: currentPlan,
      }),
    ).toMatchObject({ stage: 'execution' });
  });

  it('ignores legacy baseline findings after the corrected pre-execution evaluator runs', () => {
    const { service } = fixture();
    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Harden authentication and authorization safely',
        acceptanceCriteria: [{
          id: 'secure',
          statement: 'Authentication remains secure',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    expect(frozen.contract.risk).toBe('high');
    service.advance('mission-a', 'review-primary');
    const binding = service.getMissionWorkflow('mission-a').workflow!.binding;
    const legacy = createMergeReviewReport(binding, {
      id: 'legacy-baseline',
      findings: [{
        severity: 'high',
        category: 'correctness',
        file: 'resultado.txt',
        criterionRefs: ['secure'],
        invariantRefs: [],
        evidence:
          'The future deliverable is absent from the pre-execution baseline.',
        recommendation: 'Implement the future deliverable.',
      }],
    });
    expect(legacy).toMatchObject({
      reviewPurpose: 'legacy',
      evaluatorVersion: 'legacy-v0',
    });
    service.recordMergeReviewReport(legacy);

    const preExecutionPlanBinding = {
      intentVersion: 1,
      planHash: '1'.repeat(64),
    };
    expect(() => service.advance('mission-a', 'execution', {
      preExecutionPlanBinding,
    })).toThrow(
      /independent review.*missing/i,
    );

    const current = service.submitReview({
      missionId: 'mission-a',
      preExecutionPlanBinding,
      reviewer: {
        id: 'reviewer-current',
        sessionId: 'reviewer-current-session',
        provider: 'claude',
      },
      findings: [],
    });
    expect(current.report).toMatchObject({
      reviewPurpose: 'pre-execution',
      evaluatorVersion: 'pre-execution-plan-v2',
      preExecutionPlanBinding: {
        intentVersion: 1,
        planHash: '1'.repeat(64),
      },
    });
    expect(current.gate.ready).toBe(true);
    expect(service.advance('mission-a', 'execution', {
      preExecutionPlanBinding,
    })).toMatchObject({
      stage: 'execution',
    });
    expect(service.listPersistedEvidenceIds('mission-a')).toEqual(
      expect.arrayContaining([
        `review:${legacy.reviewId}`,
        `review:${current.report.reviewId}`,
      ]),
    );
  });

  it('does not turn a Doctor warning or stale npm defaults into contract authority', () => {
    const { root, scope, manager, service } = fixture();
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'greenfield-without-scripts' }),
    );
    fs.writeFileSync(
      path.join(root, '.context/config/sensors.json'),
      JSON.stringify({
        schemaVersion: 1,
        sensors: [
          {
            id: 'typecheck',
            command: ['npm', 'run', 'typecheck'],
            timeoutMs: 60_000,
            network: false,
          },
          {
            id: 'unit',
            command: ['npm', 'test'],
            timeoutMs: 60_000,
            network: false,
          },
        ],
      }),
    );
    git(root, 'add', 'package.json', '.context/config/sensors.json');
    git(root, 'commit', '-qm', 'remove unavailable package capabilities');

    const readiness = service.inspectReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.sensorIds).toEqual([]);
    expect(readiness.warnings).toContainEqual(
      expect.objectContaining({
        code: 'missing-required-sensors',
        details: ['typecheck', 'unit'],
      }),
    );

    const draft = {
      missionId: 'mission-a',
      goal: 'Create one plain text result file',
      acceptanceCriteria: [{
        id: 'works',
        statement: 'The exact text file exists',
        requiredSensorIds: [],
        invariantRefs: [],
        requiredArtifactIds: [],
      }],
    };
    createScopedMissionStore(manager, scope, { idFactory: () => 'mission-b' })
      .create({ title: 'Explicit unresolved sensor' });
    const explicit = service.freezeContract(
      {
        ...draft,
        missionId: 'mission-b',
        requestedSensors: ['typecheck'],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    expect(explicit.contract.requiredSensors).toEqual(['typecheck']);

    const frozen = service.freezeContract(
      draft,
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    expect(frozen.contract.requiredSensors).toEqual([]);
  });

  it('refuses to freeze when package gates exist without applicable configured sensors', () => {
    const { root, service } = fixture();
    fs.writeFileSync(
      path.join(root, '.context/config/sensors.json'),
      JSON.stringify({
        schemaVersion: 1,
        sensors: [
          {
            id: 'lint',
            command: ['npm', 'run', 'lint'],
            timeoutMs: 60_000,
            network: false,
          },
        ],
      }),
    );

    const readiness = service.inspectReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContainEqual(
      expect.objectContaining({
        code: 'missing-required-sensors',
        details: ['typecheck', 'unit'],
      }),
    );
    expect(() =>
      service.freezeContract(
        {
          missionId: 'mission-a',
          goal: 'Change behavior without bypassing project validation',
          acceptanceCriteria: [{
            id: 'works',
            statement: 'Project validation remains authoritative',
            requiredSensorIds: [],
            invariantRefs: [],
            requiredArtifactIds: [],
          }],
        },
        { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
      ),
    ).toThrow(/context is not ready/i);
  });

  it('derives one replay-safe current validation attestation per milestone', () => {
    const { manager, scope, service } = fixture();
    const stepIds = ['step-a', 'step-b', 'step-c', 'step-d', 'step-e'];
    createScopedMissionStore(manager, scope).update('mission-a', {
      milestones: stepIds.map((id, index) => ({
        id,
        label: id,
        status: index === 0 ? 'in-progress' as const : 'pending' as const,
        evidenceIds: [],
      })),
    });
    service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Small isolated behavior change',
        acceptanceCriteria: [{
          id: 'works', statement: 'Behavior remains correct',
          requiredSensorIds: [], invariantRefs: [], requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    service.advance('mission-a', 'validation-primary');
    expect(() => service.advance('mission-a', 'complete')).toThrow(
      /atomic mission-step receipt path/i,
    );
    const binding = service.getMissionWorkflow('mission-a').workflow!.binding;
    recordTrustedSensor(manager, scope, binding, 'sensor-typecheck', 'typecheck');
    recordTrustedSensor(manager, scope, binding, 'sensor-unit', 'unit');
    const review = service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'reviewer-b', sessionId: 'review-session', provider: 'claude' },
      findings: [],
    });
    const sourceIds = [
      'sensor-typecheck',
      'sensor-unit',
      `review:${review.report.reviewId}`,
    ];

    expect(() => service.recordMilestoneValidationEvidence(
      'mission-a',
      ['sensor-typecheck'],
    )).toThrow(/required final sensor/);
    const first = service.recordMilestoneValidationEvidence('mission-a', sourceIds);
    const second = service.recordMilestoneValidationEvidence('mission-a', sourceIds);
    recordTrustedSensor(manager, scope, binding, 'sensor-typecheck-retry', 'typecheck');
    recordTrustedSensor(manager, scope, binding, 'sensor-unit-retry', 'unit');
    const retryReview = service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'reviewer-c', sessionId: 'review-retry', provider: 'gemini' },
      findings: [],
    });
    const replayed = service.recordMilestoneValidationEvidence('mission-a', [
      'sensor-typecheck-retry',
      'sensor-unit-retry',
      `review:${retryReview.report.reviewId}`,
    ]);

    expect(second).toEqual(first);
    expect(replayed).toEqual(first);
    expect(first.filter((id) => id.startsWith('milestone:'))).toHaveLength(5);
    expect(new Set(first)).toHaveLength(stepIds.length);
    expect(service.listCurrentPersistedEvidenceIds('mission-a'))
      .toEqual(expect.arrayContaining([...first]));

    const stepAEvidence = milestoneValidationEvidenceId(
      'mission-a',
      'step-a',
      binding,
    );
    const stepBEvidence = milestoneValidationEvidenceId(
      'mission-a',
      'step-b',
      binding,
    );
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-milestone-bundle',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Final validation attestations for every pending milestone.',
      evidenceIds: [...first],
    });

    expect(() =>
      service.advanceMissionStep('mission-a', 'step-a', [stepBEvidence]),
    ).toThrow(/exactly one matching milestone attestation/i);
    expect(() =>
      service.advanceMissionStep(
        'mission-a',
        'step-a',
        [stepAEvidence, stepBEvidence],
      ),
    ).toThrow(/exactly one matching milestone attestation/i);
    expect(
      manager.open(scope).db.prepare(
        'SELECT COUNT(*) AS count FROM mission_step_receipts',
      ).get(),
    ).toEqual({ count: 0 });
    expect(
      service.advanceMissionStep('mission-a', 'step-a', [stepAEvidence]),
    ).toMatchObject({
      stepId: 'step-a',
      evidenceIds: [stepAEvidence],
    });
  });

  it('gates mutation, requires independent review and computes done itself', async () => {
    const { manager, scope, service } = fixture();
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', { path: 'src/a.ts' }))
      .toThrow(/contract.*frozen/i);

    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Small isolated behavior change',
        acceptanceCriteria: [{
          id: 'works', statement: 'Behavior remains correct',
          requiredSensorIds: [], invariantRefs: ['scope-required'],
          requiredArtifactIds: ['artifact-required'],
        }],
        businessInvariantRefs: ['scope-required'],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    expect(frozen.workflow.stage).toBe('execution');
    expect(frozen.contract.requiredSensors).toEqual(['typecheck', 'unit']);
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', { path: 'src/a.ts' }))
      .not.toThrow();
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', {
      path: '.context/config/policy.json',
    })).toThrow(/read-only/i);
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', {
      path: '.context/docs/business-model.md',
    })).toThrow(/read-only/i);

    // Patch hashline: o alvo vive no header de seção, não em args.path. O gate
    // PREVC precisa extraí-lo, senão um executor escreveria em .context/ via patch.
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_editor_apply_patch', {
      patch: '[src/ok.ts#1a2b]\nINS.TAIL:\n+// ok\n',
    })).not.toThrow();
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_editor_apply_patch', {
      patch: '[.context/config/policy.json#1a2b]\nINS.TAIL:\n+{}\n',
    })).toThrow(/read-only/i);
    // MV para dentro de .context/ também é bloqueado.
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_editor_apply_patch', {
      patch: '[src/x.ts#1a2b]\nMV .context/x.ts\n',
    })).toThrow(/read-only/i);

    expect(service.advance('mission-a', 'validation-primary').stage)
      .toBe('validation-primary');
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', { path: 'src/a.ts' }))
      .toThrow(/validation-primary/i);
    expect(() => service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
      findings: [],
    })).toThrow(/author cannot review/i);

    const review = service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'reviewer-b', sessionId: 'review-session', provider: 'claude' },
      findings: [],
    });
    expect(review.gate.ready).toBe(true);
    // Sensors exec through the production sandbox. On hosts without a working
    // userns (common on GitHub-hosted Linux), skip the live sensor assertions
    // and plant passing evidence so the rest of the workflow gate is covered.
    if (processSandboxRuntimeAvailable()) {
      const typecheckEvidence = await service.runSensor('mission-a', 'typecheck');
      const unitEvidence = await service.runSensor('mission-a', 'unit');
      expect(service.listPersistedEvidenceIds('mission-a')).toEqual(
        expect.arrayContaining([
          typecheckEvidence.id,
          unitEvidence.id,
          `review:${review.report.reviewId}`,
        ]),
      );
      expect([typecheckEvidence.exitCode, unitEvidence.exitCode]).toEqual([0, 0]);
      expect(manager.open(scope).db.prepare(
        'SELECT sensor_id, passed, head_sha, diff_hash FROM sensor_evidence ORDER BY sensor_id',
      ).all()).toEqual([
        expect.objectContaining({ sensor_id: 'typecheck', passed: 1 }),
        expect.objectContaining({ sensor_id: 'unit', passed: 1 }),
      ]);
    } else {
      const head = git(scope.rootRealPath, 'rev-parse', 'HEAD');
      const diffHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      const nowIso = '2026-07-11T00:00:00.000Z';
      const db = manager.open(scope).db;
      // Full TrustedEvidence shape — listPersistedEvidenceIds re-parses JSON.
      for (const sensorId of ['typecheck', 'unit'] as const) {
        const evidence = {
          id: `sensor-${sensorId}`,
          producer: 'nexus' as const,
          projectId: scope.projectId,
          checkoutId: scope.checkoutId,
          missionId: 'mission-a',
          sensorId,
          baseSha: head,
          headSha: head,
          diffHash,
          contextHash: frozen.contract.contextRevision,
          contractHash: frozen.contract.contractHash,
          sensorConfigHash: 'a'.repeat(64),
          command: ['/usr/bin/true'],
          exitCode: 0,
          stdoutHash: 'b'.repeat(64),
          stderrHash: 'c'.repeat(64),
          timedOut: false,
          truncated: false,
          startedAt: nowIso,
          finishedAt: nowIso,
        };
        db.prepare(
          `INSERT INTO sensor_evidence
             (id, mission_id, sensor_id, head_sha, diff_hash, passed,
              evidence_json, created_at)
           VALUES (?, 'mission-a', ?, ?, ?, 1, ?, ?)`,
        ).run(
          evidence.id,
          sensorId,
          head,
          diffHash,
          JSON.stringify(evidence),
          Date.parse(nowIso),
        );
      }
      expect(service.listPersistedEvidenceIds('mission-a')).toEqual(
        expect.arrayContaining([
          'sensor-typecheck',
          'sensor-unit',
          `review:${review.report.reviewId}`,
        ]),
      );
    }
    const sourceEvidenceIds = service.listPersistedEvidenceIds('mission-a');
    const [stepEvidenceId] = service.recordMilestoneValidationEvidence(
      'mission-a',
      sourceEvidenceIds,
    );
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-a',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Trusted evidence ready for the final milestone.',
      evidenceIds: [stepEvidenceId!],
    });
    expect(() =>
      service.advanceMissionStep('mission-a', 'step-a', [stepEvidenceId!]),
    ).toThrow(/required Nexus artifact.*artifact-required/i);
    expect(
      createScopedMissionStore(manager, scope)
        .get('mission-a')
        ?.milestones[0]?.status,
    ).toBe('in-progress');
    expect(
      manager.open(scope).db.prepare(
        'SELECT COUNT(*) AS count FROM mission_step_receipts',
      ).get(),
    ).toEqual({ count: 0 });
    manager.open(scope).db.prepare(
      `INSERT INTO browser_artifacts
         (id, mission_id, session_id, artifact_type, storage_key,
          metadata_json, created_at)
       VALUES (?, ?, ?, 'screenshot', ?, '{}', ?)`,
    ).run(
      'artifact-required',
      'mission-a',
      'browser-session',
      'browser-artifacts/artifact-required.png',
      Date.now(),
    );
    const advanced = service.advanceMissionStep(
      'mission-a',
      'step-a',
      [stepEvidenceId!],
    );
    expect(advanced.toStage).toBe('complete');
    expect(service.isMissionDriverComplete('mission-a', ['step-a'])).toBe(true);
    expect(
      manager.open(scope).db.prepare(
        `SELECT step_id, from_stage, to_stage
         FROM mission_step_receipts WHERE mission_id = ?`,
      ).get('mission-a'),
    ).toEqual({
      step_id: 'step-a',
      from_stage: 'validation-primary',
      to_stage: 'complete',
    });
    // Step advancement proves PREVC completion but does not set mission done;
    // Mission Driver verifies all receipts first, then performs that status
    // transition. This avoids a circular "done proves done" bypass.
    expect(createScopedMissionStore(manager, scope).get('mission-a')?.status)
      .not.toBe('done');
    expect(() =>
      manager.open(scope).db.prepare(
        `UPDATE mission_step_receipts SET to_stage = 'execution'
         WHERE mission_id = ? AND step_id = ?`,
      ).run('mission-a', 'step-a'),
    ).toThrow(/immutable/i);
    manager.open(scope).db.prepare(
      'DELETE FROM mission_step_receipts WHERE mission_id = ? AND step_id = ?',
    ).run('mission-a', 'step-a');
    expect(service.isMissionDriverComplete('mission-a', ['step-a'])).toBe(false);
  });

  it('invalidates the frozen contract when versioned context changes', () => {
    const { root, service } = fixture();
    service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Small change',
        acceptanceCriteria: [{
          id: 'works', statement: 'Works', requiredSensorIds: [],
          invariantRefs: [], requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    fs.appendFileSync(path.join(root, '.context/docs/business-model.md'), '\nChanged.\n');

    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', { path: 'src/a.ts' }))
      .toThrow(/context is not ready/i);
  });

  it('read-only caller bypasses contract/stage gates but still protects .context/ and merge-queue', () => {
    const { service } = fixture();

    // Sem contrato congelado: um caller ESCRITOR bloqueia; um READ-ONLY passa.
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', { path: 'src/a.ts' }))
      .toThrow(/contract.*frozen/i);
    expect(() => service.assertMutationAllowed(
      'mission-a', 'nexus_file_write', { path: 'src/a.ts' }, true,
    )).not.toThrow();

    service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Small change',
        acceptanceCriteria: [{
          id: 'works', statement: 'Works', requiredSensorIds: [],
          invariantRefs: [], requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );

    // Avança para validation-primary: escritor bloqueia por stage; read-only passa.
    expect(service.advance('mission-a', 'validation-primary').stage)
      .toBe('validation-primary');
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', { path: 'src/a.ts' }))
      .toThrow(/validation-primary/i);
    expect(() => service.assertMutationAllowed(
      'mission-a', 'nexus_file_write', { path: 'src/a.ts' }, true,
    )).not.toThrow();

    // Proteções que valem para TODO caller (inclusive read-only) permanecem:
    // .context/ é authority read-only mesmo para um caller read-only.
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_file_write', {
      path: '.context/config/policy.json',
    }, true)).toThrow(/read-only/i);
    // Git da missão deve passar pelo merge queue, inclusive para read-only.
    expect(() => service.assertMutationAllowed('mission-a', 'nexus_git_push', {}, true))
      .toThrow(/merge queue/i);
  });

  it('supports extra milestones and validates a pre-integration receipt against a non-empty diff', () => {
    const { root, scope, manager, service } = fixture();
    createScopedMissionStore(manager, scope).update('mission-a', {
      milestones: [
        { id: 'step-a', label: 'Implement', status: 'in-progress', evidenceIds: [] },
        { id: 'step-b', label: 'Review', status: 'pending', evidenceIds: [] },
        { id: 'step-c', label: 'Verify', status: 'pending', evidenceIds: [] },
      ],
    });
    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Small verified change',
        acceptanceCriteria: [{
          id: 'works',
          statement: 'The change works',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    recordTrustedSensor(
      manager,
      scope,
      frozen.workflow.binding,
      'sensor-before-integration',
      'preflight',
    );
    const stepAEvidence = recordMilestoneAttestationForTest(
      manager,
      scope,
      frozen.workflow.binding,
      'step-a',
      ['sensor-before-integration'],
    );
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-a',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Implementation evidence bound before integration.',
      evidenceIds: [stepAEvidence],
    });

    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/change.ts'), 'export const changed = true;\n');
    git(root, 'add', 'src/change.ts');
    git(root, 'commit', '-qm', 'implement change');

    const first = service.advanceMissionStep(
      'mission-a',
      'step-a',
      [stepAEvidence],
    );
    expect(first).toMatchObject({
      fromStage: 'execution',
      toStage: 'validation-primary',
    });
    const integrated = service.getMissionWorkflow('mission-a').workflow!;
    expect(integrated.binding.diffHash).not.toBe(frozen.workflow.binding.diffHash);

    recordTrustedSensor(manager, scope, integrated.binding, 'sensor-current-typecheck', 'typecheck');
    recordTrustedSensor(manager, scope, integrated.binding, 'sensor-current-unit', 'unit');
    const review = service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'reviewer-b', sessionId: 'review-session', provider: 'claude' },
      findings: [],
    });
    const reviewEvidence = `review:${review.report.reviewId}`;
    const stepBEvidence = recordMilestoneAttestationForTest(
      manager,
      scope,
      integrated.binding,
      'step-b',
      [reviewEvidence],
    );
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-b',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Review checkpoint is bound to the integrated diff.',
      evidenceIds: [stepBEvidence],
    });
    const checkpoint = service.advanceMissionStep(
      'mission-a',
      'step-b',
      [stepBEvidence],
    );
    expect(checkpoint).toMatchObject({
      fromStage: 'validation-primary',
      toStage: 'validation-primary',
    });
    expect(checkpoint.workflowRevisionAfter).toBe(
      checkpoint.workflowRevisionBefore,
    );

    const finalReview = service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'reviewer-c', sessionId: 'review-session-c', provider: 'gemini' },
      findings: [],
    });
    const finalEvidence = `review:${finalReview.report.reviewId}`;
    const stepCEvidence = recordMilestoneAttestationForTest(
      manager,
      scope,
      integrated.binding,
      'step-c',
      [finalEvidence],
    );
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-c',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Final review is bound to the integrated diff.',
      evidenceIds: [stepCEvidence],
    });
    expect(
      service.advanceMissionStep('mission-a', 'step-c', [stepCEvidence]),
    ).toMatchObject({ toStage: 'complete' });
    expect(service.isMissionDriverComplete('mission-a', ['step-a', 'step-b', 'step-c']))
      .toBe(true);
  });

  it('keeps planning and review receipts valid after a high-risk integration changes the diff', () => {
    const { root, scope, manager, service } = fixture();
    const stepIds = ['step-plan', 'step-review', 'step-execute', 'step-validate', 'step-confirm'];
    createScopedMissionStore(manager, scope).update('mission-a', {
      milestones: stepIds.map((id, index) => ({
        id,
        label: id,
        status: index === 0 ? 'in-progress' as const : 'pending' as const,
        evidenceIds: [],
      })),
    });
    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Harden authorization and session security',
        acceptanceCriteria: [{
          id: 'secure',
          statement: 'Authorization remains secure',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    expect(frozen.contract.risk).toBe('high');

    const submitHandoff = (id: string, evidenceIds: string[]) =>
      createScopedHandoffStore(manager, scope, { idFactory: () => id }).submit({
        missionId: 'mission-a',
        status: 'success',
        summary: `Trusted evidence for ${id}`,
        evidenceIds,
      });

    recordTrustedSensor(manager, scope, frozen.workflow.binding, 'sensor-plan', 'preflight');
    const planAttestation = recordMilestoneAttestationForTest(
      manager,
      scope,
      frozen.workflow.binding,
      'step-plan',
      ['sensor-plan'],
    );
    submitHandoff('handoff-plan', [planAttestation]);
    expect(service.advanceMissionStep('mission-a', 'step-plan', [planAttestation]))
      .toMatchObject({ fromStage: 'planning', toStage: 'review-primary' });

    const preReview = service.submitReview({
      missionId: 'mission-a',
      preExecutionPlanBinding: {
        intentVersion: 1,
        planHash: '2'.repeat(64),
      },
      reviewer: { id: 'reviewer-pre', sessionId: 'review-pre', provider: 'claude' },
      findings: [],
    });
    const preReviewEvidence = `review:${preReview.report.reviewId}`;
    const reviewBinding = service.getMissionWorkflow('mission-a').workflow!.binding;
    const reviewAttestation = recordMilestoneAttestationForTest(
      manager,
      scope,
      reviewBinding,
      'step-review',
      [preReviewEvidence],
    );
    submitHandoff('handoff-review', [reviewAttestation]);
    expect(service.advanceMissionStep(
      'mission-a',
      'step-review',
      [reviewAttestation],
      {
        preExecutionPlanBinding: {
          intentVersion: 1,
          planHash: '2'.repeat(64),
        },
      },
    ))
      .toMatchObject({ fromStage: 'review-primary', toStage: 'execution' });

    const executionBinding = service.getMissionWorkflow('mission-a').workflow!.binding;
    recordTrustedSensor(manager, scope, executionBinding, 'sensor-execute', 'preflight');
    const executionAttestation = recordMilestoneAttestationForTest(
      manager,
      scope,
      executionBinding,
      'step-execute',
      ['sensor-execute'],
    );
    submitHandoff('handoff-execute', [executionAttestation]);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/security.ts'), 'export const hardened = true;\n');
    git(root, 'add', 'src/security.ts');
    git(root, 'commit', '-qm', 'harden authorization');
    expect(service.advanceMissionStep('mission-a', 'step-execute', [executionAttestation]))
      .toMatchObject({ fromStage: 'execution', toStage: 'validation-primary' });

    const integrated = service.getMissionWorkflow('mission-a').workflow!;
    expect(integrated.binding.diffHash).not.toBe(frozen.workflow.binding.diffHash);
    recordTrustedSensor(manager, scope, integrated.binding, 'sensor-current-typecheck', 'typecheck');
    recordTrustedSensor(manager, scope, integrated.binding, 'sensor-current-unit', 'unit');
    const finalReview = service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'reviewer-final', sessionId: 'review-final', provider: 'claude' },
      findings: [],
    });
    const finalReviewEvidence = `review:${finalReview.report.reviewId}`;
    const validationAttestation = recordMilestoneAttestationForTest(
      manager,
      scope,
      integrated.binding,
      'step-validate',
      [finalReviewEvidence],
    );
    submitHandoff('handoff-validate', [validationAttestation]);
    expect(service.advanceMissionStep('mission-a', 'step-validate', [validationAttestation]))
      .toMatchObject({ fromStage: 'validation-primary', toStage: 'confirmation' });

    const confirmationBinding =
      service.getMissionWorkflow('mission-a').workflow!.binding;
    const confirmationAttestation = recordMilestoneAttestationForTest(
      manager,
      scope,
      confirmationBinding,
      'step-confirm',
      ['sensor-current-unit'],
    );
    submitHandoff('handoff-confirm', [confirmationAttestation]);
    expect(service.advanceMissionStep('mission-a', 'step-confirm', [confirmationAttestation]))
      .toMatchObject({ fromStage: 'confirmation', toStage: 'complete' });
    expect(service.isMissionDriverComplete('mission-a', stepIds)).toBe(true);
  });

  it('refreezeContract cura drift de contexto preservando goal e resetando a rota', () => {
    // Beco crítico da auditoria 17/07: contexto derivar após o freeze matava
    // a missão permanentemente (sem unfreeze). refreeze re-vincula o MESMO
    // contrato ao contexto/base atuais e o workflow recomeça na rota.
    const { root, scope, service } = fixture();
    const author = {
      id: 'author-a',
      sessionId: 'author-session',
      provider: 'codex' as const,
    };
    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Small isolated behavior change',
        acceptanceCriteria: [{
          id: 'works', statement: 'Behavior remains correct',
          requiredSensorIds: [], invariantRefs: [], requiredArtifactIds: [],
        }],
      },
      author,
    );

    // Sem drift, refreeze é recusado — não é atalho para reescrever missão.
    expect(() => service.refreezeContract('mission-a', author)).toThrow(
      /has not drifted/,
    );

    // Drift real: doc muda, re-attesta (substituindo a attestation antiga —
    // duas ativas para o mesmo alvo é blocking) e commita → contextRevision novo.
    fs.writeFileSync(
      path.join(root, '.context/docs/architecture.md'),
      '# architecture\nSegunda revisão da arquitetura.\n',
    );
    const attestationsDir = path.join(root, '.context/nexus/attestations');
    for (const entry of fs.readdirSync(attestationsDir)) {
      const file = path.join(attestationsDir, entry);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        targetPath?: string;
      };
      if (parsed.targetPath === '.context/docs/architecture.md') fs.rmSync(file);
    }
    writeContextAttestation(scope, createContextAttestation(scope, {
      targetPath: '.context/docs/architecture.md',
      targetHash: hashFile(root, '.context/docs/architecture.md'),
      sources: [{
        type: 'file',
        locator: 'package.json',
        sourceHash: hashFile(root, 'package.json'),
      }],
      author: { id: 'context-author', sessionId: 'author:drift', provider: 'codex' },
      reviewer: { id: 'context-reviewer', sessionId: 'reviewer:drift', provider: 'claude' },
      reviewedAt: '2026-07-11T12:00:00.000Z',
      nexusVersion: 'test',
    }));
    git(root, 'add', '.context');
    git(root, 'commit', '-qm', 'context drift');

    const refrozen = service.refreezeContract('mission-a', author);
    expect(refrozen.contract.contextRevision).not.toBe(
      frozen.contract.contextRevision,
    );
    expect(refrozen.contract.goal).toBe(frozen.contract.goal);
    expect(refrozen.contract.risk).toBe(frozen.contract.risk);
    expect(refrozen.contract.contractHash).not.toBe(frozen.contract.contractHash);

    const current = service.getMissionWorkflow('mission-a');
    expect(current.contract?.contract.contextRevision).toBe(
      refrozen.contract.contextRevision,
    );
    expect(current.workflow?.binding.contractHash).toBe(
      refrozen.contract.contractHash,
    );
    // Revision é estrutural (estágios completados + 1): rota recomeçada = 1.
    expect(current.workflow?.revision).toBe(1);
    expect(current.workflow?.completedStages).toEqual([]);
  });

  it('refreeze adds newly reconciled package gates without dropping prior sensors', () => {
    const { root, service } = fixture();
    const author = {
      id: 'author-a',
      sessionId: 'author-session',
      provider: 'codex' as const,
    };
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'greenfield-before-stack' }),
    );
    fs.writeFileSync(
      path.join(root, '.context/config/sensors.json'),
      JSON.stringify({
        schemaVersion: 1,
        sensors: [{
          id: 'project-proof',
          command: ['/usr/bin/true'],
          timeoutMs: 60_000,
          network: false,
        }],
      }),
    );
    git(root, 'add', 'package.json', '.context/config/sensors.json');
    git(root, 'commit', '-qm', 'freeze before package stack exists');

    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Create the package stack safely',
        acceptanceCriteria: [{
          id: 'works',
          statement: 'The package stack keeps all validation authority',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
        requestedSensors: ['project-proof'],
      },
      author,
    );
    expect(frozen.contract.requiredSensors).toEqual(['project-proof']);

    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'greenfield-after-stack',
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'vitest run',
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, '.context/config/sensors.json'),
      JSON.stringify({
        schemaVersion: 1,
        sensors: [
          {
            id: 'project-proof',
            command: ['/usr/bin/true'],
            timeoutMs: 60_000,
            network: false,
          },
          {
            id: 'typecheck',
            command: ['npm', 'run', 'typecheck'],
            timeoutMs: 60_000,
            network: false,
          },
          {
            id: 'unit',
            command: ['npm', 'test'],
            timeoutMs: 60_000,
            network: false,
          },
        ],
      }),
    );
    git(root, 'add', 'package.json', '.context/config/sensors.json');
    git(root, 'commit', '-qm', 'reconcile package stack sensors');

    const refrozen = service.refreezeContract('mission-a', author);
    expect(refrozen.contract.requiredSensors).toEqual([
      'project-proof',
      'typecheck',
      'unit',
    ]);
  });

  it('replays only an approved reviewer quorum bound to the exact merge candidate', () => {
    const { service } = fixture();
    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Make one small verified change',
        acceptanceCriteria: [{
          id: 'works',
          statement: 'The exact candidate is independently reviewed',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    const binding: ReviewBinding = Object.freeze({
      ...frozen.workflow.binding,
      headSha: '1'.repeat(40),
      diffHash: '2'.repeat(64),
    });
    const planningReport = createMergeReviewReport(binding, {
      id: 'planning',
      reviewPurpose: 'pre-execution',
      evaluatorVersion: 'pre-execution-plan-v2',
    });
    service.recordMergeReviewReport(planningReport);
    expect(service.inspectPersistedReviewGate(binding)).toMatchObject({
      ready: false,
      reason: 'review-quorum-missing',
      evidenceIds: [],
      reportCount: 0,
      quorumReportCount: 0,
    });

    const staticReport = createMergeReviewReport(binding, {
      id: 'static',
      provider: 'nexus-static-analysis-v1',
      reviewPurpose: 'candidate',
      evaluatorVersion: 'candidate-implementation-v1',
    });
    service.recordMergeReviewReport(staticReport);

    expect(service.inspectPersistedReviewGate(binding)).toMatchObject({
      ready: false,
      reason: 'review-quorum-missing',
      reportCount: 1,
      quorumReportCount: 0,
      blockingFindingCount: 0,
    });

    const physicalReport = createMergeReviewReport(binding, {
      id: 'physical',
      reviewPurpose: 'candidate',
      evaluatorVersion: 'candidate-implementation-v1',
    });
    service.recordMergeReviewReport(physicalReport);
    expect(service.inspectPersistedReviewGate(binding)).toEqual({
      ready: true,
      reason: 'ready',
      evidenceIds: [
        `review:${physicalReport.reviewId}`,
        `review:${staticReport.reviewId}`,
      ],
      reportCount: 2,
      quorumReportCount: 1,
      blockingFindingCount: 0,
    });

    const divergentBindings: readonly ReviewBinding[] = [
      { ...binding, baseSha: '3'.repeat(40) },
      { ...binding, headSha: '4'.repeat(40) },
      { ...binding, diffHash: '5'.repeat(64) },
    ];
    for (const divergent of divergentBindings) {
      expect(service.inspectPersistedReviewGate(divergent)).toMatchObject({
        ready: false,
        reason: 'review-quorum-missing',
        evidenceIds: [],
        reportCount: 0,
        quorumReportCount: 0,
      });
    }
    expect(() =>
      service.inspectPersistedReviewGate({
        ...binding,
        contextHash: '6'.repeat(64),
      }),
    ).toThrow(/current frozen contract/i);
    expect(() =>
      service.inspectPersistedReviewGate({
        ...binding,
        contractHash: '7'.repeat(64),
      }),
    ).toThrow(/current frozen contract/i);
    expect(() =>
      service.inspectPersistedReviewGate({
        ...binding,
        projectId: 'project-divergent',
      }),
    ).toThrow(/another project scope/i);
    expect(() =>
      service.inspectPersistedReviewGate({
        ...binding,
        checkoutId: 'checkout-divergent',
      }),
    ).toThrow(/another project scope/i);
    expect(() =>
      service.inspectPersistedReviewGate({
        ...binding,
        missionId: 'mission-divergent',
      }),
    ).toThrow(/frozen mission contract/i);
  });

  it('does not turn persisted HIGH or CRITICAL findings into approval', () => {
    const { service } = fixture();
    const frozen = service.freezeContract(
      {
        missionId: 'mission-a',
        goal: 'Make one small verified change',
        acceptanceCriteria: [{
          id: 'works',
          statement: 'Blocking findings remain authoritative',
          requiredSensorIds: [],
          invariantRefs: [],
          requiredArtifactIds: [],
        }],
      },
      { id: 'author-a', sessionId: 'author-session', provider: 'codex' },
    );
    const binding: ReviewBinding = Object.freeze({
      ...frozen.workflow.binding,
      headSha: '1'.repeat(40),
      diffHash: '2'.repeat(64),
    });
    const report = createMergeReviewReport(binding, {
      id: 'blocked',
      findings: [
        {
          severity: 'high',
          category: 'correctness',
          file: 'src/high.ts',
          criterionRefs: ['works'],
          invariantRefs: [],
          evidence: 'The high severity defect is still reachable.',
          recommendation: 'Repair the defect before promotion.',
        },
        {
          severity: 'critical',
          category: 'security',
          file: 'src/critical.ts',
          criterionRefs: ['works'],
          invariantRefs: [],
          evidence: 'The critical security defect remains exploitable.',
          recommendation: 'Remove the exploit path before promotion.',
        },
      ],
    });
    service.recordMergeReviewReport(report);

    expect(service.inspectPersistedReviewGate(binding)).toEqual({
      ready: false,
      reason: 'blocking-findings',
      evidenceIds: [`review:${report.reviewId}`],
      reportCount: 1,
      quorumReportCount: 1,
      blockingFindingCount: 2,
    });
  });
});
