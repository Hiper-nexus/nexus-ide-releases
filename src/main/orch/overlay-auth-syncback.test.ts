import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBackClaudeEphemeralAuth, syncBackOverlayAuth, syncBackStaleClaudeOverlayAuth } from './overlay-auth-syncback';

const snapshot = vi.hoisted(() => ({ clear: vi.fn() }));
vi.mock('../adapters/claude-config-snapshot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clearClaudeConfigSnapshotCache: snapshot.clear,
}));

const created: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-syncback-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('syncBackOverlayAuth', () => {
  it('copies a fresh in-pane login (new real file) back into the real home', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.mkdirSync(path.join(overlay, 'credentials'), { recursive: true });
    fs.writeFileSync(
      path.join(overlay, 'credentials', 'kimi-code.json'),
      '{"token":"fresh"}',
    );

    syncBackOverlayAuth(overlay, realHome, new Set(['mcp.json']));

    expect(
      fs.readFileSync(path.join(realHome, 'credentials', 'kimi-code.json'), 'utf8'),
    ).toBe('{"token":"fresh"}');
  });

  it('never copies the token-bearing overlay config file back', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.writeFileSync(path.join(overlay, 'mcp.json'), '{"bearer":"secret-token"}');

    syncBackOverlayAuth(overlay, realHome, new Set(['mcp.json']));

    expect(fs.existsSync(path.join(realHome, 'mcp.json'))).toBe(false);
  });

  it('skips symlinks — writes already went through to the real home', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.writeFileSync(path.join(realHome, 'session.json'), 'REAL');
    fs.symlinkSync(
      path.join(realHome, 'session.json'),
      path.join(overlay, 'session.json'),
    );

    syncBackOverlayAuth(overlay, realHome, new Set(['mcp.json']));

    expect(fs.lstatSync(path.join(realHome, 'session.json')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(realHome, 'session.json'), 'utf8')).toBe('REAL');
  });

  it('excludes a nested token config at any depth (excludeAnywhere)', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.mkdirSync(path.join(overlay, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(overlay, 'config', 'mcp_config.json'),
      '{"bearer":"secret"}',
    );
    fs.writeFileSync(path.join(overlay, 'config', 'settings.json'), 'keep');
    fs.writeFileSync(path.join(overlay, 'antigravity'), 'AUTH');

    syncBackOverlayAuth(overlay, realHome, new Set(), new Set(['mcp_config.json']));

    expect(fs.readFileSync(path.join(realHome, 'antigravity'), 'utf8')).toBe('AUTH');
    expect(
      fs.readFileSync(path.join(realHome, 'config', 'settings.json'), 'utf8'),
    ).toBe('keep');
    expect(
      fs.existsSync(path.join(realHome, 'config', 'mcp_config.json')),
    ).toBe(false);
  });

  it('is a best-effort no-op when the overlay does not exist', () => {
    const realHome = tmp();
    expect(() =>
      syncBackOverlayAuth(path.join(realHome, 'missing'), realHome, new Set()),
    ).not.toThrow();
  });
});

describe('syncBackClaudeEphemeralAuth', () => {
  it('forgets the in-memory ~/.claude.json snapshot after rescuing a login identity (M1)', () => {
    const realHome = tmp();
    const overlay = tmp();
    fs.writeFileSync(path.join(realHome, '.claude.json'), JSON.stringify({ projects: {} }));
    fs.writeFileSync(
      path.join(overlay, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'fresh@example.test' } }),
    );
    snapshot.clear.mockClear();

    syncBackClaudeEphemeralAuth(overlay, realHome);

    expect(JSON.parse(fs.readFileSync(path.join(realHome, '.claude.json'), 'utf8')).oauthAccount)
      .toEqual({ emailAddress: 'fresh@example.test' });
    expect(snapshot.clear).toHaveBeenCalled();
  });
});

describe('syncBackStaleClaudeOverlayAuth (overlay órfão varrido pela higiene de disco)', () => {
  const credentials = (home: string, token: string, ageMs: number) => {
    const file = path.join(home, '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token }));
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(file, at, at);
    return file;
  };

  it('credencial do overlay mais nova que a do perfil real volta (login feito no pane que morreu)', () => {
    const realHome = tmp();
    const overlay = tmp();
    const real = credentials(realHome, 'velho', 60 * 60_000);
    credentials(overlay, 'novo', 1_000);
    syncBackStaleClaudeOverlayAuth(overlay, realHome);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).token).toBe('novo');
  });

  it('credencial do overlay mais velha NUNCA sobrescreve o login atual do perfil real', () => {
    const realHome = tmp();
    const overlay = tmp();
    const real = credentials(realHome, 'atual', 1_000);
    credentials(overlay, 'velho-do-overlay', 3 * 24 * 60 * 60_000);
    syncBackStaleClaudeOverlayAuth(overlay, realHome);
    expect(JSON.parse(fs.readFileSync(real, 'utf8')).token).toBe('atual');
  });

  it('sem credencial no perfil real, a do overlay é a única e volta', () => {
    const realHome = tmp();
    const overlay = tmp();
    credentials(overlay, 'unico', 3 * 24 * 60 * 60_000);
    syncBackStaleClaudeOverlayAuth(overlay, realHome);
    expect(JSON.parse(fs.readFileSync(path.join(realHome, '.claude', '.credentials.json'), 'utf8')).token).toBe('unico');
  });
});
