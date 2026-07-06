import { Router } from 'express';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client';
import type { Env } from '../env';
import { accounts, subscriptions, teamInvites, teamMembers, teams } from '../db/schema';
import { asyncHandler as ah } from '../middleware/errors';
import { rateLimit } from '../middleware/rate-limit';
import { requireAuth } from '../middleware/require-auth';
import { createInvite, joinTeam } from './team-service';

const LIVE = ['active', 'trialing', 'past_due'];

export function buildTeamRouter(deps: { db: Db; env: Env; now?: () => number }): Router {
  const { db, env } = deps;
  const now = deps.now ?? Date.now;
  const r = Router();
  const limit = rateLimit({ windowMs: 60_000, max: 30 });

  async function myTeam(accountId: string) {
    const [membership] = await db.select().from(teamMembers)
      .where(eq(teamMembers.accountId, accountId))
      .limit(1);
    if (!membership) return null;
    const [team] = await db.select().from(teams)
      .where(eq(teams.id, membership.teamId))
      .limit(1);
    return { team, role: membership.role };
  }

  r.post('/team/invites', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine) return res.status(404).json({ ok: false, error: 'sem time' });
    if (mine.role !== 'owner') {
      return res.status(403).json({ ok: false, error: 'só o dono convida' });
    }
    const invite = await createInvite(db, mine.team.id, req.accountId!, now);
    res.json({
      ok: true,
      data: {
        code: invite.code,
        codePrefix: invite.codePrefix,
        url: `${env.PUBLIC_SITE_URL}/join/${invite.code}`,
        expiresAt: invite.expiresAt.toISOString(),
      },
    });
  }));

  r.post('/team/join', limit, requireAuth(db), ah(async (req, res) => {
    const code = String((req.body as { code?: string }).code ?? '');
    const out = await joinTeam(db, req.accountId!, code, now);
    if (!out.ok) return res.status(409).json({ ok: false, error: out.error });
    res.json({ ok: true, data: { teamId: out.teamId, name: out.name } });
  }));

  r.get('/team', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine) return res.json({ ok: true, data: { team: null } });

    const members = await db.select({
      accountId: teamMembers.accountId,
      role: teamMembers.role,
      name: accounts.name,
      email: accounts.email,
      avatarUrl: accounts.avatarUrl,
    })
      .from(teamMembers)
      .innerJoin(accounts, eq(accounts.id, teamMembers.accountId))
      .where(eq(teamMembers.teamId, mine.team.id));
    const teamSubs = await db.select().from(subscriptions).where(and(
      eq(subscriptions.ownerType, 'team'),
      eq(subscriptions.teamId, mine.team.id),
    ));
    const sub = teamSubs.find((row) => LIVE.includes(row.status)) ?? teamSubs[0];
    const invites = mine.role === 'owner'
      ? await db.select({
        codePrefix: teamInvites.codePrefix,
        usedCount: teamInvites.usedCount,
        maxUses: teamInvites.maxUses,
        expiresAt: teamInvites.expiresAt,
      })
        .from(teamInvites)
        .where(and(
          eq(teamInvites.teamId, mine.team.id),
          isNull(teamInvites.revokedAt),
          gt(teamInvites.expiresAt, new Date(now())),
        ))
      : [];

    res.json({
      ok: true,
      data: {
        team: { id: mine.team.id, name: mine.team.name, role: mine.role },
        members,
        seats: { used: members.length, total: sub?.seats ?? 0 },
        overLimit: sub ? members.length > sub.seats : false,
        status: sub?.status ?? 'none',
        invites,
      },
    });
  }));

  r.delete('/team/invites/:codePrefix', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine || mine.role !== 'owner') {
      return res.status(403).json({ ok: false, error: 'só o dono' });
    }
    await db.update(teamInvites)
      .set({ revokedAt: new Date(now()) })
      .where(and(
        eq(teamInvites.teamId, mine.team.id),
        eq(teamInvites.codePrefix, String(req.params.codePrefix)),
        isNull(teamInvites.revokedAt),
      ));
    res.json({ ok: true });
  }));

  r.delete('/team/members/:accountId', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine || mine.role !== 'owner') {
      return res.status(403).json({ ok: false, error: 'só o dono' });
    }
    const targetAccountId = String(req.params.accountId);
    if (targetAccountId === req.accountId) {
      return res.status(400).json({ ok: false, error: 'o dono não remove a si — cancele no portal' });
    }
    await db.delete(teamMembers).where(and(
      eq(teamMembers.teamId, mine.team.id),
      eq(teamMembers.accountId, targetAccountId),
    ));
    res.json({ ok: true });
  }));

  r.post('/team/leave', limit, requireAuth(db), ah(async (req, res) => {
    const mine = await myTeam(req.accountId!);
    if (!mine) return res.status(404).json({ ok: false, error: 'sem time' });
    if (mine.role === 'owner') {
      return res.status(409).json({ ok: false, error: 'o dono não sai — cancele a assinatura' });
    }
    await db.delete(teamMembers).where(and(
      eq(teamMembers.teamId, mine.team.id),
      eq(teamMembers.accountId, req.accountId!),
    ));
    res.json({ ok: true });
  }));

  return r;
}
