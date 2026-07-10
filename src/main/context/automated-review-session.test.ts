import { describe, expect, it, vi } from 'vitest';
import { AutomatedReviewSessionRegistry } from './automated-review-session';

const binding = {
  projectId: 'project-a', checkoutId: 'checkout-a', missionId: 'mission-a',
  contractHash: 'c'.repeat(64), contextHash: 'd'.repeat(64),
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffHash: 'e'.repeat(64),
};

describe('automated review session registry', () => {
  it('accepts only an independent reviewer bound to the exact candidate', async () => {
    const registry = new AutomatedReviewSessionRegistry();
    const persist = vi.fn();
    const id = registry.open({
      missionId: 'mission-a', checkoutPath: '/candidate', risk: 'high', binding,
      author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
      persist,
    });
    expect(() => registry.submit(id, {
      id: 'author', sessionId: 'author-session', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, [])).toThrow(/author cannot review/i);
    registry.submit(id, {
      id: 'reviewer', sessionId: 'review-session', provider: 'claude',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, []);

    await expect(registry.wait(id, 100)).resolves.toMatchObject({ ready: true });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('fails immediately on a high finding and enforces critical quorum', async () => {
    const registry = new AutomatedReviewSessionRegistry();
    const blocked = registry.open({
      missionId: 'mission-a', checkoutPath: '/candidate', risk: 'critical', binding,
      author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
      persist: () => {},
    });
    registry.submit(blocked, {
      id: 'reviewer-a', sessionId: 'review-a', provider: 'claude',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, [{
      severity: 'high', category: 'correctness', file: 'src/a.ts', line: 1,
      criterionRefs: [], invariantRefs: [], evidence: 'Wrong branch condition.',
      recommendation: 'Correct the branch and add regression coverage.',
    }]);
    await expect(registry.wait(blocked, 100)).resolves.toMatchObject({ ready: false });

    const quorum = registry.open({
      missionId: 'mission-a', checkoutPath: '/candidate-2', risk: 'critical', binding,
      author: { id: 'author', sessionId: 'author-session', provider: 'codex' },
      persist: () => {},
    });
    registry.submit(quorum, {
      id: 'reviewer-a', sessionId: 'review-a', provider: 'claude',
      missionId: 'mission-a', checkoutPath: '/candidate-2',
    }, []);
    const waiting = registry.wait(quorum, 500);
    registry.submit(quorum, {
      id: 'reviewer-b', sessionId: 'review-b', provider: 'agy',
      missionId: 'mission-a', checkoutPath: '/candidate-2',
    }, []);
    await expect(waiting).resolves.toMatchObject({ ready: true });
  });

  it('prevents any co-author provider from entering a high-risk review council', () => {
    const registry = new AutomatedReviewSessionRegistry();
    const id = registry.open({
      missionId: 'mission-a', checkoutPath: '/candidate', risk: 'high', binding,
      author: { id: 'author-a', sessionId: 'author-a-session', provider: 'codex' },
      additionalAuthors: [
        { id: 'author-b', sessionId: 'author-b-session', provider: 'claude' },
      ],
      persist: () => {},
    });
    expect(() => registry.submit(id, {
      id: 'reviewer', sessionId: 'review-session', provider: 'claude',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, [])).toThrow(/every code author/i);
  });
});
