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
  scope: ['create-review'],
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
    const gh = createGitHubForgeProvider({ token: 't', http: { postJson } });
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
    const gh = createGitHubForgeProvider({ token: 't', http: { postJson } });
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
});

describe('GitLab forge provider', () => {
  it('creates MR when authorized', async () => {
    const postJson = vi.fn(async () => ({
      status: 201,
      body: { web_url: 'https://gitlab.com/o/r/-/merge_requests/3', iid: 3 },
    }));
    const gl = createGitLabForgeProvider({ token: 't', http: { postJson } });
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
