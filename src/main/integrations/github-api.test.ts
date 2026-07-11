import { describe, expect, it, vi } from 'vitest';
import { listGithubIssues, createGithubPr } from './github-api';

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
});
