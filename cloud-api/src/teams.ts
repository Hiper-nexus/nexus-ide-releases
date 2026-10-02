import { Hono } from 'hono';
import type { AppEnv } from './context.js';
import type { SubscriptionRow, TeamInviteRow, TeamRole } from './db/schema.js';
import { requireNativeAuth } from './middleware.js';
import { hashToken } from './crypto.js';
import { jsonBody } from './http.js';
import { z } from 'zod';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const CODE_LENGTH = 12;
const CODE_GROUP_SIZE = 4;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
type TeamDb = Pick<D1Database, 'prepare' | 'batch'>;
interface MyTeam { readonly id: string; readonly name: string; readonly role: TeamRole; }
export type JoinTeamResult = { readonly ok: true; readonly teamId: string; readonly name: string } | { readonly ok: false; readonly error: string };

function normalizeCode(raw: string): string { return raw.toUpperCase().replace(/[^A-Z2-7]/g, ''); }
function inviteCode(): string {
  const characters = Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), (byte) => BASE32[byte % BASE32.length]).join('');
  return characters.match(/.{1,4}/g)!.join('-');
}
function myTeam(db: TeamDb, accountId: string): Promise<MyTeam | null> {
  return db.prepare('SELECT t.id,t.name,m.role FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.account_id=?').bind(accountId).first<MyTeam>();
}
function liveSubscription(row: SubscriptionRow, now: number): boolean {
  // Mirrors the native team service: active/trialing, or measured grace.
  return row.status === 'active' || row.status === 'trialing' || (row.status === 'past_due' && row.grace_until !== null && row.grace_until > now);
}
export async function createInvite(db: D1Database, teamId: string, createdBy: string, now: () => number = Date.now): Promise<{ readonly code: string; readonly codePrefix: string; readonly expiresAt: Date }> {
  const code = inviteCode();
  const codePrefix = code.slice(0, CODE_GROUP_SIZE);
  const at = now();
  const expiresAt = new Date(at + INVITE_TTL_MS);
  const row = await db.prepare(`INSERT INTO team_invites(code_hash,code_prefix,team_id,created_by,expires_at,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM team_members WHERE team_id=? AND account_id=? AND role='owner') RETURNING code_hash`).bind(await hashToken(normalizeCode(code)), codePrefix, teamId, createdBy, expiresAt.getTime(), at, teamId, createdBy).first();
  if (!row) throw new Error('Team ownership changed before invitation creation');
  return { code, codePrefix, expiresAt };
}
export async function joinTeam(db: D1Database, accountId: string, rawCode: string, now: () => number = Date.now): Promise<JoinTeamResult> {
  const at = now();
  const codeHash = await hashToken(normalizeCode(rawCode));
  const session = db.withSession('first-primary');
  // D1 batch is a transaction. Both statements run on the same connection,
  // and changes() is the result of the immediately preceding conditional insert.
  // This consumes only successful invitations, never a failed seat/account claim.
  const [inserted] = await session.batch<{ team_id: string }>([
    session.prepare(`INSERT INTO team_members(team_id,account_id,role,joined_at)
      SELECT i.team_id,?,'member',? FROM team_invites i
      WHERE i.code_hash=? AND i.revoked_at IS NULL AND i.expires_at>? AND i.used_count<i.max_uses
      AND NOT EXISTS(SELECT 1 FROM team_members WHERE account_id=?)
      AND (SELECT count(*) FROM team_members WHERE team_id=i.team_id) < (
        SELECT seats FROM subscriptions WHERE owner_type='team' AND team_id=i.team_id
        AND (status IN ('active','trialing') OR (status='past_due' AND grace_until>?))
        ORDER BY created_at,id LIMIT 1)
      ON CONFLICT DO NOTHING RETURNING team_id`).bind(accountId, at, codeHash, at, accountId, at),
    session.prepare('UPDATE team_invites SET used_count=used_count+1 WHERE code_hash=? AND changes()=1').bind(codeHash),
  ]);
  const membership = inserted.results[0];
  if (membership) {
    const team = await session.prepare('SELECT name FROM teams WHERE id=?').bind(membership.team_id).first<{ name: string }>();
    if (!team) throw new Error('Joined team is missing');
    return { ok: true, teamId: membership.team_id, name: team.name };
  }
  if (await session.prepare('SELECT team_id FROM team_members WHERE account_id=?').bind(accountId).first()) return { ok: false, error: 'você já está num time' };
  const invite = await session.prepare('SELECT * FROM team_invites WHERE code_hash=? AND revoked_at IS NULL AND expires_at>? AND used_count<max_uses').bind(codeHash, at).first<TeamInviteRow>();
  if (!invite) return { ok: false, error: 'convite inválido ou esgotado' };
  const subscriptions = await session.prepare("SELECT * FROM subscriptions WHERE owner_type='team' AND team_id=? ORDER BY created_at,id").bind(invite.team_id).all<SubscriptionRow>();
  if (!subscriptions.results.some((row) => liveSubscription(row, at))) return { ok: false, error: 'assinatura do time não está ativa' };
  return { ok: false, error: 'sem assento livre — peça ao dono' };
}

