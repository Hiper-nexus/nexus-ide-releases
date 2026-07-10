import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { createScopedMissionStore } from '../orch/mission-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ensureContextScaffold } from './context-doctor';
import {
  createContextAttestation,
  writeContextAttestation,
} from './context-attestation';
import { ContextWorkflowService } from './context-workflow-service';

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
    .create({ title: 'Implement safely' });
  let id = 0;
  const integration = () => {
    const head = git(root, 'rev-parse', 'HEAD');
    return {
      worktreeId: 'worktree-a',
      baseSha: head,
      headSha: head,
      diffHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
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

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workflow-runtime-'));
});

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('native context workflow service', () => {
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
    expect(() => service.advance('mission-a', 'complete')).toThrow(
      /required Nexus artifact.*artifact-required/i,
    );
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
    expect(service.advance('mission-a', 'complete').stage).toBe('complete');
    expect(createScopedMissionStore(manager, scope).get('mission-a')?.status).toBe('done');
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
});
