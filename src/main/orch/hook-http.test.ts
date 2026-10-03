import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_JSON_CONTENT_TYPE, handleHookJsonPost, sendHookJson } from './hook-http';

function fakeResponse() {
  const captured: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      captured.status = status;
      captured.headers = headers;
      return res;
    },
    end(body: string) {
      captured.body = body;
      return res;
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

describe('resposta JSON dos hooks (F-737)', () => {
  it('declara charset=utf-8: o PowerShell 5.1 do Windows decodifica sem charset como ISO-8859-1', () => {
    const { res, captured } = fakeResponse();
    const additionalContext = 'VOCÊ É O MAESTRO DESTA MISSÃO (vale a sessão)';
    sendHookJson(res, 200, { hookSpecificOutput: { additionalContext } });

    expect(captured.status).toBe(200);
    expect(captured.headers?.['content-type']).toBe(HOOK_JSON_CONTENT_TYPE);
    expect(HOOK_JSON_CONTENT_TYPE).toMatch(/charset=utf-8/i);
    // O tamanho é em bytes UTF-8, não em caracteres.
    expect(captured.headers?.['content-length']).toBe(Buffer.byteLength(captured.body!, 'utf8'));
    expect(JSON.parse(captured.body!).hookSpecificOutput.additionalContext).toBe(additionalContext);
  });
});

describe('resposta em texto puro dos hooks (F-802, Kimi)', () => {
  const servers: http.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  async function post(
    asText: ((payload: unknown) => string) | undefined,
    payload: unknown,
  ): Promise<{ type: string | undefined; body: string }> {
    const server = http.createServer((req, res) => {
      void handleHookJsonPost(req, res, {}, 1024, async () => ({ statusCode: 200, payload }), asText);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve({ type: res.headers['content-type'], body }));
      });
      req.on('error', reject);
      req.end('{}');
    });
  }

  it('com asText o corpo é o texto (UTF-8) e, sem nada a dizer, é VAZIO — nunca "{}"', async () => {
    const withText = await post((p) => (p as { t: string }).t, { t: 'Doutrina: não execute tudo sozinho' });
    expect(withText.type).toBe('text/plain; charset=utf-8');
    expect(withText.body).toBe('Doutrina: não execute tudo sozinho');
    const empty = await post(() => '', {});
    expect(empty.body).toBe('');
  });

  it('sem asText continua JSON', async () => {
    const json = await post(undefined, { a: 1 });
    expect(json.type).toBe(HOOK_JSON_CONTENT_TYPE);
    expect(JSON.parse(json.body)).toEqual({ a: 1 });
  });
});
