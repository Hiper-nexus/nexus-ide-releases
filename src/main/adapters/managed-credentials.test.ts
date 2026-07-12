import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureNativeAuth,
  identityFromAuthBlob,
  isFileAuthAdapter,
  managedHomeEnv,
  managedHomePath,
  materializeManagedHome,
  removeManagedHome,
} from './managed-credentials';

const tempRoots: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-managed-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('managed-credentials', () => {
  it('recognizes file-auth adapters', () => {
    expect(isFileAuthAdapter('codex')).toBe(true);
    expect(isFileAuthAdapter('grok')).toBe(true);
    expect(isFileAuthAdapter('claude')).toBe(false);
  });

  it('extracts email from Codex JWT id_token', () => {
    const payload = Buffer.from(
      JSON.stringify({ email: 'dev@example.test', sub: 'u1' }),
    ).toString('base64url');
    const blob = JSON.stringify({
      tokens: {
        id_token: `hdr.${payload}.sig`,
        access_token: 'access',
        refresh_token: 'refresh',
        account_id: 'acct',
      },
    });
    expect(identityFromAuthBlob('codex', blob)).toEqual({
      email: 'dev@example.test',
    });
  });

  it('materializes CODEX_HOME with auth.json and returns env', () => {
    const home = tempHome();
    const systemCodex = path.join(home, '.codex');
    fs.mkdirSync(systemCodex, { recursive: true });
    fs.writeFileSync(path.join(systemCodex, 'config.toml'), 'model = "o3"\n');
    fs.writeFileSync(
      path.join(systemCodex, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'system' } }),
    );

    const accountBlob = JSON.stringify({
      tokens: {
        id_token: `x.${Buffer.from(JSON.stringify({ email: 'work@x.test' })).toString('base64url')}.y`,
        access_token: 'work-access',
        refresh_token: 'work-refresh',
        account_id: 'w1',
      },
    });

    const managed = materializeManagedHome('codex', 'acct-work', accountBlob, {
      home,
      systemHome: systemCodex,
    });

    expect(managed).toBe(managedHomePath('codex', 'acct-work', home));
    expect(fs.existsSync(path.join(managed, 'config.toml'))).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(managed, 'auth.json'), 'utf8'),
    ) as { tokens: { access_token: string } };
    expect(written.tokens.access_token).toBe('work-access');
    expect(managedHomeEnv('codex', managed)).toEqual({ CODEX_HOME: managed });
  });

  it('captures native codex auth from system home', () => {
    const home = tempHome();
    const systemCodex = path.join(home, '.codex');
    fs.mkdirSync(systemCodex, { recursive: true });
    const blob = JSON.stringify({
      tokens: {
        id_token: `a.${Buffer.from(JSON.stringify({ email: 'cap@x.test' })).toString('base64url')}.b`,
        access_token: 'cap',
        refresh_token: 'r',
        account_id: 'c1',
      },
    });
    fs.writeFileSync(path.join(systemCodex, 'auth.json'), blob);

    const capture = captureNativeAuth('codex', home);
    expect(capture?.blob).toBe(blob);
    expect(capture?.email).toBe('cap@x.test');
  });

  it('removes managed home on cleanup', () => {
    const home = tempHome();
    const managed = materializeManagedHome(
      'codex',
      'acct-rm',
      JSON.stringify({ tokens: {} }),
      { home, systemHome: null },
    );
    expect(fs.existsSync(managed)).toBe(true);
    removeManagedHome('codex', 'acct-rm', home);
    expect(fs.existsSync(managed)).toBe(false);
  });

  it('rejects path-traversal account ids', () => {
    expect(() =>
      materializeManagedHome('codex', '../evil', '{}', {
        home: tempHome(),
        systemHome: null,
      }),
    ).toThrow(/invalid managed account id/);
  });

  it('restores directory snapshots under managed home', () => {
    const home = tempHome();
    const blob = JSON.stringify({
      __nexusDirSnapshot: true,
      root: 'antigravity',
      files: {
        'creds.json': '{"email":"a@b.test"}',
        'nested/token': 'abc',
      },
    });
    const managed = materializeManagedHome('agy', 'acct-agy', blob, {
      home,
      systemHome: null,
    });
    expect(
      fs.readFileSync(path.join(managed, 'antigravity', 'creds.json'), 'utf8'),
    ).toBe('{"email":"a@b.test"}');
    expect(
      fs.readFileSync(path.join(managed, 'antigravity', 'nested', 'token'), 'utf8'),
    ).toBe('abc');
  });

  it('does not clobber fresher on-disk auth with a stale vault blob', () => {
    const home = tempHome();
    const managed = materializeManagedHome(
      'codex',
      'acct-fresh',
      JSON.stringify({
        last_refresh: '2026-07-12T10:00:00.000Z',
        tokens: { access_token: 'old' },
      }),
      { home, systemHome: null },
    );
    const authPath = path.join(managed, 'auth.json');
    const fresher = JSON.stringify({
      last_refresh: '2026-07-12T12:00:00.000Z',
      tokens: { access_token: 'new' },
    });
    fs.writeFileSync(authPath, fresher);

    materializeManagedHome(
      'codex',
      'acct-fresh',
      JSON.stringify({
        last_refresh: '2026-07-12T09:00:00.000Z',
        tokens: { access_token: 'stale-vault' },
      }),
      { home, systemHome: null },
    );
    expect(fs.readFileSync(authPath, 'utf8')).toBe(fresher);
  });
});
