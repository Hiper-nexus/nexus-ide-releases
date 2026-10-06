import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { AppEnv } from './context.js';
import type { AccountRow, AdminAuditAction, LicenseCodeRow } from './db/schema.js';
import { jsonBody } from './http.js';
import { emailConfigured } from './config.js';
import { CLASSIFIED, LIVE, adminEmails } from './classified.js';
import { disableCoupon, insertCoupon, listCoupons } from './coupons.js';
import { mintLicenseCode } from './license-codes.js';
import { requireAdmin, requireCsrf, requireWebAuth } from './middleware.js';
import { decodeAccountCursor, encodeAccountCursor } from './admin-cursor.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SITUATIONS = ['trial', 'active', 'suspended', 'expired'] as const;
type Situation = typeof SITUATIONS[number];
const listSchema = z.strictObject({
  status: z.enum(['all', ...SITUATIONS]).default('all'),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  email: z.string().trim().max(200).optional(),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/).optional(),
});
const suspendSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });
const extendSchema = z.strictObject({ days: z.number().int().min(1).max(30) });
const mintCodeSchema = z.strictObject({
  // NULL = licença perpétua; expiresInDays limita o CÓDIGO, não a licença.
  periodDays: z.number().int().min(1).max(36500).nullish(),
  maxUses: z.number().int().min(1).max(100).default(1),
  note: z.string().trim().max(200).default(''),
  expiresInDays: z.number().int().min(1).max(3650).nullish(),
});

async function targetAccount(c: Context<AppEnv>): Promise<AccountRow> {
  const account = await c.env.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(c.req.param('id')).first<AccountRow>();
  if (!account) throw new HTTPException(404, { message: 'Conta não encontrada.' });
  return account;
}

/** Audit row. With `guarded`, it is only written while the target still has the suspension
 * state the admin saw, so a change that loses a race leaves no audit entry either. */
