// HTTP-level tests for POST /hook/status. The full MCP server graph is too
// heavy to boot in unit tests (repo pattern: mcp-server is always mocked), so
// these boot a throwaway loopback server wired to the REAL endpoint handler —
// same function mcp-server delegates to after its bearer check.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOOK_STATUS_MAX_BODY_BYTES,
  HOOK_TOOL_NAME_MAX_LENGTH,
  extractHookToolLabels,
  extractHookToolName,
  handleHookStatusHttp,
  handleHookStatusRequest,
  supersedeApprovalsForHookEvent,
} from './hook-status-endpoint';
import { ApprovalBroker, approvalFingerprint } from '../agent-hooks/approval-broker';
import {
  __resetAgentStatusForTests,
  getAgentSemanticStatus,
  type AgentStatusApplyResult,
} from './agent-status';
import {
  __resetObserverBusForTests,
  snapshotObserverFrames,
} from './observer-bus';

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

beforeEach(() => {
  __resetAgentStatusForTests();
  __resetObserverBusForTests();
});

afterEach(async () => {
  __resetAgentStatusForTests();
  __resetObserverBusForTests();
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

    const res = await postHook({ event: 'mystery', flavor: 'claude' });

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

describe('observer-frame flow (real HTTP → reducer → bus)', () => {
  it('a claude PreToolUse post lands a tool_call frame with the tool name', async () => {
    await boot();

    const res = await postHook({
      event: 'tool-use',
      flavor: 'claude',
      body: JSON.stringify({ tool_name: 'Bash' }),
    });

    expect(res.status).toBe(200);
    const frames = snapshotObserverFrames('pty-hook-1');
    expect(frames.map((f) => f.kind)).toEqual(['tool_call', 'status_changed']);
    expect(frames[0]).toMatchObject({
      sessionId: 'pty-hook-1',
      payload: { callId: 'call-1', toolName: 'Bash' },
    });
  });

  it('F-780: a chamada da tool Skill leva o nome da skill (validado), nunca os args', async () => {
    await boot();

    await postHook({
      event: 'tool-use',
      flavor: 'claude',
      body: JSON.stringify({
        tool_name: 'Skill',
        tool_input: { skill: 'Ponytail', args: 'sk-proj-SEGREDO --force' },
      }),
    });

    const [call] = snapshotObserverFrames('pty-hook-1');
    expect(call).toMatchObject({
      kind: 'tool_call',
      payload: { callId: 'call-1', toolName: 'Skill', skillName: 'ponytail' },
    });
    expect(JSON.stringify(call)).not.toContain('SEGREDO');
    expect(JSON.stringify(call)).not.toContain('--force');
  });

  it('F-780: Bash com curl vira toolKind shell-http sem o comando', async () => {
    await boot();

    await postHook({
      event: 'tool-use',
      flavor: 'claude',
      body: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'curl -sL https://intranet.example/relatorio?token=abc' },
      }),
    });
    await postHook({
      event: 'tool-use',
      flavor: 'claude',
      body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    });

    const calls = snapshotObserverFrames('pty-hook-1').filter((f) => f.kind === 'tool_call');
    expect(calls[0]?.payload).toEqual({ callId: 'call-1', toolName: 'Bash', toolKind: 'shell-http' });
    expect(calls[1]?.payload).toEqual({ callId: 'call-2', toolName: 'Bash' });
    expect(JSON.stringify(calls)).not.toContain('intranet.example');
    expect(JSON.stringify(calls)).not.toContain('token=abc');
  });

  it('a PostToolUse post pairs a tool_result with its call', async () => {
    await boot();

    await postHook({
      event: 'tool-use',
      flavor: 'claude',
      body: JSON.stringify({ tool_name: 'Edit' }),
    });
    await postHook({
      event: 'tool-complete',
      flavor: 'claude',
      body: JSON.stringify({ tool_name: 'Edit' }),
    });

    const results = snapshotObserverFrames('pty-hook-1').filter(
      (f) => f.kind === 'tool_result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toEqual({
      callId: 'call-1',
      toolName: 'Edit',
      ok: true,
    });
  });

  it('a claude Stop post frames status_changed(completed) + turn_ended', async () => {
    await boot();

    await postHook({ event: 'user-submit', flavor: 'claude' });
    await postHook({ event: 'stop', flavor: 'claude' });

    const kinds = snapshotObserverFrames('pty-hook-1').map((f) => f.kind);
    expect(kinds).toEqual([
      'turn_started',
      'status_changed',
      'status_changed',
      'turn_ended',
    ]);
  });
});

