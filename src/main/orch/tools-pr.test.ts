import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildPrTools, type PrToolDeps } from './tools-pr';
import { effectPolicyForTool, isToolAllowedForReadOnlyContext, requiresHumanConfirmationForTool } from './mcp-effect-policy';
import { validateToolArgs } from './mcp-args-validation';
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
    expect(names).toEqual(['nexus_pr_create', 'nexus_pr_inspect', 'nexus_pr_enqueue', 'nexus_pr_auto_merge']);
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


describe('nexus_pr_create', () => {
  beforeAll(() => fs.mkdirSync(wsDir, { recursive: true }));
  afterAll(() => fs.rmSync(wsDir, { recursive: true, force: true }));
  function setup(overrides: Partial<PrToolDeps> = {}) {
    const postJson = vi.fn<GitHubHttp['postJson']>(async () => ({ status: 201, body: restPr() }));
    const tool = buildPrTools({
      token: () => 'private-token',
      remoteUrl: () => 'git@github.com:acme/app.git',
      currentBranch: () => 'feat',
      defaultBranch: () => 'main',
      http: { getJson: vi.fn(), postJson },
      ...overrides,
    }).find((item) => item.name === 'nexus_pr_create');
    return { tool, postJson };
  }

  it('creates on an ordinary operator checkout with no mission or worktree', async () => {
    const { tool, postJson } = setup();
    expect(tool).toBeDefined();
    const result = await tool!.handler({ title: 'feat: tool', body: 'Summary\n\nTests' }, fakeCtx());
    expect(result).toEqual({ ok: true, url: 'https://github.com/acme/app/pull/9', number: 9 });
    expect(postJson).toHaveBeenCalledWith('https://api.github.com/repos/acme/app/pulls', {
      title: 'feat: tool', body: 'Summary\n\nTests', head: 'feat', base: 'main', draft: false,
    }, expect.objectContaining({ Authorization: 'Bearer private-token' }));
  });

  it('preserves literal body and explicit head/base/draft', async () => {
    const { tool, postJson } = setup();
    await tool!.handler({ title: 'Title', body: '`literal` $(no shell)\nline', head: 'release', base: 'develop', draft: true }, fakeCtx());
    expect(postJson.mock.calls[0]?.[1]).toEqual({ title: 'Title', body: '`literal` $(no shell)\nline', head: 'release', base: 'develop', draft: true });
  });

  it('supports valid Unicode branches in the origin repository', async () => {
    const { tool, postJson } = setup({ currentBranch: () => 'feat/correção' });
    await tool!.handler({ title: 'Correção', body: '', base: 'versão/estável' }, fakeCtx());
    expect(postJson.mock.calls[0]?.[1]).toMatchObject({ head: 'feat/correção', base: 'versão/estável' });
  });

  it('revalidates caller authority immediately before publication', async () => {
    const { tool, postJson } = setup();
    const assertCurrentAuthority = () => { throw new Error('session_authority_revoked'); };
    await expect(tool!.handler({ title: 'Title', body: '' }, fakeCtx(), { assertCurrentAuthority })).rejects.toThrow('session_authority_revoked');
    expect(postJson).not.toHaveBeenCalled();
  });

  it('returns actionable auth_needed without posting when the native gh session is absent', async () => {
    const { tool, postJson } = setup({ token: () => null });
    const result = await tool!.handler({ title: 'Title', body: '' }, fakeCtx());
    expect(result).toMatchObject({ ok: false, code: 'auth_needed', error: expect.stringContaining('gh auth login') });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('returns auth_needed for an expired GitHub credential', async () => {
    const { tool } = setup({ http: { getJson: vi.fn(), postJson: vi.fn(async () => ({ status: 401, body: { message: 'Bad credentials' } })) } });
    expect(await tool!.handler({ title: 'Title', body: '' }, fakeCtx())).toMatchObject({ ok: false, code: 'auth_needed' });
  });

  it.each([null, 'main'])('refuses detached HEAD or a PR into its own head (%s)', async (branch) => {
    const { tool, postJson } = setup({ currentBranch: () => branch });
    expect(await tool!.handler({ title: 'Title', body: '' }, fakeCtx())).toMatchObject({ ok: false });
    expect(postJson).not.toHaveBeenCalled();
  });

  it('does not send GitHub credentials to a different forge', async () => {
    const token = vi.fn(() => 'private-token');
    const { tool, postJson } = setup({ remoteUrl: () => 'https://gitlab.com/acme/app.git', token });
    expect(await tool!.handler({ title: 'Title', body: '' }, fakeCtx())).toMatchObject({ ok: false });
    expect(token).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
  });

  it('refuses publication from an isolated writer before any HTTP or git read', async () => {
    const remoteUrl = vi.fn();
    const { tool, postJson } = setup({ remoteUrl });
    const ctx = { ...fakeCtx(), role: 'worker' as const, executionScope: testProjectScope({ rootRealPath: '/other/worktree' }) };
    await expect(tool!.handler({ title: 'Title', body: '' }, ctx)).rejects.toThrow(/isolated_worktree/);
    expect(remoteUrl).not.toHaveBeenCalled();
    expect(postJson).not.toHaveBeenCalled();
  });

  it('refuses cwd outside the authoritative workspace', async () => {
    const { tool, postJson } = setup();
    await expect(tool!.handler({ title: 'Title', body: '', cwd: os.tmpdir() }, fakeCtx())).rejects.toThrow(/escapes workspace/);
    expect(postJson).not.toHaveBeenCalled();
  });

  it('reports API refusal rather than claiming a PR was created', async () => {
    const { tool } = setup({ http: { getJson: vi.fn(), postJson: vi.fn(async () => ({ status: 422, body: { message: 'No commits between main and feat' } })) } });
    expect(await tool!.handler({ title: 'Title', body: '' }, fakeCtx())).toMatchObject({ ok: false });
  });

  it('does not expose transport exception details or credential headers', async () => {
    const { tool } = setup({ http: { getJson: vi.fn(), postJson: vi.fn(async () => { throw new Error('Authorization: Bearer private-token'); }) } });
    const result = await tool!.handler({ title: 'Title', body: '' }, fakeCtx());
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('is an execution effect requiring policy confirmation and outside the Hardened read-only boundary', () => {
    expect(effectPolicyForTool('nexus_pr_create')).toBe('execution-effect');
    expect(requiresHumanConfirmationForTool('nexus_pr_create')).toBe(true);
    // F-1157: o predicado só vale para a lane que o Hardened confina.
    expect(isToolAllowedForReadOnlyContext('nexus_pr_create')).toBe(false);
  });

  it.each([
    { title: '', body: '' }, { title: '  ', body: '' }, { title: 'Title' },
    { title: 'Title', body: '', draft: 'yes' }, { title: 'Title', body: '', head: '--delete' },
    { title: 'Title', body: '', base: 'main:other' }, { title: 'Title', body: '', token: 'secret' },
    { title: 'Title', body: '', head: 'a@{b' }, { title: 'Title', body: '', head: 'a b' },
    { title: 'Title', body: '', head: 'HEAD' }, { title: 'Title', body: '', head: 'a.lock/b' },
    { title: 'Title', body: '', head: '.hidden/a' }, { title: 'Title', body: '', head: 'a?' },
    { title: 'Title', body: 'x'.repeat(65_537) }, { title: 'Title', body: '', head: 'a..b' },
  ])('rejects invalid arguments at the typed MCP boundary: %o', (args) => {
    expect(() => validateToolArgs('nexus_pr_create', args)).toThrow();
  });
});
