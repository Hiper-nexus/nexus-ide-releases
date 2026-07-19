// HTTP-level tests for POST /hook/status. The full MCP server graph is too
// heavy to boot in unit tests (repo pattern: mcp-server is always mocked), so
// these boot a throwaway loopback server wired to the REAL endpoint handler —
// same function mcp-server delegates to after its bearer check.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_STATUS_MAX_BODY_BYTES,
  handleHookStatusHttp,
  handleHookStatusRequest,
} from './hook-status-endpoint';
import {
  __resetAgentStatusForTests,
  getAgentSemanticStatus,
  type AgentStatusApplyResult,
} from './agent-status';

let server: http.Server | null = null;
let baseUrl = '';
const CTX = { sessionId: 'pty-hook-1' };

async function boot(
  ctx: { sessionId: string } | null = CTX,
  applyEvent?: (input: {
    sessionId: string;
    event: never;
  }) => AgentStatusApplyResult,
): Promise<void> {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = null;
  }
  server = http.createServer((req, res) => {
    void handleHookStatusHttp(req, res, ctx, applyEvent as never).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

beforeEach(() => __resetAgentStatusForTests());

afterEach(async () => {
  __resetAgentStatusForTests();
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = null;
  }
});

function postHook(options: {
  body?: string;
  event?: string;
  flavor?: string;
  headers?: Record<string, string>;
}): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...options.headers,
  };
  if (options.event !== undefined) headers['x-nexus-hook-event'] = options.event;
  if (options.flavor !== undefined) headers['x-nexus-hook-flavor'] = options.flavor;
  return fetch(`${baseUrl}/hook/status`, {
    method: 'POST',
    headers,
    body: options.body ?? '{}',
  });
}

describe('POST /hook/status — auth and validation', () => {
  it('rejects requests without a bearer context (401)', async () => {
    await boot(null);

    const res = await postHook({ event: 'start', flavor: 'claude' });

    expect(res.status).toBe(401);
  });

  it('rejects a non-JSON body (400)', async () => {
    await boot();

    const res = await postHook({ body: 'not-json{', event: 'start' });

    expect(res.status).toBe(400);
  });

  it('rejects a missing event header (400)', async () => {
    await boot();

    const res = await postHook({ flavor: 'claude' });

    expect(res.status).toBe(400);
  });

  it('rejects an unknown flavor (400)', async () => {
    await boot();

    const res = await postHook({ event: 'start', flavor: 'emacs' });

    expect(res.status).toBe(400);
  });

  it('rejects a body over the 16 KB cap (400)', async () => {
    await boot();
    const oversized = JSON.stringify({ pad: 'x'.repeat(HOOK_STATUS_MAX_BODY_BYTES) });

    const res = await postHook({ body: oversized, event: 'start' });

    expect(res.status).toBe(400);
  });
});

describe('POST /hook/status — valid events drive the semantic reducer', () => {
  it('claude start → working, stored per pane', async () => {
    await boot();

    const res = await postHook({ event: 'start', flavor: 'claude' });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({
      ok: true,
      applied: true,
      transitioned: true,
      status: 'working',
      event: 'status',
      authorizesEvidence: false,
    });
    expect(getAgentSemanticStatus('pty-hook-1')?.status).toBe('working');
  });

  it('codex idle_prompt notification → completed (vendor parser + reducer)', async () => {
    await boot();
    await postHook({ event: 'start', flavor: 'codex' });

    const res = await postHook({
      event: 'notification',
      flavor: 'codex',
      body: JSON.stringify({ notification_type: 'idle_prompt' }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ status: 'completed', event: 'status' });
    expect(getAgentSemanticStatus('pty-hook-1')?.status).toBe('completed');
  });

  it('claude permission notification → awaiting-input', async () => {
    await boot();

    const res = await postHook({
      event: 'notification',
      flavor: 'claude',
      body: JSON.stringify({ message: 'Claude needs your permission to run Bash' }),
    });

    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ status: 'awaiting-input' });
  });

  it('unknown event types parse to ignore → 200 without touching status', async () => {
    await boot();

    const res = await postHook({ event: 'tool-use', flavor: 'claude' });

    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, applied: false, event: 'ignore' });
    expect(getAgentSemanticStatus('pty-hook-1')).toBeNull();
  });

  it('accepts events for a token without a live PTY binding (200, applied:false)', async () => {
    await boot({ sessionId: '' });

    const res = await postHook({ event: 'start', flavor: 'claude' });

    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, applied: false });
  });
});

describe('fail-closed contract', () => {
  it('a throwing reducer yields 500 and the endpoint keeps serving', async () => {
    const throwing = vi.fn(() => {
      throw new Error('reducer exploded');
    });
    await boot(CTX, throwing as never);

    const first = await postHook({ event: 'start', flavor: 'claude' });
    expect(first.status).toBe(500);
    expect(((await first.json()) as { ok: boolean }).ok).toBe(false);

    // The gate is unaffected: the next request is processed normally.
    await boot(CTX);
    const second = await postHook({ event: 'start', flavor: 'claude' });
    expect(second.status).toBe(200);
  });

  it('handleHookStatusRequest also degrades cleanly on a throwing default reducer', () => {
    const result = handleHookStatusRequest(
      { sessionId: 'pty-1' },
      { eventType: 'start', flavor: 'claude', body: {} },
      () => {
        throw new Error('boom');
      },
    );

    expect(result.statusCode).toBe(500);
  });
});
