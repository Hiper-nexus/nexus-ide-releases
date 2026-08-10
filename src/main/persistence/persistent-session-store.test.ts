import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, Statement } from './db';

vi.mock('./db', () => ({
  getDb: vi.fn(),
}));

import { getDb } from './db';
import {
  deletePersistentPty,
  getPersistentPty,
  listPersistentPtys,
  upsertPersistentPty,
} from './persistent-session-store';

type Row = {
  workspace_id: string;
  pane_id: string;
  tmux_name: string;
  cwd: string;
  created_at: number;
};

function createMemoryDb(): Db {
  const rows = new Map<string, Row>();
  const key = (workspaceId: string, paneId: string) =>
    `${workspaceId}\0${paneId}`;

  const prepare = (sql: string): Statement => {
    if (sql.includes('INSERT INTO persistent_pty_sessions')) {
      return {
        run(...params: unknown[]) {
          const [workspace_id, pane_id, tmux_name, cwd, created_at] =
            params as [string, string, string, string, number];
          rows.set(key(workspace_id, pane_id), {
            workspace_id,
            pane_id,
            tmux_name,
            cwd,
            created_at,
          });
        },
        get() {
          return undefined;
        },
        all() {
          return [];
        },
      };
    }
    if (sql.includes('WHERE workspace_id = ? AND pane_id = ?') && sql.includes('SELECT')) {
      return {
        run() {},
        get(...params: unknown[]) {
          const [workspaceId, paneId] = params as [string, string];
          return rows.get(key(workspaceId, paneId));
        },
        all() {
          return [];
        },
      };
    }
    if (sql.includes('WHERE workspace_id = ?') && sql.includes('ORDER BY')) {
      return {
        run() {},
        get() {
          return undefined;
        },
        all(...params: unknown[]) {
          const [workspaceId] = params as [string];
          return [...rows.values()]
            .filter((row) => row.workspace_id === workspaceId)
            .sort((a, b) => a.created_at - b.created_at);
        },
      };
    }
    if (sql.includes('DELETE FROM persistent_pty_sessions')) {
      return {
        run(...params: unknown[]) {
          const [workspaceId, paneId] = params as [string, string];
          rows.delete(key(workspaceId, paneId));
        },
        get() {
          return undefined;
        },
        all() {
          return [];
        },
      };
    }
    throw new Error(`unexpected SQL in fake db: ${sql}`);
  };

  return {
    exec() {},
    prepare,
    close() {},
  };
}

describe('persistent-session-store', () => {
  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue(createMemoryDb());
  });

  it('upserts and reads a record', () => {
    expect(
      upsertPersistentPty({
        workspaceId: '/tmp/ws',
        paneId: 'pane-1',
        tmuxName: 'nexus-ws-pane-1',
        cwd: '/tmp/ws',
        createdAt: 100,
      }),
    ).toBe(true);
    expect(getPersistentPty('/tmp/ws', 'pane-1')).toEqual({
      workspaceId: '/tmp/ws',
      paneId: 'pane-1',
      tmuxName: 'nexus-ws-pane-1',
      cwd: '/tmp/ws',
      createdAt: 100,
    });
  });

  it('lists by workspace and deletes', () => {
    upsertPersistentPty({
      workspaceId: '/tmp/ws',
      paneId: 'a',
      tmuxName: 'nexus-a',
      cwd: '/tmp/ws',
      createdAt: 1,
    });
    upsertPersistentPty({
      workspaceId: '/tmp/ws',
      paneId: 'b',
      tmuxName: 'nexus-b',
      cwd: '/tmp/ws',
      createdAt: 2,
    });
    upsertPersistentPty({
      workspaceId: '/other',
      paneId: 'a',
      tmuxName: 'nexus-other-a',
      cwd: '/other',
      createdAt: 3,
    });
    expect(listPersistentPtys('/tmp/ws').map((r) => r.paneId)).toEqual([
      'a',
      'b',
    ]);
    deletePersistentPty('/tmp/ws', 'a');
    expect(getPersistentPty('/tmp/ws', 'a')).toBeNull();
    expect(listPersistentPtys('/tmp/ws')).toHaveLength(1);
  });

  it('returns false when db is unavailable', () => {
    vi.mocked(getDb).mockReturnValue(null);
    expect(
      upsertPersistentPty({
        workspaceId: 'w',
        paneId: 'p',
        tmuxName: 'nexus-w-p',
        cwd: '/',
        createdAt: 1,
      }),
    ).toBe(false);
  });
});
