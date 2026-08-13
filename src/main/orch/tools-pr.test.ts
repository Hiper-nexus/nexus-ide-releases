import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPrTools } from './tools-pr';
import { testProjectScope } from './__tests__/scope-fixture';
import type { GitHubHttp } from '../source-control/github-forge-provider';

const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pr-tools-'));

function fakeCtx() {
  return {
    token: 'test',
    label: 'test',
    role: 'user' as const,
    allowedTools: null as string[] | null,
    allowedSkills: null as string[] | null,
    stopAttempts: 0,
    handoffSubmitted: false,
    scope: testProjectScope({ rootRealPath: fs.realpathSync(wsDir) }),
  };
}

function restPr() {
  return {
    number: 9,
    node_id: 'PR_kwDO9',
    html_url: 'https://github.com/acme/app/pull/9',
    title: 'feat',
    state: 'open',
    draft: false,
    mergeable: true,
    mergeable_state: 'blocked',
    auto_merge: null,
    head: { ref: 'feat', sha: 'abc' },
    base: { ref: 'main' },
  };
}

function graphqlQueue(required: boolean) {
  return {
    data: {
      repository: {
        autoMergeAllowed: true,
        mergeQueue: required ? { id: 'Q' } : null,
        ref: { rules: { nodes: [] } },
      },
    },
  };
}

describe('tools-pr', () => {
  beforeAll(() => {
    fs.mkdirSync(wsDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
  });

  it('exposes inspect, enqueue and auto-merge', () => {
    const names = buildPrTools().map((tool) => tool.name);
    expect(names).toEqual(['nexus_pr_inspect', 'nexus_pr_enqueue', 'nexus_pr_auto_merge']);
  });

  it('inspects the branch PR and warns when merge queue is required', async () => {
    const http: GitHubHttp = {
      getJson: vi.fn(async (url: string) => {
        if (url.includes('/pulls?')) {
          return { status: 200, body: [restPr()] };
        }
        return { status: 200, body: restPr() };
      }),
      postJson: vi.fn(async () => ({ status: 200, body: graphqlQueue(true) })),
    };
    const inspect = buildPrTools({
      token: () => 'tok',
      remoteUrl: () => 'https://github.com/acme/app.git',
      currentBranch: () => 'feat',
      http,
    }).find((tool) => tool.name === 'nexus_pr_inspect')!;
    const result = (await inspect.handler({}, fakeCtx())) as {
      ok: boolean;
      review?: { mergeQueueRequired?: boolean };
      note?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.review?.mergeQueueRequired).toBe(true);
    expect(result.note).toMatch(/nexus_pr_enqueue/);
  });

  it('enqueues with Merge when ready on a queue branch', async () => {
    const postJson = vi.fn(async (url: string, body: unknown) => {
      if (String(url).endsWith('/graphql')) {
        const query = String((body as { query?: string }).query ?? '');
        if (query.includes('mergeQueue')) {
          return { status: 200, body: graphqlQueue(true) };
        }
        return {
          status: 200,
          body: { data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_kwDO9' } } } },
        };
      }
      return { status: 500, body: {} };
    });
    const http: GitHubHttp = {
      getJson: vi.fn(async (url: string) => {
        if (url.includes('/pulls?')) return { status: 200, body: [restPr()] };
        return { status: 200, body: restPr() };
      }),
      postJson,
    };
    const enqueue = buildPrTools({
      token: () => 'tok',
      remoteUrl: () => 'https://github.com/acme/app.git',
      currentBranch: () => 'feat',
      http,
    }).find((tool) => tool.name === 'nexus_pr_enqueue')!;
    const result = await enqueue.handler({}, fakeCtx());
    expect(result).toEqual({ ok: true, action: 'when-ready', number: 9 });
  });
});
