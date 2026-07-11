// Managed-hook consent gate (option A: prompt on first use).
//
// Installing managed status hooks edits the user's GLOBAL agent config
// (~/.claude/settings.json and ~/.codex/hooks.json), which affects Claude/Codex
// even outside NexusIDE. That must not happen silently: we persist a one-time
// decision and only install after the user explicitly consents. The decision is
// stored under Electron userData (never a project tree).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export type ManagedHookConsent = 'undecided' | 'granted' | 'denied';

function consentFilePath(userDataPath: string): string {
  return join(userDataPath, 'agent-hooks', 'consent.json');
}

export function readManagedHookConsent(userDataPath: string): ManagedHookConsent {
  const path = consentFilePath(userDataPath);
  if (!existsSync(path)) return 'undecided';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { consent?: unknown };
    if (parsed.consent === 'granted' || parsed.consent === 'denied') {
      return parsed.consent;
    }
    return 'undecided';
  } catch {
    // A corrupt consent file is treated as undecided — we ask again rather than
    // assume consent.
    return 'undecided';
  }
}

export function writeManagedHookConsent(
  userDataPath: string,
  consent: Exclude<ManagedHookConsent, 'undecided'>,
): void {
  const path = consentFilePath(userDataPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ consent }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) {
      try {
        unlinkSync(tmp);
      } catch {
        // best effort
      }
    }
  }
}

/**
 * Resolve the managed-hook consent, prompting once if the user has not decided.
 * Returns the effective decision; the prompt is injected so main supplies the
 * native dialog and tests supply a fake.
 */
export async function resolveManagedHookConsent(options: {
  userDataPath: string;
  prompt: () => Promise<'granted' | 'denied'>;
}): Promise<Exclude<ManagedHookConsent, 'undecided'>> {
  const current = readManagedHookConsent(options.userDataPath);
  if (current !== 'undecided') return current;
  const decision = await options.prompt();
  writeManagedHookConsent(options.userDataPath, decision);
  return decision;
}
