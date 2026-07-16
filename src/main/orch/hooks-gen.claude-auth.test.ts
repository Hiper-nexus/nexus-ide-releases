import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupSessionArtifacts, prepareEphemeralHome } from './hooks-gen';

const TOKEN = `claude-auth-test-${process.pid}-${Date.now()}`;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-claude-auth-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
});

afterEach(() => {
  cleanupSessionArtifacts(TOKEN);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('native Claude auth in the ephemeral HOME', () => {
  it('carries oauthAccount/userID (and nothing else) into the stub', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'user@example.com' },
        userID: 'uid-1',
        projects: { '/tmp/foo': { history: ['sensitive'] } },
      }),
    );

    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
      carryNativeClaudeAuth: true,
    });

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stub.hasCompletedOnboarding).toBe(true);
    expect(stub.oauthAccount).toEqual({ emailAddress: 'user@example.com' });
    expect(stub.userID).toBe('uid-1');
    expect(stub.projects).toBeUndefined();
  });

  it('never carries the native identity without the flag (GLM/LongCat)', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'user@example.com' } }),
    );

    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} });

    const stub = JSON.parse(
      fs.readFileSync(path.join(overlay.dir, '.claude.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stub.oauthAccount).toBeUndefined();
    expect(stub.hasCompletedOnboarding).toBe(true);
  });

  it('links the file-backed credentials so refreshes write through', () => {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ token: 'secret' }),
    );

    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
      carryNativeClaudeAuth: true,
    });

    const linked = path.join(overlay.dir, '.claude', '.credentials.json');
    expect(
      JSON.parse(fs.readFileSync(linked, 'utf8')) as Record<string, unknown>,
    ).toEqual({ token: 'secret' });
  });

  it('rescues a fresh in-pane login into the real profile on teardown', () => {
    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
      carryNativeClaudeAuth: true,
    });
    // O CLI faz /login dentro do pane: identidade + segredo nascem no overlay.
    fs.writeFileSync(
      path.join(overlay.dir, '.claude.json'),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: { emailAddress: 'fresh@example.com' },
      }),
    );
    fs.writeFileSync(
      path.join(overlay.dir, '.claude', '.credentials.json'),
      JSON.stringify({ token: 'fresh-secret' }),
    );

    cleanupSessionArtifacts(TOKEN);

    const real = JSON.parse(
      fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
    ) as { oauthAccount?: { emailAddress?: string } };
    expect(real.oauthAccount?.emailAddress).toBe('fresh@example.com');
    expect(
      fs.existsSync(path.join(home, '.claude', '.credentials.json')),
    ).toBe(true);
    expect(fs.existsSync(overlay.dir)).toBe(false);
  });

  it('never clobbers an existing native login on teardown', () => {
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'native@example.com' } }),
    );
    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} }, {
      carryNativeClaudeAuth: true,
    });
    fs.writeFileSync(
      path.join(overlay.dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'other@example.com' },
      }),
    );

    cleanupSessionArtifacts(TOKEN);

    const real = JSON.parse(
      fs.readFileSync(path.join(home, '.claude.json'), 'utf8'),
    ) as { oauthAccount?: { emailAddress?: string } };
    expect(real.oauthAccount?.emailAddress).toBe('native@example.com');
  });

  it('syncs nothing back from an overlay without the native-auth marker', () => {
    const overlay = prepareEphemeralHome(TOKEN, { mcpServers: {} });
    // Um /login dentro de um pane GLM/LongCat autentica contra endpoint de
    // terceiro — essa identidade nunca pode poluir o perfil nativo.
    fs.writeFileSync(
      path.join(overlay.dir, '.claude.json'),
      JSON.stringify({
        oauthAccount: { emailAddress: 'foreign@example.com' },
      }),
    );

    cleanupSessionArtifacts(TOKEN);

    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    expect(fs.existsSync(overlay.dir)).toBe(false);
  });
});