describe('extractHookToolLabels (F-780)', () => {
  it('skill: só o campo `skill`, normalizado; args e demais campos ficam de fora', () => {
    expect(
      extractHookToolLabels('tool-use', 'Skill', {
        tool_input: { skill: 'Impeccable', args: 'segredo' },
      }),
    ).toEqual({ skillName: 'impeccable' });
    expect(extractHookToolLabels('tool-use', 'Skill', { toolInput: { skill: 'oc-scout' } })).toEqual({
      skillName: 'oc-scout',
    });
    expect(extractHookToolLabels('tool-use', 'Skill', { tool_input: { skill: 'Deploy Prod' } })).toEqual({});
    expect(extractHookToolLabels('tool-use', 'Skill', { tool_input: { args: 'x' } })).toEqual({});
    expect(extractHookToolLabels('tool-use', 'Skill', {})).toEqual({});
  });

  it('shell: curl/wget no comando vira shell-http; o resto não ganha categoria', () => {
    expect(
      extractHookToolLabels('tool-use', 'Bash', { tool_input: { command: 'curl -s https://x' } }),
    ).toEqual({ toolKind: 'shell-http' });
    expect(
      extractHookToolLabels('tool-use', 'exec_command', { tool_input: { cmd: ['bash', '-lc', 'wget x'] } }),
    ).toEqual({ toolKind: 'shell-http' });
    expect(
      extractHookToolLabels('tool-use', 'run_command', { tool_input: { CommandLine: 'curl x' } }),
    ).toEqual({ toolKind: 'shell-http' });
    expect(extractHookToolLabels('tool-use', 'Bash', { tool_input: { command: 'npm test' } })).toEqual({});
    expect(extractHookToolLabels('tool-use', 'Read', { tool_input: { command: 'curl x' } })).toEqual({});
  });

  it('fora dos eventos de tool, ou sem tool identificada, nada é derivado', () => {
    expect(extractHookToolLabels('stop', 'Bash', { tool_input: { command: 'curl x' } })).toEqual({});
    expect(extractHookToolLabels('tool-use', undefined, { tool_input: { skill: 'ponytail' } })).toEqual({});
  });
});

describe('extractHookToolName', () => {
  it('probes the same key set as the vendored parser', () => {
    expect(extractHookToolName({ tool_name: 'Bash' })).toBe('Bash');
    expect(extractHookToolName({ toolName: 'Edit' })).toBe('Edit');
    expect(extractHookToolName({ name: 'Read' })).toBe('Read');
    expect(extractHookToolName({ tool: { name: 'Grep' } })).toBe('Grep');
  });

  it('never fabricates a name', () => {
    expect(extractHookToolName({})).toBeUndefined();
    expect(extractHookToolName({ tool_name: 42 })).toBeUndefined();
    expect(extractHookToolName({ tool_name: '   ' })).toBeUndefined();
    expect(extractHookToolName({ tool: 'Bash' })).toBeUndefined();
  });

  it('caps oversized names', () => {
    const name = extractHookToolName({ tool_name: 'x'.repeat(500) });
    expect(name).toHaveLength(HOOK_TOOL_NAME_MAX_LENGTH);
  });
});

