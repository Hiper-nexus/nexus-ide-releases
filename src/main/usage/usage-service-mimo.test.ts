import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { prepareMimoWorker } from './__tests__/mimo-worker-fixture';
import type { MimoSessionBinding } from './mimo-scanner';
const deps = vi.hoisted(() => ({ listener: null as null | ((id: string, binding: MimoSessionBinding | null) => void), speed: vi.fn() }));
vi.mock('../agent-hooks/mimo-session-registry', () => ({ isMimoUsageBindingProved: () => true,
  resolveMimoUsageBinding: (binding: MimoSessionBinding) => binding,
  releaseMimoUsageBinding: () => {},
  tapMimoSessionBindings: (listener: typeof deps.listener) => { deps.listener = listener; return () => { deps.listener = null; }; } }));
vi.mock('../orch/token-speed-tracker', () => ({ recordTokenSpeedUsage: deps.speed }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getVersion: () => 'test' }, BrowserWindow: { getAllWindows: () => [] }, ipcMain: {} }));
import { UsageTelemetryService } from './usage-service';
import { ProjectRuntimeManager } from '../runtime/project-runtime-manager';
import { ProjectUsageStoreRegistry } from './usage-store-registry';

let root = '';
let manager: ProjectRuntimeManager | null = null;
let service: UsageTelemetryService | null = null;
const databases: Database.Database[] = [];
beforeAll(prepareMimoWorker);
afterEach(async () => {
  await service?.stop(); manager?.closeAll();
  for (const db of databases.splice(0)) db.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});

it('ingests measured MiMo tokens into exact checkout/account totals with idempotent streaming corrections', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-usage-service-')));
  manager = new ProjectRuntimeManager({ baseDir: path.join(root, 'runtime'), appVersion: 'test' });
  service = new UsageTelemetryService(new ProjectUsageStoreRegistry(manager));
  service.start();
  const setup = (name: string, output: number) => {
    const cwd = path.join(root, name); fs.mkdirSync(cwd);
    const stateRoot = path.join(root, 'provider-state', 'mimo-code', name);
    fs.mkdirSync(path.join(stateRoot, 'database'), { recursive: true });
    const databasePath = path.join(stateRoot, 'database', 'mimocode.db');
    const db = new Database(databasePath); databases.push(db);
    db.exec('CREATE TABLE session (id TEXT, directory TEXT, parent_id TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_updated INTEGER, data TEXT)');
    db.prepare('INSERT INTO session VALUES (?, ?, NULL)').run('ses_same', cwd);
    const write = (tokens: number) => db.prepare('INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?)').run('msg_same', 'ses_same', tokens, JSON.stringify({
      role: 'assistant', providerID: 'xiaomi', modelID: 'mimo-v2.6-flash', path: { cwd },
      time: { created: 100 }, cost: tokens / 1000,
      tokens: { input: 10, output: tokens, reasoning: 2, cache: { read: 3, write: 0 } },
    }));
    write(output);
    const binding: MimoSessionBinding = {
      ptySessionId: `pty-${name}`, paneId: `pane-${name}`, accountId: `acct-${name}`, providerSessionId: 'ses_same',
      cwd, stateRoot, databasePath,
      scope: { version: 1, installationId: 'install', projectId: 'project', checkoutId: name, rootRealPath: cwd, identitySource: 'manifest' },
    };
    deps.listener!(binding.ptySessionId, binding);
    return { binding, write };
  };
  const a = setup('a', 4); const b = setup('b', 20);
  await vi.waitFor(() => expect(service!.snapshot(a.binding.scope)?.global.outputTokens).toBe(6), { timeout: 4_000 });
  await vi.waitFor(() => expect(service!.snapshot(b.binding.scope)?.global.outputTokens).toBe(22), { timeout: 4_000 });
  expect(service.snapshot(a.binding.scope)?.global).toMatchObject({ inputTokens: 10, outputTokens: 6, costUsd: 0.004, turns: 1 });
  expect(service.snapshot(b.binding.scope)?.global).toMatchObject({ outputTokens: 22, costUsd: 0.02, turns: 1 });
  expect(service.snapshot(a.binding.scope)?.byAccount['acct-a']).toMatchObject({ outputTokens: 6 });
  a.write(8);
  await vi.waitFor(() => expect(service!.snapshot(a.binding.scope)?.global.outputTokens).toBe(10), { timeout: 4_000 });
  expect(service.snapshot(a.binding.scope)?.global).toMatchObject({ outputTokens: 10, costUsd: 0.008, turns: 1 });
  expect(service.snapshot(b.binding.scope)?.global.outputTokens).toBe(22);
  expect(deps.speed).toHaveBeenCalledWith('pane-a', expect.objectContaining({ key: 'mimo-code:ses_same:msg_same', outputTokens: 10 }));
});
