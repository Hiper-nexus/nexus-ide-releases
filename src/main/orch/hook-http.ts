// Encanamento HTTP comum aos hooks aditivos (/hook/triage, /hook/delegate):
// 401 sem bearer, 405 não-POST, 400 corpo grande/inválido; o resto é 200.
import type http from 'node:http';

/**
 * F-737: o charset é obrigatório. O hook do Windows lê a resposta com o
 * `Invoke-WebRequest` do PowerShell 5.1, que sem charset decodifica como
 * ISO-8859-1: a doutrina chegava ao Maestro como "VOCÃ Ã O MAESTRO DESTA
 * MISSÃO (vale a sessÃ£o)". O curl do macOS/Linux repassa os bytes e não muda.
 */
export const HOOK_JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

export function sendHookJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': HOOK_JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** Texto puro (UTF-8): para a CLI que injeta o stdout do hook como está. */
export function sendHookText(res: http.ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBodyCapped(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        // Rejeita SEM destruir o socket para o handler ainda enviar o 400
        // (destruir antes de responder corre com o cliente, que veria só a
        // conexão caída em vez do erro de validação).
        reject(new Error('body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** POST de hook com bearer já resolvido pelo servidor (`ctx` null → 401). */
export async function handleHookJsonPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: unknown | null,
  maxBytes: number,
  onBody: (body: unknown) => Promise<{ statusCode: number; payload: unknown }>,
  /** Responde o payload de sucesso como texto puro em vez de JSON (ver sendHookText). */
  asText?: (payload: unknown) => string,
): Promise<void> {
  if (!ctx) {
    sendHookJson(res, 401, { ok: false, error: 'missing or unknown bearer token' });
    return;
  }
  if (req.method !== 'POST') {
    sendHookJson(res, 405, { ok: false, error: 'method not allowed' });
    return;
  }
  let raw: string;
  try {
    raw = await readBodyCapped(req, maxBytes);
  } catch {
    // Resposta antecipada: o resto de um corpo grande ainda pode estar
    // chegando, então a conexão fecha depois que o 400 sair.
    const bodyOut = JSON.stringify({ ok: false, error: 'hook payload too large' });
    res.writeHead(400, {
      'content-type': HOOK_JSON_CONTENT_TYPE,
      'content-length': Buffer.byteLength(bodyOut),
      connection: 'close',
    });
    res.end(bodyOut, () => req.destroy());
    return;
  }
  let body: unknown;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendHookJson(res, 400, { ok: false, error: 'invalid hook payload JSON' });
    return;
  }
  const result = await onBody(body);
  if (asText && result.statusCode === 200) {
    sendHookText(res, 200, asText(result.payload));
    return;
  }
  sendHookJson(res, result.statusCode, result.payload);
}
