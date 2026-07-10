import { describe, expect, it, vi } from 'vitest';
import { compileMissionContract } from './contract-compiler';
import { CliAutomatedReviewer } from './cli-automated-reviewer';
import { AutomatedReviewSessionRegistry } from './automated-review-session';
import { testProjectScope } from '../orch/__tests__/scope-fixture';
import type { SpawnToolOptions } from '../orch/tool-util';

describe('CLI automated reviewer', () => {
  it('spawns a read-only independent route and waits for structured submission', async () => {
    const sessions = new AutomatedReviewSessionRegistry();
    const scope = testProjectScope({ rootRealPath: '/candidate' });
    const contract = compileMissionContract({
      schemaVersion: 1,
      scope,
      missionId: 'mission-a',
      baseCommit: 'a'.repeat(40),
      contextRevision: 'c'.repeat(64),
      goal: 'Review behavior',
      acceptanceCriteria: [{ id: 'works', statement: 'Works' }],
    }, { invariantRefs: new Set(), availableSensorIds: new Set(), blockingConflictIds: [] });
    const binding = {
      projectId: scope.projectId, checkoutId: scope.checkoutId, missionId: 'mission-a',
      contractHash: contract.contractHash, contextHash: contract.contextRevision,
      baseSha: contract.baseCommit, headSha: 'b'.repeat(40), diffHash: 'd'.repeat(64),
    };
    const spawn = vi.fn(async (options: SpawnToolOptions) => {
      const match = options.prompt?.match(/"reviewSessionId":"([^"]+)"/);
      if (!match) throw new Error('review session missing from prompt');
      sessions.submit(match[1], {
        id: 'reviewer-claude-1', sessionId: 'session-review', provider: 'claude',
        missionId: 'mission-a', checkoutPath: '/candidate',
      }, []);
      return { paneId: 'pane-review', sessionId: 'session-review' };
    });
    const reviewer = new CliAutomatedReviewer({
      sessions,
      selectRoutes: () => [{ adapterId: 'claude' }],
      spawn,
      close: () => true,
      timeoutMs: 100,
    });

    await expect(reviewer.run({
      scope,
      checkoutPath: '/candidate',
      contract,
      binding,
      author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
      contextMarkdown: '# Context',
      persist: () => {},
    })).resolves.toMatchObject({ ready: true });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      executionScope: expect.objectContaining({ rootRealPath: '/candidate' }),
      allowedTools: expect.not.arrayContaining(['nexus_file_write', 'nexus_terminal_run']),
    }));
  });
});
