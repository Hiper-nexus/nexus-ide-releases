import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Enumerate the public-key identities currently loaded in the user's SSH agent
 * and return their OpenSSH-style SHA256 fingerprints.
 *
 * H3 mitigation: the IPC layer previously passed `allowedFingerprints: ['*']`,
 * which offered EVERY agent identity to any host — leaking all public keys and
 * allowing signing with the wrong key. Callers now use this list as the
 * allowlist so only identities the user actually loaded are offered.
 *
 * Assíncrono: um `ssh-add -L` contra um agente lento/travado (ex.: agente
 * remoto via SSH_AUTH_SOCK) pode levar até o timeout de 5 s — com execFileSync
 * isso congelava o main process inteiro (UI). O fluxo de conexão já é async.
 *
 * Returns an empty array when no agent is running or no keys are loaded
 * (fail-closed: the session manager rejects an empty allowlist).
 */
export async function enumerateSshAgentFingerprints(): Promise<string[]> {
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync('ssh-add', ['-L'], {
      encoding: 'utf8',
      timeout: 5_000,
    }));
  } catch {
    // No agent running, or no identities loaded (ssh-add exits non-zero).
    return [];
  }
  return parseAgentIdentities(output);
}

/** Parse puro do `ssh-add -L` → fingerprints SHA256 (testável sem agente). */
export function parseAgentIdentities(output: string): string[] {
  const fingerprints: string[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    // "The agent has no identities" nunca chega aqui no fluxo real (ssh-add sai
    // com status ≠ 0 → catch), mas o parser é puro/exportado: se alimentado com
    // essa linha, 'agent' decodificaria como base64 e fabricaria um fingerprint
    // bogus — uma allowlist não-vazia FALSA que driblaria o fail-closed.
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
