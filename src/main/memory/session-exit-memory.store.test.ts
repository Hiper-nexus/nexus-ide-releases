// Digest de fim de sessão contra o handoff-store real: o filtro de list()
// (entregue/não entregue) e a confiança da evidência são do store, não de stub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';;
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { createWorkflowState, type EvidenceBinding } from '../context/prevc-engine';
import type { TrustedEvidence } from '../context/sensor-broker';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { INITIAL_PROJECT_MIGRATIONS } from '../runtime/project-runtime-schema';
import { createScopedHandoffStore } from '../orch/handoff-store';
import { createScopedMissionStore } from '../orch/mission-store';
import type { OwnedAgentSessionInfo } from '../pty/pty-manager';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from './workspace-memory';
import { distillSessionExitMemory } from './session-exit-memory';

const dirs: string[] = [];
let runtime: ProjectRuntimeManager;
let scope: ProjectExecutionScope;

function seedTrustedEvidence(missionId: string): void {
  const binding: EvidenceBinding = {
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    missionId,
    contractHash: 'c'.repeat(64),
    contextHash: 'd'.repeat(64),
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diffHash: 'e'.repeat(64),
  };
  const workflow = createWorkflowState('low', binding);
  const db = runtime.open(scope).db;
  db.prepare(
    `INSERT INTO mission_contracts
       (mission_id, revision, contract_hash, context_revision, contract_json,
        author_id, author_session_id, author_provider, frozen_at)
     VALUES (?, 1, ?, ?, '{}', 'author', 'author-session', 'codex', 1)`,
  ).run(missionId, binding.contractHash, binding.contextHash);
  db.prepare(
    `INSERT INTO workflow_states (mission_id, revision, stage, workflow_json, updated_at)
     VALUES (?, ?, ?, ?, 1)`,
  ).run(missionId, workflow.revision, workflow.stage, JSON.stringify(workflow));
  const evidence: TrustedEvidence = {
    id: 'evidence-a',
    producer: 'nexus',
    ...binding,
    sensorId: 'unit',
    sensorConfigHash: 'f'.repeat(64),
    command: ['npm', 'test'],
    exitCode: 0,
    stdoutHash: '1'.repeat(64),
    stderrHash: '2'.repeat(64),
    timedOut: false,
    truncated: false,
    startedAt: '2026-07-10T00:00:00.000Z',
    finishedAt: '2026-07-10T00:00:01.000Z',
  };
  db.prepare(
    `INSERT INTO sensor_evidence
       (id, mission_id, sensor_id, head_sha, diff_hash, passed, evidence_json, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, 1)`,
  ).run(evidence.id, missionId, evidence.sensorId, evidence.headSha, evidence.diffHash, JSON.stringify(evidence));
}

const agent = (missionId?: string) =>
  ({
    sessionId: 'session-a',
    adapterId: 'claude',
    cwd: scope.rootRealPath,
    scope,
    source: 'operator',
    role: 'user',
    readOnly: false,
    allowedTools: null,
    allowedSkills: null,
    ...(missionId ? { missionId } : {}),
  }) as unknown as OwnedAgentSessionInfo;

const approve = async (input: { summary: string }) => input.summary;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-exit-store-root-'));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-exit-store-db-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-exit-store-rt-'));
  dirs.push(root, baseDir, runtimeDir);
  scope = {
    version: 1,
    installationId: 'installation-exit-store',
    projectId: 'project-exit-store',
    checkoutId: 'checkout-exit-store',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  runtime = new ProjectRuntimeManager({
    baseDir: runtimeDir,
    appVersion: '0.12.0-test',
    migrations: INITIAL_PROJECT_MIGRATIONS,
  });
  configureWorkspaceMemory({ baseDir });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
});

afterEach(() => {
  runtime.closeAll();
  disposeWorkspaceMemoryStores();
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.workspaceMemory);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

vi.mock('../license-access', async () => (await import('../__tests__/licensed-access')).licensedAccessMock);

describe('session-exit digest com o handoff-store real', () => {
  it('conta o handoff verificado que já foi entregue antes do auto-close', async () => {
    createScopedMissionStore(runtime, scope, { idFactory: () => 'mission-a' }).create({
      title: 'Mission A',
    });
    seedTrustedEvidence('mission-a');
    const handoffs = createScopedHandoffStore(runtime, scope, { idFactory: () => 'handoff-a' });
    handoffs.submit({
      missionId: 'mission-a',
      sessionId: 'session-a',
      status: 'success',
      summary: 'Parser de datas aceita fuso horário explícito.',
      evidenceIds: ['evidence-a'],
    });
    expect(handoffs.markSubmitted('handoff-a')).toBe(true);

    const outcome = await distillSessionExitMemory(
      { sessionId: 'session-a', agent: agent('mission-a') },
      { getStores: () => ({ handoffs }), distill: approve },
    );

    expect(outcome).toMatchObject({ retained: true, reason: 'ok' });
    const [hit] = getWorkspaceMemoryStore(scope).recall({
      query: 'parser datas fuso',
      includeGlobal: false,
      trustedOnly: true,
    });
    expect(hit?.source).toBe('trusted:session-digest');
  });

  it('F-768: declaração de sucesso sem evidência passa pela barreira Jev e mantém a procedência', async () => {
    const handoffs = createScopedHandoffStore(runtime, scope, { idFactory: () => 'handoff-b' });
    handoffs.submit({
      sessionId: 'session-a',
      status: 'success',
      summary: 'Helper afirma que todos os testes passam.',
    });

    const outcome = await distillSessionExitMemory(
      { sessionId: 'session-a', agent: agent() },
      { getStores: () => ({ handoffs }), distill: async () => 'Helper reported test results; rerun tests before relying on them.' },
    );

    expect(outcome).toMatchObject({ retained: true, reason: 'ok' });
    const [hit] = getWorkspaceMemoryStore(scope).recall({ query: 'test results', includeGlobal: false });
    expect(hit?.content).toContain('Helper reported test results');
    expect(hit?.content).toContain('Agent report, unverified; Jev approved for retention, not factual verification.');
    expect(hit?.content).not.toContain('todos os testes passam');
  });
});