function audit(c: Context<AppEnv>, target: AccountRow, action: AdminAuditAction, details: Record<string, unknown>, now: number, guarded = true): D1PreparedStatement {
  const values = [crypto.randomUUID(), c.get('session').account_id, target.id, action, JSON.stringify(details), now];
  return guarded
    ? c.env.DB.prepare('INSERT INTO admin_audit(id,actor_account_id,target_account_id,action,details,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM accounts WHERE id=? AND suspended_at IS ?)').bind(...values, target.id, target.suspended_at)
    : c.env.DB.prepare('INSERT INTO admin_audit(id,actor_account_id,target_account_id,action,details,created_at) VALUES(?,?,?,?,?,?)').bind(...values);
}
const STALE = 'A situação desta conta mudou. Atualize a lista e tente novamente.';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('/admin/*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); }, requireWebAuth, requireAdmin);

adminRoutes.get('/admin/overview', async (c) => {
  const counts = SITUATIONS.map(name => `count(CASE WHEN situation='${name}' THEN 1 END) AS ${name}`).join(',');
  const row = await c.env.DB.prepare(`${CLASSIFIED} SELECT count(*) AS accounts,${counts} FROM classified`).bind(Date.now(), adminEmails(c.get('config'))).first<Record<'accounts' | Situation, number>>();
  return c.json({ ok: true, data: row ?? { accounts: 0, trial: 0, active: 0, suspended: 0, expired: 0 } });
});

adminRoutes.get('/admin/accounts', async (c) => {
  const query = listSchema.safeParse(c.req.query());
  if (!query.success) throw new HTTPException(400, { message: 'Filtro inválido.' });
  const cursor = query.data.cursor === undefined ? null : decodeAccountCursor(query.data.cursor);
  if (query.data.cursor !== undefined && cursor === null) throw new HTTPException(400, { message: 'Cursor inválido.' });
  // last_seen_at é a última entrada real: findOrCreateAccount grava no login OAuth (conta nova, vínculo por e-mail e retorno).
  // sessions.last_used_at não é preenchido e a sessão expira; a lista não deriva dali.
  type Row = Pick<AccountRow, 'id' | 'email' | 'name' | 'trial_expires_at' | 'last_seen_at' | 'created_at'> & { is_admin: number; situation: Situation; subscription_status: string | null; last_app_seen_at: number | null };
  const rows = await c.env.DB.prepare(`${CLASSIFIED} SELECT id,email,name,trial_expires_at,last_seen_at,created_at,is_admin,situation,
      (SELECT t.last_app_seen_at FROM account_activity t WHERE t.account_id=classified.id) AS last_app_seen_at,
      (SELECT s.status FROM subscriptions s WHERE (s.owner_type='account' AND s.account_id=classified.id)
        OR (s.owner_type='team' AND s.team_id IN (SELECT team_id FROM team_members WHERE account_id=classified.id)) ORDER BY ${LIVE} DESC,s.updated_at DESC LIMIT 1) AS subscription_status
    FROM classified WHERE (?3='all' OR situation=?3)
      AND (?5 IS NULL OR instr(lower(email), lower(?5))>0)
      AND (?6 IS NULL OR created_at<?6 OR (created_at=?6 AND id>?7))
    ORDER BY created_at DESC, id LIMIT ?4`)
    .bind(Date.now(), adminEmails(c.get('config')), query.data.status, query.data.limit + 1, query.data.email ? query.data.email : null, cursor?.createdAt ?? null, cursor?.id ?? null).all<Row>();
  const page = rows.results.slice(0, query.data.limit);
  const last = rows.results.length > query.data.limit ? page.at(-1) : undefined;
  return c.json({ ok: true, data: {
    accounts: page.map(row => ({
      id: row.id, email: row.email.includes('@') ? row.email : '', name: row.name, role: row.is_admin ? 'admin' : 'user',
      access: row.situation === 'active' ? 'pro' : row.situation, trialEndsAt: row.trial_expires_at === null ? null : new Date(row.trial_expires_at).toISOString(),
      subscriptionStatus: row.subscription_status ?? 'none',
      lastSeenAt: row.last_seen_at === null ? null : new Date(row.last_seen_at).toISOString(),
      lastAppSeenAt: row.last_app_seen_at === null ? null : new Date(row.last_app_seen_at).toISOString(),
    })),
    nextCursor: last ? encodeAccountCursor({ createdAt: last.created_at, id: last.id }) : null,
  } });
});

// Suspension blocks NexusIDE access only. It never cancels the Stripe subscription, and the
// account keeps its sessions so the owner can still open the billing portal.
adminRoutes.post('/admin/accounts/:id/suspend', requireCsrf, async (c) => {
  const { reason } = await jsonBody(c.req.raw, suspendSchema);
  const target = await targetAccount(c), now = Date.now();
  if (target.id === c.get('session').account_id) throw new HTTPException(409, { message: 'Você não pode suspender a própria conta.' });
  if (target.suspended_at !== null) throw new HTTPException(409, { message: 'Esta conta já está suspensa.' });
  // The audit row and the change share one predicate and one batch: a concurrent change makes both no-ops.
  const [, changed] = await c.env.DB.batch<{ id: string }>([
    audit(c, target, 'suspend', { reason }, now),
    c.env.DB.prepare('UPDATE accounts SET suspended_at=?,suspension_reason=?,updated_at=? WHERE id=? AND suspended_at IS NULL RETURNING id').bind(now, reason, now, target.id),
  ]);
  if (!changed.results.length) throw new HTTPException(409, { message: STALE });
  return c.json({ ok: true, data: {} });
});

adminRoutes.post('/admin/accounts/:id/resume', requireCsrf, async (c) => {
  const target = await targetAccount(c), now = Date.now();
  if (target.suspended_at === null) throw new HTTPException(409, { message: 'Esta conta não está suspensa.' });
  const [, changed] = await c.env.DB.batch<{ id: string }>([
    audit(c, target, 'resume', {}, now),
    c.env.DB.prepare('UPDATE accounts SET suspended_at=NULL,suspension_reason=NULL,updated_at=? WHERE id=? AND suspended_at=? RETURNING id').bind(now, target.id, target.suspended_at),
  ]);
  if (!changed.results.length) throw new HTTPException(409, { message: STALE });
  return c.json({ ok: true, data: {} });
});

adminRoutes.post('/admin/accounts/:id/extend-trial', requireCsrf, async (c) => {
  const { days } = await jsonBody(c.req.raw, extendSchema);
  const target = await targetAccount(c), now = Date.now();
  // The new end is computed in SQL from the stored value, so concurrent extensions add up instead of overwriting.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE accounts SET trial_started_at=COALESCE(trial_started_at,?1),trial_expires_at=max(?1,COALESCE(trial_expires_at,?1))+?2,updated_at=?1 WHERE id=?3').bind(now, days * DAY_MS, target.id),
    audit(c, target, 'extend_trial', { days, previousEnd: target.trial_expires_at === null ? null : new Date(target.trial_expires_at).toISOString() }, now, false),
    // Um prazo novo reabre os avisos de fim de teste (o de boas-vindas não volta). Só com e-mail configurado: sem ele a tabela nem precisa existir ainda.
    ...(emailConfigured(c.get('config')) ? [c.env.DB.prepare("DELETE FROM account_notices WHERE account_id=? AND kind IN ('trial_ending_3d','trial_ending_1d','trial_ended')").bind(target.id)] : []),
  ]);
  return c.json({ ok: true, data: {} });
});

