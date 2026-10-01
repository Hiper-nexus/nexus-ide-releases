import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../context.js';
import { unsubscribeDonePage, unsubscribeInvalidPage } from '../auth-pages.js';
import { verifyNoticeToken } from './unsubscribe.js';

const ACCOUNT_ID = /^[\w:.-]{1,100}$/;

/** Devolve a conta se (e só se) o link assinado confere; qualquer outra coisa é "inválido", sem distinguir o motivo. */
async function verifiedAccount(c: Context<AppEnv>): Promise<string | null> {
  const account = c.req.query('a') ?? '';
  const token = c.req.query('t') ?? '';
  if (!ACCOUNT_ID.test(account)) return null;
  return await verifyNoticeToken(c.get('config').NOTICE_SECRET, account, token) ? account : null;
}

/** Idempotente, e sem erro para conta inexistente: o resultado não revela quais contas existem. */
async function optOut(c: Context<AppEnv>, accountId: string): Promise<void> {
  await c.env.DB.prepare('UPDATE accounts SET notices_opt_out=1 WHERE id=?').bind(accountId).run();
}

/**
 * Sem login: o token assinado é a credencial. Passam pelo limitador da API como o resto de /v1.
 * O GET descadastra direto de propósito (quem clica no e-mail quer sair); o POST é o one-click do RFC 8058.
 */
export const noticeRoutes = new Hono<AppEnv>()
  .get('/notices/unsubscribe', async (c) => {
    // O Hono responde HEAD com o handler de GET; um HEAD (pré-visualização de link) não pode descadastrar ninguém.
    if (c.req.method === 'HEAD') return c.body(null, 200);
    const account = await verifiedAccount(c);
    if (account === null) return unsubscribeInvalidPage(c);
    await optOut(c, account);
    return unsubscribeDonePage(c, c.get('config').PUBLIC_SITE_URL);
  })
  .post('/notices/unsubscribe', async (c) => {
    const account = await verifiedAccount(c);
    c.header('Cache-Control', 'no-store');
    if (account === null) return c.json({ ok: false, error: 'Link inválido.' }, 400);
    await optOut(c, account);
    return c.json({ ok: true });
  });
