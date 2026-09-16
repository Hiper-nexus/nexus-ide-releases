import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareOpenCodeMcpSession } from './cli-mcp-session-opencode';
import {
  cleanupCliMcpSession,
  purgeStaleCliMcpSessions,
} from './cli-mcp-session-artifacts';
import { getAgentResumeArgv } from '../../shared/agent-session-resume';
import {
  materializeManagedHome,
  scrubManagedAuth,
} from '../adapters/managed-credentials';

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
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-opencode-state-')),
  );
  roots.push(root);
  const providerHome = path.join(root, '.local', 'share');
  fs.mkdirSync(path.join(providerHome, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(providerHome, 'opencode', 'auth.json'), '{}');
  fs.writeFileSync(
    path.join(providerHome, 'opencode', 'opencode.db'),
    'external database',
  );
  return {
    home: root,
    providerHome,
    userDataPath: path.join(root, 'user-data'),
    checkoutId: 'checkout-a',
    artifactRoot: path.join(root, 'ephemeral'),
    allowedSkills: [],
  };
}

describe('F-567 OpenCode checkout conversations', () => {
  it.each([false, true])(
    'isolates data/state and retains exact resume after restart (governed=%s)',
    (governed) => {
      const options = { ...fixture(), governed };
      const start = (token: string, overrides = {}) => {
        tokens.push(token);
        return prepareOpenCodeMcpSession('http://127.0.0.1:9/mcp', token, {
          ...options,
          ...overrides,
        });
      };
      const first = start(`opencode-state-${governed}`);
      const state = path.join(
        options.userDataPath,
        'provider-state',
        'opencode',
        options.checkoutId,
      );
      expect(first.providerStateHome).toBe(
        path.join(options.providerHome, 'opencode', 'auth.json'),
      );
      expect(first.env.XDG_DATA_HOME.startsWith(state + path.sep)).toBe(true);
      expect(first.env.XDG_STATE_HOME.startsWith(state + path.sep)).toBe(true);
      const data = path.join(first.env.XDG_DATA_HOME, 'opencode');
      expect(fs.existsSync(path.join(data, 'opencode.db'))).toBe(false);
      expect(fs.readFileSync(path.join(data, 'auth.json'), 'utf8')).toBe('{}');
      fs.writeFileSync(path.join(data, 'auth.json'), '{"refreshed":true}');
      expect(
        fs.readFileSync(
          path.join(options.providerHome, 'opencode', 'auth.json'),
          'utf8',
        ),
      ).toContain('refreshed');
      const db = new Database(first.env.OPENCODE_DB);
      db.pragma('journal_mode = WAL');
      db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)');
      db.prepare('INSERT INTO session VALUES (?, ?)').run(
        'ses_exact',
        'pane conversation',
      );
      db.close();
      fs.writeFileSync(
        path.join(first.env.XDG_STATE_HOME, 'pane-state'),
        'state',
      );
      const other = start(`opencode-other-${governed}`, {
        checkoutId: 'checkout-b',
      });
      expect(other.env.OPENCODE_DB).not.toBe(first.env.OPENCODE_DB);
      expect(fs.existsSync(other.env.OPENCODE_DB)).toBe(false);
      cleanupCliMcpSession(`opencode-state-${governed}`);
      purgeStaleCliMcpSessions({
        home: options.home,
        artifactRoot: options.artifactRoot,
      });
      const resumed = start(`opencode-resumed-${governed}`, {
        artifactRoot: path.join(options.home, 'restart'),
      });
      expect(
        getAgentResumeArgv('opencode', { key: 'session_id', id: 'ses_exact' }),
      ).toEqual(['opencode', '--session', 'ses_exact']);
      expect(resumed.env.OPENCODE_DB).toBe(first.env.OPENCODE_DB);
      const resumedDb = new Database(resumed.env.OPENCODE_DB, {
        readonly: true,
      });
      expect(
        resumedDb
          .prepare('SELECT title FROM session WHERE id = ?')
          .get('ses_exact'),
      ).toEqual({ title: 'pane conversation' });
      resumedDb.close();
      expect(
        fs.readFileSync(
          path.join(resumed.env.XDG_STATE_HOME, 'pane-state'),
          'utf8',
        ),
      ).toBe('state');
      expect(
        fs.readFileSync(
          path.join(options.providerHome, 'opencode', 'opencode.db'),
          'utf8',
        ),
      ).toBe('external database');
    },
  );

  it('keeps two managed accounts on the same checkout from rebinding each other’s auth', () => {
    const options = fixture();
    const secondHome = path.join(options.home, 'managed');
    fs.mkdirSync(path.join(secondHome, 'opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(secondHome, 'opencode', 'auth.json'),
      '{"account":"second"}',
    );
    tokens.push('opencode-account-a', 'opencode-account-b');
    const a = prepareOpenCodeMcpSession(
      'http://127.0.0.1:9/mcp',
      tokens[0],
      options,
    );
    const b = prepareOpenCodeMcpSession('http://127.0.0.1:9/mcp', tokens[1], {
      ...options,
      providerHome: secondHome,
    });
    expect(
      fs.readFileSync(
        path.join(a.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
        'utf8',
      ),
    ).toBe('{}');
    expect(
      fs.readFileSync(
        path.join(b.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
        'utf8',
      ),
    ).toContain('second');
  });

  it('rejects checkout traversal and database redirects', () => {
    const options = fixture();
    expect(() =>
      prepareOpenCodeMcpSession('http://127.0.0.1:9/mcp', 'bad-checkout', {
        ...options,
        checkoutId: '../escape',
      }),
    ).toThrow(/identity/i);
    const database = path.join(
      options.userDataPath,
      'provider-state',
      'opencode',
      options.checkoutId,
      'database',
    );
    fs.mkdirSync(database, { recursive: true });
    fs.symlinkSync(
      path.join(options.providerHome, 'opencode', 'opencode.db'),
      path.join(database, 'opencode.db'),
    );
    expect(() =>
      prepareOpenCodeMcpSession('http://127.0.0.1:9/mcp', 'linked-db', options),
    ).toThrow(/symlink/i);
    expect(
      fs.readFileSync(
        path.join(options.providerHome, 'opencode', 'opencode.db'),
        'utf8',
      ),
    ).toBe('external database');
  });

  it('links data directories with Windows junctions and shares auth via a hardlink', () => {
    const options = fixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const link = vi.spyOn(fs, 'symlinkSync');
    tokens.push('opencode-windows');
    const prepared = prepareOpenCodeMcpSession(
      'http://127.0.0.1:9/mcp',
      'opencode-windows',
      options,
    );
    expect(link.mock.calls.some((call) => call[2] === 'junction')).toBe(true);
    fs.writeFileSync(
      path.join(prepared.env.XDG_DATA_HOME, 'opencode', 'auth.json'),
      '{"refreshed":true}',
    );
    expect(
      fs.readFileSync(
        path.join(options.providerHome, 'opencode', 'auth.json'),
        'utf8',
      ),
    ).toContain('refreshed');
  });

  it('scrubs durable Windows auth hardlinks and rebinds credentials after account rematerialization', () => {
    const options = fixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const providerHome = materializeManagedHome(
      'opencode',
      'saved',
      '{"key":"first"}',
      { home: options.home, systemHome: null },
    );
    tokens.push('opencode-scrub', 'opencode-reauth');
    const first = prepareOpenCodeMcpSession(
      'http://127.0.0.1:9/mcp',
      'opencode-scrub',
      { ...options, providerHome },
    );
    const auth = path.join(first.env.XDG_DATA_HOME, 'opencode', 'auth.json');
    cleanupCliMcpSession('opencode-scrub');
    scrubManagedAuth('opencode', 'saved', { home: options.home });
    expect(fs.readFileSync(auth, 'utf8')).toBe('');
    materializeManagedHome('opencode', 'saved', '{"key":"second"}', {
      home: options.home,
      systemHome: null,
    });
    prepareOpenCodeMcpSession('http://127.0.0.1:9/mcp', 'opencode-reauth', {
      ...options,
      providerHome,
    });
    expect(fs.readFileSync(auth, 'utf8')).toContain('second');
  });

  it('fails closed when Windows cannot share the auth inode across volumes', () => {
    const options = fixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-volume auth link'), {
        code: 'EXDEV',
      });
    });
    const copy = vi.spyOn(fs, 'copyFileSync');
    expect(() =>
      prepareOpenCodeMcpSession(
        'http://127.0.0.1:9/mcp',
        'opencode-exdev',
        options,
      ),
    ).toThrow(/cross-volume/);
    expect(copy).not.toHaveBeenCalled();
  });
});
