// Vendored from generalaction/emdash@c1af543 — Apache-2.0
// Source: apps/emdash-desktop/src/main/core/github/services/github-api-errors.test.ts
// See src/vendor/emdash/hooks/LICENSE.md. Nexus changes: upstream cases ported
// to the renamed Nexus wire tags (not_found_or_no_access → not_found,
// api_error → unknown); added account_host_mismatch constructor and
// githubApiErrorMessage formatter coverage.

import { describe, expect, it } from 'vitest';
import {
  classifyGitHubApiError,
  githubApiAccountHostMismatch,
  githubApiErrorMessage,
} from './github-api-errors';

describe('classifyGitHubApiError', () => {
  it('classifies 401 as auth required with host-specific guidance', () => {
    expect(
      classifyGitHubApiError(
        { status: 401 },
        { host: 'ghe.example.com', fallback: 'Unable to load GitHub data' }
      )
    ).toEqual({
      type: 'auth_required',
      host: 'ghe.example.com',
      status: 401,
      message:
        'GitHub Enterprise authentication required for ghe.example.com. Run: gh auth login --hostname ghe.example.com',
      hint: 'Run: gh auth login --hostname ghe.example.com',
    });
  });

  it('classifies 404 as not_found (repo missing or no access)', () => {
    expect(
      classifyGitHubApiError(
        { status: 404 },
        {
          host: 'github.com',
          nameWithOwner: 'acme/repo',
          fallback: 'Unable to load GitHub data',
        }
      )
    ).toEqual({
      type: 'not_found',
      host: 'github.com',
      nameWithOwner: 'acme/repo',
      status: 404,
      message:
        'acme/repo on github.com was not found, or the selected GitHub account does not have access.',
    });
  });

  it('classifies SSO-flavoured 403 responses as sso_required with the SSO url', () => {
    expect(
      classifyGitHubApiError(
        {
          status: 403,
          response: {
            headers: {
              'x-github-sso':
                'required; url=https://github.com/orgs/acme/sso?authorization_request=1',
            },
            data: { message: 'Resource protected by organization SAML enforcement.' },
          },
        },
        { host: 'github.com', fallback: 'Unable to load GitHub data' }
      )
    ).toEqual({
      type: 'sso_required',
      host: 'github.com',
      status: 403,
      ssoUrl: 'https://github.com/orgs/acme/sso?authorization_request=1',
      message: 'Resource protected by organization SAML enforcement.',
    });
  });

  it('classifies SSO by message when the SSO header is absent', () => {
    const result = classifyGitHubApiError(
      { status: 403, response: { data: { message: 'You must grant SAML single sign-on access' } } },
      { host: 'github.com', fallback: 'fallback' }
    );
    expect(result.type).toBe('sso_required');
    if (result.type === 'sso_required') {
      expect(result.ssoUrl).toBeUndefined();
    }
  });

  it('classifies rate limit 403 responses as rate_limited with resetAt', () => {
    expect(
      classifyGitHubApiError(
        {
          status: 403,
          response: {
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700000000' },
            data: { message: 'API rate limit exceeded.' },
          },
        },
        { host: 'github.com', fallback: 'Unable to load GitHub data' }
      )
    ).toEqual({
      type: 'rate_limited',
      host: 'github.com',
      status: 403,
      resetAt: '2023-11-14T22:13:20.000Z',
      message: 'API rate limit exceeded.',
    });
  });

  it('classifies 429 as rate_limited even without rate-limit headers', () => {
    const result = classifyGitHubApiError(
      { status: 429, response: { data: { message: 'Too many requests' } } },
      { host: 'github.com', fallback: 'fallback' }
    );
    expect(result).toMatchObject({ type: 'rate_limited', status: 429 });
  });

  it('classifies remaining 403 responses as forbidden', () => {
    expect(
      classifyGitHubApiError(
        { status: 403, response: { data: { message: 'Forbidden' } } },
        { host: 'github.com', fallback: 'Unable to load GitHub data' }
      )
    ).toEqual({
      type: 'forbidden',
      host: 'github.com',
      status: 403,
      message: 'Forbidden',
    });
  });

  it('classifies network failures as host_unreachable', () => {
    const error = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });

    expect(
      classifyGitHubApiError(error, {
        host: 'ghe.example.com',
        fallback: 'Unable to load GitHub data',
      })
    ).toEqual({
      type: 'host_unreachable',
      host: 'ghe.example.com',
      reason: 'connect timeout',
    });
  });

  it('classifies a bare fetch failure as host_unreachable', () => {
    expect(
      classifyGitHubApiError(new TypeError('fetch failed'), {
        host: 'github.com',
        fallback: 'Unable to load GitHub data',
      })
    ).toEqual({
      type: 'host_unreachable',
      host: 'github.com',
      reason: 'fetch failed',
    });
  });

  it('extracts GraphQL error messages for unknown errors', () => {
    expect(
      classifyGitHubApiError(
        {
          response: {
            data: {
              errors: [{ message: 'Something went wrong while executing your query.' }],
            },
          },
        },
        { host: 'github.com', fallback: 'Unable to load GitHub data' }
      )
    ).toEqual({
      type: 'unknown',
      message: 'Something went wrong while executing your query.',
    });
  });

  it('falls back to the context fallback for shapeless errors', () => {
    expect(
      classifyGitHubApiError('boom', { host: 'github.com', fallback: 'Nope' })
    ).toEqual({ type: 'unknown', message: 'Nope' });
  });
});

describe('githubApiAccountHostMismatch', () => {
  it('builds an actionable mismatch error', () => {
    expect(githubApiAccountHostMismatch('ghe.acme.com', 'github.com')).toEqual({
      type: 'account_host_mismatch',
      host: 'ghe.acme.com',
      accountHost: 'github.com',
      message:
        'The saved GitHub credential is for github.com, but this repository uses ghe.acme.com.',
      hint: 'Run: gh auth login --hostname ghe.acme.com',
    });
  });
});

describe('githubApiErrorMessage', () => {
  it('prefixes host_unreachable with the host', () => {
    expect(
      githubApiErrorMessage({ type: 'host_unreachable', host: 'github.com', reason: 'dns boom' })
    ).toBe('Unable to reach github.com: dns boom');
  });

  it('appends the SSO url when present', () => {
    expect(
      githubApiErrorMessage({
        type: 'sso_required',
        host: 'github.com',
        status: 403,
        ssoUrl: 'https://github.com/orgs/a/sso',
        message: 'SAML required.',
      })
    ).toBe('SAML required. Authorize SSO: https://github.com/orgs/a/sso');
  });

  it('appends the rate-limit reset timestamp when present', () => {
    expect(
      githubApiErrorMessage({
        type: 'rate_limited',
        host: 'github.com',
        status: 403,
        resetAt: '2023-11-14T22:13:20.000Z',
        message: 'API rate limit exceeded.',
      })
    ).toBe('API rate limit exceeded. (rate limit resets at 2023-11-14T22:13:20.000Z)');
  });

  it('returns the plain message for the remaining kinds', () => {
    expect(
      githubApiErrorMessage({ type: 'forbidden', host: 'github.com', status: 403, message: 'No.' })
    ).toBe('No.');
    expect(githubApiErrorMessage({ type: 'unknown', message: 'Nope' })).toBe('Nope');
  });
});