export const teamRoutes = new Hono<AppEnv>();
teamRoutes.use('/team', requireNativeAuth);
teamRoutes.use('/team/*', requireNativeAuth);
teamRoutes.post('/team/invites', async (c) => {
  const mine = await myTeam(c.env.DB, c.get('session').account_id);
  if (!mine) return c.json({ ok: false, error: 'sem time' }, 404);
  if (mine.role !== 'owner') return c.json({ ok: false, error: 'só o dono convida' }, 403);
  const invite = await createInvite(c.env.DB, mine.id, c.get('session').account_id);
  return c.json({ ok: true, data: { code: invite.code, codePrefix: invite.codePrefix, url: `${c.get('config').PUBLIC_SITE_URL}/join/${invite.code}`, expiresAt: invite.expiresAt.toISOString() } });
});
teamRoutes.post('/team/join', async (c) => {
  const body = await jsonBody(c.req.raw, z.object({ code: z.string().min(1).max(4096) }).strict());
  const result = await joinTeam(c.env.DB, c.get('session').account_id, body.code);
  return result.ok ? c.json({ ok: true, data: { teamId: result.teamId, name: result.name } }) : c.json({ ok: false, error: result.error }, 409);
});
teamRoutes.get('/team', async (c) => {
  const db = c.env.DB.withSession('first-primary');
  const mine = await myTeam(db, c.get('session').account_id);
  if (!mine) return c.json({ ok: true, data: { team: null } });
  const members = await db.prepare('SELECT m.account_id AS accountId,m.role,a.name,a.email,a.avatar_url AS avatarUrl FROM team_members m JOIN accounts a ON a.id=m.account_id WHERE m.team_id=?').bind(mine.id).all<{ accountId: string; role: TeamRole; name: string | null; email: string; avatarUrl: string | null }>();
  const subscriptions = await db.prepare("SELECT * FROM subscriptions WHERE owner_type='team' AND team_id=? ORDER BY created_at,id").bind(mine.id).all<SubscriptionRow>();
  const sub = subscriptions.results.find((row) => ['active', 'trialing', 'past_due'].includes(row.status)) ?? subscriptions.results[0];
  const invites = mine.role === 'owner' ? (await db.prepare('SELECT code_prefix,used_count,max_uses,expires_at FROM team_invites WHERE team_id=? AND revoked_at IS NULL AND expires_at>?').bind(mine.id, Date.now()).all<Pick<TeamInviteRow, 'code_prefix' | 'used_count' | 'max_uses' | 'expires_at'>>()).results : [];
  return c.json({ ok: true, data: { team: { id: mine.id, name: mine.name, role: mine.role }, members: members.results, seats: { used: members.results.length, total: sub?.seats ?? 0 }, overLimit: sub ? members.results.length > sub.seats : false, status: sub?.status ?? 'none', invites: invites.map((row) => ({ codePrefix: row.code_prefix, usedCount: row.used_count, maxUses: row.max_uses, expiresAt: new Date(row.expires_at).toISOString() })) } });
});
teamRoutes.delete('/team/invites/:codePrefix', async (c) => {
  const accountId = c.get('session').account_id;
  const mine = await myTeam(c.env.DB, accountId);
  if (!mine || mine.role !== 'owner') return c.json({ ok: false, error: 'só o dono' }, 403);
  await c.env.DB.prepare("UPDATE team_invites SET revoked_at=? WHERE team_id=? AND code_prefix=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM team_members WHERE team_id=? AND account_id=? AND role='owner')").bind(Date.now(), mine.id, c.req.param('codePrefix'), mine.id, accountId).run();
  return c.json({ ok: true });
});
teamRoutes.delete('/team/members/:accountId', async (c) => {
  const accountId = c.get('session').account_id;
  const mine = await myTeam(c.env.DB, accountId);
  if (!mine || mine.role !== 'owner') return c.json({ ok: false, error: 'só o dono' }, 403);
  const target = c.req.param('accountId');
  if (target === accountId) return c.json({ ok: false, error: 'o dono não remove a si — cancele no portal' }, 400);
  await c.env.DB.prepare("DELETE FROM team_members WHERE team_id=? AND account_id=? AND role='member' AND EXISTS(SELECT 1 FROM team_members WHERE team_id=? AND account_id=? AND role='owner')").bind(mine.id, target, mine.id, accountId).run();
  return c.json({ ok: true });
});
teamRoutes.post('/team/leave', async (c) => {
  const accountId = c.get('session').account_id;
  const mine = await myTeam(c.env.DB, accountId);
  if (!mine) return c.json({ ok: false, error: 'sem time' }, 404);
  if (mine.role === 'owner') return c.json({ ok: false, error: 'o dono não sai — cancele a assinatura' }, 409);
  await c.env.DB.prepare("DELETE FROM team_members WHERE team_id=? AND account_id=? AND role='member'").bind(mine.id, accountId).run();
  return c.json({ ok: true });
});
