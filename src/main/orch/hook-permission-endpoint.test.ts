import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalBroker,
  __resetApprovalRespondersForTests,
  approvalBroker,
  setDesktopApprovalSurfaces,
} from '../agent-hooks/approval-broker';
import {
  approvalWaitMs,
  handleHookPermissionHttp,
  handleHookPermissionRequest,
  isHighImpactApproval,
} from './hook-permission-endpoint';

// Payload real (chaves) do PermissionRequest do claude 2.1.283 na sonda x2.
const CLAUDE_BODY = {
  hook_event_name: 'PermissionRequest',
  session_id: 'claude-session',
  cwd: '/tmp/x2-probe/cwd',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command: 'touch probe.txt', description: 'Create a file' },
  permission_suggestions: [
    { type: 'addDirectories', directories: ['/tmp/x2-probe/cwd'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ],
};

async function nextRequest(broker: ApprovalBroker): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const [request] = broker.list();
    if (request) return request.requestId;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('no approval request was opened');
}

afterEach(() => {
  __resetApprovalRespondersForTests();
  for (const request of approvalBroker.list()) approvalBroker.cancelForSession(request.sessionId);
});

describe('handleHookPermissionRequest', () => {
  it('without a responder answers {} at once and opens nothing (TUI as today)', async () => {
    const broker = new ApprovalBroker();
    const started = Date.now();
    const result = await handleHookPermissionRequest({ sessionId: 'sess-a' }, CLAUDE_BODY, {
      provider: 'claude',
      broker,
      hasResponder: () => false,
      waitMs: 60_000,
    });
    expect(result).toEqual({ statusCode: 200, payload: {} });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(broker.list()).toEqual([]);
  });

  it('with a responder waits and returns the Claude hook decision', async () => {
    const broker = new ApprovalBroker();
    const pending = handleHookPermissionRequest({ sessionId: 'sess-a' }, CLAUDE_BODY, {
      provider: 'claude',
      broker,
      hasResponder: () => true,
      waitMs: 60_000,
    });
    const [request] = broker.list();
    expect(request).toMatchObject({
      sessionId: 'sess-a',
      tool: 'Bash',
      summary: 'touch probe.txt',
      provider: 'claude',
      options: [{ optionId: 'accept' }, { optionId: 'acceptForSession', degradesTo: 'accept' }, { optionId: 'decline' }],
    });
    broker.respond({ requestId: request!.requestId, expectedRevision: 1, optionId: 'decline', source: 'desktop' });
    await expect(pending).resolves.toEqual({
      statusCode: 200,
      payload: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'User declined tool execution.' },
        },
      },
    });
  });

  it('Codex gets allow without updatedPermissions for "session"', async () => {
    const broker = new ApprovalBroker();
    const pending = handleHookPermissionRequest(
      { sessionId: 'sess-c' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'ls'] } },
      { provider: 'codex', broker, hasResponder: () => true, waitMs: 60_000 },
    );
    const [request] = broker.list();
    broker.respond({ requestId: request!.requestId, expectedRevision: 1, optionId: 'acceptForSession', source: 'mobile' });
    await expect(pending).resolves.toEqual({
      statusCode: 200,
      payload: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } },
    });
  });

  it('timeout answers {} so the TUI decides', async () => {
    const broker = new ApprovalBroker();
    const result = await handleHookPermissionRequest({ sessionId: 'sess-a' }, CLAUDE_BODY, {
      provider: 'claude',
      broker,
      hasResponder: () => true,
      waitMs: 20,
    });
    expect(result.payload).toEqual({});
    expect(broker.list()).toEqual([]);
  });

  it('abort (hook gave up) closes the request', async () => {
    const broker = new ApprovalBroker();
    const abort = new AbortController();
    const pending = handleHookPermissionRequest({ sessionId: 'sess-a' }, CLAUDE_BODY, {
      provider: 'claude',
      broker,
      hasResponder: () => true,
      waitMs: 60_000,
      signal: abort.signal,
    });
    expect(broker.list()).toHaveLength(1);
    abort.abort();
    await expect(pending).resolves.toEqual({ statusCode: 200, payload: {} });
    expect(broker.list()).toEqual([]);
  });

  it('the card summary never carries a known secret format', async () => {
    const broker = new ApprovalBroker();
    void handleHookPermissionRequest(
      { sessionId: 'sess-a' },
      { tool_name: 'Bash', tool_input: { command: 'curl -H "Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" https://x' } },
      { provider: 'claude', broker, hasResponder: () => true, waitMs: 60_000 },
    );
    const [request] = broker.list();
    expect(request!.summary).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
    broker.cancelForSession('sess-a');
  });

  it('malformed payloads and missing session are {} without opening a request', async () => {
    const broker = new ApprovalBroker();
    const deps = { provider: 'claude' as const, broker, hasResponder: () => true, waitMs: 60_000 };
    await expect(handleHookPermissionRequest({ sessionId: 'sess-a' }, { tool_name: '' }, deps)).resolves.toEqual({
      statusCode: 200,
      payload: {},
    });
    await expect(handleHookPermissionRequest({}, CLAUDE_BODY, deps)).resolves.toEqual({ statusCode: 200, payload: {} });
    expect(broker.list()).toEqual([]);
  });
});

