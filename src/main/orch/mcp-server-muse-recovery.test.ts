import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ recover: vi.fn(), purge: vi.fn() }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-recovery-'));
vi.mock('electron', () => ({
  app: { getPath: () => root, getAppPath: () => process.cwd(), getVersion: () => 'private-test' },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock('./native-heavy-muse-lease', () => ({ recoverMuseNativeHeavyLeases: mocks.recover }));
vi.mock('./cli-mcp-inject', async original => ({
  ...(await original<typeof import('./cli-mcp-inject')>()),
  purgeStaleAgyMcpConfigs: mocks.purge,
}));

it('awaits Muse lease recovery before any stale artifact purge at MCP startup', async () => {
  let finish!: (result: { restored: number; retained: number; failed: number }) => void;
  mocks.recover.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const endBeforeServing = new Error('private stop before server startup');
  mocks.purge.mockImplementation(() => { throw endBeforeServing; });
  const { startMcpServer } = await import('./mcp-server');
  const outcome = startMcpServer().catch(error => error);
  try {
    await Promise.resolve();
    expect(mocks.recover).toHaveBeenCalledOnce();
    expect(mocks.purge).not.toHaveBeenCalled();
  } finally {
    finish?.({ restored: 1, retained: 0, failed: 0 });
    expect(await outcome).toBe(endBeforeServing);
  }
  expect(mocks.purge).toHaveBeenCalledOnce();
});

it('reports a failed recovery without exposing config errors or blocking other cleanup', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.recover.mockRejectedValueOnce(new Error('private configuration contents'));
  mocks.purge.mockClear();
  const endBeforeServing = new Error('private stop before server startup');
  mocks.purge.mockImplementation(() => { throw endBeforeServing; });
  try {
    const { startMcpServer } = await import('./mcp-server');
    await expect(startMcpServer()).rejects.toBe(endBeforeServing);
    expect(mocks.purge).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[orch] Muse hook lease recovery was incomplete', {
      failed: 1, retained: 0,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain('private configuration contents');
  } finally { warning.mockRestore(); }
});

it('a Muse lease held by a live process never delays the startup of the other CLIs', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-mcp-contended-'))), leases = path.join(home, '.nexus/ephemeral/mcp-clients/muse/leases');
  const lock = path.join(leases, `${'a'.repeat(64)}.lock`);
  fs.mkdirSync(leases, { recursive: true }); fs.writeFileSync(path.join(leases, `${'a'.repeat(64)}.json`), '{}');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, id: 'live-holder' }));
  vi.stubEnv('HOME', home);
  const actual = await vi.importActual<typeof import('./native-heavy-muse-lease')>('./native-heavy-muse-lease');
  mocks.recover.mockReset().mockImplementation(() => actual.recoverMuseNativeHeavyLeases());
  const endBeforeServing = new Error('private stop before server startup'), started = performance.now(); let purgedAfter = Number.POSITIVE_INFINITY;
  mocks.purge.mockReset().mockImplementation(() => { purgedAfter = performance.now() - started; throw endBeforeServing; });
  try {
    const { startMcpServer } = await import('./mcp-server');
    await expect(startMcpServer()).rejects.toBe(endBeforeServing);
    expect(purgedAfter).toBeLessThan(1000);
    await expect(mocks.recover.mock.results.at(-1)!.value).resolves.toEqual({ restored: 0, retained: 1, failed: 0 });
    expect(fs.readFileSync(lock, 'utf8')).toContain('live-holder');
  } finally { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); }
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
