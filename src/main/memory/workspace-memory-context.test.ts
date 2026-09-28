import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import {
  configureWorkspaceMemory,
  disposeWorkspaceMemoryStores,
  getWorkspaceMemoryStore,
} from './workspace-memory';
import { retainAcceptedHandoffMemory } from './trusted-memory';
import {
  standingWorkspaceMemoryBlock,
  workspaceMemoryContextBlock,
  AUTO_RECALL_DEFAULT_MAX_BYTES,
  autoRecallPhaseForAgent,
  formatAutoRecallContext,
  withAutoRecalledWorkspaceMemory,
} from './workspace-memory-context';

const dirs: string[] = [];
let scope: ProjectExecutionScope;

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-auto-recall-'));
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-auto-recall-db-'));
  dirs.push(root, baseDir);
  scope = {
    version: 1,
    installationId: 'installation-memory',
    projectId: 'project-memory',
    checkoutId: 'checkout-memory',
    rootRealPath: root,
    identitySource: 'manifest',
  };
  configureWorkspaceMemory({ baseDir });
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
});

afterEach(() => {
  disposeWorkspaceMemoryStores();
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.workspaceMemory);
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('automatic workspace-memory recall', () => {
  it('maps orchestrator, workers, and reviewers to the three recall phases', () => {
    expect(autoRecallPhaseForAgent({ role: 'orchestrator' })).toBe('planning');
    expect(autoRecallPhaseForAgent({ role: 'worker' })).toBe('execution');
    expect(
      autoRecallPhaseForAgent({
        role: 'worker',
        agentCategory: 'reviewer',
      }),
    ).toBe('review');
    expect(autoRecallPhaseForAgent({ readOnly: true })).toBe('review');
  });

  it('injects relevant canonical context before planning without changing the brief', () => {
    getWorkspaceMemoryStore(scope).retain({
      content:
        'Architecture rule: PostgreSQL writes use one explicit transaction.',
      kind: 'decision',
      importance: 5,
      source: 'trusted:architecture-rule',
    });
    getWorkspaceMemoryStore(scope).retain({
      content: 'Agent guess: PostgreSQL writes should bypass transactions.',
      kind: 'fact',
      importance: 5,
      source: 'mission:unverified-worker',
    });
    const brief = 'Plan the PostgreSQL write flow and its transaction boundary.';

    const prompt = withAutoRecalledWorkspaceMemory(scope, brief, 'planning');

    expect(prompt).toContain('<workspace-memory');
    expect(prompt).toContain('phase="planning"');
    expect(prompt).toContain('PostgreSQL writes use one explicit transaction');
    expect(prompt).not.toContain('bypass transactions');
    expect(prompt.endsWith(brief)).toBe(true);
    expect(Buffer.byteLength(prompt.slice(0, -brief.length), 'utf8')).toBeLessThanOrEqual(
      AUTO_RECALL_DEFAULT_MAX_BYTES + 2,
    );
  });

  it('recibos sem aprendizado ficam auditáveis, mas não ocupam o contexto automático', () => {
    const receipt = { missionId: 'm', taskId: 't', dispatchId: 'd', status: 'success' as const, acceptedAt: 1 };
    retainAcceptedHandoffMemory(scope, { ...receipt, handoffId: 'receipt-only' });
    expect(standingWorkspaceMemoryBlock(scope)).toBeNull();
    expect(workspaceMemoryContextBlock(scope, 'Nexus handoff mission')).toBeNull();
    retainAcceptedHandoffMemory(scope, { ...receipt, handoffId: 'learned',
      distilledSummary: 'Use cobrarUmaVez para cobrança idempotente.',
    });
    const block = standingWorkspaceMemoryBlock(scope);
    expect(block).toContain('cobrarUmaVez');
    expect(block).not.toContain('Handoff:');
    expect(block).not.toContain('Dispatch:');
    const stored = getWorkspaceMemoryStore(scope).recall({ query: 'Handoff', trustedOnly: true });
    expect(stored.some((hit) => hit.content.includes('receipt-only'))).toBe(true);
  });

  it('caps formatted memory between the architectural 2–4 KB envelope', () => {
    const context = formatAutoRecallContext(
      Array.from({ length: 12 }, (_, index) => ({
        id: `mem-${index}`,
        content: `Relevant fact ${index}: ${'á'.repeat(700)}`,
        kind: 'fact' as const,
        scope: 'workspace' as const,
        importance: 5,
        source: 'trusted:resolved-problem',
        createdAt: 1,
        updatedAt: 1,
        recallCount: 1,
        score: 1,
      })),
      'review',
      2_048,
    );

    expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(context).toContain('phase="review"');
    expect(context).toContain('</workspace-memory>');
  });

  it('is fail-soft and leaves prompts untouched when disabled or irrelevant', () => {
    const brief = 'Review a completely unrelated zebra renderer.';
    expect(withAutoRecalledWorkspaceMemory(scope, brief, 'review')).toBe(brief);

    getFeatureFlagRegistry().setOverride(
      FEATURE_FLAG_IDS.workspaceMemory,
      false,
    );
    expect(
      withAutoRecalledWorkspaceMemory(scope, brief, 'execution'),
    ).toBe(brief);
  });
});
