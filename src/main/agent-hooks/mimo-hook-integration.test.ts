import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { prepareMimoWorker } from '../usage/__tests__/mimo-worker-fixture';
import { stopMimoValidationReader } from '../usage/mimo-worker-reader';
const deps = vi.hoisted(() => ({ agent: null as any, db: null as any }));
vi.mock('../pty/pty-manager', () => ({ getAgentSessionInfo: () => deps.agent, tapSessionExit: () => () => undefined }));
vi.mock('../persistence/db', () => ({ getDb: () => deps.db }));
vi.mock('../agent-runtime/agent-runtime-bridge', () => ({ publishAgentHookActivity: () => ({ paneSessionState: 'busy' }) }));
import { startAgentHookHttpServer, stopAgentHookHttpServer } from './hook-http-server';
import { registerMimoRuntime, unregisterMimoRuntime } from './mimo-session-registry';
import { mimoStatusHookSource } from './mimo-hook-source';
import { getProviderPaneSession } from '../persistence/provider-session-store';

let root = '';
beforeAll(prepareMimoWorker);
afterEach(async () => {
  unregisterMimoRuntime('pty-a'); await stopAgentHookHttpServer();
  await stopMimoValidationReader();
  deps.db?.close(); deps.db = null; deps.agent = null;
  vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it('runs the generated hook against the authenticated Main endpoint and persists only the exact root/account', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-hook-integration-')));
  const stateRoot = path.join(root, 'provider-state', 'mimo-code', 'checkout-a');
  fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
  const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
  const native = new Database(databasePath);
  native.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT)');
  native.prepare('INSERT INTO session VALUES (?, ?, NULL)').run('ses_root', root);
  native.prepare('INSERT INTO session VALUES (?, ?, ?)').run('ses_child', root, 'ses_root');
  native.close();
  deps.db = new Database(':memory:');
  deps.db.exec(`CREATE TABLE provider_pane_sessions (
    installation_id TEXT, project_id TEXT, checkout_id TEXT, pane_id TEXT, adapter_id TEXT,
    session_key TEXT, session_id TEXT, transcript_path TEXT, updated_at INTEGER, account_id TEXT,
    PRIMARY KEY (installation_id, project_id, checkout_id, pane_id, adapter_id));
    CREATE TABLE provider_session_accounts (
      installation_id TEXT, project_id TEXT, checkout_id TEXT, adapter_id TEXT, session_id TEXT, account_id TEXT,
      PRIMARY KEY (installation_id, project_id, checkout_id, adapter_id, session_id))`);
  const scope = { version: 1 as const, installationId: 'install', projectId: 'project', checkoutId: 'checkout-a', rootRealPath: root, identitySource: 'manifest' as const };
  deps.agent = { adapterId: 'mimo-code', paneId: 'pane-a', accountId: 'acct-a', scope, cwd: root };
  const token = 'b'.repeat(64);
  registerMimoRuntime({ ...deps.agent, ptySessionId: 'pty-a', stateRoot, databasePath }, token);
  const endpoint = await startAgentHookHttpServer({ userDataPath: root });
  vi.stubEnv('NEXUS_AGENT_HOOK_PORT', String(endpoint.port));
  vi.stubEnv('NEXUS_AGENT_HOOK_TOKEN', endpoint.token);
  vi.stubEnv('NEXUS_MIMO_HOOK_TOKEN', token); vi.stubEnv('NEXUS_PANE_KEY', 'pty-a');
  const hook = (await import(`data:text/javascript,${encodeURIComponent(mimoStatusHookSource())}`)).default;
  await hook['chat.message']({ sessionID: 'ses_root', text: 'private prompt never sent' });
  expect(getProviderPaneSession(scope, 'pane-a', 'mimo-code', 'acct-a')).toMatchObject({ key: 'session_id', id: 'ses_root' });
  expect(getProviderPaneSession(scope, 'pane-a', 'mimo-code', 'acct-b')).toBeNull();
  await hook['chat.message']({ sessionID: 'ses_child' });
  expect(getProviderPaneSession(scope, 'pane-a', 'mimo-code', 'acct-a')?.id).toBe('ses_root');
  const wrongProof = await fetch(`http://127.0.0.1:${endpoint.port}/hook/mimo-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-Agent-Hook-Token': endpoint.token, 'X-Nexus-Mimo-Session-Token': 'c'.repeat(64) },
    body: JSON.stringify({ paneKey: 'pty-a', agentType: 'mimo-code', state: 'done', providerSession: { key: 'session_id', id: 'ses_root' } }),
  });
  expect(wrongProof.status).toBe(400);
});
