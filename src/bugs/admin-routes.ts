import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../context.js';
import { jsonBody } from '../http.js';
import { requireAdmin, requireCsrf, requireWebAuth } from '../middleware.js';
import { applyPatch, findReport, getReportDetail, listReports, reportStats } from './admin-store.js';
import { decodeCursor } from './cursor.js';
import { planPatch } from './patch-plan.js';
import { listQuerySchema, patchReportSchema } from './schemas.js';

const MAX_PATCH_BODY_BYTES = 16 * 1024;
const REPORT_ID = /^[0-9a-f-]{36}$/;

const noStore: MiddlewareHandler<AppEnv> = async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); };

function reportId(raw: string | undefined): string {
  if (raw === undefined || !REPORT_ID.test(raw)) throw new HTTPException(404, { message: 'Relato não encontrado.' });
  return raw;
}

/**
 * Painel admin dos relatos de bug. As guardas são EXPLÍCITAS em cada rota (como em email/admin-routes.ts), não
 * herdadas do roteador de /admin/*: o roteador de admin vem depois e estas rotas respondem sozinhas. As mutações
 * exigem também CSRF. É aqui, e só aqui, que o e-mail de quem reportou é revelado.
 *
 * O PATCH com status "approved" é o ponto de AUTORIZAÇÃO HUMANA da correção: só vale vindo de "fix_proposed", e o
 * evento `approved` registra o admin (`actor_account_id`) e a correção aprovada (resumo e URL). A FASE 2 (correção
 * automática por agente) terá de exigir esse status e esse evento; nada aqui executa correção.
 */
export function createBugAdminRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/admin/bug-reports', noStore, requireWebAuth, requireAdmin, async (c) => {
    const query = listQuerySchema.safeParse(c.req.query());
    if (!query.success) throw new HTTPException(400, { message: 'Filtro inválido.' });
    const cursor = query.data.cursor === undefined ? null : decodeCursor(query.data.cursor);
    if (query.data.cursor !== undefined && cursor === null) throw new HTTPException(400, { message: 'Cursor inválido.' });
    return c.json({ ok: true, data: await listReports(c.env.DB, query.data, cursor) });
  });

  // Antes de /:id, para "stats" não ser lido como um id.
  routes.get('/admin/bug-reports/stats', noStore, requireWebAuth, requireAdmin, async (c) => c.json({ ok: true, data: await reportStats(c.env.DB) }));

  routes.get('/admin/bug-reports/:id', noStore, requireWebAuth, requireAdmin, async (c) => {
    const detail = await getReportDetail(c.env.DB, reportId(c.req.param('id')));
    if (detail === null) throw new HTTPException(404, { message: 'Relato não encontrado.' });
    return c.json({ ok: true, data: detail });
  });

  routes.patch('/admin/bug-reports/:id', noStore, requireWebAuth, requireAdmin, requireCsrf, async (c) => {
    const id = reportId(c.req.param('id'));
    const patch = await jsonBody(c.req.raw, patchReportSchema, MAX_PATCH_BODY_BYTES);
    const current = await findReport(c.env.DB, id);
    if (current === null) throw new HTTPException(404, { message: 'Relato não encontrado.' });
    const original = patch.duplicateOf === undefined ? null : await findReport(c.env.DB, patch.duplicateOf);
    const plan = planPatch(current, patch, original);
    if (!await applyPatch(c.env.DB, current, plan, c.get('session').account_id, Date.now())) {
      throw new HTTPException(409, { message: 'Este relato foi alterado por outra pessoa. Atualize e tente de novo.' });
    }
    return c.json({ ok: true, data: await getReportDetail(c.env.DB, id) });
  });

  return routes;
}
