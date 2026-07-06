import { Router } from 'express';

const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - NexusIDE</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#010102;color:#f7f8f8;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{width:min(460px,calc(100vw - 40px));padding:28px;background:#0f1011;border:1px solid #23252a;border-radius:12px;text-align:center;box-shadow:0 24px 80px rgb(0 0 0 / .35)}
h1{margin:0 0 10px;font-size:24px;line-height:1.2;font-weight:650}p{margin:0;color:#d0d6e0;font-size:14px;line-height:1.55}code{display:inline-block;margin-top:16px;padding:7px 11px;border:1px solid #34343a;border-radius:8px;background:#141516;color:#828fff;font-size:18px;letter-spacing:.04em}
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function buildWebPages(): Router {
  const router = Router();

  router.get('/billing/success', (_req, res) => {
    res.type('html').send(page(
      'Pagamento confirmado',
      '<h1>Pagamento confirmado</h1><p>Volte ao NexusIDE. Seu plano atualiza sozinho em instantes.</p>',
    ));
  });

  router.get('/billing/cancel', (_req, res) => {
    res.type('html').send(page(
      'Pagamento cancelado',
      '<h1>Nada foi cobrado</h1><p>Volte ao NexusIDE quando quiser continuar.</p>',
    ));
  });

  router.get(/^\/join\/(.+)$/, (req, res) => {
    const raw = String(req.params[0]);
    const code = CODE_RE.test(raw) ? raw.toUpperCase() : null;
    res.type('html').send(page(
      'Convite de time',
      code
        ? `<h1>Convite de time</h1><p>Abra o NexusIDE e cole este código em Conta.</p><code>${code}</code>`
        : '<h1>Convite inválido</h1><p>Confira o link com quem enviou o convite.</p>',
    ));
  });

  return router;
}
