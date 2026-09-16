import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { parse } from 'smol-toml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  prepareCodexGovernedSession,
  prepareCodexOperatorMissionHome,
} from './cli-mcp-session-codex';
import {
  cleanupCliMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-artifacts';
import { materializeManagedHome } from '../adapters/managed-credentials';
import { getAgentResumeArgv } from '../../shared/agent-session-resume';
import type { CliMcpSessionResult } from './cli-mcp-session-types';

const roots: string[] = [];
const tokens: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const token of tokens.splice(0)) cleanupCliMcpSession(token);
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-codex-state-')),
  );
  roots.push(root);
  const providerHome = path.join(root, '.codex');
  fs.mkdirSync(path.join(providerHome, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(providerHome, 'auth.json'), '{}');
  fs.writeFileSync(
    path.join(providerHome, 'sessions', 'external.jsonl'),
    'external',
  );
  fs.writeFileSync(
    path.join(providerHome, 'state_5.sqlite'),
    'external database',
  );
  return {
    home: root,
    providerHome,
    userDataPath: path.join(root, 'user-data'),
    checkoutId: 'checkout-a',
    artifactRoot: path.join(root, 'ephemeral'),
    cwd: root,
    workspaceRoot: root,
    codexNativeAuthority: 'read-only' as const,
    allowedSkills: [],
  };
}
const exactId = '11111111-1111-4111-8111-111111111111';