/** Ações de código não têm conta-alvo: target_account_id fica nulo no audit. */
function codeAudit(c: Context<AppEnv>, action: AdminAuditAction, details: Record<string, unknown>, now: number): D1PreparedStatement {
  return c.env.DB.prepare('INSERT INTO admin_audit(id,actor_account_id,target_account_id,action,details,created_at) VALUES(?,?,NULL,?,?,?)')
    .bind(crypto.randomUUID(), c.get('session').account_id, action, JSON.stringify(details), now);
}

adminRoutes.get('/admin/license-codes', async (c) => {
  type Row = Pick<LicenseCodeRow, 'id' | 'code_suffix' | 'plan' | 'period_days' | 'max_uses' | 'note' | 'expires_at' | 'revoked_at' | 'created_at'>
    & { uses: number; created_by_email: string | null };
  const rows = await c.env.DB.prepare(`SELECT c.id,c.code_suffix,c.plan,c.period_days,c.max_uses,c.note,c.expires_at,c.revoked_at,c.created_at,
      (SELECT COUNT(*) FROM license_redemptions r WHERE r.code_id=c.id) AS uses, a.email AS created_by_email
    FROM license_codes c LEFT JOIN accounts a ON a.id=c.created_by ORDER BY c.created_at DESC LIMIT 200`).all<Row>();
  return c.json({ ok: true, data: { codes: rows.results.map(row => ({
    id: row.id, suffix: row.code_suffix, plan: row.plan, periodDays: row.period_days, maxUses: row.max_uses, uses: row.uses,
    note: row.note, createdBy: row.created_by_email?.includes('@') ? row.created_by_email : null,
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  })) } });
});

// O plaintext volta exatamente uma vez na resposta; o banco guarda só o hash.
adminRoutes.post('/admin/license-codes', requireCsrf, async (c) => {
  const body = await jsonBody(c.req.raw, mintCodeSchema);
  const now = Date.now();
  const minted = await mintLicenseCode(c.env.DB, {
    createdBy: c.get('session').account_id, periodDays: body.periodDays ?? null,
    maxUses: body.maxUses, note: body.note,
    expiresAt: body.expiresInDays ? now + body.expiresInDays * DAY_MS : null,
  }, now);
  await c.env.DB.batch([codeAudit(c, 'mint_license_code', { codeId: minted.id, suffix: minted.code.slice(-4), maxUses: body.maxUses, periodDays: body.periodDays ?? null }, now)]);
  return c.json({ ok: true, data: minted });
});

