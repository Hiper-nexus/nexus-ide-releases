// F-1004: o smoke empacotado do gate de release (scripts/smoke-packaged-app.mjs)
// roda SEM sandbox, com o HOME real do operador. Em modo smoke o boot não pode
// ler o Keychain (`security find-generic-password`) nem executar CLIs de IA
// (`--version`, `agy models`, `opencode models`, `codex app-server`, sondas de
// cota). Cada caminho automático do boot passa por uma destas portas.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => {
  /** Qualquer processo filho: registra e falha como binário ausente. */
  const record = vi.fn((file: unknown, ...rest: unknown[]) => {
    const callback = [...rest].reverse().find((arg) => typeof arg === 'function') as
      | ((error: Error, stdout: string, stderr: string) => void)
      | undefined;
    if (callback) {
      setImmediate(() =>
        callback(Object.assign(new Error(`blocked ${String(file)}`), { code: 'ENOENT' }), '', ''),
      );
    }
    return { on() {}, once() {}, kill() {}, stdout: null, stderr: null, pid: undefined };
  });
  return { record };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const stub = {
    ...actual,
    execFile: exec.record,
    spawn: exec.record,
    exec: exec.record,
    execFileSync: vi.fn((file: unknown) => {
      exec.record(file);
      throw Object.assign(new Error('blocked'), { code: 'ENOENT' });
    }),
    spawnSync: vi.fn((file: unknown) => {
      exec.record(file);
      return { status: null, error: new Error('blocked'), stdout: '', stderr: '' };
    }),
  };
  return { ...stub, default: stub };
});

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), isPackaged: false, getVersion: () => '0.0.0-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
}));

vi.mock('./smoke-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./smoke-core')>()),
  isCurrentProcessSmokeTest: () => true,
}));

import { probeCliBinaryVersion } from './path-resolver';
import { refreshDiscoveredModels } from './adapters/model-discovery';
import { readNativeOAuthCredential } from './adapters/native-oauth-keychain';
import { agyKeychainCredentialIsUsableAsync } from './adapters/subscription-auth';
import { QuotaService } from './quota/quota-service';
import type { ProviderSettingsInfo } from '../shared/provider-settings-types';
import type { AccountInfo } from '../shared/account-types';

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-smoke-isolation-'));
function fakeCli(name: string): string {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, '#!/bin/sh\necho "9.9.9"\n', { mode: 0o755 });
  return file;
}

beforeEach(() => exec.record.mockClear());
afterAll(() => fs.rmSync(binDir, { recursive: true, force: true }));

describe('modo smoke: o boot não executa CLI de IA nem lê o Keychain', () => {
  it('sonda `--version` de codex/opencode não roda', async () => {
    for (const name of ['codex', 'opencode', 'claude']) {
      await expect(probeCliBinaryVersion(fakeCli(name), binDir)).resolves.toBeNull();
    }
    expect(exec.record).not.toHaveBeenCalled();
  });

  it('descoberta de modelos (agy/opencode/codex) não roda', async () => {
    await Promise.all(
      ['agy', 'opencode', 'codex', 'cursor-agent', 'kimi'].map((id) =>
        refreshDiscoveredModels(id, { force: true }),
      ),
    );
    expect(exec.record).not.toHaveBeenCalled();
  });

  it('Keychain do Claude não é lido (e não cai no `claude auth status`)', async () => {
    const execImpl = vi.fn();
    await expect(
      readNativeOAuthCredential('Claude Code-credentials', execImpl as never),
    ).rejects.toThrow('Keychain unavailable');
    expect(execImpl).not.toHaveBeenCalled();
    expect(exec.record).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'darwin')('Keychain do AGY não é lido', async () => {
    const execImpl = vi.fn();
    await expect(agyKeychainCredentialIsUsableAsync(execImpl as never)).rejects.toThrow();
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('a cota viva não sonda conta (token, Keychain, CLI) no snapshot', async () => {
    const resolveClaudeAccessToken = vi.fn(() => 'sk-ant-oat01-test');
    const fetchImpl = vi.fn();
    const svc = new QuotaService({
      listProviders: () =>
        ['claude', 'cursor-agent', 'agy', 'codex'].map(
          (adapterId) =>
            ({ adapterId, label: adapterId, installed: true, enabled: true }) as ProviderSettingsInfo,
        ),
      listAccounts: () => [] as AccountInfo[],
      resolveClaudeAccessToken,
      fetchImpl: fetchImpl as never,
    });
    const snap = await svc.snapshot(1_000_000);
    svc.stop();
    expect(snap.entries.length).toBeGreaterThan(0);
    expect(resolveClaudeAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(exec.record).not.toHaveBeenCalled();
  });
});
