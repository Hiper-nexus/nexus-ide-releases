import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import { createScopedMissionStore } from '../orch/mission-store';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { compileMissionContract } from './contract-compiler';
import { createWorkflowState, type WorkflowEvidence } from './prevc-engine';
import { createContextWorkflowStore } from './context-workflow-store';

let baseDir = '';
const managers: ProjectRuntimeManager[] = [];

function manager(): ProjectRuntimeManager {
  const value = new ProjectRuntimeManager({ baseDir, appVersion: '0.12.0-test' });
  managers.push(value);
  return value;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-workflow-'));
});

afterEach(() => {
  for (const value of managers.splice(0)) value.closeAll();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('durable context workflow store', () => {
  it('freezes a content-addressed contract and survives runtime reopen', () => {
    const runtimeManager = manager();
    const scope = testProjectScope();
    const mission = createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-a',
    }).create({ title: 'Scoped change' });
    const contract = compileMissionContract(
      {
        schemaVersion: 1,
        scope,
        missionId: mission.id,
        baseCommit: 'a'.repeat(40),
        contextRevision: 'c'.repeat(64),
        goal: 'Implement a local isolated feature',
        acceptanceCriteria: [
          {
            id: 'criterion-a',
            statement: 'Unit sensor passes',
            requiredSensorIds: ['unit'],
          },
        ],
      },
      {
        invariantRefs: new Set(),
        availableSensorIds: new Set(['unit']),
        blockingConflictIds: [],
      },
    );
    const binding = {
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      missionId: mission.id,
      contractHash: contract.contractHash,
      contextHash: contract.contextRevision,
      baseSha: contract.baseCommit,
      headSha: contract.baseCommit,
      diffHash: 'd'.repeat(64),
    };
    const store = createContextWorkflowStore(runtimeManager, scope, { now: () => 42 });
    store.freeze(contract, createWorkflowState(contract.risk, binding), {
      id: 'author-a',
      sessionId: 'session-a',
      provider: 'codex',
    });

    runtimeManager.close(scope);
    const reopened = createContextWorkflowStore(runtimeManager, scope);
    expect(reopened.getContract(mission.id)).toMatchObject({
      contract: { contractHash: contract.contractHash },
      author: { id: 'author-a', sessionId: 'session-a', provider: 'codex' },
      frozenAt: 42,
    });
    expect(reopened.getWorkflow(mission.id)).toMatchObject({
      revision: 1,
      binding,
    });
    expect(() =>
      reopened.freeze(contract, createWorkflowState(contract.risk, binding), {
        id: 'author-a',
        sessionId: 'session-a',
        provider: 'codex',
      }),
    ).toThrow();
  });

  it('advances with optimistic concurrency and never crosses checkouts', () => {
    const runtimeManager = manager();
    const scope = testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-a' });
    createScopedMissionStore(runtimeManager, scope, {
      idFactory: () => 'mission-a',
    }).create({ title: 'A' });
    const contract = compileMissionContract(
      {
        schemaVersion: 1,
        scope,
        missionId: 'mission-a',
        baseCommit: 'a'.repeat(40),
        contextRevision: 'c'.repeat(64),
        goal: 'Small change',
        acceptanceCriteria: [{ id: 'criterion-a', statement: 'Works' }],
      },
      { invariantRefs: new Set(), availableSensorIds: new Set(), blockingConflictIds: [] },
    );
    const binding = {
      projectId: scope.projectId,
      checkoutId: scope.checkoutId,
      missionId: 'mission-a',
      contractHash: contract.contractHash,
      contextHash: contract.contextRevision,
      baseSha: contract.baseCommit,
      headSha: contract.baseCommit,
      diffHash: 'd'.repeat(64),
    };
    const store = createContextWorkflowStore(runtimeManager, scope);
    store.freeze(contract, createWorkflowState('low', binding), {
      id: 'author-a', sessionId: 'session-a', provider: 'codex',
    });
    const evidence: WorkflowEvidence = {
      binding,
      blockingConflictIds: [],
      openFindingSeverities: [],
      trustedSensorIds: [],
      requiredSensorIds: [],
      trustedArtifactIds: [],
      requiredArtifactIds: [],
      authorId: 'author-a',
      authorSessionId: 'session-a',
      authorProvider: 'codex',
      worktreeId: 'worktree-a',
      integratedHeadSha: binding.headSha,
      integratedDiffHash: binding.diffHash,
    };

    expect(store.advance('mission-a', 1, evidence, 'validation-primary')).toMatchObject({
      revision: 2,
      stage: 'validation-primary',
    });
    expect(() => store.advance('mission-a', 1, evidence, 'validation-primary')).toThrow(
      /concurrency/i,
    );

    const other = createContextWorkflowStore(
      runtimeManager,
      testProjectScope({ projectId: 'project-a', checkoutId: 'checkout-b' }),
    );
    expect(other.getContract('mission-a')).toBeNull();
    expect(other.getWorkflow('mission-a')).toBeNull();
  });
});
