import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const publishSessionActivityState = vi.fn(
  (_sessionId: string, _state: string) => true,
);

vi.mock('../pty/pty-manager', () => ({
  getAgentSessionInfo: () => null,
  publishSessionActivityState: (sessionId: string, state: string) =>
    publishSessionActivityState(sessionId, state),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getVersion: () => '0.13.0-test',
    getAppMetrics: () => [],
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => true),
  },
}));

import {
  startAgentHookHttpServer,
  stopAgentHookHttpServer,
} from './hook-http-server';
import { __resetHookIngestForTests } from './hook-ingest';
import { __resetAgentRuntimeBridgeForTests } from '../agent-runtime/agent-runtime-bridge';

let userData: string;

afterEach(async () => {
  await stopAgentHookHttpServer();
  __resetHookIngestForTests();
  __resetAgentRuntimeBridgeForTests();
  publishSessionActivityState.mockClear();
  if (userData) {
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe('hook-http-server', () => {
  it('ingests form body into pane session without authorizing evidence', async () => {
    userData = mkdtempSync(join(tmpdir(), 'nexus-hook-http-'));
    const handle = await startAgentHookHttpServer({
      userDataPath: userData,
      token: 'aabbccddeeff00112233445566778899',
    });

    const form = new URLSearchParams({
      paneKey: 'pty-session-1',
      payload: JSON.stringify({ state: 'working', agentType: 'claude' }),
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Nexus-Agent-Hook-Token': 'aabbccddeeff00112233445566778899',
      },
      body: form.toString(),
    });
    const body = (await res.json()) as {
      ok: boolean;
      paneSessionState?: string;
      authorizesEvidence?: boolean;
      authorizesMissionCompletion?: boolean;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.paneSessionState).toBe('busy');
    expect(body.authorizesEvidence).toBe(false);
    expect(body.authorizesMissionCompletion).toBe(false);
    expect(publishSessionActivityState).toHaveBeenCalledWith(
      'pty-session-1',
      'busy',
    );
  });

  it('rejects bad token', async () => {
    userData = mkdtempSync(join(tmpdir(), 'nexus-hook-http-'));
    const handle = await startAgentHookHttpServer({
      userDataPath: userData,
      token: '00112233445566778899aabbccddeeff',
    });
    const res = await fetch(`http://127.0.0.1:${handle.port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nexus-Agent-Hook-Token': 'ffeeddccbbaa99887766554433221100',
      },
      body: JSON.stringify({ paneKey: 'x', state: 'working' }),
    });
    expect(res.status).toBe(401);
  });
});