describe('F-567 Codex checkout conversations', () => {
  it.each(['operator', 'governed', 'common'] as const)(
    'persists only checkout state across overlay purge (%s)',
    (mode) => {
      const governed = mode === 'governed';
      const options = fixture();
      fs.writeFileSync(
        path.join(options.providerHome, 'config.toml'),
        '[mcp_servers.personal]\nurl = "https://example.test/mcp"\n',
      );
      const prepare = governed
        ? prepareCodexGovernedSession
        : prepareCodexOperatorMissionHome;
      const start = (token: string, overrides = {}) => {
        tokens.push(token);
        return prepare(token, {
          ...options,
          preserveUserMcp: mode === 'common',
          ...overrides,
        });
      };
      const first = start(`codex-state-${governed}`);
      const state = path.join(
        options.userDataPath,
        'provider-state',
        'codex',
        options.checkoutId,
      );
      expect(fs.realpathSync(path.join(first.env.CODEX_HOME, 'sessions'))).toBe(
        path.join(state, 'sessions'),
      );
      expect(first.env.CODEX_SQLITE_HOME).toBe(state);
      expect(
        parse(
          fs.readFileSync(
            path.join(first.env.CODEX_HOME, 'config.toml'),
            'utf8',
          ),
        ).sqlite_home,
      ).toBe(state);
      expect(
        Boolean(
          parse(
            fs.readFileSync(
              path.join(first.env.CODEX_HOME, 'config.toml'),
              'utf8',
            ),
          ).mcp_servers,
        ),
      ).toBe(mode === 'common');
      if (governed) {
        expect(
          (first as CliMcpSessionResult).codexProcessSandbox
            ?.providerStatePaths,
        ).toContain(state);
      }
      expect(
        fs.readFileSync(path.join(first.env.CODEX_HOME, 'auth.json'), 'utf8'),
      ).toBe('{}');
      fs.writeFileSync(
        path.join(first.env.CODEX_HOME, 'auth.json'),
        '{"refreshed":true}',
      );
      expect(
        fs.readFileSync(path.join(options.providerHome, 'auth.json'), 'utf8'),
      ).toContain('refreshed');
      expect(
        fs.existsSync(
          path.join(first.env.CODEX_HOME, 'sessions', 'external.jsonl'),
        ),
      ).toBe(false);
      const rollout = path.join(
        first.env.CODEX_HOME,
        'sessions',
        `rollout-${exactId}.jsonl`,
      );
      fs.writeFileSync(rollout, 'pane conversation');
      const db = new Database(
        path.join(first.env.CODEX_SQLITE_HOME, 'state_5.sqlite'),
      );
      db.pragma('journal_mode = WAL');
      db.exec(
        'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)',
      );
      db.exec('CREATE TABLE thread_dynamic_tools (thread_id TEXT, name TEXT)');
      db.prepare('INSERT INTO thread_dynamic_tools VALUES (?, ?)').run(
        exactId,
        'old-account-app',
      );
      db.prepare('INSERT INTO thread_dynamic_tools VALUES (?, ?)').run(
        'other-thread',
        'unrelated-app',
      );
      db.prepare('INSERT INTO threads VALUES (?, ?)').run(exactId, rollout);
      db.close();
      const other = start(`codex-other-${governed}`, {
        checkoutId: 'checkout-b',
      });
      expect(other.env.CODEX_SQLITE_HOME).not.toBe(first.env.CODEX_SQLITE_HOME);
      expect(
        fs.existsSync(
          path.join(other.env.CODEX_HOME, 'sessions', path.basename(rollout)),
        ),
      ).toBe(false);
      cleanupCliMcpSession(`codex-state-${governed}`);
      purgeStaleCliMcpSessions({
        home: options.home,
        artifactRoot: options.artifactRoot,
      });
      const resumed = start(`codex-resumed-${governed}`, {
        codexResumeSessionId: exactId,
        artifactRoot: path.join(options.home, 'restart'),
      });
      expect(
        getAgentResumeArgv('codex', { key: 'session_id', id: exactId }),
      ).toEqual(['codex', 'resume', exactId]);
      const resumedDb = new Database(
        path.join(resumed.env.CODEX_SQLITE_HOME, 'state_5.sqlite'),
        { readonly: true },
      );
      const row = resumedDb
        .prepare('SELECT rollout_path FROM threads WHERE id = ?')
        .get(exactId) as { rollout_path: string };
      expect(
        resumedDb
          .prepare('SELECT name FROM thread_dynamic_tools WHERE thread_id = ?')
          .all(exactId),
      ).toHaveLength(governed ? 0 : 1);
      expect(
        resumedDb
          .prepare('SELECT name FROM thread_dynamic_tools WHERE thread_id = ?')
          .all('other-thread'),
      ).toHaveLength(1);
      resumedDb.close();
      expect(fs.readFileSync(row.rollout_path, 'utf8')).toBe(
        'pane conversation',
      );
      expect(
        fs.readFileSync(
          path.join(options.providerHome, 'state_5.sqlite'),
          'utf8',
        ),
      ).toBe('external database');
      expect(
        fs.readdirSync(path.join(options.providerHome, 'sessions')),
      ).toEqual(['external.jsonl']);
    },
  );

  it('does not import a native conversation to satisfy an exact resume', () => {
    const options = fixture();
    expect(() =>
      prepareCodexGovernedSession('external-resume', {
        ...options,
        codexResumeSessionId: exactId,
      }),
    ).toThrow(/resume/i);
    expect(
      fs.readFileSync(
        path.join(options.providerHome, 'state_5.sqlite'),
        'utf8',
      ),
    ).toBe('external database');
  });

  it('managed Codex homes do not link native conversation entries', () => {
    const options = fixture();
    const managed = materializeManagedHome('codex', 'account-a', '{}', {
      home: options.home,
    });
    expect(fs.existsSync(path.join(managed, 'sessions'))).toBe(false);
    expect(fs.existsSync(path.join(managed, 'state_5.sqlite'))).toBe(false);
  });

  it('rejects checkout traversal and linked databases without touching native data', () => {
    const options = fixture();
    expect(() =>
      prepareCodexOperatorMissionHome('bad-checkout', {
        ...options,
        checkoutId: '../escape',
      }),
    ).toThrow(/identity/i);
    const state = path.join(
      options.userDataPath,
      'provider-state',
      'codex',
      options.checkoutId,
    );
    fs.mkdirSync(state, { recursive: true });
    fs.symlinkSync(
      path.join(options.providerHome, 'state_5.sqlite'),
      path.join(state, 'state_5.sqlite'),
    );
    expect(() => prepareCodexOperatorMissionHome('linked-db', options)).toThrow(
      /symlink/i,
    );
    expect(
      fs.readFileSync(
        path.join(options.providerHome, 'state_5.sqlite'),
        'utf8',
      ),
    ).toBe('external database');
  });

  it('uses directory junctions for durable sessions on Windows', () => {
    const options = fixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const link = vi.spyOn(fs, 'symlinkSync');
    tokens.push('codex-windows');
    const prepared = prepareCodexOperatorMissionHome('codex-windows', options);
    expect(link).toHaveBeenCalledWith(
      path.join(
        options.userDataPath,
        'provider-state',
        'codex',
        options.checkoutId,
        'sessions',
      ),
      path.join(prepared.env.CODEX_HOME, 'sessions'),
      'junction',
    );
  });

  it('never syncs a replaced history link or session index to the native profile', () => {
    const options = fixture();
    tokens.push('codex-atomic');
    const prepared = prepareCodexOperatorMissionHome('codex-atomic', options);
    for (const name of ['history.jsonl', 'session_index.jsonl']) {
      fs.unlinkSync(path.join(prepared.env.CODEX_HOME, name));
      fs.writeFileSync(path.join(prepared.env.CODEX_HOME, name), 'pane-only');
    }
    cleanupCliMcpSession('codex-atomic');
    expect(
      fs.existsSync(path.join(options.providerHome, 'history.jsonl')),
    ).toBe(false);
    expect(
      fs.existsSync(path.join(options.providerHome, 'session_index.jsonl')),
    ).toBe(false);
  });
});
