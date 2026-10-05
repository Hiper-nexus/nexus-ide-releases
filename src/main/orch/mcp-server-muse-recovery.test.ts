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

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });
