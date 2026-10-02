import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { HOOK_JSON_CONTENT_TYPE, sendHookJson } from './hook-http';

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