// C-194.1: o Stop canônico dispara o fechamento mecânico (fire-and-forget),
// com o body cru que o CanonicalHookEvent descarta (last_assistant_message).
describe('turn-end mechanical handoff trigger', () => {
  const ctx = { sessionId: 'pty-turn-end' } as const;

  const envelope = (body: Record<string, unknown>) => ({
    eventType: 'stop',
    flavor: 'claude',
    body,
  });

  it('codex Stop com last_agent_message entrega o body cru ao fechamento', () => {
    const seen: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
    const result = handleHookStatusRequest(
      ctx,
      {
        eventType: 'stop',
        flavor: 'codex',
        body: { last_agent_message: '3', cwd: '/proj' },
      },
      undefined,
      (input) => seen.push(input),
    );
    expect(result.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body.last_agent_message).toBe('3');
  });

  it('status/stop entrega sessionId + body cru ao callback de turno', () => {
    const seen: Array<{ sessionId: string; body: Record<string, unknown> }> = [];
    const result = handleHookStatusRequest(
      ctx,
      envelope({ last_assistant_message: 'pronto', transcript_path: '/t.jsonl' }),
      undefined,
      (input) => seen.push(input),
    );
    expect(result.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].sessionId).toBe('pty-turn-end');
    expect(seen[0].body.last_assistant_message).toBe('pronto');
    expect(seen[0].body.transcript_path).toBe('/t.jsonl');
  });

  it('eventos que não são stop não disparam o fechamento', () => {
    for (const eventType of ['start', 'notification', 'tool-use']) {
      const seen: unknown[] = [];
      const result = handleHookStatusRequest(
        ctx,
        { eventType, flavor: 'claude', body: {} },
        undefined,
        (input) => seen.push(input),
      );
      expect(result.statusCode).toBe(200);
      expect(seen).toHaveLength(0);
    }
  });

  it('sessão sem binding não dispara (mesma regra do reducer)', () => {
    const seen: unknown[] = [];
    const result = handleHookStatusRequest(
      { sessionId: undefined } as unknown as { sessionId: string },
      envelope({}),
      undefined,
      (input) => seen.push(input),
    );
    expect(result.statusCode).toBe(200);
    expect(seen).toHaveLength(0);
  });

  it('F-734: StopFailure da família Claude fecha o turno sem fechamento mecânico e sem texto do provedor', () => {
    const providerText =
      'Please run /login · API Error: 401 Authentication Fails, Your api key: ****WXYZ is invalid';
    const seen: unknown[] = [];
    const applied: unknown[] = [];
    const result = handleHookStatusRequest(
      ctx,
      {
        eventType: 'stop-failure',
        flavor: 'claude',
        body: {
          hook_event_name: 'StopFailure',
          error: 'authentication_failed',
          error_details: providerText,
          last_assistant_message: providerText,
        },
      },
      (input) => {
        applied.push(input.event);
        return { applied: true, transitioned: true, entry: null };
      },
      (input) => seen.push(input),
    );
    expect(result.statusCode).toBe(200);
    // O body cru (texto do provedor) nunca vira handoff `[auto]`.
    expect(seen).toHaveLength(0);
    // Só a categoria chega ao reducer.
    expect(applied).toEqual([{ kind: 'status', type: 'stop', stopFailure: 'auth' }]);
    expect(JSON.stringify(applied)).not.toContain('WXYZ');
  });
});

