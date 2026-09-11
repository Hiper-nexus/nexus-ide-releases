// Adapted from stablyai/orca @ f352b6b08d9028ba8b577d6ac8a8247c2a6c9c92
// Copyright (c) 2026 Lovecast Inc. — MIT License
// See third_party/licenses/orca-MIT.txt. Nexus changes: Nexus authz/audit +
// GH/GL adapter unit tests (not the full ORCA hosted-review multi-forge suite).
// Resync 2026-09-11: upstream's test at this pin mocks the hosted-review
// monolith Nexus does not import; no shared assertions to port.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertForgeWriteAuthorized,
  clearForgeAuditLog,
  getForgeAuditLog,
  type ForgeAuthorization,
} from './forge-provider';
import { createGitHubForgeProvider } from './github-forge-provider';
import { createGitLabForgeProvider } from './gitlab-forge-provider';
import { createDisabledForgeStub, isForgeEnabled } from './forge-flags';

afterEach(() => {
  clearForgeAuditLog();
});

const auth: ForgeAuthorization = {
  grantedBy: 'user:test',
  grantedAt: Date.now(),
  scope: ['create-review', 'enqueue-merge-queue', 'auto-merge'],
  reason: 'manual PR from UI',
};

describe('forge authorization', () => {
  it('requires grant metadata and matching scope', () => {
    expect(assertForgeWriteAuthorized(auth, 'create-review')).toBe(true);
    expect(
      assertForgeWriteAuthorized({ ...auth, scope: ['comment'] }, 'create-review'),
    ).toBe(false);
    expect(
      assertForgeWriteAuthorized({ ...auth, grantedBy: '' }, 'create-review'),
    ).toBe(false);
  });

  it('rejects an expired grant and honors a still-valid expiry', () => {
    const expiring = { ...auth, grantedAt: 1_000, expiresAt: 2_000 };
    expect(assertForgeWriteAuthorized(expiring, 'create-review', 1_500)).toBe(true);
    expect(assertForgeWriteAuthorized(expiring, 'create-review', 2_001)).toBe(false);
  });
});

describe('GitHub forge provider', () => {
  it('refuses createReview without authorization and audits', async () => {
    const postJson = vi.fn();
    const getJson = vi.fn();
    const gh = createGitHubForgeProvider({ token: 't', http: { postJson, getJson } });
    const result = await gh.createReview(
      { owner: 'o', name: 'r', host: 'github.com' },
      {
        title: 't',
        body: 'b',
        sourceBranch: 'feat',
        targetBranch: 'main',
      },
      { grantedBy: '', grantedAt: 0, scope: [], reason: '' },
    );
    expect(result).toEqual({ ok: false, reason: 'unauthorized' });
    expect(postJson).not.toHaveBeenCalled();
    expect(getForgeAuditLog()[0]?.authorized).toBe(false);
  });

  it('creates PR when authorized and logs audit', async () => {
    const postJson = vi.fn(async () => ({
      status: 201,
      body: { html_url: 'https://github.com/o/r/pull/9', number: 9 },
    }));
    const getJson = vi.fn();
    const gh = createGitHubForgeProvider({ token: 't', http: { postJson, getJson } });
    const result = await gh.createReview(
      { owner: 'o', name: 'r', host: 'github.com' },
      {
        title: 't',
        body: 'b',
        sourceBranch: 'feat',
        targetBranch: 'main',
      },
      auth,
    );
    expect(result).toEqual({
      ok: true,
      url: 'https://github.com/o/r/pull/9',
      number: 9,
    });
    expect(postJson).toHaveBeenCalledOnce();
    expect(getForgeAuditLog()[0]).toMatchObject({
      provider: 'github',
      authorized: true,
      actor: 'user:test',
    });
  });

  it('gets PR for branch via mock HTTP', async () => {
    const getJson = vi.fn(
      async (_url: string, _headers: Record<string, string>) => ({
        status: 200,
        body: [
          {
            number: 12,
            html_url: 'https://github.com/o/r/pull/12',
            title: 'feat',
            state: 'open',
            head: { ref: 'feat' },
            base: { ref: 'main' },
          },
        ],
      }),
    );
    const postJson = vi.fn(
      async (
        _url: string,
        _body: unknown,
        _headers: Record<string, string>,
      ) => ({ status: 500, body: {} }),
    );
    const gh = createGitHubForgeProvider({ token: 't', http: { postJson, getJson } });
    const result = await gh.getReviewForBranch!(
      { owner: 'o', name: 'r', host: 'github.com' },
      'feat',
    );
    expect(result).toEqual({
      ok: true,
      review: {
        number: 12,
        url: 'https://github.com/o/r/pull/12',
        title: 'feat',
        state: 'open',
        sourceBranch: 'feat',
        targetBranch: 'main',
      },
    });
    expect(getJson).toHaveBeenCalledOnce();
    expect(getJson.mock.calls[0]![0]).toContain('head=');
  });

  it('refuses enqueue without enqueue-merge-queue scope', async () => {
    const gh = createGitHubForgeProvider({
      token: 't',
      http: { postJson: vi.fn(), getJson: vi.fn() },
    });
    const result = await gh.enqueueMergeQueue!(
      { owner: 'o', name: 'r', host: 'github.com' },
      { number: 1 },
      { grantedBy: 'user:test', grantedAt: Date.now(), scope: ['create-review'], reason: 'pr' },
    );
    expect(result).toEqual({ ok: false, reason: 'unauthorized' });
  });
});

describe('GitLab forge provider', () => {
  it('creates MR when authorized', async () => {
    const postJson = vi.fn(async () => ({
      status: 201,
      body: { web_url: 'https://gitlab.com/o/r/-/merge_requests/3', iid: 3 },
    }));
    const getJson = vi.fn();
    const gl = createGitLabForgeProvider({ token: 't', http: { postJson, getJson } });
    const result = await gl.createReview(
      { owner: 'o', name: 'r', host: 'gitlab.com' },
      {
        title: 't',
        body: 'b',
        sourceBranch: 'feat',
        targetBranch: 'main',
      },
      auth,
    );
    expect(result).toEqual({
      ok: true,
      url: 'https://gitlab.com/o/r/-/merge_requests/3',
      number: 3,
    });
  });

  it('gets MR for branch via mock HTTP', async () => {
    const getJson = vi.fn(async () => ({
      status: 200,
      body: [
        {
          iid: 7,
          web_url: 'https://gitlab.com/o/r/-/merge_requests/7',
          title: 'feat',
          state: 'opened',
          source_branch: 'feat',
          target_branch: 'main',
        },
      ],
    }));
    const postJson = vi.fn();
    const gl = createGitLabForgeProvider({ token: 't', http: { postJson, getJson } });
    const result = await gl.getReviewForBranch!(
      { owner: 'o', name: 'r', host: 'gitlab.com' },
      'feat',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.review?.number).toBe(7);
      expect(result.review?.sourceBranch).toBe('feat');
    }
  });
});

describe('forge flags', () => {
  it('keeps bitbucket/azure/gitea disabled by default', () => {
    expect(isForgeEnabled('github', {})).toBe(true);
    expect(isForgeEnabled('gitlab', {})).toBe(true);
    expect(isForgeEnabled('bitbucket', {})).toBe(false);
    expect(isForgeEnabled('gitea', {})).toBe(false);
    expect(createDisabledForgeStub('bitbucket').enabled).toBe(false);
  });
});
