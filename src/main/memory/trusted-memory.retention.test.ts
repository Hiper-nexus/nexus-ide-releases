import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_IDS } from '../../shared/feature-flags';
import type { ProjectExecutionScope } from '../../shared/types';
import { getFeatureFlagRegistry } from '../feature-flags/feature-flag-registry';
import { configureJevDecisionLog } from '../jev/jev-decision-log';
import { distillHandoffSummary } from '../jev/jev-memory-distill';
import { configureWorkspaceMemory, disposeWorkspaceMemoryStores, getWorkspaceMemoryStore } from './workspace-memory';
import { retainAcknowledgedHandoffMemoryBestEffort, retryPendingMemoryRetentions } from './trusted-memory';

vi.mock('../jev/jev-memory-distill', async (importOriginal) => ({
  ...await importOriginal<typeof import('../jev/jev-memory-distill')>(),
  distillHandoffSummary: vi.fn(),
}));

let dir: string;
let scope: ProjectExecutionScope;
const delivered = { handoffId: 'helper-1', status: 'success' as const };
const distill = vi.mocked(distillHandoffSummary);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-retention-'));
  scope = { version: 1, installationId: 'install', projectId: 'project', checkoutId: 'checkout', rootRealPath: dir, identitySource: 'manifest' };
  configureWorkspaceMemory({ baseDir: dir });
  configureJevDecisionLog(path.join(dir, 'jev'));
  getFeatureFlagRegistry().setOverride(FEATURE_FLAG_IDS.workspaceMemory, true);
  distill.mockReset();
});
afterEach(() => {
  disposeWorkspaceMemoryStores();
  configureJevDecisionLog(undefined);
  getFeatureFlagRegistry().clearOverride(FEATURE_FLAG_IDS.workspaceMemory);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('F-768 durable retention retry', () => {
  it('dedupes unavailable handoffs and replays the backlog on database reopen', async () => {
    distill.mockImplementation(async (_, deps) => { deps?.onSkip?.('no-route'); return null; });
    await retainAcknowledgedHandoffMemoryBestEffort(scope, delivered, 'The parser rejects invalid dates.');
    await retainAcknowledgedHandoffMemoryBestEffort(scope, delivered, 'The parser rejects invalid dates.');
    const first = getWorkspaceMemoryStore(scope);
    expect(first.stats().workspace.active).toBe(0);
    expect(first.stats().retention.pending).toBe(1);
    expect(first.stats().retention.skips['no-route']).toBeGreaterThanOrEqual(2);
    configureWorkspaceMemory({ baseDir: dir });
    distill.mockResolvedValue('The parser rejects invalid dates.');
    const reopened = getWorkspaceMemoryStore(scope);
    await vi.waitFor(() => expect(reopened.stats().retention.pending).toBe(0));
    expect(reopened.stats().workspace.active).toBe(1);
    const [hit] = reopened.recall({ query: 'parser invalid dates', includeGlobal: false });
    expect(hit.content).toContain('Summary: [Agent report, unverified; Jev approved for retention, not factual verification.]');
    expect(hit.content.match(/Summary:/g)).toHaveLength(1);
  });

  it('permanent Jev rejection removes a queued candidate without retaining it', async () => {
    distill.mockImplementation(async (_, deps) => { deps?.onSkip?.('timeout'); return null; });
    await retainAcknowledgedHandoffMemoryBestEffort(scope, delivered, 'Routine status.');
    distill.mockImplementation(async (_, deps) => { deps?.onSkip?.('jev-skip'); return null; });
    await retryPendingMemoryRetentions(scope);
    const stats = getWorkspaceMemoryStore(scope).stats();
    expect(stats.retention.pending).toBe(0);
    expect(stats.workspace.active).toBe(0);
    expect(stats.retention.skips['jev-skip']).toBe(1);
  });

  it('scrubs secrets in pending payloads before storing them', async () => {
    distill.mockImplementation(async (_, deps) => { deps?.onSkip?.('timeout'); return null; });
    const secret = 'ghp_' + 'A'.repeat(36);
    await retainAcknowledgedHandoffMemoryBestEffort(scope, delivered, `Parser token=${secret} rotation fixed.`);
    const [row] = getWorkspaceMemoryStore(scope).pendingRetentions();
    expect(row.payload).not.toContain(secret);
    expect(() => JSON.parse(row.payload)).not.toThrow();
  });

  it('forgets legacy identifier-only receipts on reopen and preserves useful summaries', () => {
    const store = getWorkspaceMemoryStore(scope);
    for (let i = 0; i < 6; i++) store.retain({ content: `Summary: Handoff accepted by Nexus Main.\nHandoff: legacy-${i}\nTask: task-${i}`, source: 'trusted:accepted-handoff' });
    const useful = store.retain({ content: 'Summary: Handoff accepted by Nexus Main.\nSummary: Parser rejects invalid dates.\nHandoff: useful', source: 'trusted:accepted-handoff' });
    configureWorkspaceMemory({ baseDir: dir });
    const reopened = getWorkspaceMemoryStore(scope);
    expect(reopened.stats().workspace.active).toBe(1);
    expect(reopened.activeWorkspaceSource(useful.id)).toBe('trusted:accepted-handoff');
  });
});