describe('F-734: StopFailure pelo HTTP real', () => {
  it('claude stop-failure → completed, turn_ended em erro, fim de turno com a categoria', async () => {
    await boot();
    await postHook({ event: 'user-submit', flavor: 'claude' });
    const response = await postHook({
      event: 'stop-failure',
      flavor: 'claude',
      body: JSON.stringify({
        hook_event_name: 'StopFailure',
        error: 'billing_error',
        error_details: 'Your credit balance is too low (key ****WXYZ)',
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      applied: true,
      status: 'completed',
    });
    expect(getAgentSemanticStatus('pty-hook-1')?.status).toBe('completed');
    const frames = snapshotObserverFrames('pty-hook-1');
    expect(frames.at(-1)).toMatchObject({
      kind: 'turn_ended',
      payload: { turnId: 'turn-1', outcome: 'error' },
    });
    expect(JSON.stringify(frames)).not.toContain('WXYZ');
  });
});

describe('approval supersede (PRV-02: the TUI answered first)', () => {
  function openFor(broker: ApprovalBroker, sessionId: string, command: string) {
    return broker.open({
      sessionId,
      provider: 'claude',
      tool: 'Bash',
      summary: command,
      options: [{ optionId: 'accept' }, { optionId: 'decline' }],
      waitMs: 60_000,
      fingerprint: approvalFingerprint('Bash', { command }),
      highImpact: false,
    })!;
  }

  it('PostToolUse of the SAME call closes it; a different call stays pending', async () => {
    const broker = new ApprovalBroker();
    const ls = openFor(broker, 'pty-1', 'ls');
    openFor(broker, 'pty-1', 'touch a');
    const body = { tool_name: 'Bash', tool_input: { command: 'ls' } };
    expect(supersedeApprovalsForHookEvent('pty-1', 'tool-complete', body, broker)).toBe(1);
    await expect(ls.decision).resolves.toBeNull();
    expect(broker.list().map((r) => r.summary)).toEqual(['touch a']);
    // PreToolUse arrives BEFORE PermissionRequest: it must never supersede.
    expect(supersedeApprovalsForHookEvent('pty-1', 'tool-use', { tool_name: 'Bash', tool_input: { command: 'touch a' } }, broker)).toBe(0);
  });

  it('turn end / new prompt closes every pending request of that session only', () => {
    const broker = new ApprovalBroker();
    openFor(broker, 'pty-1', 'ls');
    openFor(broker, 'pty-2', 'ls');
    expect(supersedeApprovalsForHookEvent('pty-1', 'stop', {}, broker)).toBe(1);
    expect(broker.list().map((r) => r.sessionId)).toEqual(['pty-2']);
    expect(supersedeApprovalsForHookEvent('pty-2', 'user-submit', {}, broker)).toBe(1);
    expect(broker.list()).toEqual([]);
  });
});


describe('F-1139 authenticated native argv ingress', () => {
  it('only records an applied first native prompt through the exact current bearer', async () => {
    const gate = await import('./gate');
    const pty = await import('../pty/pty-manager');
    const { testProjectScope } = await import('./__tests__/scope-fixture');
    const ctx = gate.mintToken({ label: 'private argv test', role: 'user', scope: testProjectScope(),
      allowedTools: [], allowedSkills: [] });
    gate.bindTokenToSession(ctx.token, 'argv-ingress');
    const record = vi.spyOn(pty, 'recordAuthenticatedNativeArgvSubmission').mockImplementation(() => {});
    const applied = () => ({ applied: true, transitioned: false, entry: null });
    try {
      const envelope = (eventType: string, body: Record<string, unknown> = { prompt: 'exact private argv' }) =>
        ({ eventType, flavor: 'claude', body });
      handleHookStatusRequest({ sessionId: 'argv-ingress' }, envelope('user-submit'), applied);
      handleHookStatusRequest(ctx, envelope('user-submit'), () => ({ applied: false, transitioned: false, entry: null }));
      handleHookStatusRequest(ctx, envelope('tool-use'), applied);
      handleHookStatusRequest(ctx, envelope('stop'), applied, () => {});
      expect(record).not.toHaveBeenCalled();
      const result = handleHookStatusRequest(ctx, envelope('user-submit'), applied);
      expect(result).toMatchObject({ statusCode: 200, payload: { applied: true, authorizesEvidence: false } });
      expect(record).toHaveBeenCalledExactlyOnceWith('argv-ingress', 'exact private argv');
      record.mockClear();
      gate.releaseSession('argv-ingress');
      handleHookStatusRequest(ctx, envelope('user-submit'), applied);
      expect(record).not.toHaveBeenCalled();
    } finally { gate.releaseSession('argv-ingress'); record.mockRestore(); }
  });
});
