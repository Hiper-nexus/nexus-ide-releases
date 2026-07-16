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
import { ContextWorkflowService } from './context-workflow-service';
import { processSandboxRuntimeAvailable } from '../runtime/process-sandbox-capability';
import { inspectGitBinding } from './git-binding';
import type { EvidenceBinding } from './prevc-engine';

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

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workflow-runtime-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('native context workflow service', () => {
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
    const evidenceIds = service.listPersistedEvidenceIds('mission-a');
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-a',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Trusted evidence ready for the final milestone.',
      evidenceIds: [...evidenceIds],
    });
    expect(() =>
      service.advanceMissionStep('mission-a', 'step-a', evidenceIds),
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
      evidenceIds,
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
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-a',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Implementation evidence bound before integration.',
      evidenceIds: ['sensor-before-integration'],
    });

    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/change.ts'), 'export const changed = true;\n');
    git(root, 'add', 'src/change.ts');
    git(root, 'commit', '-qm', 'implement change');

    const first = service.advanceMissionStep(
      'mission-a',
      'step-a',
      ['sensor-before-integration'],
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
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-b',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Review checkpoint is bound to the integrated diff.',
      evidenceIds: [reviewEvidence],
    });
    const checkpoint = service.advanceMissionStep(
      'mission-a',
      'step-b',
      [reviewEvidence],
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
    createScopedHandoffStore(manager, scope, {
      idFactory: () => 'handoff-step-c',
    }).submit({
      missionId: 'mission-a',
      status: 'success',
      summary: 'Final review is bound to the integrated diff.',
      evidenceIds: [finalEvidence],
    });
    expect(
      service.advanceMissionStep('mission-a', 'step-c', [finalEvidence]),
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
    submitHandoff('handoff-plan', ['sensor-plan']);
    expect(service.advanceMissionStep('mission-a', 'step-plan', ['sensor-plan']))
      .toMatchObject({ fromStage: 'planning', toStage: 'review-primary' });

    const preReview = service.submitReview({
      missionId: 'mission-a',
      reviewer: { id: 'reviewer-pre', sessionId: 'review-pre', provider: 'claude' },
      findings: [],
    });
    const preReviewEvidence = `review:${preReview.report.reviewId}`;
    submitHandoff('handoff-review', [preReviewEvidence]);
    expect(service.advanceMissionStep('mission-a', 'step-review', [preReviewEvidence]))
      .toMatchObject({ fromStage: 'review-primary', toStage: 'execution' });

    const executionBinding = service.getMissionWorkflow('mission-a').workflow!.binding;
    recordTrustedSensor(manager, scope, executionBinding, 'sensor-execute', 'preflight');
    submitHandoff('handoff-execute', ['sensor-execute']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/security.ts'), 'export const hardened = true;\n');
    git(root, 'add', 'src/security.ts');
    git(root, 'commit', '-qm', 'harden authorization');
    expect(service.advanceMissionStep('mission-a', 'step-execute', ['sensor-execute']))
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
    submitHandoff('handoff-validate', [finalReviewEvidence]);
    expect(service.advanceMissionStep('mission-a', 'step-validate', [finalReviewEvidence]))
      .toMatchObject({ fromStage: 'validation-primary', toStage: 'confirmation' });

    submitHandoff('handoff-confirm', ['sensor-current-unit']);
    expect(service.advanceMissionStep('mission-a', 'step-confirm', ['sensor-current-unit']))
      .toMatchObject({ fromStage: 'confirmation', toStage: 'complete' });
    expect(service.isMissionDriverComplete('mission-a', stepIds)).toBe(true);
  });
});
