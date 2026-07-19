import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Enumerate the public-key identities currently loaded in the user's SSH agent
 * and return their OpenSSH-style SHA256 fingerprints.
 *
 * H3 mitigation: the IPC layer previously passed `allowedFingerprints: ['*']`,
 * which offered EVERY agent identity to any host — leaking all public keys and
 * allowing signing with the wrong key. Callers now use this list as the
 * allowlist so only identities the user actually loaded are offered.
 *
 * Returns an empty array when no agent is running or no keys are loaded
 * (fail-closed: the session manager rejects an empty allowlist).
 */
export function enumerateSshAgentFingerprints(): string[] {
  let output: string;
  try {
    output = execFileSync('ssh-add', ['-L'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
  } catch {
    // No agent running, or no identities loaded.
    return [];
  }
  const fingerprints: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('The agent has no identities')) continue;
    // Format: "<key-type> <base64-blob> <comment>"
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const blob = parts[1];
    try {
      const raw = Buffer.from(blob, 'base64');
      const hash = createHash('sha256').update(raw).digest('base64').replace(/=+$/u, '');
      fingerprints.push(`SHA256:${hash}`);
    } catch {
      // Skip malformed entries.
    }
  }
  return fingerprints;
}
