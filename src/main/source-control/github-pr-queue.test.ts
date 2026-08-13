import { describe, expect, it, vi } from 'vitest';
import {
  enqueueGitHubPullRequest,
  inspectGitHubPullRequest,
} from './github-pr-queue';
import type { GitHubHttp } from './github-forge-provider';

const repo = { owner: 'acme', name: 'app', host: 'github.com' };

function restPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    node_id: 'PR_kwDO12',
    html_url: 'https://github.com/acme/app/pull/12',
    title: 'feat',
    state: 'open',
    draft: false,
    mergeable: true,
    mergeable_state: 'blocked',
    auto_merge: null,
    head: { ref: 'feat', sha: 'abc' },
    base: { ref: 'main' },
    ...overrides,
  };
}

function graphqlQueue(required: boolean) {
  return {
    data: {
      repository: {
        autoMergeAllowed: true,
        mergeQueue: required ? { id: 'Q1' } : null,
        ref: { rules: { nodes: [] } },
      },
    },
  };
}

describe('inspectGitHubPullRequest', () => {
  it('combines REST PR with GraphQL merge-queue metadata', async () => {
    const http: GitHubHttp = {
      getJson: vi.fn(async () => ({ status: 200, body: restPr() })),
      postJson: vi.fn(async () => ({ status: 200, body: graphqlQueue(true) })),
    };
    const result = await inspectGitHubPullRequest(
      { token: 't', http, apiBase: 'https://api.github.com' },
      repo,
      12,
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.review) return;
    expect(result.review).toMatchObject({
      number: 12,
      mergeQueueRequired: true,
      autoMergeAllowed: true,
      mergeStateStatus: 'BLOCKED',
      stacked: false,
    });
  });
});

describe('enqueueGitHubPullRequest', () => {
  it('enables auto-merge (when-ready) on a merge-queue branch', async () => {
    const postJson = vi.fn(async (url: string, body: unknown) => {
      if (String(url).endsWith('/graphql')) {
        const query = String((body as { query?: string }).query ?? '');
        if (query.includes('mergeQueue')) {
          return { status: 200, body: graphqlQueue(true) };
        }
        expect(query).toContain('enablePullRequestAutoMerge');
        return { status: 200, body: { data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_kwDO12' } } } } };
      }
      return { status: 500, body: {} };
    });
    const http: GitHubHttp = {
      getJson: vi.fn(async () => ({ status: 200, body: restPr() })),
      postJson,
    };
    const result = await enqueueGitHubPullRequest(
      { token: 't', http, apiBase: 'https://api.github.com' },
      repo,
      { number: 12 },
    );
    expect(result).toEqual({ ok: true, action: 'when-ready' });
  });

  it('uses enqueuePullRequest when mode is now', async () => {
    const postJson = vi.fn(async (url: string, body: unknown) => {
      if (String(url).endsWith('/graphql')) {
        const query = String((body as { query?: string }).query ?? '');
        if (query.includes('mergeQueue')) {
          return { status: 200, body: graphqlQueue(true) };
        }
        expect(query).toContain('enqueuePullRequest');
        return { status: 200, body: { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E1' } } } } };
      }
      return { status: 500, body: {} };
    });
    const http: GitHubHttp = {
      getJson: vi.fn(async () => ({ status: 200, body: restPr() })),
      postJson,
    };
    const result = await enqueueGitHubPullRequest(
      { token: 't', http, apiBase: 'https://api.github.com' },
      repo,
      { number: 12, mode: 'now' },
    );
    expect(result).toEqual({ ok: true, action: 'enqueued' });
  });

  it('routes a stacked PR through merge-async PUT', async () => {
    const putJson = vi.fn(
      async (_url: string, _body: unknown, _headers: Record<string, string>) => ({
        status: 200,
        body: { status: 'enqueued' },
      }),
    );
    const http: GitHubHttp = {
      getJson: vi.fn(async () => ({ status: 200, body: restPr({ stack: { baseRefName: 'main' } }) })),
      postJson: vi.fn(async () => ({ status: 200, body: graphqlQueue(true) })),
      putJson,
    };
    const result = await enqueueGitHubPullRequest(
      { token: 't', http, apiBase: 'https://api.github.com' },
      repo,
      { number: 12 },
    );
    expect(result).toEqual({ ok: true, action: 'stack' });
    expect(putJson).toHaveBeenCalledOnce();
    expect(String(putJson.mock.calls[0]?.[0])).toContain('/merge-async');
    expect(putJson.mock.calls[0]?.[1]).toMatchObject({ merge_action: 'merge_queue' });
  });

  it('refuses immediate enqueue when the base has no merge queue', async () => {
    const http: GitHubHttp = {
      getJson: vi.fn(async () => ({ status: 200, body: restPr() })),
      postJson: vi.fn(async () => ({ status: 200, body: graphqlQueue(false) })),
    };
    const result = await enqueueGitHubPullRequest(
      { token: 't', http, apiBase: 'https://api.github.com' },
      repo,
      { number: 12, mode: 'now' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/does not use GitHub merge queue/);
  });
});
