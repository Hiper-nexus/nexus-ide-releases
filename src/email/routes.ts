import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../context.js';
import { unsubscribeConfirmPage, unsubscribeDonePage, unsubscribeInvalidPage } from '../auth-pages.js';
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
 * O GET só mostra a página com o botão: scanners de link de empresa abrem todo link do e-mail e descadastrariam a
 * pessoa antes de ela ler o aviso. Quem descadastra é o POST: o botão da página (`confirm=1`) e o one-click do RFC 8058
 * que os provedores de e-mail enviam por conta própria (`List-Unsubscribe=One-Click`).
 */
export const noticeRoutes = new Hono<AppEnv>()
  .get('/notices/unsubscribe', async (c) => {
    const account = await verifiedAccount(c);
    if (account === null) return unsubscribeInvalidPage(c);
    const action = new URL('/v1/notices/unsubscribe', 'https://placeholder.invalid');
    action.searchParams.set('a', account);
    action.searchParams.set('t', c.req.query('t') ?? '');
    return unsubscribeConfirmPage(c, `${action.pathname}${action.search}`);
  })
  .post('/notices/unsubscribe', async (c) => {
    const account = await verifiedAccount(c);
    const form: Record<string, unknown> = await c.req.parseBody().catch(() => ({}));
    const fromPage = form['confirm'] === '1';
    if (fromPage) {
      if (account === null) return unsubscribeInvalidPage(c);
      await optOut(c, account);
      return unsubscribeDonePage(c, c.get('config').PUBLIC_SITE_URL);
    }
    c.header('Cache-Control', 'no-store');
    if (account === null) return c.json({ ok: false, error: 'Link inválido.' }, 400);
    await optOut(c, account);
    return c.json({ ok: true });
  });
