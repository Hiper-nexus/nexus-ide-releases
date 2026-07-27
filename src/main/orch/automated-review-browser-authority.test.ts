import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneAuthzInfo } from './pane-authz';

const stubs = vi.hoisted(() => ({
  pane: null as PaneAuthzInfo | null,
  previewActive: true,
}));

vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: vi.fn(() => stubs.pane),
}));
vi.mock('./preview-server', () => ({
  isRunningPreviewDescriptorForScope: vi.fn(
    () => stubs.previewActive,
  ),
}));

import { automatedReviewSessions } from '../context/automated-review-session';
import {
  automatedReviewSkills,
  automatedReviewTools,
} from './prevc-reviewer-profile';
import { resolveAutomatedReviewBrowserAuthority } from './automated-review-browser-authority';
import { testProjectScope } from './__tests__/scope-fixture';
import type { AgentGateContext } from './gate';

const scope = testProjectScope({
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace',
});
const executionScope = Object.freeze({
  ...scope,
  rootRealPath: '/candidate',
});
const binding = {
  projectId: scope.projectId,
  checkoutId: scope.checkoutId,
  missionId: 'mission-a',
  contractHash: 'c'.repeat(64),
  contextHash: 'd'.repeat(64),
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  diffHash: 'e'.repeat(64),
};

function activeFixture() {
  const reviewSessionId = automatedReviewSessions.open({
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
  automatedReviewSessions.bindDesignSurface(reviewSessionId, {
    paneId: 'browser-review',
    previewId: 'preview-review',
    url: 'http://127.0.0.1:1234/',
    missionId: 'mission-a',
    scope,
    executionScope,
  });
  stubs.pane = {
    paneId: 'browser-review',
    sessionId: null,
    kind: 'browser',
    missionId: 'mission-a',
    scope,
  };
  const suffix = reviewSessionId.replaceAll('-', '').slice(0, 12);
  const ctx: AgentGateContext = {
    token: 'token',
    label: 'reviewer',
    role: 'worker',
    sessionId: 'reviewer-session',
    missionId: 'mission-a',
    agentName: `reviewer-claude-1-${suffix}`,
    providerId: 'claude',
    internalPrevcReviewerAuthority: {
      kind: 'automated-review',
      reviewSessionId,
      issuedFor: 'pre-execution',
    },
    readOnly: true,
    scope,
    executionScope,
    allowedTools: [...automatedReviewTools(true)],
    allowedSkills: [...automatedReviewSkills(true)],
    stopAttempts: 0,
    handoffSubmitted: false,
  };
  return { reviewSessionId, ctx };
}

describe('automated review browser authority', () => {
  beforeEach(() => {
    automatedReviewSessions.reset();
    stubs.previewActive = true;
    stubs.pane = null;
  });
  afterEach(() => automatedReviewSessions.reset());

  it('resolves only an active exact design profile bound to the physical pane', () => {
    const { reviewSessionId, ctx } = activeFixture();
    expect(
      resolveAutomatedReviewBrowserAuthority(ctx, 'browser-review', 'read'),
    ).toMatchObject({
      reviewSessionId,
      reviewerSessionId: 'reviewer-session',
      surface: { paneId: 'browser-review' },
    });

    expect(
      resolveAutomatedReviewBrowserAuthority(
        { ...ctx, allowedSkills: [...automatedReviewSkills(false)] },
        'browser-review',
        'read',
      ),
    ).toBeNull();
    expect(
      resolveAutomatedReviewBrowserAuthority(
        { ...ctx, sessionId: undefined },
        'browser-review',
        'read',
      ),
    ).toBeNull();
    expect(
      resolveAutomatedReviewBrowserAuthority(ctx, 'browser-review', 'write'),
    ).toBeNull();
  });

  it('rejects pane substitution, stopped previews and expired review sessions', () => {
    const { reviewSessionId, ctx } = activeFixture();
    expect(
      resolveAutomatedReviewBrowserAuthority(ctx, 'browser-other', 'read'),
    ).toBeNull();

    stubs.previewActive = false;
    expect(
      resolveAutomatedReviewBrowserAuthority(ctx, 'browser-review', 'read'),
    ).toBeNull();

    stubs.previewActive = true;
    automatedReviewSessions.close(reviewSessionId);
    expect(
      resolveAutomatedReviewBrowserAuthority(ctx, 'browser-review', 'read'),
    ).toBeNull();
  });

  it('rejects a browser pane from another mission or checkout', () => {
    const { ctx } = activeFixture();
    stubs.pane = {
      ...stubs.pane!,
      missionId: 'mission-b',
    };
    expect(
      resolveAutomatedReviewBrowserAuthority(ctx, 'browser-review', 'read'),
    ).toBeNull();

    stubs.pane = {
      ...stubs.pane!,
      missionId: 'mission-a',
      scope: testProjectScope({
        projectId: 'project-a',
        checkoutId: 'checkout-b',
        rootRealPath: '/workspace',
      }),
    };
    expect(
      resolveAutomatedReviewBrowserAuthority(ctx, 'browser-review', 'read'),
    ).toBeNull();
  });
});