// Revogar tem efeito real: para novos resgates E derruba as concessões feitas
// por este código (suspensão de conta continua sendo o caminho para o usuário).
adminRoutes.post('/admin/license-codes/:id/revoke', requireCsrf, async (c) => {
  const id = c.req.param('id'), now = Date.now();
  const code = await c.env.DB.prepare('SELECT id,revoked_at FROM license_codes WHERE id=?').bind(id).first<Pick<LicenseCodeRow, 'id' | 'revoked_at'>>();
  if (!code) throw new HTTPException(404, { message: 'Código não encontrado.' });
  if (code.revoked_at !== null) throw new HTTPException(409, { message: 'Este código já está revogado.' });
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE license_codes SET revoked_at=? WHERE id=?').bind(now, id),
    c.env.DB.prepare("DELETE FROM subscriptions WHERE stripe_subscription_id IN (SELECT 'codegrant:'||code_id||':'||account_id FROM license_redemptions WHERE code_id=?)").bind(id),
    // Mesmo recálculo de cache de plano que o webhook da Stripe mantém.
    c.env.DB.prepare(`UPDATE accounts SET updated_at=?1,plan=CASE WHEN EXISTS(SELECT 1 FROM subscriptions s WHERE s.owner_type='account' AND s.account_id=accounts.id
        AND ((s.status IN('active','trialing') AND s.current_period_end>?1) OR (s.status='past_due' AND s.grace_until>?1))) THEN 'pro' ELSE 'free' END
      WHERE id IN (SELECT account_id FROM license_redemptions WHERE code_id=?2)`).bind(now, id),
    codeAudit(c, 'revoke_license_code', { codeId: id }, now),
  ]);
  return c.json({ ok: true, data: {} });
});

const createCouponSchema = z.strictObject({
  code: z.string().trim().min(1).max(40),
  kind: z.enum(['percent', 'amount']),
  value: z.number().int().positive().max(100_000_000),
  intervals: z.array(z.enum(['month', 'quarter', 'semiannual', 'year'])).min(1).max(4),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/).nullish(),
  maxRedemptions: z.number().int().min(1).max(100_000).nullish(),
});

adminRoutes.get('/admin/coupons', async (c) => {
  return c.json({ ok: true, data: { coupons: await listCoupons(c.env.DB) } });
});

adminRoutes.post('/admin/coupons', requireCsrf, async (c) => {
  const body = await jsonBody(c.req.raw, createCouponSchema);
  const now = Date.now();
  const expiresAt = body.expiresAt ? Date.parse(body.expiresAt) : null;
  if (body.expiresAt && !Number.isFinite(expiresAt)) throw new HTTPException(400, { message: 'A validade do cupom precisa ser uma data futura.' });
  const created = await insertCoupon(c.env.DB, {
    code: body.code, kind: body.kind, value: body.value, intervals: body.intervals,
    expiresAt, maxRedemptions: body.maxRedemptions ?? null, createdBy: c.get('session').account_id,
  }, now);
  await c.env.DB.batch([codeAudit(c, 'create_coupon', { couponId: created.id, code: created.code, kind: created.kind, value: created.value, intervals: created.intervals }, now)]);
  return c.json({ ok: true, data: created });
});

adminRoutes.post('/admin/coupons/:id/disable', requireCsrf, async (c) => {
  const id = c.req.param('id'), now = Date.now();
  await disableCoupon(c.env.DB, id, now);
  await c.env.DB.batch([codeAudit(c, 'disable_coupon', { couponId: id }, now)]);
  return c.json({ ok: true, data: {} });
});
