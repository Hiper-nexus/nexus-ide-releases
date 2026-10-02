import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../context.js';
import { jsonBody } from '../http.js';
import { requireNativeAuth } from '../middleware.js';
import { buildNewReport } from './build-report.js';
import { MAX_REPORT_BODY_BYTES, REPORTS_PER_HOUR } from './constants.js';
import { createReportSchema } from './schemas.js';
import { insertReportWithinLimit, listMine, secondsUntilNextReport } from './store.js';

/**
 * Rotas do app desktop (Bearer). Só pedem login: quem está com o teste vencido ou suspenso também pode reportar
 * (o bug pode ser justamente a licença). Nenhuma resposta traz e-mail de ninguém.
 */
export const bugReportRoutes = new Hono<AppEnv>()
  .post('/bug-reports', requireNativeAuth, async (c) => {
    // O tamanho é conferido ANTES de parsear; depois o esquema estrito e a limpeza.
    const input = await jsonBody(c.req.raw, createReportSchema, MAX_REPORT_BODY_BYTES);
    const accountId = c.get('session').account_id;
    const report = await buildNewReport(input, accountId, Date.now());
    if (!await insertReportWithinLimit(c.env.DB, report)) {
      c.header('Retry-After', String(await secondsUntilNextReport(c.env.DB, accountId, report.createdAt)));
      throw new HTTPException(429, { message: `Você já enviou ${REPORTS_PER_HOUR} relatos na última hora. Aguarde um pouco antes de enviar outro.` });
    }
    return c.json({ ok: true, data: { id: report.id, status: 'new' } }, 201);
  })
  .get('/bug-reports/mine', requireNativeAuth, async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ ok: true, data: { reports: await listMine(c.env.DB, c.get('session').account_id) } });
  });
