import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { identityFromAuthBlob } from './managed-credentials';
import { compareAuthFreshness } from './auth-freshness';

type Role = 'fresh' | 'leader' | 'follower-fresh';
const authorities = new Map<string, string>();

export function resetGrokAuthFamiliesForTests(): void { authorities.clear(); }

function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function family(blob: string): { key: string; scope: string } | null {
  try {
    const entries = Object.values(JSON.parse(blob)).filter(v => v && typeof v === 'object') as Record<string, unknown>[];
    if (entries.length !== 1) return null;
    const entry = entries[0];
    const subject = identityFromAuthBlob('grok', blob).subject;
    if (!subject || typeof entry.refresh_token !== 'string' || !entry.refresh_token) return null;
    const scope = JSON.stringify([subject, entry.oidc_issuer, entry.oidc_client_id, entry.team_id]);
    const key = createHash('sha256').update(JSON.stringify([scope, entry.refresh_token])).digest('hex');
    return { key, scope };
  } catch { return null; }
}

/** Main-owned spawns and quota probes share one leader even for copied credentials. */
export async function withGrokAuthFamilyGate(
  authFile: string,
  run: (canonicalFile: string) => Promise<Role>,
): Promise<Role> {
  const before = read(authFile);
  const identity = before ? family(before) : null;
  if (!identity || !before) return run(authFile);
  const target = fs.realpathSync(authFile);
  let canonical = authorities.get(identity.key) ?? target;
  if (!read(canonical) || family(read(canonical)!)?.scope !== identity.scope) canonical = target;
  authorities.set(identity.key, canonical);
  let role = await run(canonical);
  if (canonical === target) return role;
  if (role === 'leader') {
    // The earlier lease expired without a refresh. The new actual writer owns
    // the next attempt; keep the old lease until its normal timeout.
    authorities.set(identity.key, target);
    role = await run(target);
    return role;
  }
  const renewed = read(canonical);
  const current = read(target);
  if (!renewed || !current || family(renewed)?.scope !== identity.scope ||
      family(current)?.scope !== identity.scope) throw new Error('A conta mudou durante a renovação.');
  if (renewed === current) return role;
  if (current !== before) throw new Error('A sessão mudou durante a renovação.');
  if ((compareAuthFreshness(renewed, current) ?? 0) <= 0) throw new Error('A renovação da sessão ainda não foi comprovada.');
  const temp = path.join(path.dirname(target), `.grok-auth-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, renewed, { mode: 0o600, flag: 'wx' });
    // No await between comparison and replacement: a Main-driven login cannot interleave.
    if (read(target) !== before) throw new Error('A conta mudou durante a renovação.');
    fs.renameSync(temp, target);
  } finally { fs.rmSync(temp, { force: true }); }
  return 'follower-fresh';
}
