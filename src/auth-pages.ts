import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Páginas em que o navegador termina o login do app. Sem elas a pessoa via JSON
 * cru (erro) ou uma aba em branco (sucesso). Sem script e sem recurso externo:
 * só estilo inline, e o CSP próprio da página não libera mais que isso.
 */
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#080709;color:#faf7f9;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(100%,440px)}
.brand{font:600 15px/1 ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.04em;margin:0 0 28px;color:#aaa2a8}
h1{margin:0 0 10px;font-size:28px;line-height:1.15;letter-spacing:-.02em;font-weight:600;text-wrap:balance}
p{margin:0 0 20px;color:#aaa2a8;text-wrap:pretty}
.cta{display:inline-block;padding:12px 20px;border-radius:8px;background:#faf7f9;color:#080709;font-weight:600;text-decoration:none}
.cta:hover{background:#e6e2e5}
.cta:focus-visible{outline:2px solid #ff4f8b;outline-offset:2px}
.hint{margin:20px 0 0;font-size:14px;color:#928b90}
.error{padding:12px 14px;border:1px solid rgba(255,107,74,.45);border-radius:8px;background:rgba(255,107,74,.09);color:#faf7f9}
`;

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function layout(title: string, head: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>${head}<style>${STYLE}</style></head><body><main><p class="brand">NexusIDE</p>${body}</main></body></html>`;
}

function page(c: Context, html: string, status: ContentfulStatusCode): Response {
  c.header('Content-Security-Policy', PAGE_CSP);
  return c.html(html, status);
}

/**
 * Login feito: a página tenta abrir o app sozinha (meta refresh) e deixa o botão,
 * porque o navegador só garante abrir um protocolo próprio com um clique.
 */
export function loginSuccessPage(c: Context, input: { appName: string; deepLink: string }): Response {
  const link = escapeHtml(input.deepLink);
  const app = escapeHtml(input.appName);
  return page(c, layout('Login concluído', `<meta http-equiv="refresh" content="1;url=${link}">`, `
<h1>Login concluído</h1>
<p>Volte ao ${app}: ele continua sozinho em instantes.</p>
<a class="cta" href="${link}">Abrir ${app}</a>
<p class="hint">Se o navegador perguntar, permita abrir o ${app}. Depois você pode fechar esta aba.</p>`), 200);
}

/** O motivo vem das mensagens fixas da API (nunca de texto do provedor) e é escapado mesmo assim. */
export function loginErrorPage(c: Context, message: string, status: ContentfulStatusCode): Response {
  return page(c, layout('Não foi possível concluir o login', '', `
<h1>Não foi possível concluir o login</h1>
<p class="error" role="alert">${escapeHtml(message)}</p>
<p class="hint">Volte ao NexusIDE e clique em “Abrir de novo” para tentar outra vez.</p>`), status);
}

/** Descadastro feito. Nada na página vem da requisição: o link só carrega o que já foi verificado. */
export function unsubscribeDonePage(c: Context, siteUrl: string): Response {
  c.header('Cache-Control', 'no-store');
  return page(c, layout('Avisos cancelados', '', `
<h1>Avisos cancelados</h1>
<p>Pronto: você não vai mais receber estes avisos por e-mail.</p>
<a class="cta" href="${escapeHtml(siteUrl)}">Ir para o NexusIDE</a>`), 200);
}

/** Resposta única para qualquer link recusado (token errado, conta alheia, parâmetro faltando): não revela qual deles. */
export function unsubscribeInvalidPage(c: Context): Response {
  c.header('Cache-Control', 'no-store');
  return page(c, layout('Link inválido', '', `
<h1>Link inválido</h1>
<p class="error" role="alert">Este link de descadastro não é válido ou está incompleto.</p>
<p class="hint">Use o link mais recente de um e-mail do NexusIDE.</p>`), 400);
}
