import { beforeEach, describe, expect, it, vi } from 'vitest';

const childProcess = vi.hoisted(() => ({
  execFileSync: vi.fn(() => 'credential-blob\n'),
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

const fsMock = vi.hoisted(() => ({
  mkdtempSync: vi.fn(() => '/tmp/nexus-claude-cred-test'),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
  rmSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:child_process', () => childProcess);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdtempSync: fsMock.mkdtempSync,
      writeFileSync: fsMock.writeFileSync,
      chmodSync: fsMock.chmodSync,
      rmSync: fsMock.rmSync,
      readFileSync: fsMock.readFileSync,
    },
    mkdtempSync: fsMock.mkdtempSync,
    writeFileSync: fsMock.writeFileSync,
    chmodSync: fsMock.chmodSync,
    rmSync: fsMock.rmSync,
    readFileSync: fsMock.readFileSync,
  };
});

import {
  CLAUDE_KEYCHAIN_INTERACTIVE_CMD_MAX_BYTES,
  claudeCredentialBlobIsUsable,
  readActiveClaudeCredential,
  slimClaudeCredentialBlob,
  writeActiveClaudeCredential,
  managedClaudeKeychainService,
  readManagedClaudeCredential,
  writeManagedClaudeCredential,
  deleteManagedClaudeCredential,
} from './claude-credential';

function fullFatBlob(accessToken = 'sk-ant-oat01-live'): string {
  const mcpOAuth: Record<string, unknown> = {};
  for (let i = 0; i < 40; i += 1) {
    mcpOAuth[`plugin:example:svc|${i.toString(16).padStart(16, '0')}`] = {
      serverName: `plugin:example:svc${i}`,
      serverUrl: `https://mcp.example.com/${i}`,
      accessToken: `mcp-token-${i}-${'x'.repeat(40)}`,
      clientSecret: `secret-${i}-${'y'.repeat(32)}`,
      refreshToken: `refresh-${i}`,
      discoveryState: {
        authorizationServerUrl: 'https://auth.example.com',
        oauthMetadataFound: true,
      },
    };
  }
  return JSON.stringify({
    mcpOAuth,
    claudeAiOauth: {
      accessToken,
      refreshToken: 'sk-ant-ort01-refresh',
      expiresAt: 1_800_000_000_000,
      refreshTokenExpiresAt: 1_900_000_000_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      clientId: 'synthetic-oauth-client',
    },
  });
}

describe('slimClaudeCredentialBlob', () => {
  it('drops mcpOAuth and keeps only claudeAiOauth session fields', () => {
    const full = fullFatBlob();
    expect(full.length).toBeGreaterThan(3500);
    const slim = slimClaudeCredentialBlob(full);
    expect(slim).not.toBeNull();
    const parsed = JSON.parse(slim!);
    expect(Object.keys(parsed)).toEqual(['claudeAiOauth']);
    expect(parsed.mcpOAuth).toBeUndefined();
    expect(parsed.claudeAiOauth.accessToken).toBe('sk-ant-oat01-live');
    expect(parsed.claudeAiOauth.clientId).toBe('synthetic-oauth-client');
    expect(parsed.claudeAiOauth.refreshToken).toBe('sk-ant-ort01-refresh');
    expect(parsed.claudeAiOauth.scopes).toEqual([
      'user:inference',
      'user:profile',
    ]);
    expect(slim!.includes('\n')).toBe(false);
    expect(Buffer.byteLength(slim!, 'utf8')).toBeLessThan(800);
  });

  it('returns null without accessToken', () => {
    expect(slimClaudeCredentialBlob('{}')).toBeNull();
    expect(
      slimClaudeCredentialBlob(JSON.stringify({ claudeAiOauth: {} })),
    ).toBeNull();
    expect(slimClaudeCredentialBlob('not-json')).toBeNull();
    expect(claudeCredentialBlobIsUsable(null)).toBe(false);
    expect(claudeCredentialBlobIsUsable(fullFatBlob())).toBe(true);
  });
});

describe.runIf(process.platform === 'darwin')('Claude Keychain boundaries', () => {
  beforeEach(() => {
    childProcess.execFileSync.mockClear();
    childProcess.spawnSync.mockClear();
    childProcess.spawnSync.mockReturnValue({ status: 0 });
    fsMock.mkdtempSync.mockClear();
    fsMock.writeFileSync.mockClear();
    fsMock.chmodSync.mockClear();
    fsMock.rmSync.mockClear();
  });

  it('bounds the Keychain read so SecurityAgent cannot freeze the main loop', () => {
    expect(readActiveClaudeCredential()).toBe('credential-blob');
    expect(childProcess.execFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      expect.objectContaining({
        timeout: 5_000,
        killSignal: 'SIGKILL',
      }),
    );
  });

  it('keeps managed account reads and writes outside the native Keychain service', () => {
    const profile = '/tmp/nexus-managed-claude/account-a/auth';
    const service = managedClaudeKeychainService(profile);
    expect(service).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
    expect(managedClaudeKeychainService('/tmp/nexus-managed-claude/account-b/auth')).not.toBe(service);
    expect(() => managedClaudeKeychainService('')).toThrow();
    expect(() => managedClaudeKeychainService('../native')).toThrow();
    readManagedClaudeCredential(profile);
    expect(childProcess.execFileSync).toHaveBeenCalledWith('security',
      ['find-generic-password', '-s', service, '-w'], expect.any(Object));
    const blob = fullFatBlob('synthetic-managed-token');
    expect(writeManagedClaudeCredential(profile, blob)).toBe(true);
    const [command, args, options] = childProcess.spawnSync.mock.calls.at(-1)! as unknown as [string, string[], { input: string }];
    expect(command).toBe('security');
    expect(args).toEqual(['-i']);
    expect(options.input).toContain(service);
    expect(options.input).not.toContain('mcpOAuth');
    expect(args.join(' ')).not.toContain('synthetic-managed-token');
    expect(deleteManagedClaudeCredential(profile)).toBe(true);
    expect(childProcess.execFileSync).toHaveBeenLastCalledWith('security',
      ['delete-generic-password', '-s', service], expect.any(Object));
  });

  it('bounds the Keychain write so account activation cannot freeze the main loop', () => {
    // Must be a usable OAuth blob — bare strings are refused by slim.
    const slim = slimClaudeCredentialBlob(fullFatBlob())!;
    expect(writeActiveClaudeCredential(slim)).toBe(true);
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      'security',
      ['-i'],
      expect.objectContaining({
        timeout: 5_000,
        killSignal: 'SIGKILL',
      }),
    );
  });

  it('slims a fat mcpOAuth blob before interactive write', () => {
    const full = fullFatBlob();
    expect(writeActiveClaudeCredential(full)).toBe(true);
    expect(childProcess.spawnSync).toHaveBeenCalled();
    const calls = childProcess.spawnSync.mock.calls as unknown as Array<
      [string, string[], { input?: string }]
    >;
    const first = calls[0];
    expect(first?.[0]).toBe('security');
    expect(first?.[1]).toEqual(['-i']);
    const input = String(first?.[2]?.input ?? '');
    expect(input.includes('mcpOAuth')).toBe(false);
    expect(input.includes('sk-ant-oat01-live')).toBe(true);
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThan(
      CLAUDE_KEYCHAIN_INTERACTIVE_CMD_MAX_BYTES,
    );
  });

  it('refuses newline blobs without claiming success', () => {
    expect(writeActiveClaudeCredential('line1\nline2')).toBe(false);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('refuses blobs without usable accessToken', () => {
    expect(writeActiveClaudeCredential(JSON.stringify({ mcpOAuth: {} }))).toBe(
      false,
    );
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it('falls back to temp-file write when interactive path fails', () => {
    childProcess.spawnSync
      .mockReturnValueOnce({ status: 1 }) // interactive fails
      .mockReturnValueOnce({ status: 0 }); // fallback succeeds
    const slim = slimClaudeCredentialBlob(fullFatBlob())!;
    expect(writeActiveClaudeCredential(slim)).toBe(true);
    expect(childProcess.spawnSync).toHaveBeenCalledTimes(2);
    const calls = childProcess.spawnSync.mock.calls as unknown as Array<
      [string, ...unknown[]]
    >;
    expect(calls[1]?.[0]).toBe('/bin/bash');
    expect(fsMock.writeFileSync).toHaveBeenCalled();
    expect(fsMock.rmSync).toHaveBeenCalled();
  });

  it('returns false when interactive and fallback both fail (no success)', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1 });
    expect(writeActiveClaudeCredential(slimClaudeCredentialBlob(fullFatBlob())!)).toBe(
      false,
    );
  });
});
