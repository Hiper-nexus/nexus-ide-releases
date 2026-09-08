import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareGrokMcpSession,
  resolveGrokOverlayAuthSource,
} from './cli-mcp-session-grok';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-grok-overlay-'));
  tempDirs.push(dir);
  return dir;
}

function writeAuth(
  dir: string,
  entries: Record<string, { email?: string; expires_at?: string }>,
): void {
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(entries));
}

function entry(email: string, expiresAt: string): Record<string, { email?: string; expires_at?: string }> {
  return { 'https://auth.x.ai::test-account': { email, expires_at: expiresAt } };
}

describe('resolveGrokOverlayAuthSource', () => {
  it('keeps providerHome when it already is the native profile', () => {
    const home = tempDir();
    const native = path.join(home, '.grok');
    fs.mkdirSync(native, { recursive: true });
    expect(resolveGrokOverlayAuthSource(native, home)).toBe(native);
  });

  it('falls back to a fresh same-account native session over a stale managed copy', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    const stale = new Date(now - 86400_000).toISOString();
    const fresh = new Date(now + 3600_000).toISOString();
    writeAuth(managed, entry('user@example.com', stale));
    writeAuth(path.join(home, '.grok'), entry('user@example.com', fresh));
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(
      path.join(home, '.grok'),
    );
  });

  it('keeps a managed home that already holds any fresh entry', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('other@example.com', new Date(now + 3600_000).toISOString()),
    );
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now - 86400_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
  });

  it('never leaks a fresh native identity into a different-account pin', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('pinned@example.com', new Date(now - 86400_000).toISOString()),
    );
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now + 3600_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
  });

  it('covers a pinned account that was never captured', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now + 3600_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(
      path.join(home, '.grok'),
    );
  });

  it('keeps today behavior when nothing is fresh anywhere', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('user@example.com', new Date(now - 86400_000).toISOString()),
    );
    expect(resolveGrokOverlayAuthSource(managed, home, now)).toBe(managed);
  });
});

describe('prepareGrokMcpSession auth fallback', () => {
  it('links overlay auth.json at the fresh native session, not the stale shadow', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const managed = path.join(root, 'managed');
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
    fs.mkdirSync(managed, { recursive: true });
    const now = Date.now();
    writeAuth(
      managed,
      entry('user@example.com', new Date(now - 86400_000).toISOString()),
    );
    writeAuth(
      path.join(home, '.grok'),
      entry('user@example.com', new Date(now + 3600_000).toISOString()),
    );
    const prepared = prepareGrokMcpSession('http://127.0.0.1:9/mcp', 'test-token-grok-auth', {
      home,
      providerHome: managed,
      artifactRoot: artifacts,
      governed: true,
      cwd: root,
    });
    const artifactDir = prepared.artifactDir as string;
    expect(artifactDir).toBeTruthy();
    const linked = path.join(artifactDir, 'auth.json');
    expect(fs.readlinkSync(linked)).toBe(
      path.join(home, '.grok', 'auth.json'),
    );
    expect(prepared.env.GROK_HOME).toBe(artifactDir);
  });
});
