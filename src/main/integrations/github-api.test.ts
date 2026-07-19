import { describe, expect, it, vi } from 'vitest';
import { listGithubIssues, listGithubPulls, createGithubPr } from './github-api';

describe('github-api', () => {
  it('lists issues excluding pull_request entries', async () => {
    const http = {
      getJson: vi.fn(async () => ({
        status: 200,
        body: [
          { number: 1, title: 'Bug', html_url: 'https://x/1', state: 'open', labels: [] },
          {
            number: 2,
            title: 'PR',
            html_url: 'https://x/2',
            state: 'open',
            pull_request: {},
            labels: [],
          },
        ],
      })),
      postJson: vi.fn(),
    };
    const r = await listGithubIssues('tok', 'o', 'r', { limit: 10, state: 'open' }, http);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues).toHaveLength(1);
      expect(r.issues[0]?.title).toBe('Bug');
    }
  });

  it('creates PR via forge provider', async () => {
    const http = {
      getJson: vi.fn(),
      postJson: vi.fn(async () => ({
        status: 201,
        body: { html_url: 'https://github.com/o/r/pull/9', number: 9 },
      })),
    };
    const r = await createGithubPr(
      'tok',
      'o',
      'r',
      {
        title: 'feat',
        body: '',
        sourceBranch: 'feat',
        targetBranch: 'main',
      },
      http,
    );
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/9', number: 9 });
  });

  it('maps a SAML 403 into a typed sso_required error (never a silent empty list)', async () => {
    const http = {
      getJson: vi.fn(async () => ({
        status: 403,
        body: { message: 'Resource protected by organization SAML enforcement.' },
        headers: {
          'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=1',
        },
      })),
      postJson: vi.fn(),
    };
    const r = await listGithubPulls('tok', 'acme', 'repo', http);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.githubError).toEqual({
      type: 'sso_required',
      host: 'github.com',
      status: 403,
      ssoUrl: 'https://github.com/orgs/acme/sso?authorization_request=1',
      message: 'Resource protected by organization SAML enforcement.',
    });
    expect(r.error).toContain('Authorize SSO');
  });

  it('maps a transport throw into host_unreachable', async () => {
    const http = {
      getJson: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
      postJson: vi.fn(),
    };
    const r = await listGithubIssues('tok', 'o', 'r', { limit: 5, state: 'open' }, http);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.githubError).toEqual({
      type: 'host_unreachable',
      host: 'github.com',
      reason: 'fetch failed',
    });
  });

  it('create PR failure carries the typed error from the forge provider', async () => {
    const http = {
      getJson: vi.fn(),
      postJson: vi.fn(async () => ({
        status: 404,
        body: { message: 'Not Found' },
        headers: {},
      })),
    };
    const r = await createGithubPr(
      'tok',
      'o',
      'r',
      { title: 't', body: '', sourceBranch: 'a', targetBranch: 'main' },
      http,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.githubError?.type).toBe('not_found');
    expect(r.error).toContain('does not have access');
  });
});
