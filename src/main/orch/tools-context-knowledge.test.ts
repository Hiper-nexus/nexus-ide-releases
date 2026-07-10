import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  configureContextWorkflowRegistry,
  disposeContextWorkflowRegistry,
} from '../context/context-workflow-registry';
import { ensureContextScaffold } from '../context/context-doctor';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import type { AgentGateContext } from './gate';
import { buildContextTools } from './tools-context';

let baseDir = '';
let root = '';
let manager: ProjectRuntimeManager;
let scope: ProjectExecutionScope;

function context(
  providerId: string,
  sessionId: string,
  role: AgentGateContext['role'] = 'orchestrator',
): AgentGateContext {
  return {
    token: `token-${sessionId}`,
    label: providerId,
    role,
    sessionId,
    agentName: `${providerId}-agent`,
    providerId,
    scope,
    allowedTools: null,
    allowedSkills: null,
    stopAttempts: 0,
    handoffSubmitted: false,
  };
}

function tool(name: string) {
  const found = buildContextTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-tools-runtime-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-context-tools-')));
  scope = Object.freeze({
    version: 1,
    installationId: 'installation-tools',
    projectId: 'project-tools',
    checkoutId: 'checkout-tools',
    rootRealPath: root,
    identitySource: 'manifest',
  });
  manager = new ProjectRuntimeManager({ baseDir, appVersion: 'test' });
  configureContextWorkflowRegistry(manager, { appVersion: 'test' });
  ensureContextScaffold(scope);
});

afterEach(() => {
  disposeContextWorkflowRegistry();
  manager.closeAll();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('native context knowledge MCP tools', () => {
  it('exposes the autonomous context and recoverable merge control surface', () => {
    expect(buildContextTools().map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining([
        'nexus_context_draft_propose',
        'nexus_system_doctor',
        'nexus_context_draft_review',
        'nexus_context_draft_review_run',
        'nexus_context_draft_apply',
        'nexus_context_commit',
        'nexus_merge_status',
        'nexus_merge_retry',
      ]),
    );
  });

  it('keeps proposal read-only until an independent provider approves it', async () => {
    const source = '# Product source\nRun unit tests.\n';
    fs.writeFileSync(path.join(root, 'README.md'), source);
    const proposed = await tool('nexus_context_draft_propose').handler({
      targetPath: '.context/docs/testing.md',
      content: '# Testing\nRun unit tests.\n',
      expectedTargetHash: null,
      sources: [{
        type: 'file',
        locator: 'README.md',
        sourceHash: createHash('sha256').update(source).digest('hex'),
      }],
    }, context('codex', 'author-session')) as { id: string };

    expect(fs.existsSync(path.join(root, '.context/docs/testing.md'))).toBe(false);
    await expect(tool('nexus_context_draft_review').handler({
      draftId: proposed.id,
      decision: 'approve',
      rationale: 'Self approval.',
    }, context('codex', 'author-session'))).rejects.toThrow(/independent/i);

    await expect(tool('nexus_context_draft_review').handler({
      draftId: proposed.id,
      decision: 'approve',
      rationale: 'The target matches the independently inspected source.',
    }, context('claude', 'reviewer-session', 'worker'))).resolves.toMatchObject({
      status: 'approved',
    });
    await expect(tool('nexus_context_draft_apply').handler({
      draftId: proposed.id,
    }, context('codex', 'orchestrator-session'))).resolves.toMatchObject({
      draft: expect.objectContaining({ status: 'applied' }),
    });
    expect(fs.readFileSync(path.join(root, '.context/docs/testing.md'), 'utf8'))
      .toContain('Run unit tests');
  });

  it('never lets a worker materialize approved authority', async () => {
    await expect(tool('nexus_context_draft_apply').handler({
      draftId: 'draft-a',
    }, context('claude', 'worker-session', 'worker'))).rejects.toThrow(/orchestrator/i);
  });

  it('never lets an author worker mint trusted sensor evidence', async () => {
    await expect(tool('nexus_sensor_run').handler({
      missionId: 'mission-a',
      sensorId: 'unit',
    }, {
      ...context('codex', 'author-worker', 'worker'),
      missionId: 'mission-a',
    })).rejects.toThrow(/only the mission orchestrator/i);
  });
});