describe('approval wait and risk', () => {
  it('wait is configurable and clamped below the hook transport', () => {
    expect(approvalWaitMs({})).toBe(120_000);
    expect(approvalWaitMs({ NEXUS_APPROVAL_WAIT_SECONDS: '30' })).toBe(30_000);
    expect(approvalWaitMs({ NEXUS_APPROVAL_WAIT_SECONDS: '9999' })).toBe(170_000);
    expect(approvalWaitMs({ NEXUS_APPROVAL_WAIT_SECONDS: '1' })).toBe(5_000);
  });

  it('classifies the whole command, not the 200-char summary', () => {
    expect(isHighImpactApproval({ command: 'ls -la' })).toBe(false);
    expect(isHighImpactApproval({ command: `echo ${'x'.repeat(300)}\nrm -rf /` })).toBe(true);
    expect(isHighImpactApproval({ command: ['bash', '-lc', 'git push origin main'] })).toBe(true);
    expect(isHighImpactApproval({ file_path: '/tmp/a' })).toBe(false);
  });
});

describe('POST /hook/permission over HTTP', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  async function listen(ctx: { sessionId?: string } | null): Promise<number> {
    server = http.createServer((req, res) => void handleHookPermissionHttp(req, res, ctx));
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server!.address() as AddressInfo).port;
  }

  it('401 without bearer context', async () => {
    const port = await listen(null);
    const response = await fetch(`http://127.0.0.1:${port}/hook/permission`, {
      method: 'POST',
      body: JSON.stringify(CLAUDE_BODY),
    });
    expect(response.status).toBe(401);
  });

  it('desktop card visible → waits; the card decision becomes the hook output', async () => {
    setDesktopApprovalSurfaces(['sess-http']);
    const port = await listen({ sessionId: 'sess-http' });
    const pending = fetch(`http://127.0.0.1:${port}/hook/permission`, {
      method: 'POST',
      headers: { 'x-nexus-approval-provider': 'claude' },
      body: JSON.stringify(CLAUDE_BODY),
    });
    const requestId = await nextRequest(approvalBroker);
    approvalBroker.respond({ requestId, expectedRevision: 1, optionId: 'accept', source: 'desktop' });
    const response = await pending;
    expect(await response.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('the hook dropping the connection closes the request', async () => {
    setDesktopApprovalSurfaces(['sess-drop']);
    const port = await listen({ sessionId: 'sess-drop' });
    const abort = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/hook/permission`, {
      method: 'POST',
      body: JSON.stringify(CLAUDE_BODY),
      signal: abort.signal,
    }).catch(() => null);
    await nextRequest(approvalBroker);
    abort.abort();
    await pending;
    await vi.waitFor(() => expect(approvalBroker.list()).toEqual([]));
  });
});
