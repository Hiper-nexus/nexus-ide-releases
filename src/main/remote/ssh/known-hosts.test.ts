import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const knownHostsDeps = vi.hoisted(() => ({
  home: `/tmp/nexus-known-hosts-${process.pid}`,
}));

vi.mock('node:os', () => ({
  default: { homedir: () => knownHostsDeps.home },
  homedir: () => knownHostsDeps.home,
}));

import { fingerprintHostKey, hostKeyVerdict, pinHostKey } from './known-hosts';

const keyA = Buffer.from('ssh-ed25519 AAAA-host-key-alpha');
const keyB = Buffer.from('ssh-ed25519 BBBB-host-key-bravo');
const knownHostsFile = path.join(knownHostsDeps.home, '.nexus', 'known_hosts.json');

describe('ssh known-hosts (trust-on-first-use)', () => {
  beforeEach(() => {
    fs.rmSync(knownHostsDeps.home, { recursive: true, force: true });
  });

  afterAll(() => {
    fs.rmSync(knownHostsDeps.home, { recursive: true, force: true });
  });

  it('produces an OpenSSH-style SHA256 fingerprint without padding', () => {
    const fingerprint = fingerprintHostKey(keyA);
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(fingerprint.endsWith('=')).toBe(false);
    // Deterministic for a given key.
    expect(fingerprintHostKey(keyA)).toBe(fingerprint);
  });

  it('reports an unseen host key as unknown', () => {
    const { verdict, fingerprint } = hostKeyVerdict('example.com', 22, keyA);
    expect(verdict).toBe('unknown');
    expect(fingerprint).toBe(fingerprintHostKey(keyA));
  });

  it('matches the same key after pinning (trust-on-first-use)', () => {
    pinHostKey('example.com', 22, keyA);
    expect(hostKeyVerdict('example.com', 22, keyA).verdict).toBe('match');
    // The pin is durable on disk (mode 0600).
    const raw = JSON.parse(fs.readFileSync(knownHostsFile, 'utf8'));
    expect(raw['example.com:22']).toBe(fingerprintHostKey(keyA));
    expect(fs.statSync(knownHostsFile).mode & 0o777).toBe(0o600);
  });

  it('rejects a CHANGED key for a pinned host (MITM fail-closed)', () => {
    pinHostKey('example.com', 22, keyA);
    expect(hostKeyVerdict('example.com', 22, keyB).verdict).toBe('mismatch');
  });

  it('pins per host:port — a different port is independent', () => {
    pinHostKey('example.com', 22, keyA);
    expect(hostKeyVerdict('example.com', 2222, keyA).verdict).toBe('unknown');
  });
});
