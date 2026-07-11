import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * SSH known-hosts vault (trust-on-first-use). `ssh2` auto-accepts ANY host key
 * when no `hostVerifier` is supplied — unlike the OpenSSH CLI it does not read
 * `~/.ssh/known_hosts` — so an on-path attacker can silently impersonate the
 * destination and capture the session/password. This store pins the SHA256
 * fingerprint per host:port on first connect and, on every later connect,
 * rejects a changed key (fail closed) exactly like `StrictHostKeyChecking`.
 *
 * The file is written 0600 under a 0700 directory (mirrors secrets-store.ts):
 * a fingerprint is not secret, but tamper-resistance of the pin set is what
 * gives the check its value.
 */

const KNOWN_HOSTS_FILE = path.join(os.homedir(), '.nexus', 'known_hosts.json');

export type HostKeyVerdict = 'match' | 'mismatch' | 'unknown';

/** OpenSSH-style fingerprint (`SHA256:<base64, no padding>`) of a raw host key. */
export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function pinKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function loadPins(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function persistPins(pins: Readonly<Record<string, string>>): void {
  const directory = path.dirname(KNOWN_HOSTS_FILE);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryFile = `${KNOWN_HOSTS_FILE}.tmp-${process.pid}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporaryFile, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(pins), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporaryFile, KNOWN_HOSTS_FILE);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original failure remains authoritative.
      }
    }
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

/**
 * Compare a presented host key against the pinned fingerprint for host:port.
 * `unknown` → never seen (caller decides trust-on-first-use); `mismatch` → the
 * key changed since it was pinned (caller MUST reject: possible MITM).
 */
export function hostKeyVerdict(
  host: string,
  port: number,
  key: Buffer,
): { verdict: HostKeyVerdict; fingerprint: string } {
  const fingerprint = fingerprintHostKey(key);
  const pinned = loadPins()[pinKey(host, port)];
  if (pinned === undefined) return { verdict: 'unknown', fingerprint };
  return {
    verdict: pinned === fingerprint ? 'match' : 'mismatch',
    fingerprint,
  };
}

/** Trust a host key for host:port on first use. */
export function pinHostKey(host: string, port: number, key: Buffer): string {
  const fingerprint = fingerprintHostKey(key);
  const pins = loadPins();
  pins[pinKey(host, port)] = fingerprint;
  persistPins(pins);
  return fingerprint;
}
