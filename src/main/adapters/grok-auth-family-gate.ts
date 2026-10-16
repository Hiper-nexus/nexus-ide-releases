import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { identityFromAuthBlob } from './managed-credentials';
import { compareAuthFreshness } from './auth-freshness';

type Role = 'fresh' | 'leader' | 'follower-fresh';
const authorities = new Map<string, string>();
/** Cada arquivo que entrou numa família: acha a cópia renovada fora do portão. */
const members = new Map<string, Set<string>>();

export function resetGrokAuthFamiliesForTests(): void { authorities.clear(); members.clear(); }

function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

interface Family { key: string; scope: string; refresh: string }

function family(blob: string): Family | null {
  try {
    const entries = Object.values(JSON.parse(blob)).filter(v => v && typeof v === 'object') as Record<string, unknown>[];
    if (entries.length !== 1) return null;
    const entry = entries[0];
    const subject = identityFromAuthBlob('grok', blob).subject;
    if (!subject || typeof entry.refresh_token !== 'string' || !entry.refresh_token) return null;
    // Codex também casa aqui (subject = user_id do id_token). O mesmo usuário
    // ChatGPT em dois workspaces tem o mesmo user_id: o account_id os separa.
    const scope = JSON.stringify([subject, entry.oidc_issuer, entry.oidc_client_id, entry.team_id, entry.account_id]);
    const key = createHash('sha256').update(JSON.stringify([scope, entry.refresh_token])).digest('hex');
    return { key, scope, refresh: entry.refresh_token };
  } catch { return null; }
}

/** Troca `target` só se ele ainda guarda `expected`; o temporário nunca segue link plantado. */
function replaceIfUnchanged(target: string, expected: string, next: string): boolean {
  const temp = path.join(path.dirname(target), `.grok-auth-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, next, { mode: 0o600, flag: 'wx' });
    // No await between comparison and replacement: a Main-driven login cannot interleave.
    if (read(target) !== expected) return false;
    fs.renameSync(temp, target);
    return true;
  } finally { fs.rmSync(temp, { force: true }); }
}

/**
 * Cópia irmã (mesma conta) que já girou o refresh token desta: um pane renovou
 * no meio da sessão, fora deste portão. Renovar com o token desta apresentaria
 * um refresh token já usado e a rotação derrubaria a conta.
 */
function rotatedSibling(target: string, before: string, identity: Family): string | null {
  for (const member of members.get(identity.key) ?? []) {
    if (member === target) continue;
    const blob = read(member);
    const other = blob ? family(blob) : null;
    if (blob && other && other.scope === identity.scope && other.refresh !== identity.refresh &&
        (compareAuthFreshness(blob, before) ?? 0) > 0) return blob;
  }
  return null;
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
  const joined = members.get(identity.key) ?? new Set<string>();
  members.set(identity.key, joined.add(target));
  let canonical = authorities.get(identity.key) ?? target;
  if (!read(canonical) || family(read(canonical)!)?.scope !== identity.scope) canonical = target;
  if (canonical === target) {
    // Esta cópia lideraria a renovação: adota antes a linhagem que já girou.
    const renewed = rotatedSibling(target, before, identity);
    if (renewed) replaceIfUnchanged(target, before, renewed);
  }
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
  if (!replaceIfUnchanged(target, before, renewed)) throw new Error('A conta mudou durante a renovação.');
  return 'follower-fresh';
}
