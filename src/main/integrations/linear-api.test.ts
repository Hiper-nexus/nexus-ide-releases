import { describe, expect, it, vi } from 'vitest';
import { listLinearIssues } from './linear-api';

describe('linear-api', () => {
  it('maps GraphQL nodes to ExternalIssue', async () => {
    const http = {
      postJson: vi.fn(async () => ({
        status: 200,
        body: {
          data: {
            issues: {
              nodes: [
                {
                  id: '1',
                  identifier: 'ENG-1',
                  title: 'Ship it',
                  url: 'https://linear.app/x',
                  state: { name: 'In Progress' },
                  labels: { nodes: [{ name: 'p0' }] },
                },
              ],
            },
          },
        },
      })),
    };
    const r = await listLinearIssues('key', 10, http);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.issues[0]?.title).toBe('Ship it');
      expect(r.issues[0]?.labels).toEqual(['p0']);
    }
  });
});
