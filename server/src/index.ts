import express, { type Express } from 'express';

/** Monta o app Express. Rotas /v1 são adicionadas nas próximas tasks/partes. */
export function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

// Boot real só quando executado direto (não em teste/import).
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const app = createApp();
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => console.log(`[server] :${port}`));
}
