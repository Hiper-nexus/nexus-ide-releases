import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../context.js';
import { emailConfigured } from '../config.js';
import { requireAdmin, requireCsrf, requireWebAuth } from '../middleware.js';
import { sendTestNotice } from './dispatch.js';
import { isDeliverableEmail } from './notices.js';

interface AddressRow { readonly email: string; readonly name: string | null; readonly identity_email: string | null }

/**
 * Painel admin: manda o aviso de 3 dias só para o e-mail de quem chamou, para provar o Resend antes de ligar o cron.
 * As guardas são explícitas (e não herdadas do roteador de admin): esta rota tem de se proteger sozinha.
 */
export function createNoticeAdminRoutes(fetchFn?: typeof fetch): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.post('/admin/notices/test', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); }, requireWebAuth, requireAdmin, requireCsrf, async (c) => {
    if (!emailConfigured(c.get('config'))) throw new HTTPException(503, { message: 'Defina EMAIL_ENABLED, RESEND_API_KEY e NOTICE_SECRET para enviar e-mails.' });
    const accountId = c.get('session').account_id;
    const row = await c.env.DB.prepare(`SELECT a.email AS email, a.name AS name,
        (SELECT i.email FROM identities i WHERE i.account_id=a.id AND i.email_verified=1 AND instr(i.email,'@')>1 ORDER BY i.created_at LIMIT 1) AS identity_email
      FROM accounts a WHERE a.id=?`).bind(accountId).first<AddressRow>();
    const to = row === null ? null : [row.email, row.identity_email].find(isDeliverableEmail) ?? null;
    if (row === null || to === null) throw new HTTPException(409, { message: 'Sua conta não tem um e-mail verificado para receber o teste.' });

    const result = await sendTestNotice(c.env, { accountId, to, name: row.name }, fetchFn);
    // O endereço nunca entra na auditoria: só o tipo, o resultado e o código do erro.
    const details = result.ok ? { kind: 'trial_ending_3d', sent: true } : { kind: 'trial_ending_3d', sent: false, reason: result.reason };
    await c.env.DB.prepare("INSERT INTO admin_audit(id,actor_account_id,target_account_id,action,details,created_at) VALUES(?,?,NULL,'test_notice',?,?)")
      .bind(crypto.randomUUID(), accountId, JSON.stringify(details), Date.now()).run();
    return c.json(result.ok ? { ok: true, sent: true } : { ok: true, sent: false, reason: result.reason });
  });
  return routes;
}
