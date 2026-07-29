import { describe, expect, it, vi } from 'vitest';
import { AutomatedReviewSessionRegistry } from './automated-review-session';
import { testProjectScope } from '../orch/__tests__/scope-fixture';

const binding = {
  projectId: 'project-a', checkoutId: 'checkout-a', missionId: 'mission-a',
  contractHash: 'c'.repeat(64), contextHash: 'd'.repeat(64),
  baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), diffHash: 'e'.repeat(64),
};

describe('automated review session registry', () => {
  it('attaches the Main-owned sealed plan binding to pre-execution reports', () => {
    const registry = new AutomatedReviewSessionRegistry();
    const persist = vi.fn();
    const preExecutionPlanBinding = {
      intentVersion: 3,
      planHash: 'f'.repeat(64),
    };
    const id = registry.open({
      missionId: 'mission-a',
      checkoutPath: '/candidate',
      risk: 'high',
      binding,
      author: {
        id: 'author',
        sessionId: 'author-session',
        provider: 'codex',
      },
      reviewPurpose: 'pre-execution',
      evaluatorVersion: 'pre-execution-plan-v2',
      preExecutionPlanBinding,
      persist,
    });

    const report = registry.submit(id, {
      id: 'reviewer',
      sessionId: 'review-session',
      provider: 'claude',
      missionId: 'mission-a',
      checkoutPath: '/candidate',
    }, []);

    expect(report.preExecutionPlanBinding).toEqual(preExecutionPlanBinding);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ preExecutionPlanBinding }),
    );
  });

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
    expect(() => registry.submit(id, {
      id: 'reviewer-alias', sessionId: 'author-session', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, [])).toThrow(/author cannot review/i);
    registry.submit(id, {
      id: 'reviewer', sessionId: 'review-session', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, []);
    expect(() => registry.submit(id, {
      id: 'reviewer-replay', sessionId: 'review-session', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, [])).toThrow(/independent reviewer sessions/i);

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
      id: 'reviewer-a', sessionId: 'review-a', provider: 'codex',
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
      id: 'reviewer-a', sessionId: 'review-a', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate-2',
    }, []);
    const waiting = registry.wait(quorum, 500);
    registry.submit(quorum, {
      id: 'reviewer-b', sessionId: 'review-b', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate-2',
    }, []);
    await expect(waiting).resolves.toMatchObject({ ready: true });
  });

  it('waits only for critical quorum and resolves medium divergence as advisory', async () => {
    const registry = new AutomatedReviewSessionRegistry();
    const id = registry.open({
      missionId: 'mission-a',
      checkoutPath: '/candidate',
      risk: 'critical',
      binding,
      author: {
        id: 'author',
        sessionId: 'author-session',
        provider: 'codex',
      },
      persist: () => {},
    });
    const waiting = registry.wait(id, 10 * 60_000);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });

    registry.submit(id, {
      id: 'reviewer-a',
      sessionId: 'review-a',
      provider: 'codex',
      missionId: 'mission-a',
      checkoutPath: '/candidate',
    }, [{
      severity: 'medium',
      category: 'correctness',
      file: 'src/a.ts',
      line: 1,
      criterionRefs: [],
      invariantRefs: [],
      evidence: 'The helper could be split for readability.',
      recommendation: 'Consider extracting the parsing branch.',
    }]);
    await Promise.resolve();
    expect(settled).toBe(false);

    registry.submit(id, {
      id: 'reviewer-b',
      sessionId: 'review-b',
      provider: 'claude',
      missionId: 'mission-a',
      checkoutPath: '/candidate',
    }, []);

    await expect(waiting).resolves.toMatchObject({
      ready: true,
      gate: {
        ready: true,
        reason: 'ready',
        blockingFindingCount: 0,
        reportCount: 2,
      },
    });
  });

  it('seals the resolved report snapshot against a late reviewer submission', async () => {
    const registry = new AutomatedReviewSessionRegistry();
    const persist = vi.fn();
    const id = registry.open({
      missionId: 'mission-a',
      checkoutPath: '/candidate',
      risk: 'high',
      binding,
      author: {
        id: 'author',
        sessionId: 'author-session',
        provider: 'codex',
      },
      persist,
    });
    const first = registry.submit(id, {
      id: 'reviewer-a',
      sessionId: 'review-a',
      provider: 'codex',
      missionId: 'mission-a',
      checkoutPath: '/candidate',
    }, []);
    const resolved = await registry.wait(id, 100);

    expect(() =>
      registry.submit(id, {
        id: 'reviewer-b',
        sessionId: 'review-b',
        provider: 'claude',
        missionId: 'mission-a',
        checkoutPath: '/candidate',
      }, []),
    ).toThrow(/review session is sealed/i);

    await expect(registry.wait(id, 100)).resolves.toBe(resolved);
    expect(resolved.reports.map((report) => report.reviewId)).toEqual([
      first.reviewId,
    ]);
    expect(persist).toHaveBeenCalledOnce();
  });

  it('blocks every co-author identity/session while allowing a shared provider', async () => {
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
      id: 'reviewer-alias', sessionId: 'author-b-session', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, [])).toThrow(/author cannot review/i);
    registry.submit(id, {
      id: 'reviewer', sessionId: 'review-session', provider: 'codex',
      missionId: 'mission-a', checkoutPath: '/candidate',
    }, []);
    await expect(registry.wait(id, 100)).resolves.toMatchObject({ ready: true });
  });

  it('cancels a pending wait immediately when review authority is revoked', async () => {
    const registry = new AutomatedReviewSessionRegistry();
    const id = registry.open({
      missionId: 'mission-a',
      checkoutPath: '/candidate',
      risk: 'medium',
      binding,
      author: {
        id: 'author',
        sessionId: 'author-session',
        provider: 'codex',
      },
      persist: () => {},
    });
    const controller = new AbortController();
    const waiting = registry.wait(id, 10 * 60_000, controller.signal);

    controller.abort(new Error('review authority revoked'));

    await expect(waiting).rejects.toThrow(/authority revoked/i);
    registry.close(id);
  });

  it('detects callback-only authority revocation without waiting for the review timeout', async () => {
    const registry = new AutomatedReviewSessionRegistry();
    const id = registry.open({
      missionId: 'mission-a',
      checkoutPath: '/candidate',
      risk: 'medium',
      binding,
      author: {
        id: 'author',
        sessionId: 'author-session',
        provider: 'codex',
      },
      persist: () => {},
    });
    let revoked = false;
    const waiting = registry.wait(id, 10 * 60_000, undefined, () => {
      if (revoked) throw new Error('review authority revoked');
    });

    revoked = true;

    await expect(waiting).rejects.toThrow(/authority revoked/i);
    registry.close(id);
  });

  it('binds the rendered surface to the exact mission checkout and active session', () => {
    const registry = new AutomatedReviewSessionRegistry();
    const scope = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: '/workspace',
    });
    const executionScope = { ...scope, rootRealPath: '/candidate' };
    const id = registry.open({
      missionId: 'mission-a',
      checkoutPath: '/candidate',
      requiresDesignInspection: true,
      risk: 'medium',
      binding,
      author: {
        id: 'author',
        sessionId: 'author-session',
        provider: 'codex',
      },
      persist: () => {},
    });
    const surface = {
      paneId: 'browser-review',
      previewId: 'preview-review',
      url: 'http://127.0.0.1:1234/',
      missionId: 'mission-a',
      scope,
      executionScope,
    };

    registry.bindDesignSurface(id, surface);
    expect(
      registry.findActiveDesignSurface({
        reviewSessionId: id,
        paneId: 'browser-review',
        missionId: 'mission-a',
        scope,
        executionScope,
      }),
    ).toMatchObject({ paneId: 'browser-review', previewId: 'preview-review' });
    expect(
      registry.findActiveDesignSurface({
        reviewSessionId: id,
        paneId: 'browser-other',
        missionId: 'mission-a',
        scope,
        executionScope,
      }),
    ).toBeNull();
    expect(() =>
      registry.bindDesignSurface(id, {
        ...surface,
        paneId: 'browser-other',
      }),
    ).toThrow(/already bound/i);

    registry.close(id);
    expect(
      registry.findActiveDesignSurface({
        reviewSessionId: id,
        paneId: 'browser-review',
        missionId: 'mission-a',
        scope,
        executionScope,
      }),
    ).toBeNull();
  });

  it('requires read and screenshot from each physical reviewer in a design quorum', async () => {
    const registry = new AutomatedReviewSessionRegistry();
    const scope = testProjectScope({
      projectId: 'project-a',
      checkoutId: 'checkout-a',
      rootRealPath: '/workspace',
    });
    const id = registry.open({
      missionId: 'mission-a',
      checkoutPath: '/candidate',
      requiresDesignInspection: true,
      risk: 'critical',
      binding,
      author: {
        id: 'author',
        sessionId: 'author-session',
        provider: 'codex',
      },
      persist: () => {},
    });
    registry.bindDesignSurface(id, {
      paneId: 'browser-review',
      previewId: 'preview-review',
      url: 'http://127.0.0.1:1234/',
      missionId: 'mission-a',
      scope,
      executionScope: { ...scope, rootRealPath: '/candidate' },
    });
    registry.recordDesignInspection(
      id,
      'review-session-a',
      'browser-review',
      'read',
    );
    registry.recordDesignInspection(
      id,
      'review-session-a',
      'browser-review',
      'screenshot',
    );
    registry.submit(id, {
      id: 'reviewer-a',
      sessionId: 'review-session-a',
      provider: 'claude',
      missionId: 'mission-a',
      checkoutPath: '/candidate',
    }, []);

    expect(() =>
      registry.submit(id, {
        id: 'reviewer-b',
        sessionId: 'review-session-b',
        provider: 'agy',
        missionId: 'mission-a',
        checkoutPath: '/candidate',
      }, []),
    ).toThrow(/this reviewer session.*read and screenshot/i);

    registry.recordDesignInspection(
      id,
      'review-session-b',
      'browser-review',
      'read',
    );
    registry.recordDesignInspection(
      id,
      'review-session-b',
      'browser-review',
      'screenshot',
    );
    registry.submit(id, {
      id: 'reviewer-b',
      sessionId: 'review-session-b',
      provider: 'agy',
      missionId: 'mission-a',
      checkoutPath: '/candidate',
    }, []);
    await expect(registry.wait(id, 100)).resolves.toMatchObject({ ready: true });
  });
});
